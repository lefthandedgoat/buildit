import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LOCUST_KG_M3,
  defaultCgMm,
  flipAssist,
  flipLoad,
} from "../src/flip.ts";
import {
  defaultPlan,
  planAsymmetric,
  planAsymmetric96,
} from "../src/modules.ts";

describe("flip-drum balance", () => {
  it("every shipped flip drum is flat-heavy (rests tool-up)", () => {
    for (const plan of [defaultPlan(), planAsymmetric(), planAsymmetric96()]) {
      const bays = plan.bays.filter((b) => b.kind === "flip");
      assert.ok(bays.length > 0, "plan must have flip bays");
      for (const bay of bays) {
        const l = flipLoad(plan, bay.id);
        assert.ok(
          l.drumMomentKgM < 0,
          `${bay.id} self-moment ${l.drumMomentKgM} should be flat-heavy`,
        );
        assert.ok(l.drumMassKg > 5 && l.drumMassKg < 100);
        assert.ok(l.counterweightArmMm > 50);
        assert.ok(l.swingRadiusMm > 0);
        assert.ok(l.axleHeightMm > 0);
      }
    }
  });

  it("neutral counterweight exactly cancels the peak moment", () => {
    const l = flipLoad(planAsymmetric96(), "fplan");
    const a = flipAssist(l, 30, 200);
    const expected = (a.peakMomentKgM / l.counterweightArmMm) * 1000;
    assert.ok(Math.abs(a.neutralCounterweightKg - expected) < 1e-9);
    assert.ok(a.peakMomentKgM > 0, "a 30 kg tool must want to fall to stowed");
    assert.ok(a.peakTorqueNm > 0);
    assert.ok(a.rimForceN > 0);
  });

  it("heavier tools need heavier counterweights; light ones self-hold", () => {
    const l = flipLoad(planAsymmetric96(), "fjoin");
    const light = flipAssist(l, 1, 10);
    const mid = flipAssist(l, 20, 90);
    const heavy = flipAssist(l, 40, 180);
    assert.equal(light.neutralCounterweightKg, 0);
    assert.ok(light.peakMomentKgM < 0);
    assert.ok(heavy.neutralCounterweightKg > mid.neutralCounterweightKg);
    assert.ok(mid.neutralCounterweightKg >= 0);
  });

  it("drum mass is a plausible 19mm glue-up volume", () => {
    const l = flipLoad(planAsymmetric96(), "fplan");
    const volumeM3 = l.drumMassKg / LOCUST_KG_M3;
    assert.ok(volumeM3 > 0.01 && volumeM3 < 0.1, `volume ${volumeM3} m3`);
  });

  it("rejects nonsense inputs", () => {
    const l = flipLoad(planAsymmetric96(), "fplan");
    assert.throws(() => flipAssist(l, 0, 100));
    assert.throws(() => flipAssist(l, 30, -1));
    assert.throws(() => flipLoad(planAsymmetric96(), "stop-w"));
  });

  it("default CG is the mid-envelope", () => {
    assert.equal(defaultCgMm(150, 250), 200);
    assert.equal(defaultCgMm(100, 80), 90);
  });
});
