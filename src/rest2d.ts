// 2.5D rest-region analysis (v3 module 2). ANALYSIS ONLY in v3: it finds
// pocket loops, computes the leftover area a smaller finish tool must
// still clear after a larger tool, and reports it. No cut paths are
// generated (that's v4).
//
// Method: exact concave-corner analysis (no general polygon clipper).
// Straight edges contribute zero rest (the opening argument: dilating the
// prev tool's reachable region by (Rp-Rf) recovers the finish erosion
// exactly on convex geometry). All rest lives in concave corners: for a
// corner with wedge half-angle b (b = (2*pi - interiorAngle)/2), the
// region between the vertex and a tangent tool circle of radius r is
//   A(r) = r^2 * (cot(b) - pi/2 + b)
// (quadrilateral V-T1-C-T2 minus the sector; for a 90-degree inside
// corner this reduces to the familiar r^2*(1-pi/4)). Rest per corner =
// A(Rp) - A(Rf). Monotone in Rp; zero for convex loops; zero when Rp<=Rf.
//
// NOTE on clipper2-js (vetted, rejected): erosion and boolean
// Difference/Xor were verified broken in hand tests (10x10 minus 6x6
// returned 136 instead of 64 regardless of winding/fill rule;
// negative-delta offsets applied nonlinear wrong magnitudes, while
// dilation was exact). Only dilation + Intersection/Union were sound.
// Rather than build on a half-broken primitive, v3 uses the exact
// corner analysis above, which needs no clipper at all. Revisit if a
// sound offset library is required (v4 cut paths may need one).

import { type Block, trackMoves } from "./parser.ts";

export interface RestRegion {
  /** Z depth of the pocket loop. */
  z: number;
  /** Loop area in mm^2. */
  loopArea: number;
  /** Number of concave corners contributing rest. */
  corners: number;
  /** Leftover area in mm^2 the finish tool must clear. */
  restArea: number;
  /** Previous tool diameter this was computed against. */
  prevDiameter: number;
}

export interface RestStats {
  loopsFound: number;
  regions: RestRegion[];
  totalRestArea: number;
}

export interface Loop {
  pts: [number, number][];
  z: number;
  area: number;
  ccw: boolean;
  /** Block-array index of the loop's first move (for v4 insertion). */
  startBi: number;
  /** Block-array index of the loop's last move (insertion point). */
  endBi: number;
}

function shoelace(pts: [number, number][]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    s += x0 * y1 - x1 * y0;
  }
  return s / 2;
}

/** Closed constant-Z G1 loops with area > 1mm^2. Arcs are skipped (v3). */
export function extractLoops(blocks: Block[]): Loop[] {
  const moves = trackMoves({ blocks });
  const blockIndex = new Map<Block, number>();
  blocks.forEach((b, i) => {
    if (!blockIndex.has(b)) blockIndex.set(b, i);
  });
  const loops: Loop[] = [];
  let run: typeof moves = [];
  let runZ = 0;
  const flush = () => {
    if (run.length >= 3) {
      const first = run[0].from;
      const last = run[run.length - 1].to;
      const closed =
        Math.hypot(last[0] - first[0], last[1] - first[1]) < 0.05 &&
        Math.abs(last[2] - first[2]) < 0.05;
      if (closed) {
        const pts = run.map((m) => [m.from[0], m.from[1]] as [number, number]);
        const signed = shoelace(pts);
        if (Math.abs(signed) > 1)
          loops.push({
            pts,
            z: runZ,
            area: Math.abs(signed),
            ccw: signed > 0,
            startBi: blockIndex.get(run[0].block) ?? -1,
            endBi: blockIndex.get(run[run.length - 1].block) ?? -1,
          });
      }
    }
    run = [];
  };
  for (const m of moves) {
    const isCut =
      m.block.motion === 1 &&
      Math.abs(m.to[0] - m.from[0]) + Math.abs(m.to[1] - m.from[1]) > 1e-9;
    const z = (m.from[2] + m.to[2]) / 2;
    if (!isCut || Math.abs(m.to[2] - m.from[2]) > 0.005) {
      flush();
      continue;
    }
    if (run.length > 0 && Math.abs(z - runZ) > 0.005) flush();
    if (run.length === 0) runZ = z;
    run.push(m);
  }
  flush();
  return loops;
}

/** Concave-corner frame shared by cornerRest and v4 path gen. */
export interface CornerGeom {
  /** Vertex XY. */
  v: [number, number];
  /** Unit vector away from V along the incoming edge. */
  u1: [number, number];
  /** Unit vector away from V along the outgoing edge. */
  u2: [number, number];
  /** Wedge half-angle in (0, pi/2). */
  beta: number;
}

function cornerFrame(
  prev: [number, number],
  p: [number, number],
  next: [number, number],
  ccw: boolean,
): CornerGeom | null {
  const e1x = p[0] - prev[0];
  const e1y = p[1] - prev[1];
  const e2x = next[0] - p[0];
  const e2y = next[1] - p[1];
  const l1 = Math.hypot(e1x, e1y);
  const l2 = Math.hypot(e2x, e2y);
  if (l1 < 1e-9 || l2 < 1e-9) return null;
  let turn = Math.atan2(e1x * e2y - e1y * e2x, e1x * e2x + e1y * e2y);
  if (!ccw) turn = -turn;
  // CCW frame: convex <=> turn > 0. Concave <=> turn < 0.
  if (turn >= -1e-9) return null;
  const beta = (Math.PI + turn) / 2; // wedge half-angle in (0, pi/2)
  if (beta < 0.05 || beta > Math.PI / 2 - 0.05) return null; // spike/collinear
  return {
    v: [p[0], p[1]],
    u1: [-e1x / l1, -e1y / l1],
    u2: [e2x / l2, e2y / l2],
    beta,
  };
}

/** Concave-corner frames for every rest-contributing vertex of a loop. */
export function cornerGeoms(loop: Loop): CornerGeom[] {
  const out: CornerGeom[] = [];
  const n = loop.pts.length;
  for (let i = 0; i < n; i++) {
    const g = cornerFrame(
      loop.pts[(i - 1 + n) % n],
      loop.pts[i],
      loop.pts[(i + 1) % n],
      loop.ccw,
    );
    if (g) out.push(g);
  }
  return out;
}

/** Corner leftover for one tool radius; 0 for convex/collinear vertices. */
function cornerRest(
  prev: [number, number],
  p: [number, number],
  next: [number, number],
  ccw: boolean,
  rp: number,
  rf: number,
): number {
  const g = cornerFrame(prev, p, next, ccw);
  if (!g) return 0;
  const leftover = (r: number) =>
    r * r * (1 / Math.tan(g.beta) - Math.PI / 2 + g.beta);
  return Math.max(0, leftover(rp) - leftover(rf));
}

/** Rest area of one loop. Synchronous; never throws. */
export function loopRest(
  loop: Loop,
  prevDiameter: number,
  finishDiameter: number,
): { restArea: number; corners: number } {
  if (prevDiameter <= finishDiameter) return { restArea: 0, corners: 0 };
  const rp = prevDiameter / 2;
  const rf = finishDiameter / 2;
  let rest = 0;
  let corners = 0;
  const n = loop.pts.length;
  for (let i = 0; i < n; i++) {
    const r = cornerRest(
      loop.pts[(i - 1 + n) % n],
      loop.pts[i],
      loop.pts[(i + 1) % n],
      loop.ccw,
      rp,
      rf,
    );
    if (r > 1e-9) {
      rest += r;
      corners++;
    }
  }
  return { restArea: Math.min(rest, loop.area), corners };
}

/** Rest analysis over the largest loops. Synchronous; never throws. */
export function analyzeRest(
  blocks: Block[],
  prevDiameter: number,
  finishDiameter = 1.0,
  maxLoops = 8,
): RestStats {
  const loops = extractLoops(blocks).sort((a, b) => b.area - a.area);
  const regions: RestRegion[] = [];
  for (const loop of loops.slice(0, maxLoops)) {
    const { restArea, corners } = loopRest(loop, prevDiameter, finishDiameter);
    if (restArea > 0.01) {
      regions.push({
        z: loop.z,
        loopArea: loop.area,
        corners,
        restArea,
        prevDiameter,
      });
    }
  }
  return {
    loopsFound: loops.length,
    regions,
    totalRestArea: regions.reduce((s, r) => s + r.restArea, 0),
  };
}
