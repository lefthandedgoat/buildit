// --check min-feature audit (report only, never modifies geometry).
//
// Flags cut features finer than a given tool diameter, so missing detail
// is caught before carving instead of after. Three exact checks over the
// post-janitor stream (same domain as the v3 rest analysis — closed
// constant-Z G1 loops; deliberately no general polygon clipper):
//
//   1. narrow channels: min distance between non-adjacent edges of one
//      loop (segment-segment exact: min of 4 point-segment distances;
//      shared endpoints skipped). Under toolD the tool body cannot pass.
//      Same-loop pairs only: wall-to-outside gaps are stock, not
//      channels — cross-loop pairing would false-positive. Documented
//      limitation: island-to-wall gaps are not audited (v4.2 rest has
//      the same pocket-interior scope).
//   2. tiny input arcs: G2/G3 with radius under toolR (center from IJ).
//      Rare in CC input, trivial to check, catastrophic to miss.
//   3. corner residue (needs --check-prev): per concave corner wedge
//      (rp^2-rf^2)(cot b-pi/2+b), flagged above 0.01mm^2 — the same
//      epsilon v4 declines unfinishable micro-rest at. Answers "will my
//      finish bit clean this, or do I owe a detail pass / hand work?"
//      Skipped when prev <= finish (nothing to leave behind).

import { type Block, trackMoves } from "./parser.ts";
import {
  type CornerGeom,
  type Loop,
  cornerGeoms,
  extractLoops,
} from "./rest2d.ts";

export interface CheckOptions {
  /** Finish/detail tool diameter under audit. */
  toolDiameter: number;
  /** Rough tool diameter for corner residue. Omit to skip check 3. */
  prevDiameter?: number;
  /** Residue area threshold per corner. Default 0.01mm^2. */
  residueEps?: number;
}

export interface ChannelHit {
  loopZ: number;
  /** Narrowest gap in mm. */
  width: number;
  /** Midpoint of the narrowest edge pair. */
  at: [number, number];
}

export interface TinyArcHit {
  /** Arc radius in mm. */
  r: number;
  at: [number, number];
}

export interface CornerHit {
  loopZ: number;
  /** Inside angle in degrees (90 = square corner). */
  angleDeg: number;
  /** Residue area in mm^2 after the finish tool. */
  residue: number;
  at: [number, number];
}

export interface CheckResult {
  channels: ChannelHit[];
  tinyArcs: TinyArcHit[];
  corners: CornerHit[];
  loopsFound: number;
  /** True when every check is clean. */
  clean: boolean;
}

type Pt = [number, number];

function distToSeg(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Exact min distance between two segments (non-intersecting case). */
function segSeg(a: Pt, b: Pt, c: Pt, d: Pt): number {
  return Math.min(
    distToSeg(a, c, d),
    distToSeg(b, c, d),
    distToSeg(c, a, b),
    distToSeg(d, a, b),
  );
}

function mid(a: Pt, b: Pt): Pt {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

/** Per-corner residue of finish tool rf after rough tool rp (mm^2). */
export function cornerResidue(g: CornerGeom, rp: number, rf: number): number {
  if (rp <= rf) return 0;
  return (rp * rp - rf * rf) * (1 / Math.tan(g.beta) - Math.PI / 2 + g.beta);
}

export function auditBlocks(blocks: Block[], opts: CheckOptions): CheckResult {
  const rf = opts.toolDiameter / 2;
  const eps = opts.residueEps ?? 0.01;
  const channels: ChannelHit[] = [];
  const tinyArcs: TinyArcHit[] = [];
  const corners: CornerHit[] = [];

  const loops: Loop[] = extractLoops(blocks);

  for (const loop of loops) {
    const pts = loop.pts;
    const n = pts.length;
    if (n < 4) continue;
    // Check 1: narrowest non-adjacent edge pair in this loop.
    let best = Infinity;
    let bestAt: Pt = [0, 0];
    for (let i = 0; i < n; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      for (let j = i + 2; j < n; j++) {
        // Skip pairs sharing an endpoint (adjacent + first/last wrap).
        if (i === 0 && j === n - 1) continue;
        const c = pts[j];
        const d = pts[(j + 1) % n];
        const w = segSeg(a, b, c, d);
        if (w < best) {
          best = w;
          bestAt = mid(mid(a, b), mid(c, d));
        }
      }
    }
    if (best < opts.toolDiameter) {
      channels.push({ loopZ: loop.z, width: best, at: bestAt });
    }
    // Check 3: corner residue (only with a real rough tool).
    if (opts.prevDiameter !== undefined && opts.prevDiameter > 0) {
      const rp = opts.prevDiameter / 2;
      if (rp > rf) {
        for (const g of cornerGeoms(loop)) {
          const residue = cornerResidue(g, rp, rf);
          if (residue > eps) {
            // Inside angle is twice the wedge half-angle (90-degree
            // corner <=> beta pi/4, flat wall <=> beta pi/2).
            corners.push({
              loopZ: loop.z,
              angleDeg: (2 * g.beta * 180) / Math.PI,
              residue,
              at: [g.v[0], g.v[1]],
            });
          }
        }
      }
    }
  }

  // Check 2: input arcs tighter than the tool radius.
  for (const m of trackMoves({ blocks })) {
    const b = m.block;
    if (b.motion !== 2 && b.motion !== 3) continue;
    const { I, J } = b.coords;
    if (I === undefined || J === undefined) continue;
    const r = Math.hypot(I, J);
    if (r < rf) tinyArcs.push({ r, at: [m.to[0], m.to[1]] });
  }

  return {
    channels,
    tinyArcs,
    corners,
    loopsFound: loops.length,
    clean:
      channels.length === 0 && tinyArcs.length === 0 && corners.length === 0,
  };
}
