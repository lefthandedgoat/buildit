// v2 — G2/G3 arc fitting for grbl (Shapeoko-class).
//
// Converts dense runs of short G1 segments (curves diced into confetti by
// CAM) back into IJK-center arcs within tolerance, so the planner can look
// ahead through arcs instead of choking on micro-segments.
//
// Safety rules (non-negotiable):
//   - Planar only: a run is split whenever Z drifts more than Z_EPS
//     (0.005 mm). Every emitted arc is constant-Z.
//   - IJK centers only, never R-word (avoids the >180° ambiguity).
//   - Max sweep 90° per emitted arc, so minor/major arc interpretation is
//     unambiguous by construction.
//   - Min sweep 5° and min arc length 0.3 mm: below that, G1 stays.
//   - Emitted blocks carry full explicit state (G-word, XYZ, IJ, F) so
//     downstream modal inheritance can never corrupt (v1 modal-repair
//     lesson).

import type { Block } from "./parser.ts";

export interface ArcFitOptions {
  /** Max deviation (mm) of any original point from a fitted arc.
   *  Split evenly: covered endpoints within tol/2 radially, every covered
   *  chord's sagitta within tol/2 — so chord midpoints (original polyline
   *  points too) stay within tol. See bestFrom. */
  tolerance: number;
}

export interface ArcFitStats {
  arcsEmitted: number;
  runsConsidered: number;
  /** Runs abandoned because Z varied within the run (3D slopes). */
  zSplitCount: number;
}

/** Max Z drift (mm) allowed inside one fittable run. */
export const Z_EPS = 0.005;
/** Minimum arc sweep: 5° in radians. */
export const MIN_SWEEP = (5 * Math.PI) / 180;
/** Maximum arc sweep per block: 90° — keeps minor/major unambiguous. */
export const MAX_SWEEP = (Math.PI / 2) * 0.999;
/** Minimum arc length in mm. */
export const MIN_ARC_LEN = 0.3;
/** Minimum circle radius in mm (rejects degenerate fits). */
export const MIN_RADIUS = 0.05;

export type XY = [number, number];
export type XYZ = [number, number, number];

export interface Circle {
  cx: number;
  cy: number;
  r: number;
}

/** Circumcenter of three points. Null when (near-)collinear. */
export function circleFrom3Points(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): Circle | null {
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = ax * ax + ay * ay;
  const b2 = bx * bx + by * by;
  const c2 = cx * cx + cy * cy;
  const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
  const uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
  const r = Math.hypot(ax - ux, ay - uy);
  if (!(r >= MIN_RADIUS) || !Number.isFinite(r)) return null;
  return { cx: ux, cy: uy, r };
}

/** Absolute deviation of a point from a circle. */
export function devFromCircle(px: number, py: number, c: Circle): number {
  return Math.abs(Math.hypot(px - c.cx, py - c.cy) - c.r);
}

/**
 * Signed sweep angle (radians, (-PI, PI]) from p0 to p1 about center.
 * Positive = counter-clockwise (G3), negative = clockwise (G2).
 */
export function signedSweep(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  cx: number,
  cy: number,
): number {
  const ax = x0 - cx;
  const ay = y0 - cy;
  const bx = x1 - cx;
  const by = y1 - cy;
  return Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
}

/** grbl motion code for travel from p0 to p1 about center. */
export function arcDirection(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  cx: number,
  cy: number,
): 2 | 3 {
  return signedSweep(x0, y0, x1, y1, cx, cy) > 0 ? 3 : 2;
}

/** Arc length from start point, end point, and incremental center. */
export function arcLenFromBlock(
  fx: number,
  fy: number,
  tx: number,
  ty: number,
  i: number,
  j: number,
): number {
  const cx = fx + i;
  const cy = fy + j;
  const r = (Math.hypot(fx - cx, fy - cy) + Math.hypot(tx - cx, ty - cy)) / 2;
  const sweep = Math.abs(signedSweep(fx, fy, tx, ty, cx, cy));
  return r * sweep;
}

export interface Run {
  blocks: Block[];
  /** Absolute positions: one more than blocks (start + one per block). */
  pts: XYZ[];
  feed: number;
  hasZ: boolean;
}

/** Absolute position of every motion block (shared helper). */
function absolutePositions(blocks: Block[]): Map<Block, XYZ> {
  const pos: XYZ = [0, 0, 0];
  const abs = new Map<Block, XYZ>();
  for (const b of blocks) {
    if (!b.passthrough && b.motion !== null) {
      if (b.coords.X !== undefined) pos[0] = b.coords.X;
      if (b.coords.Y !== undefined) pos[1] = b.coords.Y;
      if (b.coords.Z !== undefined) pos[2] = b.coords.Z;
      abs.set(b, [...pos]);
    }
  }
  return abs;
}

/**
 * Split blocks into maximal fittable G1 runs. A run breaks on: anything
 * that is not a plain G1 (passthrough, G0/G2/G3, misc words, IJK/R
 * words), a resolved feed VALUE change, or Z drift beyond Z_EPS.
 * Feed-setting (explicit-F) blocks may start and continue runs: unlike the
 * janitor, fitting never swallows an F word without re-emitting it — every
 * emitted arc carries explicitFeed with the run's feed. Single-block runs
 * are dropped (nothing to fit).
 */
export function splitRuns(blocks: Block[]): { runs: Run[]; zSplits: number } {
  const abs = absolutePositions(blocks);
  const runs: Run[] = [];
  let zSplits = 0;
  // Blocks of the open run plus absolute positions: afters[i] is the
  // position AFTER cur[i]; start is the position BEFORE cur[0] (the
  // after-position of the preceding motion block, or machine origin).
  // Getting this wrong shifts every fitted arc by one block of travel.
  let cur: Block[] = [];
  let start: XYZ = [0, 0, 0];
  let afters: XYZ[] = [];
  let curFeed = 0;
  let curZ = 0;
  let curHasZ = false;
  // After-position of the most recent motion block (any motion).
  let prevPos: XYZ = [0, 0, 0];
  const flush = () => {
    if (cur.length >= 2) {
      runs.push({
        blocks: [...cur],
        pts: [start, ...afters],
        feed: curFeed,
        hasZ: curHasZ,
      });
    }
    cur = [];
    afters = [];
  };
  for (const b of blocks) {
    const hasCoords =
      b.coords.X !== undefined ||
      b.coords.Y !== undefined ||
      b.coords.Z !== undefined;
    // Coordless explicit blocks (v4 modal restores) carry modal state, not
    // geometry: never absorb into a fit run, never drop — flush and pass.
    if (!hasCoords && !b.passthrough && b.motion !== null) {
      flush();
      continue;
    }
    const continuable =
      !b.passthrough &&
      b.motion === 1 &&
      b.misc.length === 0 &&
      b.coords.I === undefined &&
      b.coords.J === undefined &&
      b.coords.R === undefined;
    const p = !b.passthrough && b.motion !== null ? abs.get(b)! : null;
    if (continuable && p) {
      if (cur.length === 0) {
        curFeed = b.feed;
        curZ = p[2];
        curHasZ = b.coords.Z !== undefined;
        start = [...prevPos];
      } else if (b.feed !== curFeed || Math.abs(p[2] - curZ) > Z_EPS) {
        if (Math.abs(p[2] - curZ) > Z_EPS) zSplits++;
        flush();
        curFeed = b.feed;
        curZ = p[2];
        curHasZ = b.coords.Z !== undefined;
        start = [...prevPos];
      }
      if (b.coords.Z !== undefined) curHasZ = true;
      cur.push(b);
      afters.push([...p]);
    } else {
      flush();
    }
    if (p) prevPos = [...p];
  }
  flush();
  return { runs, zSplits };
}

interface Fit {
  end: number; // point index (exclusive coverage: points s..end)
  circle: Circle;
  dir: 2 | 3; // directed through the mid anchor (NOT the chord sign)
}

/**
 * Signed sweep from s through m to e about center. NaN when the three are
 * not consistently ordered (mid not on a single directed arc s->e) — the
 * cusp case: a circle can fit radial-wise while neither directed arc
 * covers mid. Emitting the chord-sign direction then cuts a shortcut.
 */
export function directedSweep(
  sx: number,
  sy: number,
  mx: number,
  my: number,
  ex: number,
  ey: number,
  cx: number,
  cy: number,
): number {
  const a = signedSweep(sx, sy, mx, my, cx, cy);
  const b = signedSweep(mx, my, ex, ey, cx, cy);
  if (a === 0 || b === 0) return NaN;
  if (Math.sign(a) !== Math.sign(b)) return NaN;
  return a + b;
}

/** Best (longest) valid arc starting at point s, or null. */
function bestFrom(pts: XYZ[], s: number, tol: number): Fit | null {
  let best: Fit | null = null;
  // Candidate end must leave room for the mid anchor: e >= s+2.
  for (let e = s + 2; e < pts.length; e++) {
    const m = (s + e) >> 1;
    if (m === s || m === e) continue;
    const c = circleFrom3Points(
      pts[s][0],
      pts[s][1],
      pts[m][0],
      pts[m][1],
      pts[e][0],
      pts[e][1],
    );
    if (!c) break; // locally straight: longer spans only get straighter
    // Covered endpoints within tol/2 radially ...
    const rtol = tol / 2;
    let ok = true;
    for (let k = s + 1; k < e; k++) {
      if (devFromCircle(pts[k][0], pts[k][1], c) > rtol) {
        ok = false;
        break;
      }
    }
    if (ok) {
      // ... and every covered chord's sagitta within tol/2. Endpoints
      // on-circle do not bound the chords between them: a 3.95mm chord
      // on an r=3.83 circle bulges 0.55 off the arc while both endpoints
      // verify clean (happy-w-1-16: viewer maxA 0.55, exact sagitta
      // match). Without this gate the fitter emits bowed arcs over
      // sparse chords and no endpoint check can catch them.
      // Range covers ALL covered segments s..e inclusive of the last:
      // the point loop above stops at e-1 (e is exactly on-circle),
      // but the final chord (e-1,e) bulges like any other.
      for (let k = s + 1; k <= e; k++) {
        const chord = Math.hypot(
          pts[k][0] - pts[k - 1][0],
          pts[k][1] - pts[k - 1][1],
        );
        const half = chord / 2;
        if (half >= c.r) {
          ok = false;
          break;
        }
        if (c.r - Math.sqrt(c.r * c.r - half * half) > rtol) {
          ok = false;
          break;
        }
      }
    }
    if (!ok) break; // deviation grows monotonically past the kink: stop
    // Mid must lie on the DIRECTED arc, not just the circle: chord-sign
    // direction would cut across cusps whose true path wraps the long way.
    const ds = directedSweep(
      pts[s][0],
      pts[s][1],
      pts[m][0],
      pts[m][1],
      pts[e][0],
      pts[e][1],
      c.cx,
      c.cy,
    );
    if (!Number.isFinite(ds)) break;
    const asweep = Math.abs(ds);
    if (asweep > MAX_SWEEP) break; // would wrap ambiguous: emit shorter
    best = { end: e, circle: c, dir: ds > 0 ? 3 : 2 };
  }
  if (!best) return null;
  // Directed total sweep through mid (best.end was validated above).
  const m = (s + best.end) >> 1;
  const ds = directedSweep(
    pts[s][0],
    pts[s][1],
    pts[m][0],
    pts[m][1],
    pts[best.end][0],
    pts[best.end][1],
    best.circle.cx,
    best.circle.cy,
  );
  const sweep = Number.isFinite(ds) ? Math.abs(ds) : Infinity;
  if (sweep < MIN_SWEEP) return null;
  if (best.circle.r * sweep < MIN_ARC_LEN) return null;
  return best;
}

/**
 * Greedy arc fitting over G1 blocks. Returns a NEW array; input untouched.
 * Original blocks not covered by an emitted arc pass through unchanged.
 */
export function fitArcs(
  blocks: Block[],
  opts: ArcFitOptions,
): { blocks: Block[]; stats: ArcFitStats } {
  const tol = opts.tolerance;
  const { runs, zSplits } = splitRuns(blocks);
  const coveredToArc = new Map<Block, Block>();
  const drop = new Set<Block>();
  let emitted = 0;

  for (const run of runs) {
    const { pts } = run;
    let s = 0;
    while (s < pts.length - 1) {
      const fit = bestFrom(pts, s, tol);
      if (!fit) {
        s++;
        continue;
      }
      const p0 = pts[s];
      const p1 = pts[fit.end];
      // Direction through the mid anchor (fit.dir), never the chord sign:
      // chord direction cuts across cusps. See directedSweep.
      const dir = fit.dir;
      const coords: Block["coords"] = {
        X: p1[0],
        Y: p1[1],
        I: fit.circle.cx - p0[0],
        J: fit.circle.cy - p0[1],
      };
      if (run.hasZ) coords.Z = p1[2];
      const first = run.blocks[s];
      const arc: Block = {
        line: first.line,
        raw: "",
        passthrough: false,
        motion: dir,
        explicitMotion: true,
        coords,
        explicitFeed: true,
        feed: run.feed,
        misc: [],
      };
      // Arc replaces blocks s..fit.end-1; anchor the emitted block on the
      // first covered block's slot to preserve program order.
      coveredToArc.set(run.blocks[s], arc);
      for (let k = s + 1; k < fit.end; k++) drop.add(run.blocks[k]);
      emitted++;
      s = fit.end;
    }
  }

  const out = blocks
    .filter((b) => !drop.has(b))
    .map((b) => coveredToArc.get(b) ?? b);
  return {
    blocks: out,
    stats: {
      arcsEmitted: emitted,
      runsConsidered: runs.length,
      zSplitCount: zSplits,
    },
  };
}
