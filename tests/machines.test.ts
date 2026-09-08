import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getMachine, machineNames, resolveRates } from "../src/machines.ts";

describe("machine profiles", () => {
  it("ships the calibrated shapeoko preset", () => {
    const m = getMachine("shapeoko");
    assert.ok(m, "shapeoko preset missing");
    assert.equal(m.accel, 400);
    assert.equal(m.rapidRate, 5000);
  });

  it("is case-insensitive, lists names", () => {
    assert.ok(getMachine("Shapeoko"), "case-insensitive lookup");
    assert.ok(machineNames().includes("shapeoko"));
  });

  it("unknown machines return null (caller fails loud)", () => {
    assert.equal(getMachine("bridgemill-9000"), null);
  });

  it("preset alone resolves with preset provenance", () => {
    const m = getMachine("shapeoko")!;
    const r = resolveRates(m, null, null);
    assert.equal(r.accel, 400);
    assert.equal(r.rapidRate, 5000);
    assert.equal(r.source, "shapeoko");
  });

  it("explicit flags beat the preset, provenance recorded", () => {
    const m = getMachine("shapeoko")!;
    const r = resolveRates(m, 500, null);
    assert.equal(r.accel, 500);
    assert.equal(r.rapidRate, 5000);
    assert.ok(r.source.includes("accel=500"), `source ${r.source}`);
    const r2 = resolveRates(m, null, 3000);
    assert.equal(r2.rapidRate, 3000);
    assert.ok(r2.source.includes("rapid=3000"));
  });

  it("NaN overrides fall back (index.ts rejects them first)", () => {
    // resolveRates is lenient by itself; the CLI validates raws with
    // usage() before calling. Pinned so the layers stay in contract.
    const m = getMachine("shapeoko")!;
    const r = resolveRates(m, NaN, NaN);
    assert.equal(r.accel, 400);
    assert.equal(r.rapidRate, 5000);
  });
});
