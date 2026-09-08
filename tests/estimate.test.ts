import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "../src/parser.ts";
import { blockTime, estimate } from "../src/estimate.ts";

import { CORPUS } from "./corpus.ts";
const SHARK = join(CORPUS, "shark-bottom-finish-fine.c2d.nc");

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

describe("shark baselines", () => {
  it("reproduces naive ~38.9 and accel ~53.9 min", () => {
    const prog = parse(readFileSync(SHARK, "utf8"));
    const est = estimate(prog, { accel: 400, rapidRate: 5000 });
    assert.equal(est.g1Blocks, 48007);
    assert.ok(Math.abs(est.naiveMin - 38.9) < 1.0, `naive=${est.naiveMin}`);
    assert.ok(Math.abs(est.accelMin - 53.9) < 3.0, `accel=${est.accelMin}`);
  });
});
