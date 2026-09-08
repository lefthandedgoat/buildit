// Cycle-time models: naive (distance / feed, i.e. what Carbide Create's
// estimator reports) and accel-aware trapezoidal (stop-to-stop per block
// by default, the stopwatch-calibrated behavior; grbl-style
// junction-deviation blending is opt-in via EstimateOptions).

import { type Program, trackMoves } from "./parser.ts";
import { arcLenFromBlock } from "./arcs.ts";

export interface EstimateOptions {
  /** Axis acceleration in mm/s^2. Shapeoko-class default: 400. */
  accel: number;
  /** Rapid traverse rate in mm/min for G0 blocks. Default 5000. */
  rapidRate: number;
  /**
   * Junction deviation in mm (grbl $11 style): how far the planner may
   * round a corner to carry speed through the junction. Default 0, the
   * stopwatch-calibrated legacy: every cutting block runs stop-to-stop,
   * exactly as before blending existed. Pass an explicit value (grbl
   * stock is 0.010, exported as DEFAULT_JUNCTION_DEVIATION) to opt in;
   * larger values brake less and move the estimate toward naive.
   * Measured on dense raster: opt-in 0.010 collapses the shark finish
   * 54.0 -> 39.1 min against a 54-min stopwatch, so blending stays
   * opt-in. Rapids (G0) always stay stop-to-stop.
   */
  junctionDeviation?: number;
}

/** Grbl $11 stock value: the documented opt-in for blending. */
export const DEFAULT_JUNCTION_DEVIATION = 0.01;

export interface Estimate {
  g0Blocks: number;
  g1Blocks: number;
  /** G2/G3 blocks (v2 arcs). Time uses true arc length, not chord. */
  arcBlocks: number;
  g1Under02mm: number;
  /** Naive minutes (distance / programmed feed). */
  naiveMin: number;
  /** Accel-aware minutes. */
  accelMin: number;
}

/** Time in seconds for one block of length `dist` at feed `v` with accel `a`. */
export function blockTime(
  dist: number,
  feedMmMin: number,
  accelMmS2: number,
): number {
  if (dist <= 0 || feedMmMin <= 0 || accelMmS2 <= 0) return 0;
  const v = feedMmMin / 60;
  const dAcc = (v * v) / accelMmS2; // distance for full accel+decel triangle
  if (dAcc >= dist) return 2 * Math.sqrt(dist / accelMmS2); // triangular profile
  return (dist - dAcc) / v + (2 * v) / accelMmS2; // trapezoidal profile
}

/**
 * Max junction velocity in mm/s, grbl planner form: the corner speed at
 * which centripetal accel for deviation `jdMm` matches axis `accelMmS2`.
 *
 * `dot` is the unit dot product of the incoming and outgoing cut
 * direction vectors (+1 straight, 0 square corner, -1 full reversal).
 * `vCapMmS` caps the answer at the slower adjacent feed. Returns 0 on
 * reversal or non-positive accel/deviation (full stop = legacy path).
 */
export function junctionSpeed(
  dot: number,
  accelMmS2: number,
  jdMm: number,
  vCapMmS: number,
): number {
  if (!(accelMmS2 > 0) || !(jdMm > 0) || !(vCapMmS > 0)) return 0;
  if (!Number.isFinite(dot)) return 0;
  // grbl junction cos(theta) = -dot(prev, next): -1 straight, +1 reversal.
  const c = Math.min(1, Math.max(-1, -dot));
  if (c < -0.999999) return vCapMmS; // straight enough: no junction limit
  const sinHalf = Math.sqrt(0.5 * (1 - c)); // sin(theta/2)
  if (!(sinHalf > 1e-9) || sinHalf >= 1) return 0;
  return Math.min(
    vCapMmS,
    Math.sqrt((accelMmS2 * jdMm * sinHalf) / (1 - sinHalf)),
  );
}

/**
 * Time in seconds for one block of length `dist` with entry speed `v0`
 * and exit speed `v1` (mm/s), capped at the block feed `vmax`. Reduces
 * to {@link blockTime} when v0 = v1 = 0. Higher entry/exit never takes
 * longer: blending only removes the full-stop penalty, never adds one.
 */
export function blockTimeWithEntry(
  dist: number,
  v0MmS: number,
  v1MmS: number,
  feedMmMin: number,
  accelMmS2: number,
): number {
  if (dist <= 0 || feedMmMin <= 0 || accelMmS2 <= 0) return 0;
  const vmax = feedMmMin / 60;
  const v0 = Math.min(Math.max(v0MmS, 0), vmax);
  const v1 = Math.min(Math.max(v1MmS, 0), vmax);
  const dAcc = (vmax * vmax - v0 * v0) / (2 * accelMmS2);
  const dDec = (vmax * vmax - v1 * v1) / (2 * accelMmS2);
  if (dAcc + dDec <= dist) {
    return (
      (vmax - v0) / accelMmS2 +
      (vmax - v1) / accelMmS2 +
      (dist - dAcc - dDec) / vmax
    );
  }
  const vp = Math.sqrt((2 * accelMmS2 * dist + v0 * v0 + v1 * v1) / 2);
  return (vp - v0) / accelMmS2 + (vp - v1) / accelMmS2;
}

export function estimate(prog: Program, opts: EstimateOptions): Estimate {
  const moves = trackMoves(prog);
  const jd = opts.junctionDeviation === undefined ? 0 : opts.junctionDeviation;
  let naive = 0;
  let accel = 0;
  let g0 = 0;
  let g1 = 0;
  let arcs = 0;
  let under02 = 0;
  // One maximal run of consecutive cutting blocks blended together.
  // Directions are chord unit vectors (arcs use chord, ~tangent for
  // short blocks); the run stops at rapids, feed/position gaps, and
  // program ends, where the machine really does stop.
  let run: { dist: number; feed: number; dir: [number, number, number] }[] = [];
  const flushRun = () => {
    if (run.length === 0) return;
    const n = run.length;
    if (!(opts.accel > 0) || !(jd > 0) || n === 1) {
      for (const b of run) accel += blockTime(b.dist, b.feed, opts.accel);
      run = [];
      return;
    }
    const vMax = run.map((b) => b.feed / 60);
    // Interior node caps from junction geometry, 0 at both run ends.
    const node: number[] = Array(n + 1).fill(0);
    for (let k = 1; k < n; k++) {
      const dot =
        run[k - 1].dir[0] * run[k].dir[0] +
        run[k - 1].dir[1] * run[k].dir[1] +
        run[k - 1].dir[2] * run[k].dir[2];
      node[k] = junctionSpeed(
        dot,
        opts.accel,
        jd,
        Math.min(vMax[k - 1], vMax[k]),
      );
    }
    // Forward/backward accel passes: no node faster than its neighbor
    // plus what fits in the block between them.
    for (let i = 0; i < n; i++) {
      node[i + 1] = Math.min(
        node[i + 1],
        Math.sqrt(node[i] * node[i] + 2 * opts.accel * run[i].dist),
      );
    }
    for (let i = n - 1; i >= 0; i--) {
      node[i] = Math.min(
        node[i],
        Math.sqrt(node[i + 1] * node[i + 1] + 2 * opts.accel * run[i].dist),
      );
    }
    for (let i = 0; i < n; i++) {
      const blended = blockTimeWithEntry(
        run[i].dist,
        node[i],
        node[i + 1],
        run[i].feed,
        opts.accel,
      );
      // Float guard for the core invariant: blending removes the
      // full-stop penalty, so it can never exceed stop-to-stop.
      accel += Math.min(
        blended,
        blockTime(run[i].dist, run[i].feed, opts.accel),
      );
    }
    run = [];
  };
  for (const m of moves) {
    const feed = m.block.motion === 0 ? opts.rapidRate : m.block.feed;
    let dist = m.dist;
    if (m.block.motion === 0) {
      g0++;
      flushRun();
    } else if (m.block.motion === 1) {
      g1++;
      if (m.dist < 0.2) under02++;
    } else if (m.block.motion === 2 || m.block.motion === 3) {
      // True arc length from IJK center; fall back to chord without it.
      arcs++;
      const { I, J } = m.block.coords;
      if (I !== undefined && J !== undefined) {
        dist = arcLenFromBlock(m.from[0], m.from[1], m.to[0], m.to[1], I, J);
      }
    } else {
      flushRun();
      continue;
    }
    if (feed > 0 && dist > 0) {
      naive += dist / (feed / 60);
      if (m.block.motion === 0) {
        // Rapids stay stop-to-stop: traverse endpoints really do stop.
        accel += blockTime(dist, feed, opts.accel);
      } else {
        const dx = m.to[0] - m.from[0];
        const dy = m.to[1] - m.from[1];
        const dz = m.to[2] - m.from[2];
        const len = Math.hypot(dx, dy, dz);
        if (len > 0) {
          run.push({
            dist,
            feed,
            dir: [dx / len, dy / len, dz / len],
          });
        } else {
          // Degenerate chord (e.g. full-circle arc): no direction to
          // blend, so time it isolated stop-to-stop exactly as legacy.
          flushRun();
          accel += blockTime(dist, feed, opts.accel);
        }
      }
    } else {
      // Zero feed or zero distance carries no time and no direction:
      // conservative run break (full stop), same as legacy.
      flushRun();
    }
  }
  flushRun();
  return {
    g0Blocks: g0,
    g1Blocks: g1,
    arcBlocks: arcs,
    g1Under02mm: under02,
    naiveMin: naive / 60,
    accelMin: accel / 60,
  };
}
