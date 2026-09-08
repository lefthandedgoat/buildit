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
//
// Two further readouts are REPORT-ONLY (advisory, never graded): they
// add new diagnostics fields without touching the three verdicts above,
// `clean`, or the CLI exit code.
//
//   4. waist-vs-fold separation: same-loop narrow pairs that persist
//      over extended parallel wall (loop-separation >= 8 edges each way
//      on dense loops kills i/i+2 fold artifacts; opposing walls must
//      run antiparallel and stay narrow over >= one tool diameter of
//      wall; loops smaller than the tool footprint read as pinholes,
//      not waists). Gated by toolD like check 1.
//   5. island candidates: strictly-nested same-Z OPP-winding pairs
//      (centroid + every vertex inside) with moat width under toolD,
//      compactness and corridor gates rejecting linked-pass slivers.

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

export interface WaistHit {
  loopZ: number;
  /** Persistent waist width in mm (under toolD). */
  width: number;
  /** Narrow wall length in mm (antiparallel run under toolD). */
  runMM: number;
  /** Midpoint of the narrowest persistent edge pair. */
  at: [number, number];
}

export interface IslandHit {
  loopZ: number;
  /** Narrowest moat gap between island and outer wall, mm. */
  moat: number;
  /** Island loop area in mm^2. */
  innerArea: number;
  /** Containing loop area in mm^2. */
  outerArea: number;
  /** Island compactness 4*pi*A/P^2 (1 = circle). */
  compactness: number;
  /** Moat corridor P*moat/A (ring-area upper-bound ratio). */
  corridor: number;
  /** Island centroid. */
  at: [number, number];
}

export interface CheckResult {
  channels: ChannelHit[];
  tinyArcs: TinyArcHit[];
  corners: CornerHit[];
  /** Report-only waist readout (never graded). */
  waists: WaistHit[];
  /** Report-only island-candidate readout (never graded). */
  islands: IslandHit[];
  loopsFound: number;
  /** True when every graded check is clean (waists/islands excluded). */
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

/** Cosine between directed edges a->b and c->d (1 = parallel). */
function edgeCos(a: Pt, b: Pt, c: Pt, d: Pt): number {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const vx = d[0] - c[0];
  const vy = d[1] - c[1];
  const lu = Math.hypot(ux, uy);
  const lv = Math.hypot(vx, vy);
  if (lu < 1e-9 || lv < 1e-9) return 1;
  return (ux * vx + uy * vy) / (lu * lv);
}

function edgeLen(a: Pt, b: Pt): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

function insidePoly(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (
      yi > p[1] !== yj > p[1] &&
      p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi
    )
      inside = !inside;
  }
  return inside;
}

function centroid(pts: Pt[]): Pt {
  let x = 0;
  let y = 0;
  for (const [px, py] of pts) {
    x += px;
    y += py;
  }
  return [x / pts.length, y / pts.length];
}

function perim(pts: Pt[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++)
    s += edgeLen(pts[i], pts[(i + 1) % pts.length]);
  return s;
}

/** Min segment-segment distance between two loops (moat width). */
function loopDist(a: Pt[], b: Pt[]): number {
  let d = Infinity;
  for (let i = 0; i < a.length; i++)
    for (let j = 0; j < b.length; j++)
      d = Math.min(
        d,
        segSeg(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length]),
      );
  return d;
}

/**
 * Report-only waist readout: narrow pairs that persist over extended
 * parallel wall. Fold artifacts of faceted curves are i/i+2 kinks, so
 * dense loops (n >= 20) require loop-separation >= 8 edges each way;
 * small loops (synthetic slots) use >= 2. Candidate pairs must run
 * antiparallel (cos <= -0.5) and stay under toolD over >= one tool
 * diameter of wall; loops smaller than the tool footprint are pinholes.
 */
function waistHits(loops: Loop[], toolD: number): WaistHit[] {
  const out: WaistHit[] = [];
  const rf = toolD / 2;
  const footprint = Math.PI * rf * rf;
  for (const loop of loops) {
    const pts = loop.pts;
    const n = pts.length;
    if (n < 4) continue;
    if (loop.area < footprint) continue;
    const minSep = n >= 20 ? 8 : 2;
    // Narrowest antiparallel sep-gated pair.
    let best = Infinity;
    let bi = -1;
    let bj = -1;
    for (let i = 0; i < n; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      for (let j = 0; j < n; j++) {
        const fwd = (j - i + n) % n;
        const bwd = n - fwd;
        if (fwd < minSep || bwd < minSep) continue;
        if (edgeCos(a, b, pts[j], pts[(j + 1) % n]) > -0.5) continue;
        const w = segSeg(a, b, pts[j], pts[(j + 1) % n]);
        if (w < best) {
          best = w;
          bi = i;
          bj = j;
        }
      }
    }
    if (!(best < toolD)) continue;
    // Persistence: antiparallel run around (bi, bj) staying narrow.
    const narrow = (u: number, v: number): boolean => {
      if (u === v) return false;
      const fwd = (v - u + n) % n;
      const bwd = n - fwd;
      if (fwd < minSep || bwd < minSep) return false;
      return segSeg(pts[u], pts[(u + 1) % n], pts[v], pts[(v + 1) % n]) < toolD;
    };
    let runMM = 0;
    for (let t = 0; t < n / 2; t++) {
      const u = (bi + t) % n;
      const v = (((bj - t) % n) + n) % n;
      if (!narrow(u, v)) break;
      runMM += edgeLen(pts[u], pts[(u + 1) % n]);
    }
    for (let t = 1; t < n / 2; t++) {
      const u = (((bi - t) % n) + n) % n;
      const v = (bj + t) % n;
      if (!narrow(u, v)) break;
      runMM += edgeLen(pts[u], pts[(u + 1) % n]);
    }
    if (runMM < toolD) continue;
    out.push({
      loopZ: loop.z,
      width: best,
      runMM,
      at: mid(mid(pts[bi], pts[(bi + 1) % n]), mid(pts[bj], pts[(bj + 1) % n])),
    });
  }
  return out;
}

/**
 * Report-only island candidates: strictly-nested same-Z OPP-winding
 * pairs with moat under toolD. Same-winding nested pairs are stepover
 * offsets of linked passes, not islands. Compactness rejects thin
 * linked-pass slivers; the corridor cap rejects absurd moat rings;
 * the 0.05mm moat floor is the loop-closure epsilon (touching passes).
 */
function islandHits(loops: Loop[], toolD: number): IslandHit[] {
  const out: IslandHit[] = [];
  const rf = toolD / 2;
  const footprint = Math.PI * rf * rf;
  const bands = new Map<string, Loop[]>();
  for (const l of loops) {
    const key = l.z.toFixed(2);
    const g = bands.get(key);
    if (g) g.push(l);
    else bands.set(key, [l]);
  }
  for (const g of bands.values()) {
    if (g.length < 2) continue;
    for (let i = 0; i < g.length; i++) {
      for (let j = 0; j < g.length; j++) {
        if (i === j) continue;
        const inner = g[i];
        const outer = g[j];
        if (inner.area >= outer.area) continue;
        if (inner.ccw === outer.ccw) continue;
        const c = centroid(inner.pts);
        if (!insidePoly(c, outer.pts)) continue;
        if (!inner.pts.every((p) => insidePoly(p, outer.pts))) continue;
        const moat = loopDist(inner.pts, outer.pts);
        if (!(moat < toolD) || moat < 0.05) continue;
        if (inner.area < footprint) continue;
        const P = perim(inner.pts);
        if (P < 1e-9) continue;
        const compact = (4 * Math.PI * inner.area) / (P * P);
        if (compact < 0.5) continue;
        const corridor = (P * moat) / inner.area;
        if (corridor > 8) continue;
        out.push({
          loopZ: outer.z,
          moat,
          innerArea: inner.area,
          outerArea: outer.area,
          compactness: compact,
          corridor,
          at: [c[0], c[1]],
        });
      }
    }
  }
  return out;
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
    waists: waistHits(loops, opts.toolDiameter),
    islands: islandHits(loops, opts.toolDiameter),
    loopsFound: loops.length,
    clean:
      channels.length === 0 && tinyArcs.length === 0 && corners.length === 0,
  };
}
