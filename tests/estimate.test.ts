import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "../src/parser.ts";
import {
  blockTime,
  blockTimeWithEntry,
  DEFAULT_JUNCTION_DEVIATION,
  estimate,
  junctionSpeed,
} from "../src/estimate.ts";

import { CORPUS } from "./corpus.ts";
const SHARK = join(CORPUS, "shark-bottom-finish-fine.c2d.nc");
const HALF_MIL = join(CORPUS, "happy-w-half-mil.c2d.nc");

const ACCEL = 400;
const FEED = 450; // mm/min -> 7.5 mm/s
const V = FEED / 60;

/** G-code for a straight run of `n` collinear segments of `step` mm. */
function straightGcode(n: number, step: number): string {
  const lines = ["G21 G90"];
  for (let i = 1; i <= n; i++) {
    const x = (i * step).toFixed(4);
    lines.push(i === 1 ? `G1 X${x} F${FEED}` : `X${x}`);
  }
  return lines.join("\n");
}

describe("blockTime", () => {
  it("is triangular for short blocks", () => {
    // v=7.5mm/s, d_acc = 56.25/400 = 0.14mm > 0.05 -> triangular
    const t = blockTime(0.05, 450, 400);
    assert.ok(Math.abs(t - 2 * Math.sqrt(0.05 / 400)) < 1e-9);
  });

  it("is trapezoidal for long blocks", () => {
    const t = blockTime(10, 450, 400);
    const v = 7.5;
    const expected = (10 - (v * v) / 400) / v + (2 * v) / 400;
    assert.ok(Math.abs(t - expected) < 1e-9);
  });

  it("accel-aware time always >= naive time", () => {
    for (const d of [0.01, 0.1, 0.5, 2, 20]) {
      assert.ok(blockTime(d, 450, 400) >= d / 7.5 - 1e-9);
    }
  });
});

describe("junctionSpeed", () => {
  it("is uncapped at the slower feed on a straight junction", () => {
    assert.equal(junctionSpeed(1, ACCEL, 0.01, V), V);
    assert.equal(junctionSpeed(1, ACCEL, 0.01, 2), 2);
  });

  it("matches the hand-computed grbl value for a square corner", () => {
    // sqrt(a*d*sin(45)/(1-sin(45))) = sqrt(400*0.01*0.70711/0.29289)
    const vj = junctionSpeed(0, ACCEL, 0.01, V);
    assert.ok(Math.abs(vj - 3.1075) < 0.01, `vj=${vj}`);
    assert.ok(vj < V);
  });

  it("respects a slower adjacent feed cap", () => {
    assert.equal(junctionSpeed(0, ACCEL, 0.01, 1), 1);
  });

  it("is a full stop on reversal or degenerate params", () => {
    assert.equal(junctionSpeed(-1, ACCEL, 0.01, V), 0);
    assert.equal(junctionSpeed(0, ACCEL, 0, V), 0);
    assert.equal(junctionSpeed(0, 0, 0.01, V), 0);
    assert.equal(junctionSpeed(0, ACCEL, 0.01, 0), 0);
  });
});

describe("blockTimeWithEntry", () => {
  it("reduces to blockTime for a full stop entry and exit", () => {
    for (const d of [0.05, 0.3, 10]) {
      const a = blockTimeWithEntry(d, 0, 0, FEED, ACCEL);
      assert.ok(Math.abs(a - blockTime(d, FEED, ACCEL)) < 1e-12, `d=${d}`);
    }
  });

  it("is pure cruise when entering and exiting at feed", () => {
    assert.ok(
      Math.abs(blockTimeWithEntry(3, V, V, FEED, ACCEL) - 3 / V) < 1e-12,
    );
  });

  it("never takes longer with higher entry/exit speeds", () => {
    const stopped = blockTimeWithEntry(0.3, 0, 0, FEED, ACCEL);
    const rolling = blockTimeWithEntry(0.3, V, V, FEED, ACCEL);
    const partial = blockTimeWithEntry(0.3, 0, V / 2, FEED, ACCEL);
    assert.ok(rolling < partial && partial < stopped);
  });
});

describe("dense-path blending (falsifying test)", () => {
  // 50 x 0.3mm collinear segments = 15mm at 7.5mm/s.
  // Hand-computed blended bound: ideal cruise (15/7.5) + both end ramps
  // (2*7.5/400) + 0.2s slack. A stop-to-stop model cannot beat it; a
  // blending model must.
  const N = 50;
  const STEP = 0.3;
  const TOTAL = N * STEP;
  const BOUND_SEC = TOTAL / V + (2 * V) / ACCEL + 0.2;
  // Legacy stop-to-stop total: 50 * blockTime(0.3) = 2.9375s > bound.
  const LEGACY_SEC = N * blockTime(STEP, FEED, ACCEL);
  assert.ok(LEGACY_SEC > BOUND_SEC, "test bug: bound must falsify legacy");

  it("legacy default exceeds the hand-computed blended bound", () => {
    const prog = parse(straightGcode(N, STEP));
    const est = estimate(prog, { accel: ACCEL, rapidRate: 5000 });
    assert.ok(
      est.accelMin * 60 > BOUND_SEC,
      `legacy=${est.accelMin * 60} bound=${BOUND_SEC}`,
    );
  });

  it("opt-in blending beats the bound while naive stays bit-identical", () => {
    const prog = parse(straightGcode(N, STEP));
    const legacy = estimate(prog, { accel: ACCEL, rapidRate: 5000 });
    const blended = estimate(prog, {
      accel: ACCEL,
      rapidRate: 5000,
      junctionDeviation: DEFAULT_JUNCTION_DEVIATION,
    });
    assert.equal(blended.naiveMin, legacy.naiveMin);
    assert.ok(
      Math.abs(blended.naiveMin * 60 - TOTAL / V) < 1e-9,
      `naive=${blended.naiveMin * 60}`,
    );
    assert.ok(
      blended.accelMin * 60 < BOUND_SEC,
      `blended=${blended.accelMin * 60} bound=${BOUND_SEC}`,
    );
    assert.ok(blended.accelMin < legacy.accelMin);
    assert.ok(blended.accelMin >= blended.naiveMin);
  });

  it("explicit jd=0 reproduces the legacy default exactly", () => {
    const prog = parse(straightGcode(N, STEP));
    const def = estimate(prog, { accel: ACCEL, rapidRate: 5000 });
    const zero = estimate(prog, {
      accel: ACCEL,
      rapidRate: 5000,
      junctionDeviation: 0,
    });
    assert.equal(zero.accelMin, def.accelMin);
    assert.equal(zero.naiveMin, def.naiveMin);
  });

  it("sharp corners blend slower than straights but faster than stops", () => {
    // Two 0.3mm legs: straight (X0.3, X0.6) vs 90-degree (X0.3, Y0.3).
    const straight = parse("G21 G90\nG1 X0.3 F450\nX0.6");
    const corner = parse("G21 G90\nG1 X0.3 F450\nX0.3 Y0.3");
    const opt = {
      accel: ACCEL,
      rapidRate: 5000,
      junctionDeviation: DEFAULT_JUNCTION_DEVIATION,
    };
    const legStop = estimate(straight, { accel: ACCEL, rapidRate: 5000 });
    const legBlend = estimate(straight, opt).accelMin;
    const cornerBlend = estimate(corner, opt).accelMin;
    const naive = estimate(straight, opt).naiveMin;
    assert.ok(legBlend < legStop.accelMin, "blending helps straights");
    assert.ok(cornerBlend < legStop.accelMin, "blending helps corners");
    assert.ok(cornerBlend > legBlend, "corners brake vs straights");
    assert.ok(legBlend >= naive, "blended stays above naive");
    assert.equal(estimate(corner, opt).naiveMin, naive);
  });
});

describe("rapids stay stop-to-stop under opt-in blending", () => {
  const OPT = {
    accel: ACCEL,
    rapidRate: 5000,
    junctionDeviation: DEFAULT_JUNCTION_DEVIATION,
  };
  // Left run, rapid traverse, right run: identical geometry to the
  // full program below, so the decomposition is exact.
  const LEFT = "G21 G90\nG1 X0.3 F450\nX0.6\nX0.9";
  const RIGHT = "G21 G90\nG0 X10\nG1 X10.3 F450\nX10.6\nX10.9";
  const FULL =
    "G21 G90\nG1 X0.3 F450\nX0.6\nX0.9\nG0 X10\nG1 X10.3\nX10.6\nX10.9";
  const RAPID_DIST = 10 - 0.9;

  it("a G0 separates blended runs and costs exactly blockTime", () => {
    const left = estimate(parse(LEFT), OPT).accelMin * 60;
    const rightProg = estimate(parse(RIGHT), OPT).accelMin * 60;
    const right = rightProg - blockTime(10, 5000, ACCEL);
    const rapid = blockTime(RAPID_DIST, 5000, ACCEL);
    const full = estimate(parse(FULL), OPT).accelMin * 60;
    assert.ok(
      Math.abs(full - (left + rapid + right)) < 1e-9,
      `full=${full} left=${left} rapid=${rapid} right=${right}`,
    );
  });
});

describe("legacy default preserved on corpus spot-checks", () => {
  it("shark default is bit-identical to explicit jd=0", () => {
    const prog = parse(readFileSync(SHARK, "utf8"));
    const def = estimate(prog, { accel: 400, rapidRate: 5000 });
    const zero = estimate(prog, {
      accel: 400,
      rapidRate: 5000,
      junctionDeviation: 0,
    });
    assert.equal(def.accelMin, zero.accelMin);
    assert.equal(def.naiveMin, zero.naiveMin);
    assert.ok(
      Math.abs(def.accelMin - 53.98) < 0.5,
      `shark default=${def.accelMin}`,
    );
  });

  it("opt-in never exceeds legacy and naive never moves (shark + half-mil)", () => {
    for (const file of [SHARK, HALF_MIL]) {
      const prog = parse(readFileSync(file, "utf8"));
      const def = estimate(prog, { accel: 400, rapidRate: 5000 });
      const blended = estimate(prog, {
        accel: 400,
        rapidRate: 5000,
        junctionDeviation: DEFAULT_JUNCTION_DEVIATION,
      });
      assert.equal(blended.naiveMin, def.naiveMin, file);
      assert.ok(blended.accelMin <= def.accelMin, file);
      assert.ok(blended.accelMin >= blended.naiveMin, file);
    }
  });
});

describe("shark baselines", () => {
  it("reproduces naive ~38.9 and accel ~53.9 min", () => {
    const prog = parse(readFileSync(SHARK, "utf8"));
    const est = estimate(prog, { accel: 400, rapidRate: 5000 });
    assert.equal(est.g1Blocks, 48007);
    assert.ok(Math.abs(est.naiveMin - 38.9) < 1.0, `naive=${est.naiveMin}`);
    assert.ok(Math.abs(est.accelMin - 53.9) < 3.0, `accel=${est.accelMin}`);
  });
});
