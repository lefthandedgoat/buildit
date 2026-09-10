import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse, trackMoves, type Block } from "../src/parser.ts";
import { emit } from "../src/janitor.ts";
import { janitor } from "../src/janitor.ts";
import {
  arcDirection,
  circleFrom3Points,
  devFromCircle,
  fitArcs,
  signedSweep,
  splitRuns,
} from "../src/arcs.ts";

import { CORPUS, corpusSkip } from "./corpus.ts";
const SHARK_FINE = join(CORPUS, "shark-bottom-finish-fine.c2d.nc");
// 2.5D pocketing file with long constant-Z runs (thousands of arcs expected).
const POCKET = join(CORPUS, "happy-w-half-mil.c2d.nc");
// 1/16 finish with one sparse 3.95mm chord in an otherwise dense file:
// the fitter once bowed an arc 0.55 off it with clean endpoints.
const SPARSE = join(CORPUS, "happy-w-1-16.c2d.nc");
const TOL = 0.02;

/** G-code text for an XY polyline at fixed Z: rapid to start, then modal G1. */
function polyline(
  pts: Array<[number, number]>,
  z: number | ((i: number) => number),
): string {
  const lines = pts.map(([x, y], i) => {
    const zz = typeof z === "function" ? z(i) : z;
    if (i === 0) return `G0X${x}Y${y}Z${zz}`;
    if (i === 1) return `G1X${x}Y${y}Z${zz}F450`;
    return `X${x}Y${y}Z${zz}`;
  });
  return lines.join("\n");
}

/** Points on a circular arc (degrees) of radius r about (cx, cy). */
function arcPts(
  cx: number,
  cy: number,
  r: number,
  a0: number,
  a1: number,
  step: number,
): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  for (let a = a0; a <= a1 + 1e-9; a += step) {
    const t = (a * Math.PI) / 180;
    pts.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
  }
  return pts;
}

describe("circleFrom3Points", () => {
  it("finds center and radius of a known circle", () => {
    const c = circleFrom3Points(10, 0, 0, 10, -10, 0)!;
    assert.ok(Math.abs(c.cx) < 1e-9 && Math.abs(c.cy) < 1e-9);
    assert.ok(Math.abs(c.r - 10) < 1e-9);
  });

  it("returns null for collinear points", () => {
    assert.equal(circleFrom3Points(0, 0, 1, 1, 2, 2), null);
  });
});

describe("arcDirection", () => {
  it("detects CCW (G3) and CW (G2)", () => {
    // Unit circle: (1,0) -> (0,1) about origin is CCW.
    assert.equal(arcDirection(1, 0, 0, 1, 0, 0), 3);
    assert.equal(arcDirection(0, 1, 1, 0, 0, 0), 2);
  });
});

describe("signedSweep", () => {
  it("measures exact angles (pins the dot-product terms)", () => {
    // (1,0) -> (0,1) about origin: exactly +90°.
    assert.ok(Math.abs(signedSweep(1, 0, 0, 1, 0, 0) - Math.PI / 2) < 1e-12);
    // Obtuse case: must exceed 90°. A dot-product typo (ay*bx for ay*by)
    // once returned 86° here instead of ~161°.
    const obtuse = signedSweep(0.317, -0.805, -0.034, 0.864, 0, 0);
    assert.ok(
      Math.abs(Math.abs(obtuse) - 2.806) < 0.01,
      `expected ~161°, got ${(Math.abs(obtuse) * 180) / Math.PI}°`,
    );
    // Degenerate: zero-length sweep.
    assert.ok(Math.abs(signedSweep(1, 0, 1, 0, 0, 0)) < 1e-12);
  });
});

describe("fitArcs on synthetic geometry", () => {
  it("fits one arc to a clean circular run", () => {
    const prog = parse(polyline(arcPts(0, 0, 10, 0, 60, 5), -1));
    const { blocks, stats } = fitArcs(prog.blocks, { tolerance: TOL });
    assert.equal(stats.arcsEmitted, 1);
    const arc = blocks.find((b) => b.motion === 2 || b.motion === 3)!;
    assert.equal(blocks.filter((b) => b.motion === 1).length, 0);
    assert.ok(arc.coords.I !== undefined && arc.coords.J !== undefined);
  });

  it("splits at a kink exceeding tolerance", () => {
    const left = arcPts(0, 0, 10, 0, 40, 5);
    // Kink: jump 0.5 mm off the circle, then resume on a shifted arc.
    const kinked: Array<[number, number]> = [
      ...left,
      [
        10 * Math.cos((45 * Math.PI) / 180) + 0.5,
        10 * Math.sin((45 * Math.PI) / 180),
      ],
      ...arcPts(0.5, 0, 10, 50, 90, 5),
    ];
    const prog = parse(polyline(kinked, -1));
    const { stats } = fitArcs(prog.blocks, { tolerance: TOL });
    assert.ok(
      stats.arcsEmitted >= 2,
      `kink should force 2+ arcs, got ${stats.arcsEmitted}`,
    );
  });

  it("splits runs on Z change", () => {
    const pts = arcPts(0, 0, 10, 0, 60, 5);
    const prog = parse(polyline(pts, (i) => (i < pts.length / 2 ? -1 : -1.05)));
    const { runs } = splitRuns(prog.blocks);
    assert.equal(runs.length, 2);
    // No emitted arc may span the Z step: every arc endpoint pair must
    // sit on one side of it.
    const { blocks } = fitArcs(prog.blocks, { tolerance: TOL });
    for (const b of blocks) {
      if (b.motion === 2 || b.motion === 3) {
        assert.ok(b.coords.Z === -1 || b.coords.Z === -1.05);
      }
    }
  });

  it("every emitted arc carries explicit XYZIJ+F (modal safety)", () => {
    const prog = parse(polyline(arcPts(5, 5, 8, 0, 90, 4), -2));
    const { blocks } = fitArcs(prog.blocks, { tolerance: TOL });
    const arcs = blocks.filter((b) => b.motion === 2 || b.motion === 3);
    assert.ok(arcs.length > 0);
    for (const a of arcs) {
      assert.equal(a.explicitMotion, true);
      assert.equal(a.explicitFeed, true);
      assert.ok(a.coords.X !== undefined, "X missing");
      assert.ok(a.coords.Y !== undefined, "Y missing");
      assert.ok(a.coords.Z !== undefined, "Z missing");
      assert.ok(a.coords.I !== undefined, "I missing");
      assert.ok(a.coords.J !== undefined, "J missing");
      assert.ok(a.feed > 0, "feed missing");
    }
  });

  it("modal safety: re-parsed output tracks identical positions", () => {
    // Partial-coordinate lines (Y-only, X-only) around an arc.
    const lines = ["G1X10Y0Z-1F450"];
    const pts = arcPts(0, 0, 10, 5, 60, 5);
    let px = 10;
    let py = 0;
    for (const [x, y] of pts) {
      if (Math.abs(x - px) > Math.abs(y - py)) lines.push(`X${x.toFixed(4)}`);
      else lines.push(`Y${y.toFixed(4)}`);
      px = x;
      py = y;
    }
    const prog = parse(lines.join("\n"));
    const { blocks } = fitArcs(prog.blocks, { tolerance: TOL });
    const out = parse(emit({ blocks }, 3, true));
    const m0 = trackMoves(prog).map((m) => m.to);
    const m1 = trackMoves(out).map((m) => m.to);
    // Every post-arcs endpoint must match a pre-arcs endpoint (arcs only
    // remove intermediate points, never move them).
    for (const p of m1) {
      assert.ok(
        m0.some(
          (q) =>
            Math.abs(q[0] - p[0]) < 1e-3 &&
            Math.abs(q[1] - p[1]) < 1e-3 &&
            Math.abs(q[2] - p[2]) < 1e-3,
        ),
        `endpoint ${p} not found in original`,
      );
    }
    const e1 = m1[m1.length - 1];
    const e0 = m0[m0.length - 1];
    assert.ok(
      Math.abs(e1[0] - e0[0]) < 1e-3 &&
        Math.abs(e1[1] - e0[1]) < 1e-3 &&
        Math.abs(e1[2] - e0[2]) < 1e-3,
      "final endpoint moved",
    );
  });
});

/**
 * Verify every emitted arc against the original (pre-arcs) moves:
 * locate the arc's start/end in the original endpoint sequence and assert
 * all covered intermediate points deviate <= tol from the fitted circle.
 */
function verifyArcSpans(
  origMoves: Array<{ to: [number, number, number] }>,
  arcBlocks: Block[],
  tol: number,
): number {
  let checked = 0;
  const pos: [number, number, number] = [0, 0, 0];
  for (const b of arcBlocks) {
    if (b.passthrough || b.motion === null) {
      if (b.coords.X !== undefined) pos[0] = b.coords.X;
      if (b.coords.Y !== undefined) pos[1] = b.coords.Y;
      if (b.coords.Z !== undefined) pos[2] = b.coords.Z;
      continue;
    }
    const from: [number, number, number] = [...pos];
    if (b.coords.X !== undefined) pos[0] = b.coords.X;
    if (b.coords.Y !== undefined) pos[1] = b.coords.Y;
    if (b.coords.Z !== undefined) pos[2] = b.coords.Z;
    if (b.motion !== 2 && b.motion !== 3) continue;
    const { I, J } = b.coords;
    assert.ok(I !== undefined && J !== undefined, "arc without IJK");
    const cx = from[0] + I;
    const cy = from[1] + J;
    const r = Math.hypot(from[0] - cx, from[1] - cy);
    // Directed sweep of the emitted arc (grbl takes the directed side).
    const dirSign = b.motion === 3 ? 1 : -1;
    const TAU = 2 * Math.PI;
    const startAng = Math.atan2(from[1] - cy, from[0] - cx);
    const endAng = Math.atan2(pos[1] - cy, pos[0] - cx);
    let total = (endAng - startAng) * dirSign;
    while (total <= 0) total += TAU;
    const onArc = (px: number, py: number) => {
      const a = Math.atan2(py - cy, px - cx);
      let rel = (a - startAng) * dirSign;
      while (rel < 0) rel += TAU;
      return rel <= total + 1e-6;
    };
    // Locate start/end in the original endpoint sequence.
    const near = (p: [number, number, number], q: [number, number, number]) =>
      Math.abs(p[0] - q[0]) < 1e-6 &&
      Math.abs(p[1] - q[1]) < 1e-6 &&
      Math.abs(p[2] - q[2]) < 1e-6;
    const si = origMoves.findIndex((m) => near(m.to, from));
    assert.ok(si >= 0, `arc start ${from} not an original endpoint`);
    let ei = -1;
    for (let k = si + 1; k < origMoves.length; k++) {
      if (near(origMoves[k].to, pos)) {
        ei = k;
        break;
      }
    }
    assert.ok(ei > si, `arc end ${pos} not found after start`);
    for (let k = si + 1; k < ei; k++) {
      const d = devFromCircle(origMoves[k].to[0], origMoves[k].to[1], {
        cx,
        cy,
        r,
      });
      assert.ok(
        d <= tol + 1e-9,
        `point ${origMoves[k].to} deviates ${d.toFixed(4)} > ${tol}`,
      );
      // The point must lie on the DIRECTED arc, not just the circle:
      // a circle fit through a cusp also fits the shortcut side.
      assert.ok(
        onArc(origMoves[k].to[0], origMoves[k].to[1]),
        `point ${origMoves[k].to} off the directed arc`,
      );
      checked++;
    }
    // Inter-point bulge (v4.3): endpoints on-circle do not bound the
    // chords between them. Assert every covered chord's sagitta AND
    // midpoint within tol — a 3.95mm chord once bulged 0.55 with clean
    // endpoints (happy-w-1-16). The fitter gates both at tol/2, so
    // this must hold with room to spare.
    for (let k = si + 1; k <= ei; k++) {
      const ax = origMoves[k - 1].to[0];
      const ay = origMoves[k - 1].to[1];
      const bx = origMoves[k].to[0];
      const by = origMoves[k].to[1];
      const half = Math.hypot(bx - ax, by - ay) / 2;
      assert.ok(
        half < r,
        `chord longer than diameter in span ending ${origMoves[ei].to}`,
      );
      const sag = r - Math.sqrt(r * r - half * half);
      assert.ok(
        sag <= tol + 1e-9,
        `chord ${k} sagitta ${sag.toFixed(4)} > ${tol}`,
      );
      const mx = (ax + bx) / 2;
      const my = (ay + by) / 2;
      const md = devFromCircle(mx, my, { cx, cy, r });
      assert.ok(
        md <= tol + 1e-9,
        `chord ${k} midpoint deviates ${md.toFixed(4)} > ${tol}`,
      );
      checked++;
    }
  }
  return checked;
}

describe("sparse-chord honesty (happy-w-1-16, v4.3)", corpusSkip, () => {
  it("no emitted arc bulges off a sparse chord", () => {
    // One 3.95mm chord in dense confetti: endpoints verify clean on any
    // circle through them, but the chord midpoint bulged 0.55 off the
    // emitted arc (viewer maxA 0.55, exact sagitta match). Fails without
    // the bestFrom sagitta gate; the harness midpoint/sagitta checks
    // below are the tripwire.
    const prog = parse(readFileSync(SPARSE, "utf8"));
    const { text: jText } = janitor(prog, { tolerance: 0.01, decimals: 3 });
    const jProg = parse(jText);
    const jMoves = trackMoves(jProg);
    const fit = fitArcs(jProg.blocks, { tolerance: TOL });
    assert.ok(fit.stats.arcsEmitted > 100, "expected arcs on this file");
    const checked = verifyArcSpans(jMoves, fit.blocks, TOL);
    assert.ok(checked > 0, "no arc spans checked");
  });
});
describe("corpus fidelity (2.5D pocket file)", corpusSkip, () => {
  it("emits thousands of arcs, fewer blocks, zero tolerance violations", () => {
    const prog = parse(readFileSync(POCKET, "utf8"));
    const { text: jText } = janitor(prog, { tolerance: 0.01, decimals: 3 });
    const jProg = parse(jText);
    const jMoves = trackMoves(jProg);
    const fit = fitArcs(jProg.blocks, { tolerance: TOL });
    assert.ok(
      fit.stats.arcsEmitted > 1000,
      `expected 1000+ arcs, got ${fit.stats.arcsEmitted}`,
    );
    assert.ok(fit.blocks.length < jProg.blocks.length, "blocks must shrink");
    const checked = verifyArcSpans(jMoves, fit.blocks, TOL);
    assert.ok(checked > 5000, `expected 5000+ covered points, got ${checked}`);
    // Bounding stats: same envelope, same path length within 1%.
    const final = parse(emit({ blocks: fit.blocks }, 3, true));
    const bbox = (
      ms: Array<{ to: [number, number, number] }>,
    ): [number, number, number, number, number, number] => {
      let x0 = Infinity,
        y0 = Infinity,
        z0 = Infinity,
        x1 = -Infinity,
        y1 = -Infinity,
        z1 = -Infinity;
      for (const m of ms) {
        x0 = Math.min(x0, m.to[0]);
        y0 = Math.min(y0, m.to[1]);
        z0 = Math.min(z0, m.to[2]);
        x1 = Math.max(x1, m.to[0]);
        y1 = Math.max(y1, m.to[1]);
        z1 = Math.max(z1, m.to[2]);
      }
      return [x0, y0, z0, x1, y1, z1];
    };
    // Arc-aware envelope AND length. Endpoint-only tracking is blind to
    // bulge between arc endpoints (and chord lengths undercount arcs),
    // so sample emitted arcs every 2°: envelope must match within tol
    // (wrong-side arcs would miss by ~2r), length within 1%.
    const finalMoves = trackMoves(final);
    const envPts: Array<[number, number, number]> = [];
    let lf = 0;
    for (const m of finalMoves) {
      const b = m.block;
      if (
        (b.motion === 2 || b.motion === 3) &&
        b.coords.I !== undefined &&
        b.coords.J !== undefined
      ) {
        const cx = m.from[0] + b.coords.I;
        const cy = m.from[1] + b.coords.J;
        const r = Math.hypot(m.from[0] - cx, m.from[1] - cy);
        const a0 = Math.atan2(m.from[1] - cy, m.from[0] - cx);
        let sweep = Math.atan2(
          (m.from[0] - cx) * (m.to[1] - cy) - (m.from[1] - cy) * (m.to[0] - cx),
          (m.from[0] - cx) * (m.to[0] - cx) + (m.from[1] - cy) * (m.to[1] - cy),
        );
        if (b.motion === 2 && sweep > 0) sweep -= 2 * Math.PI;
        if (b.motion === 3 && sweep < 0) sweep += 2 * Math.PI;
        const steps = Math.max(
          4,
          Math.ceil(Math.abs(sweep) / ((2 * Math.PI) / 180)),
        );
        let prev: [number, number, number] = m.from;
        for (let k = 1; k <= steps; k++) {
          const a = a0 + (sweep * k) / steps;
          const p: [number, number, number] = [
            cx + r * Math.cos(a),
            cy + r * Math.sin(a),
            m.to[2],
          ];
          envPts.push(p);
          lf += Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]);
          prev = p;
        }
      } else {
        envPts.push(m.to);
        lf += m.dist;
      }
    }
    const bj = bbox(jMoves);
    const bs = bbox(envPts.map((to) => ({ to })));
    for (let i = 0; i < 6; i++) {
      assert.ok(
        Math.abs(bs[i] - bj[i]) <= TOL + 0.01,
        `envelope bound ${i} drifted: ${bj[i]} -> ${bs[i]}`,
      );
    }
    const len = (ms: Array<{ dist: number }>) =>
      ms.reduce((s, m) => s + m.dist, 0);
    const lj = len(jMoves);
    assert.ok(
      Math.abs(lf - lj) / lj < 0.01,
      `path length drifted: ${lj.toFixed(1)} -> ${lf.toFixed(1)}`,
    );
  });
});

describe("steep-3D honesty check (shark fine finish)", corpusSkip, () => {
  it("fits only genuinely planar spans, Z-blocks everything else", () => {
    const prog = parse(readFileSync(SHARK_FINE, "utf8"));
    const { text: jText } = janitor(prog, { tolerance: 0.01, decimals: 3 });
    const jProg = parse(jText);
    const jMoves = trackMoves(jProg);
    const fit = fitArcs(jProg.blocks, { tolerance: TOL });
    // Median per-move |dZ| is ~0.1 mm (20x Z_EPS): essentially no planar
    // runs exist. A handful of arcs may fit true flat spots; mass
    // Z-blocking must dominate and nothing may be forced.
    assert.ok(
      fit.stats.arcsEmitted <= 20,
      `expected ~0 arcs, got ${fit.stats.arcsEmitted}`,
    );
    assert.ok(
      fit.stats.zSplitCount > 30000,
      `expected mass Z-blocking, got ${fit.stats.zSplitCount}`,
    );
    assert.ok(fit.blocks.length <= jProg.blocks.length);
    // Whatever was emitted must still verify exactly.
    verifyArcSpans(jMoves, fit.blocks, TOL);
  });
});

describe("coordless modal blocks (v4.1)", () => {
  it("passes coordless explicit blocks through unabsorbed and undropped", () => {
    const mk = (
      motion: 0 | 1 | 2 | 3 | null,
      coords: Record<string, number>,
      feed: number,
      explicitFeed: boolean,
    ): Block => ({
      line: 0,
      raw: "",
      passthrough: false,
      motion,
      explicitMotion: true,
      coords,
      explicitFeed,
      feed,
      misc: [],
    });
    const blocks: Block[] = [
      mk(1, { X: 0, Y: 0, Z: -1 }, 400, true),
      mk(1, { X: 10, Y: 0, Z: -1 }, 400, false),
      mk(1, { X: 20, Y: 0, Z: -1 }, 400, false),
      // v4 modal restore: no coords, explicit motion+feed. Must survive.
      mk(1, {}, 400, true),
      mk(1, { X: 30, Y: 0, Z: -1 }, 400, false),
      mk(1, { X: 40, Y: 0, Z: -1 }, 400, false),
    ];
    const fit = fitArcs(blocks, { tolerance: 0.02 });
    const coordless = fit.blocks.filter(
      (b) =>
        !b.passthrough &&
        b.motion !== null &&
        b.coords.X === undefined &&
        b.coords.Y === undefined &&
        b.coords.Z === undefined,
    );
    assert.equal(coordless.length, 1);
    assert.equal(coordless[0].feed, 400);
  });
});

describe("cusp directed-side regression (v4.1)", () => {
  it("never shortcuts a sharp V with a minor-side arc", () => {
    // Real failure: cusp (88.74,47.15)->(88.38,46.34)->(88.09,47.16) got a
    // G3 minor arc missing the tip by 0.8mm at tol 0.02.
    const mk = (x: number, y: number, feed: number): Block => ({
      line: 0,
      raw: "",
      passthrough: false,
      motion: 1,
      explicitMotion: true,
      coords: { X: x, Y: y, Z: -4 },
      explicitFeed: true,
      feed,
      misc: [],
    });
    const blocks: Block[] = [
      mk(88.74, 47.15, 500),
      mk(88.47, 46.54, 500),
      mk(88.38, 46.34, 500),
      mk(88.09, 47.16, 500),
      mk(87.5, 47.2, 500),
    ];
    const fit = fitArcs(blocks, { tolerance: 0.02 });
    // Directed-verify every emitted arc against every input point it spans.
    const pos: [number, number, number] = [0, 0, 0];
    const TAU = 2 * Math.PI;
    for (const b of fit.blocks) {
      if (b.motion === null) continue;
      const from: [number, number, number] = [...pos];
      if (b.coords.X !== undefined) pos[0] = b.coords.X;
      if (b.coords.Y !== undefined) pos[1] = b.coords.Y;
      if (b.coords.Z !== undefined) pos[2] = b.coords.Z;
      if (b.motion !== 2 && b.motion !== 3) continue;
      const cx = from[0] + (b.coords.I ?? 0);
      const cy = from[1] + (b.coords.J ?? 0);
      const r = Math.hypot(from[0] - cx, from[1] - cy);
      const dirSign = b.motion === 3 ? 1 : -1;
      const startAng = Math.atan2(from[1] - cy, from[0] - cx);
      const endAng = Math.atan2(pos[1] - cy, pos[0] - cx);
      let total = (endAng - startAng) * dirSign;
      while (total <= 0) total += TAU;
      for (const p of [
        [88.47, 46.54],
        [88.38, 46.34],
      ]) {
        const pr = Math.hypot(p[0] - cx, p[1] - cy);
        const a = Math.atan2(p[1] - cy, p[0] - cx);
        let rel = (a - startAng) * dirSign;
        while (rel < 0) rel += TAU;
        const onArc = rel <= total + 1e-6;
        // Either the arc avoids the cusp region or it covers the tip.
        if (onArc || Math.abs(pr - r) < 0.5) {
          assert.ok(
            Math.abs(pr - r) <= 0.02 + 1e-9 && onArc,
            `cusp mishandled: r-err ${Math.abs(pr - r).toFixed(3)} onArc=${onArc}`,
          );
        }
      }
    }
  });
});
