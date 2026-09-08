// Cycle-time models: naive (distance / feed, i.e. what Carbide Create's
// estimator reports) and accel-aware trapezoidal per block (what the
// machine actually does on segmented 3D paths).

import { type Program, trackMoves } from "./parser.ts";
import { arcLenFromBlock } from "./arcs.ts";

export interface EstimateOptions {
  /** Axis acceleration in mm/s^2. Shapeoko-class default: 400. */
  accel: number;
  /** Rapid traverse rate in mm/min for G0 blocks. Default 5000. */
  rapidRate: number;
}

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

export function estimate(prog: Program, opts: EstimateOptions): Estimate {
  const moves = trackMoves(prog);
  let naive = 0;
  let accel = 0;
  let g0 = 0;
  let g1 = 0;
  let arcs = 0;
  let under02 = 0;
  for (const m of moves) {
    const feed = m.block.motion === 0 ? opts.rapidRate : m.block.feed;
    let dist = m.dist;
    if (m.block.motion === 0) {
      g0++;
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
      continue;
    }
    if (feed > 0 && dist > 0) {
      naive += dist / (feed / 60);
      accel += blockTime(dist, feed, opts.accel);
    }
  }
  return {
    g0Blocks: g0,
    g1Blocks: g1,
    arcBlocks: arcs,
    g1Under02mm: under02,
    naiveMin: naive / 60,
    accelMin: accel / 60,
  };
}
