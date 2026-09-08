// buildit viewer core: modal grbl parser + sampler + deviation.
// Runs in node (tests) and browser (viewer.html) — no dependencies.
((root, factory) => {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory();
    return;
  }
  root.builditCore = factory();
})(typeof self === "undefined" ? this : self, () => {
  "use strict";

  function parseNC(text) {
    const blocks = [];
    let modal = null,
      feed = 0;
    // v4.2: rest spans are atomic wrt rapids reorder, so op/END markers
    // survive — tag spans by marker first (works at any clearance). The
    // elevation fingerprint below stays as fallback for older files.
    let restOpen = -1;
    const pos = [0, 0, 0];
    const lines = text.split(/\r?\n/);
    for (let li = 0; li < lines.length; li++) {
      const raw = lines[li];
      // Writers emit BUILDIT; pre-rename TRUEPATH files still read.
      if (
        raw.includes("BUILDIT REST op=") ||
        raw.includes("TRUEPATH REST op=")
      ) {
        restOpen = blocks.length;
        continue;
      }
      if (
        raw.includes("BUILDIT REST END") ||
        raw.includes("TRUEPATH REST END")
      ) {
        if (restOpen >= 0) {
          for (let i = restOpen; i < blocks.length; i++) blocks[i].rest = true;
          restOpen = -1;
        }
        continue;
      }
      const l = raw.split(";")[0].split("(")[0].trim();
      if (!l) continue;
      // All G words; last motion word wins ("G90 G1 X.." must not stick
      // at modal 90). Track units/distance modes; reject non-mm/incremental.
      const gwords = l.match(/G0*(\d+)/g) || [];
      for (const gw of gwords) {
        const n = parseInt(gw.slice(1), 10);
        if (n === 20 || n === 21) {
          if (n === 20) throw new Error("inch input (G20) not supported");
          continue;
        }
        if (n === 90 || n === 91) {
          if (n === 91)
            throw new Error("incremental input (G91) not supported");
          continue;
        }
        if (n >= 0 && n <= 3) modal = n;
      }
      if (modal !== 0 && modal !== 1 && modal !== 2 && modal !== 3) continue;
      const coords = {};
      const re = /([XYZIJK])(-?[\d.]+)/g;
      let m;
      while ((m = re.exec(l)) !== null) coords[m[1]] = parseFloat(m[2]);
      const fm = l.match(/F([\d.]+)/);
      if (fm) feed = parseFloat(fm[1]);
      if (!("X" in coords) && !("Y" in coords) && !("Z" in coords)) {
        // Full-circle arcs carry only I/J (no endpoint words): retain so
        // the verdict can see them. Anything else coordless is modal state.
        if (!((modal === 2 || modal === 3) && ("I" in coords || "J" in coords)))
          continue;
        coords.X = pos[0];
        coords.Y = pos[1];
        coords.Z = pos[2];
      }
      const from = [pos[0], pos[1], pos[2]];
      if ("X" in coords) pos[0] = coords.X;
      if ("Y" in coords) pos[1] = coords.Y;
      if ("Z" in coords) pos[2] = coords.Z;
      const dx = pos[0] - from[0],
        dy = pos[1] - from[1],
        dz = pos[2] - from[2];
      const dist = Math.hypot(dx, dy, dz);
      const fullCircle =
        (modal === 2 || modal === 3) &&
        ("I" in coords || "J" in coords) &&
        dist <= 0;
      if (dist <= 0 && !fullCircle) continue;
      blocks.push({
        motion: modal,
        feed,
        from,
        to: [pos[0], pos[1], pos[2]],
        I: coords.I,
        J: coords.J,
        rest: false,
        idx: blocks.length,
      });
    }
    // ---- rest-pass fingerprint tagging -------------------------------------
    // v4 rest spans get scattered by rapids reorder (comments stranded), so
    // comment-pair tagging is unreliable. Rest passes are self-contained and
    // bracketed by retracts to a clearance ABOVE the file's own (5.027 vs
    // 4.000 here): tag bookend-delimited passes + anything touching it.
    (function tagRest(blocks) {
      const zs = [];
      for (const b of blocks) {
        if (b.motion !== 0) continue;
        if (
          b.from[0] === b.to[0] &&
          b.from[1] === b.to[1] &&
          b.from[2] !== b.to[2]
        )
          zs.push(b.to[2]);
      }
      if (!zs.length) return;
      const freq = new Map();
      for (const z of zs) {
        const k = z.toFixed(3);
        freq.set(k, (freq.get(k) || 0) + 1);
      }
      let mode = 0,
        modeN = 0,
        mx = -Infinity;
      for (const [k, n] of freq) {
        const z = parseFloat(k);
        if (n > modeN) {
          modeN = n;
          mode = z;
        }
        if (z > mx) mx = z;
      }
      if (!(mx > mode + 0.5)) return; // no elevated clearance -> no rest
      const RC = mx;
      const nearRC = (z) => Math.abs(z - RC) < 0.05;
      // Pass-phase machine. A rest pass = retract (pure-Z G0 to RC), entries
      // (G0 XY at RC), plunge (G1 down from RC), serpentine cuts, optional
      // restore (G0 XY at RC) — then original resumes, usually with NO
      // retract, so the restore itself must close the span.
      let inRest = false,
        hadCut = false;
      for (const b of blocks) {
        const cutMotion = b.motion === 1 || b.motion === 2 || b.motion === 3;
        // Rest cutFeed caps at 500 by construction; parent finish (F1200)
        // is never rest. Veto doubles as an inRest leak-stopper.
        if (cutMotion && b.feed > 500) {
          inRest = false;
          continue;
        }
        const pureZ =
          b.from[0] === b.to[0] &&
          b.from[1] === b.to[1] &&
          b.from[2] !== b.to[2];
        const pureXY = !pureZ && b.from[2] === b.to[2];
        const toRC = nearRC(b.to[2]),
          fromRC = nearRC(b.from[2]);
        if (b.motion === 0 && pureZ && toRC) {
          b.rest = true; // retract to rest clearance: opens a pass
          inRest = true;
          hadCut = false;
          continue;
        }
        if (b.motion === 0 && pureZ && !toRC) {
          inRest = false; // retract/plunge elsewhere: pass over (or never in)
          continue;
        }
        if (b.motion === 0 && pureXY && toRC && fromRC) {
          b.rest = true; // positioning at rest clearance (entry or restore)
          if (inRest && hadCut) {
            inRest = false;
            hadCut = false;
          } // restore closes
          continue;
        }
        if (pureZ && fromRC && !toRC && b.motion === 1) {
          b.rest = true; // G1 plunge from rest clearance: rest work
          hadCut = false; // fresh pass: cuts below set hadCut
          continue;
        }
        if (toRC || fromRC) {
          b.rest = true;
          continue;
        }
        if (inRest) {
          b.rest = true;
          if (b.motion === 1 || b.motion === 2 || b.motion === 3) hadCut = true;
        }
      }
      // (Corner-repeat tagging removed: in dense rest areas it mistags
      // adjacent lead-ins. tagAddedPlunges below handles rewritten passes.)
    })(blocks);
    // Unmatched OPEN (truncated file): tag through end, safe direction
    // (rest is excluded from verdict inputs, never hidden). Matched spans
    // were already tagged at their END marker above.
    if (restOpen >= 0) {
      for (let i = restOpen; i < blocks.length; i++) blocks[i].rest = true;
    }
    return blocks;
  }

  function arcCenter(b) {
    return [b.from[0] + (b.I || 0), b.from[1] + (b.J || 0)];
  }

  function arcPoints(b, maxSegLen) {
    // Tessellate G2/G3 block into points (for render + sampling).
    const [cx, cy] = arcCenter(b);
    const r = Math.hypot(b.from[0] - cx, b.from[1] - cy);
    const a0 = Math.atan2(b.from[1] - cy, b.from[0] - cx);
    const a1 = Math.atan2(b.to[1] - cy, b.to[0] - cx);
    let sweep;
    if (b.motion === 2) {
      // CW: decreasing angle
      sweep = a0 - a1;
      while (sweep <= 0) sweep += 2 * Math.PI;
      if (sweep >= 2 * Math.PI - 1e-9) sweep = 2 * Math.PI;
    } else {
      sweep = a1 - a0;
      while (sweep <= 0) sweep += 2 * Math.PI;
      if (sweep >= 2 * Math.PI - 1e-9) sweep = 2 * Math.PI;
    }
    const len = Math.abs(sweep) * r;
    const n = Math.max(2, Math.min(400, Math.ceil(len / maxSegLen)));
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const a = b.motion === 2 ? a0 - (sweep * i) / n : a0 + (sweep * i) / n;
      const t = i / n;
      pts.push([
        cx + r * Math.cos(a),
        cy + r * Math.sin(a),
        b.from[2] + (b.to[2] - b.from[2]) * t,
      ]);
    }
    return pts;
  }

  function samplePath(blocks, maxSegLen, cap) {
    // Flatten to point list, stride-capped. `null` entries are air-breaks:
    // consecutive points across a null must never be joined into a segment.
    // A break is emitted between blocks unless the cut is continuous
    // (prev end == next start and no rapid/tool action between).
    const pts = [];
    const counts = { g0: 0, g1: 0, arc: 0, rest: 0, link: 0 };
    const push = (p, kind) => {
      pts.push([p[0], p[1], p[2], kind]);
      counts[kind]++;
    };
    let prevEnd = null;
    for (const b of blocks) {
      const continuous =
        prevEnd !== null &&
        b.motion !== 0 &&
        Math.abs(prevEnd[0] - b.from[0]) < 1e-9 &&
        Math.abs(prevEnd[1] - b.from[1]) < 1e-9 &&
        Math.abs(prevEnd[2] - b.from[2]) < 1e-9;
      if (!continuous && pts.length && pts[pts.length - 1] !== null)
        pts.push(null);
      if (b.motion === 0) {
        const n = Math.max(
          1,
          Math.min(
            200,
            Math.ceil(
              Math.hypot(
                b.to[0] - b.from[0],
                b.to[1] - b.from[1],
                b.to[2] - b.from[2],
              ) / maxSegLen,
            ),
          ),
        );
        for (let i = 1; i <= n; i++) {
          const t = i / n;
          push(
            [
              b.from[0] + (b.to[0] - b.from[0]) * t,
              b.from[1] + (b.to[1] - b.from[1]) * t,
              b.from[2] + (b.to[2] - b.from[2]) * t,
            ],
            "g0",
          );
        }
      } else if (b.motion === 1 || b.I === undefined) {
        // Subdivide long chords so dense-vs-collapsed comparisons sample
        // the same geometry (else nearest-sample gaps fake deviations).
        // Per-block subdivision cap (not stride): every block keeps both
        // endpoints, so no move can vanish from the verdict. Pass
        // cap=Infinity for verdicts; decimate only for drawing.
        const L = Math.hypot(
          b.to[0] - b.from[0],
          b.to[1] - b.from[1],
          b.to[2] - b.from[2],
        );
        const flatLink = L > 8 && Math.abs(b.to[2] - b.from[2]) < 0.05;
        const kind = b.rest ? "rest" : flatLink ? "link" : "g1";
        const n = Math.max(1, Math.min(200, Math.ceil(L / maxSegLen)));
        for (let i = 1; i <= n; i++) {
          const t = i / n;
          push(
            [
              b.from[0] + (b.to[0] - b.from[0]) * t,
              b.from[1] + (b.to[1] - b.from[1]) * t,
              b.from[2] + (b.to[2] - b.from[2]) * t,
            ],
            kind,
          );
        }
      } else {
        const ap = arcPoints(b, maxSegLen);
        for (let i = 1; i < ap.length; i++)
          push(ap[i], b.rest ? "rest" : "arc");
      }
      prevEnd = b.to;
    }
    // Stride-cap.
    if (pts.length > cap) {
      const stride = pts.length / cap;
      const slim = [];
      for (let i = 0; i < cap; i++) slim.push(pts[Math.floor(i * stride)]);
      return { pts: slim, counts };
    }
    return { pts, counts };
  }

  function stockTop(blocks) {
    // Two cues, feed first: fast G1 (>=1500) is travel by definition, so
    // stockTop = max Z of arcs + slow G1. Uniform-feed files (3D finishes)
    // fall back to the highest crowned air gap; default = compare everything.
    let feedTop = -Infinity,
      hasFast = false;
    for (const b of blocks) {
      if (b.motion === 2 || b.motion === 3)
        feedTop = Math.max(feedTop, b.from[2], b.to[2]);
      else if (b.motion === 1 && b.feed > 0) {
        if (b.feed >= 1500) hasFast = true;
        else feedTop = Math.max(feedTop, b.from[2], b.to[2]);
      }
    }
    const zs = [];
    for (const b of blocks) {
      if (b.motion === 1 || b.motion === 2 || b.motion === 3) {
        zs.push(b.from[2], b.to[2]);
      }
    }
    if (!zs.length) return 0;
    if (hasFast && feedTop > -Infinity) return feedTop;
    // Dense ceiling: highest level with real cut density (>=300 pts). Sparse
    // travel clusters above it (clearance traverses at cutting feeds) are air.
    // Facing passes are dense -> correctly included as cuts.
    const BIN = 0.25;
    let lo = Infinity,
      hi = -Infinity;
    for (const z of zs) {
      if (z < lo) lo = z;
      if (z > hi) hi = z;
    }
    const nb = Math.max(1, Math.ceil((hi - lo) / BIN));
    const hist = new Array(nb).fill(0);
    for (const z of zs) hist[Math.min(nb - 1, Math.floor((z - lo) / BIN))]++;
    for (let i = nb - 1; i >= 0; i--) {
      // Boundary BELOW the topmost dense level: sparse travel above it.
      if (hist[i] >= 300) return lo + i * BIN;
    }
    // Highest crowned air gap: empty span >=0.5 whose top carries a travel
    // cluster (>=30 in 0.5 above) or IS the file max (cluster at the edge).
    // Highest wins: air gap over spike gaps and pocket-floor ripples.
    let best = hi; // default: compare everything (no travel found)
    let i = nb - 1;
    while (i >= 0) {
      if (hist[i] !== 0) {
        i--;
        continue;
      }
      let j = i;
      while (j >= 0 && hist[j] === 0) j--;
      const spanLen = (i - j) * BIN;
      const spanTop = lo + (i + 1) * BIN;
      let crown = 0;
      for (let k = i + 1; k < nb && (k - i - 1) * BIN < 0.5; k++)
        crown += hist[k];
      const atEdge = spanTop >= hi - 1e-9;
      if (spanLen >= 0.5 && (crown >= 30 || atEdge)) {
        best = lo + (j + 1) * BIN;
        break;
      }
      i = j;
    }
    return best;
  }

  function segsOf(pts) {
    // Null-safe: never join across air-breaks. Rest excluded (added
    // geometry, separate layer). Links INCLUDED as match targets: janitor
    // merges short cuts into long chords, and excluding them fakes gaps.
    // Link points still never query (see deviation filters).
    const segs = [];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1],
        b = pts[i];
      if (!a || !b) continue;
      if (a[3] === "rest" || b[3] === "rest") continue;
      segs.push(a, b);
    }
    return segs;
  }

  function ptSeg(p, a, b) {
    const abx = b[0] - a[0],
      aby = b[1] - a[1],
      abz = b[2] - a[2];
    const L2 = abx * abx + aby * aby + abz * abz;
    let t = L2
      ? ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby + (p[2] - a[2]) * abz) / L2
      : 0;
    t = Math.max(0, Math.min(1, t));
    const dx = p[0] - (a[0] + abx * t),
      dy = p[1] - (a[1] + aby * t),
      dz = p[2] - (a[2] + abz * t);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  function deviation(aPts, bPts, topZ) {
    // Honest fidelity = point-to-SEGMENT Hausdorff over the material zone.
    const lim = topZ === undefined ? Infinity : topZ + 0.25;
    const CUT = (p) => p && p[3] !== "g0" && p[3] !== "link" && p[3] !== "rest";
    // Cut-kind points above the material line are travel the verdict cannot
    // see (relocated clearance moves). Counted, never silently dropped:
    // green requires zero (unprovable != proven).
    let exclA = 0,
      exclB = 0;
    for (const p of aPts) if (CUT(p) && p[2] >= lim) exclA++;
    for (const p of bPts) if (CUT(p) && p[2] >= lim) exclB++;
    const A = aPts.filter((p) => CUT(p) && p[2] < lim);
    const B = bPts.filter((p) => CUT(p) && p[2] < lim);
    // NOTE: segsOf input keeps nulls as breaks but drops g0 only via kind;
    // height filter applies at query time (segments fully above lim skipped).
    const CS = 2.0;
    function build(pts) {
      const grid = new Map();
      const segs = segsOf(pts);
      for (let s = 0; s < segs.length; s += 2) {
        const a = segs[s],
          b = segs[s + 1];
        if (a[2] > lim && b[2] > lim) continue;
        const x0 = Math.floor(Math.min(a[0], b[0]) / CS),
          x1 = Math.floor(Math.max(a[0], b[0]) / CS);
        const y0 = Math.floor(Math.min(a[1], b[1]) / CS),
          y1 = Math.floor(Math.max(a[1], b[1]) / CS);
        const z0 = Math.floor(Math.min(a[2], b[2]) / CS),
          z1 = Math.floor(Math.max(a[2], b[2]) / CS);
        for (let ix = x0; ix <= x1; ix++)
          for (let iy = y0; iy <= y1; iy++)
            for (let iz = z0; iz <= z1; iz++) {
              const k = ix + ":" + iy + ":" + iz;
              let arr = grid.get(k);
              if (!arr) {
                arr = [];
                grid.set(k, arr);
              }
              arr.push(s);
            }
      }
      return { grid, segs };
    }
    function query(built, p) {
      const cx = Math.floor(p[0] / CS),
        cy = Math.floor(p[1] / CS),
        cz = Math.floor(p[2] / CS);
      let best = Infinity;
      // Branch-and-bound: stop when no unsearched cell can beat best.
      for (let ring = 0; ring < 8; ring++) {
        for (let ix = cx - ring; ix <= cx + ring; ix++)
          for (let iy = cy - ring; iy <= cy + ring; iy++)
            for (let iz = cz - ring; iz <= cz + ring; iz++) {
              if (
                ring > 0 &&
                ix > cx - ring &&
                ix < cx + ring &&
                iy > cy - ring &&
                iy < cy + ring &&
                iz > cz - ring &&
                iz < cz + ring
              )
                continue;
              const arr = built.grid.get(ix + ":" + iy + ":" + iz);
              if (!arr) continue;
              for (const s of arr) {
                const d = ptSeg(p, built.segs[s], built.segs[s + 1]);
                if (d < best) best = d;
                if (best === 0) return 0;
              }
            }
        if (best <= ring * CS) break;
      }
      return best;
    }
    const GB = build(bPts),
      GA = build(aPts);
    // Split verdict: preservation (A->B: nothing removed/moved) vs
    // additions (B->A: rest cleanup + repositioned travel are expected).
    // exclMax: worst match among height-excluded travel. Travel the optimizer
    // moved (lowered clearance) shows up here: unprovable statically (could
    // meet a clamp), so it caps the grade at amber instead of failing green.
    const EX = [],
      BX = [];
    for (const p of aPts) if (CUT(p) && p[2] >= lim) EX.push(p);
    for (const p of bPts) if (CUT(p) && p[2] >= lim) BX.push(p);
    let exclMax = 0;
    for (const p of EX) {
      const d = query(GB, p);
      if (d > exclMax) exclMax = d;
    }
    for (const p of BX) {
      const d = query(GA, p);
      if (d > exclMax) exclMax = d;
    }
    let maxA = 0,
      sumA = 0,
      nA = 0,
      worstA = null;
    for (const p of A) {
      const d = query(GB, p);
      if (d > maxA) {
        maxA = d;
        worstA = p;
      }
      sumA += d;
      nA++;
    }
    let maxB = 0,
      sumB = 0,
      nB = 0,
      worstB = null;
    for (const p of B) {
      const d = query(GA, p);
      if (d > maxB) {
        maxB = d;
        worstB = p;
      }
      sumB += d;
      nB++;
    }
    const n = nA + nB;
    const max = Math.max(maxA, maxB);
    return {
      max,
      mean: n ? (sumA + sumB) / n : 0,
      n,
      maxA,
      maxB,
      meanA: nA ? sumA / nA : 0,
      meanB: nB ? sumB / nB : 0,
      worstA: worstA ? [worstA[0], worstA[1], worstA[2], worstA[3]] : null,
      worstB: worstB ? [worstB[0], worstB[1], worstB[2], worstB[3]] : null,
      excludedCut: exclA + exclB,
      exclMax,
    };
  }

  function anomalies(blocks) {
    // Cut points plunging far below the job's dense zone (mesh-glitch
    // spikes like the -38mm single-point plunge). Reported, not verified.
    const zs = [];
    for (const b of blocks) {
      if (b.motion === 1) zs.push(b.to[2]);
    }
    if (zs.length < 10) return { count: 0, worst: 0 };
    zs.sort((x, y) => x - y);
    const p10 = zs[Math.floor(zs.length * 0.1)];
    let count = 0,
      worst = 0;
    for (const z of zs) {
      if (z < p10 - 3) {
        count++;
        if (z < worst || count === 1) worst = z;
      }
    }
    return { count, worst };
  }

  /**
   * Tag rest plunges the fingerprint misses: rapids rewrites some rest
   * retracts to file clearance, erasing the 5.027 signature. A B-side
   * pure-Z descent with no A-geometry nearby is added by definition
   * (optimizer never moves originals). Extends to the enclosing pass
   * (back to previous G0, forward to next retract).
   */
  function tagAddedPlunges(aBlocks, bBlocks) {
    const aPts = [];
    for (const b of aBlocks) {
      if (b.motion === null) continue;
      aPts.push(b.from, b.to);
    }
    const nearA = (x, y, r) => {
      for (let i = 0; i < aPts.length; i += 3) {
        const dx = x - aPts[i][0],
          dy = y - aPts[i][1];
        if (dx * dx + dy * dy < r * r) return true;
      }
      return false;
    };
    for (let i = 0; i < bBlocks.length; i++) {
      const b = bBlocks[i];
      if (b.rest || b.motion !== 1) continue;
      const dx = b.to[0] - b.from[0],
        dy = b.to[1] - b.from[1];
      const dz = b.to[2] - b.from[2];
      if (dz > -1 || Math.hypot(dx, dy) > 0.3) continue;
      if (nearA(b.from[0], b.from[1], 0.5)) continue;
      // Added plunge: tag enclosing pass, but ONLY with both anchors
      // (entry G0 behind, retract ahead). Tagging errors must fail toward
      // amber noise, never toward hidden moves: revert if unanchored.
      let back = -1;
      for (let j = i - 1; j >= Math.max(0, i - 6); j--) {
        if (bBlocks[j].motion === 0) {
          back = j;
          break;
        }
      }
      let fwd = -1;
      for (let j = i + 1; j < bBlocks.length && j < i + 400; j++) {
        const c = bBlocks[j];
        if (
          c.motion === 0 &&
          c.from[0] === c.to[0] &&
          c.from[1] === c.to[1] &&
          c.from[2] !== c.to[2]
        ) {
          fwd = j;
          break;
        }
      }
      if (back < 0 || fwd < 0) continue;
      // Locality guard: serpentine stays within ~2mm of its plunge; the
      // forward scan must not swallow unrelated downstream geometry.
      const px = b.from[0],
        py = b.from[1];
      const inside = (j) => {
        const c = bBlocks[j];
        const mx = (c.from[0] + c.to[0]) / 2,
          my = (c.from[1] + c.to[1]) / 2;
        return Math.hypot(mx - px, my - py) <= 3;
      };
      if (!inside(fwd)) continue;
      for (let j = back; j <= fwd; j++) {
        if (!inside(j)) break;
        const c = bBlocks[j];
        if (
          (c.motion === 1 || c.motion === 2 || c.motion === 3) &&
          c.feed > 500
        )
          continue;
        c.rest = true;
      }
    }
  }

  // ---- verdict messaging helpers (pure, render-only) ---------------------
  // Thresholds are load-bearing: SAFE<=0.25mm cuts AND <=0.5mm travel,
  // INSPECT<=1.5mm. Keep in sync with viewer.html + tests/viewer.test.ts.
  function fmtPt(p) {
    if (!p) return "-";
    const f = (x) => (Math.round(x * 100) / 100).toFixed(2);
    return "X" + f(p[0]) + " Y" + f(p[1]) + " Z" + f(p[2]);
  }

  function gradeVerdict(maxA, maxB, exclMax) {
    const worst = Math.max(maxA, maxB);
    const excl = exclMax || 0;
    if (worst <= 0.25 && excl <= 0.5)
      return { key: "green", label: "SAFE TO CARVE" };
    if (worst <= 1.5) return { key: "amber", label: "INSPECT" };
    return { key: "red", label: "DO NOT RUN" };
  }

  return {
    parseNC,
    arcPoints,
    samplePath,
    deviation,
    stockTop,
    anomalies,
    tagAddedPlunges,
    fmtPt,
    gradeVerdict,
  };
});
