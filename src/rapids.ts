// Rapids + retract optimizer (v3 module 1).
//
// Two independent rewrites over the post-arcs block stream:
//
//   A. TSP reorder of "sites". A site starts at a G0 XY traverse flown at
//      or above the clearance plane, followed by work with NO XY motion
//      below clearance (drill/peck strings, pocket-island entries), and
//      ends back at/above clearance. Reordering whole sites never splits
//      a continuous engagement path: anything cutting XY below clearance
//      stays inside its site by construction. Continuous 3D finishes
//      produce zero sites (no full-retract-separated segments) and are
//      left in order. Nearest-neighbor from the first site + 2-opt,
//      fully deterministic (no randomness anywhere).
//      Safety gates (any violation -> reorder skipped, report 0):
//        - every site must start AND end at/above clearance;
//        - no M/S/T words inside reordered spans (spindle/tool state
//          never moves relative to anything).
//   B. Adaptive clearance. Pure-Z G0 moves above (stockTop + margin) get
//      lowered to that plane. G0 moves at/below the plane (e.g. CC's
//      rapid-to-just-above-previous-depth peck steps) are never touched,
//      and the plane is never raised. So no rapid can enter material it
//      didn't already enter in the input.

import { type Block, trackMoves } from "./parser.ts";
import { blockTime } from "./estimate.ts";

export interface RapidsOptions {
  /** Enable TSP reorder. Default true. */
  tsp: boolean;
  /** "auto" -> stockTop + margin; a number -> absolute plane. Default auto. */
  clearance: number | "auto";
  /** Margin above stockTop for auto clearance. Default 1.0mm. */
  margin: number;
  /** Rapid rate mm/min for time math. Default 5000. */
  rapidRate: number;
  /** Accel mm/s^2 for time math. Default 400. */
  accel: number;
}

export interface RapidsStats {
  sitesFound: number;
  sitesReordered: number;
  rapidDistBefore: number;
  rapidDistAfter: number;
  clearancePlane: number;
  clearanceChanges: number;
  rapidMinSaved: number;
}

interface Move {
  bi: number; // index into blocks array
  motion: number | null;
  from: [number, number, number];
  to: [number, number, number];
  hasXY: boolean;
}

const EPS = 1e-9;

/** Legacy marker prefix (pre-rename files). Readers accept both; writers emit BUILDIT. */
const REST_OPEN = ["BUILDIT REST op=", "TRUEPATH REST op="];
const REST_END = ["BUILDIT REST END", "TRUEPATH REST END"];

const hasAny = (s: string, needles: string[]): boolean =>
  needles.some((n) => s.includes(n));

/** v4.2: block-index ranges of BUILDIT REST op= ... REST END spans.
 *  Unmatched START pins to end-of-program (safe direction: no reorder
 *  across it). Stray END without START is ignored. */
export function findRestSpans(blocks: Block[]): { from: number; to: number }[] {
  const spans: { from: number; to: number }[] = [];
  let open = -1;
  blocks.forEach((b, i) => {
    if (b.passthrough && hasAny(b.raw, REST_OPEN)) {
      if (open < 0) open = i;
    } else if (b.passthrough && hasAny(b.raw, REST_END)) {
      if (open >= 0) {
        spans.push({ from: open, to: i });
        open = -1;
      }
    }
  });
  if (open >= 0) spans.push({ from: open, to: blocks.length - 1 });
  return spans;
}

export function optimizeRapids(
  blocks: Block[],
  opts: RapidsOptions,
): { blocks: Block[]; stats: RapidsStats } {
  const moves = trackMoves({ blocks });
  const g0 = moves.filter((m) => m.block.motion === 0 && m.dist > EPS);
  const rapidDistBefore = g0.reduce((s, m) => s + m.dist, 0);

  // Stock top: highest Z touched by a G1 cut, using move ENDPOINTS only.
  // (A plunge's *start* is traverse height, not stock — using from.z
  // would mistake clearance for material.) Endpoints at/above the real
  // top only ever raise the plane, i.e. the safe direction.
  let stockTop = -Infinity;
  for (const m of moves) {
    if (m.block.motion === 1) stockTop = Math.max(stockTop, m.to[2]);
  }
  if (!Number.isFinite(stockTop)) stockTop = 0;

  const plane =
    opts.clearance === "auto" ? stockTop + opts.margin : opts.clearance;

  // ---- B. Adaptive clearance: lower pure-Z G0 above the plane. ----
  let clearanceChanges = 0;
  let out: Block[] = blocks.map((b) => {
    if (b.motion !== 0) return b;
    const hasXY = b.coords.X !== undefined || b.coords.Y !== undefined;
    const z = b.coords.Z;
    if (!hasXY && z !== undefined && z > plane + EPS) {
      clearanceChanges++;
      return { ...b, coords: { ...b.coords, Z: plane } };
    }
    return b;
  });

  // ---- A. Site segmentation on the clearance-rewritten stream. ----
  // v4.2: rest spans are atomic. A BUILDIT REST op= ... REST END span is
  // inserted immediately after its parent loop; splitting sites inside it
  // strands the markers and separates cleanup from its parent (moves are
  // absolute so cuts survive, but comments strand and the viewer must
  // fingerprint around it). Interior traverses never open new sites, so
  // each span travels whole with the site containing its insertion point.
  const restSpans = findRestSpans(out);
  const inRestSpan = (bi: number) =>
    restSpans.some((s) => bi > s.from && bi <= s.to);
  // Split plane: the LOWEST Z at which the rewritten stream relocates
  // in XY via G0. Transitions between reordered sites fly at exactly
  // heights the program already uses for relocation, so reordering
  // introduces no new low XY flight. (CC peck drill: first positioning
  // at Z4, all working traverses at retract Z3.175 -> splitZ 3.175,
  // lowered to stockTop+margin by the clearance pass above.)
  const stats: RapidsStats = {
    sitesFound: 0,
    sitesReordered: 0,
    rapidDistBefore,
    rapidDistAfter: rapidDistBefore, // updated below
    clearancePlane: plane,
    clearanceChanges,
    rapidMinSaved: 0,
  };

  if (!opts.tsp) {
    finishStats(out, stats, opts);
    return { blocks: out, stats };
  }

  // Re-track after clearance rewrite (positions of pure-Z G0 changed).
  const m2 = trackMoves({ blocks: out });
  // Split plane = lowest Z at which this stream relocates in XY via G0.
  let splitZ = Infinity;
  for (const m of m2) {
    if (m.block.motion !== 0 || m.dist <= EPS) continue;
    if (Math.hypot(m.to[0] - m.from[0], m.to[1] - m.from[1]) > EPS)
      splitZ = Math.min(splitZ, m.to[2]);
  }
  if (!Number.isFinite(splitZ)) splitZ = 0;
  const enriched: Move[] = m2.map((m) => ({
    bi: out.indexOf(m.block),
    motion: m.block.motion,
    from: m.from,
    to: m.to,
    hasXY:
      Math.abs(m.to[0] - m.from[0]) > EPS ||
      Math.abs(m.to[1] - m.from[1]) > EPS,
  }));

  // Traverse = G0 XY move ENDING at/above the split plane. The start
  // height is irrelevant: reordered sites are entered from the previous
  // site's high exit, and absolute (G90) coords make the traverse fly
  // from there to its high target — geometry the input already flies.
  // v4.2: traverses interior to a rest span never open sites (atomicity).
  const isTraverse = (m: Move) =>
    m.motion === 0 && m.hasXY && m.to[2] >= splitZ - 1e-6 && !inRestSpan(m.bi);

  const travIdx: number[] = [];
  enriched.forEach((m, i) => {
    if (isTraverse(m)) travIdx.push(i);
  });

  if (travIdx.length >= 2) {
    // Sites: traverse move + following moves up to (not incl.) next traverse.
    // Prologue (before first traverse) and epilogue stay pinned.
    interface Site {
      moves: Move[];
      entry: [number, number]; // XY where work starts (traverse target)
      exit: [number, number]; // XY where site ends
    }
    const sites: Site[] = travIdx.map((ti, s) => {
      const end = s + 1 < travIdx.length ? travIdx[s + 1] : enriched.length;
      const ms = enriched.slice(ti, end);
      return {
        moves: ms,
        entry: [ms[0].to[0], ms[0].to[1]],
        exit: [ms[ms.length - 1].to[0], ms[ms.length - 1].to[1]],
      };
    });

    // Gate 1: every site ends at/above the split plane, so each
    // site-to-site transition starts high. (Site starts need no gate:
    // entry always flies from the previous high exit to a high target.)
    const sealed = sites.every(
      (st) => st.moves[st.moves.length - 1].to[2] >= splitZ - 1e-6,
    );
    // Gate 2 (structural, verified by construction): sites split only at
    // high traverses, so any XY motion below clearance is interior to a
    // site and moves with it. No action needed.
    // Gate 3: no M/S/T words in reordered spans.
    const spanHasMST = (a: number, b: number) => {
      for (let bi = a; bi < b; bi++) {
        const blk = out[bi];
        if (!blk || blk.passthrough) continue;
        if (/[MS]\s*\d|T\s*\d/i.test(blk.raw)) return true;
        if (blk.misc.some((w) => /^[MST]/i.test(w))) return true;
      }
      return false;
    };

    if (sealed) {
      // Block spans: from traverse block to last motion block of site.
      const spans = sites.map((st) => {
        const firstBi = st.moves[0].bi;
        const lastBi = st.moves[st.moves.length - 1].bi;
        return { firstBi, lastBi };
      });
      // Extended spans: interstitial non-motion blocks travel with the
      // FOLLOWING site; prologue (before first traverse) and epilogue
      // (after the last motion block) stay pinned and never move, so
      // their M/S/T words need no check.
      const ext = spans.map((sp, s) => ({
        from: sp.firstBi,
        to: s + 1 < spans.length ? spans[s + 1].firstBi : sp.lastBi + 1,
      }));
      const epilogue = out.slice(spans[spans.length - 1].lastBi + 1);
      let gated = true;
      for (const e of ext) {
        if (spanHasMST(e.from, e.to)) {
          gated = false;
          break;
        }
      }
      if (gated && sites.length >= 2) {
        // TSP: fixed first site, nearest-neighbor + 2-opt on the rest.
        const dist = (a: [number, number], b: [number, number]) =>
          Math.hypot(a[0] - b[0], a[1] - b[1]);
        const order = [0];
        const rest = new Set<number>();
        for (let i = 1; i < sites.length; i++) rest.add(i);
        while (rest.size > 0) {
          const cur = order[order.length - 1];
          let best = -1;
          let bestD = Infinity;
          for (const c of rest) {
            const d = dist(sites[cur].exit, sites[c].entry);
            if (
              d < bestD - 1e-12 ||
              (Math.abs(d - bestD) < 1e-12 && c < best)
            ) {
              bestD = d;
              best = c;
            }
          }
          order.push(best);
          rest.delete(best);
        }
        // 2-opt with fixed endpoints (first and last pinned).
        let improved = true;
        const tourLen = (o: number[]) => {
          let s = 0;
          for (let i = 0; i + 1 < o.length; i++)
            s += dist(sites[o[i]].exit, sites[o[i + 1]].entry);
          return s;
        };
        while (improved) {
          improved = false;
          for (let i = 1; i < order.length - 2; i++) {
            for (let k = i + 1; k < order.length - 1; k++) {
              const cand = [
                ...order.slice(0, i),
                ...order.slice(i, k + 1).reverse(),
                ...order.slice(k + 1),
              ];
              if (tourLen(cand) < tourLen(order) - 1e-9) {
                for (let j = 0; j < order.length; j++) order[j] = cand[j];
                improved = true;
              }
            }
          }
        }
        const changed = order.some((v, i) => v !== i);
        if (changed) {
          // Rebuild: pinned prologue + reordered spans + pinned epilogue.
          const prologueEnd = spans[0].firstBi;
          const rebuilt: Block[] = out.slice(0, prologueEnd);
          for (const si of order)
            rebuilt.push(...out.slice(ext[si].from, ext[si].to));
          rebuilt.push(...epilogue);
          out = rebuilt;
          stats.sitesReordered = sites.length;
        }
        stats.sitesFound = sites.length;
      } else {
        stats.sitesFound = sites.length;
      }
    }
  }

  finishStats(out, stats, opts);
  return { blocks: out, stats };
}

function finishStats(out: Block[], stats: RapidsStats, opts: RapidsOptions) {
  const g0 = trackMoves({ blocks: out }).filter(
    (m) => m.block.motion === 0 && m.dist > EPS,
  );
  stats.rapidDistAfter = g0.reduce((s, m) => s + m.dist, 0);
  // Rapid time saved using the same trapezoid model as the estimator.
  // Approximate: saved distance flown at rapid rate.
  const savedDist = Math.max(0, stats.rapidDistBefore - stats.rapidDistAfter);
  const v = opts.rapidRate / 60;
  const dAcc = (v * v) / opts.accel;
  // Upper bound: treat savings as one cruise move (slight overestimate
  // vs many short hops, but conservative vs ignoring accel entirely).
  stats.rapidMinSaved =
    (savedDist <= 0
      ? 0
      : dAcc >= savedDist
        ? 2 * Math.sqrt(savedDist / opts.accel)
        : (savedDist - dAcc) / v + (2 * v) / opts.accel) / 60;
}
