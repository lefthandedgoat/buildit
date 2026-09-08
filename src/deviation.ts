// Sampled-path deviation between two programs ("safe to carve" verdict).
//
// Compares CUT paths only (G1 + tessellated G2/G3; rapids excluded —
// reorder changes rapid travel by design). Arcs are tessellated from IJK
// centers with the same circle math as src/arcs.ts, never as chords.
// Inserted rest cleanup is excluded (intentional additive stock removal,
// shown as its own layer); air above the stock top is clipped (approach
// planes differ by design after TSP reorder + adaptive clearance).

import { trackMoves, type Program } from "./parser.ts";
import { signedSweep } from "./arcs.ts";

export type Pt = [number, number, number];

/** Tessellate one arc move into points (excluding the start point). */
function tessellateArc(
  fx: number,
  fy: number,
  fz: number,
  tx: number,
  ty: number,
  i: number,
  j: number,
  maxStep: number,
): Pt[] {
  const cx = fx + i;
  const cy = fy + j;
  const r = (Math.hypot(fx - cx, fy - cy) + Math.hypot(tx - cx, ty - cy)) / 2;
  if (!(r > 0) || !Number.isFinite(r)) return [[tx, ty, fz]];
  const sweep = signedSweep(fx, fy, tx, ty, cx, cy);
  const len = Math.abs(sweep) * r;
  const n = Math.max(1, Math.min(4096, Math.ceil(len / maxStep)));
  const a0 = Math.atan2(fy - cy, fx - cx);
  const pts: Pt[] = [];
  for (let k = 1; k <= n; k++) {
    const a = a0 + (sweep * k) / n;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a), fz]);
  }
  return pts;
}

export interface SampleOpts {
  /** Skip inserted rest-cleanup spans (default true). */
  excludeRest?: boolean;
  /** Drop sampled points above this Z — air plunges differ by design. */
  clipZ?: number;
}

/** Rest-marker test. Writers emit BUILDIT; pre-rename TRUEPATH files still read. */
export function isRestMarker(s: string): boolean {
  return s.includes("BUILDIT REST") || s.includes("TRUEPATH REST");
}

/** Block-index spans of inserted rest cleanup (comment marker to next
 *  paren-comment, M-word block, or EOF). */
export function restSpans(prog: Program): [number, number][] {
  const spans: [number, number][] = [];
  let open = -1;
  prog.blocks.forEach((b, i) => {
    if (
      b.passthrough &&
      (isRestMarker(b.raw) || b.misc.some((m) => isRestMarker(m)))
    ) {
      if (open >= 0) spans.push([open, i]);
      open = i;
      return;
    }
    if (open >= 0) {
      const isComment = b.passthrough && b.raw.trimStart().startsWith("(");
      const hasM = b.misc.some((m) => /^[MT]\d/i.test(m));
      if (isComment || hasM) {
        spans.push([open, i]);
        open = -1;
      }
    }
  });
  if (open >= 0) spans.push([open, prog.blocks.length]);
  return spans;
}

/** Stock-top estimate: max G1 Z in the program. */
export function stockTopOf(prog: Program): number {
  let top = -Infinity;
  for (const b of prog.blocks)
    if (b.motion === 1 && b.coords.Z !== undefined && b.coords.Z > top)
      top = b.coords.Z;
  return Number.isFinite(top) ? top : 0;
}

/** Sampled cut path: G1 interpolated + tessellated G2/G3. */
export function sampleCutPath(
  prog: Program,
  maxStep = 0.1,
  opts: SampleOpts = {},
): Pt[] {
  const pts: Pt[] = [];
  const excludeRest = opts.excludeRest ?? true;
  let restSet: Set<object> | null = null;
  if (excludeRest) {
    restSet = new Set();
    for (const [s, e] of restSpans(prog))
      for (let i = s; i < e; i++) restSet.add(prog.blocks[i]);
  }
  const keep = (p: Pt) =>
    opts.clipZ === undefined || p[2] <= opts.clipZ + 1e-9;
  for (const m of trackMoves(prog)) {
    const mo = m.block.motion;
    if (mo === 0 || mo === null) continue; // rapids excluded
    if (restSet?.has(m.block)) continue; // intentional additive cleanup
    if (mo === 1) {
      // Interpolate long segments: endpoints alone misrepresent sparse
      // polylines (a point 0.01mm off a 20mm segment can sit ~10mm from
      // the nearest endpoint).
      const len = Math.hypot(
        m.to[0] - m.from[0],
        m.to[1] - m.from[1],
        m.to[2] - m.from[2],
      );
      const n = Math.max(1, Math.min(4096, Math.ceil(len / maxStep)));
      for (let k = 1; k <= n; k++) {
        const t = k / n;
        const p: Pt = [
          m.from[0] + (m.to[0] - m.from[0]) * t,
          m.from[1] + (m.to[1] - m.from[1]) * t,
          m.from[2] + (m.to[2] - m.from[2]) * t,
        ];
        if (keep(p)) pts.push(p);
      }
    } else {
      const { I, J } = m.block.coords;
      if (I === undefined || J === undefined) {
        if (keep(m.to)) pts.push(m.to);
        continue;
      }
      for (const p of tessellateArc(
        m.from[0],
        m.from[1],
        m.from[2],
        m.to[0],
        m.to[1],
        I,
        J,
        maxStep,
      ))
        if (keep(p)) pts.push(p);
    }
  }
  return pts;
}

export interface Deviation {
  /** Bidirectional Hausdorff max (mm). */
  max: number;
  /** Mean nearest-neighbor distance both directions (mm). */
  mean: number;
  pointsA: number;
  pointsB: number;
}

function buildGrid(
  pts: Pt[],
  cell: number,
): Map<string, number[]> {
  const g = new Map<string, number[]>();
  pts.forEach((p, idx) => {
    const k = `${Math.floor(p[0] / cell)},${Math.floor(p[1] / cell)},${Math.floor(p[2] / cell)}`;
    let arr = g.get(k);
    if (!arr) {
      arr = [];
      g.set(k, arr);
    }
    arr.push(idx);
  });
  return g;
}

/** Nearest distance from p to any point in set (grid-accelerated). */
function nearest(
  p: Pt,
  set: Pt[],
  grid: Map<string, number[]>,
  cell: number,
): number {
  let best = Infinity;
  const cx = Math.floor(p[0] / cell);
  const cy = Math.floor(p[1] / cell);
  const cz = Math.floor(p[2] / cell);
  // Expand rings; unsearched cells past ring r are at least r*cell away,
  // so stop once best beats that bound. Ring cap bounds the cost for
  // true outliers (reported as >= cap distance — still "big").
  for (let ring = 0; ring <= 24; ring++) {
    for (let dx = -ring; dx <= ring; dx++)
      for (let dy = -ring; dy <= ring; dy++)
        for (let dz = -ring; dz <= ring; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== ring)
            continue;
          const arr = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (!arr) continue;
          for (const idx of arr) {
            const q = set[idx];
            const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
            if (d < best) best = d;
          }
        }
    if (best <= ring * cell || best <= cell * 0.75) return best;
  }
  return best;
}

export interface DeviationOpts {
  /** Sampling step in mm; auto-budgeted when omitted. */
  maxStep?: number;
  /** Cap on sampled points per side (default 60000). */
  pointBudget?: number;
}

/** Bidirectional sampled deviation between two programs' cut paths. */
export function pathDeviation(
  a: Program,
  b: Program,
  opts: DeviationOpts = {},
): Deviation {
  const budget = opts.pointBudget ?? 60000;
  // Auto-budget the step from total cut length so huge files stay fast.
  let step = opts.maxStep ?? 0.1;
  if (opts.maxStep === undefined) {
    let len = 0;
    for (const prog of [a, b])
      for (const m of trackMoves(prog))
        if (m.block.motion === 1 || m.block.motion === 2 || m.block.motion === 3)
          len += m.dist;
    step = Math.min(0.5, Math.max(0.02, len / budget));
  }
  const topA = stockTopOf(a);
  const topB = stockTopOf(b);
  const clip = Math.min(topA, topB);
  const pa = sampleCutPath(a, step, { clipZ: clip });
  const pb = sampleCutPath(b, step, { clipZ: clip });
  if (pa.length === 0 || pb.length === 0)
    return {
      max: Infinity,
      mean: Infinity,
      pointsA: pa.length,
      pointsB: pb.length,
    };
  const cell = 0.5;
  const gb = buildGrid(pb, cell);
  const ga = buildGrid(pa, cell);
  let maxD = 0;
  let sum = 0;
  for (const p of pa) {
    const d = nearest(p, pb, gb, cell);
    sum += d;
    if (d > maxD) maxD = d;
  }
  for (const p of pb) {
    const d = nearest(p, pa, ga, cell);
    sum += d;
    if (d > maxD) maxD = d;
  }
  return {
    max: maxD,
    mean: sum / (pa.length + pb.length),
    pointsA: pa.length,
    pointsB: pb.length,
  };
}
