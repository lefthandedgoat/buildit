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

  it("shipped-plan pins: arm, self-moment, rim and sized assist", () => {
    // Golden numbers, not relations derived from the implementation: these
    // fail if the arm is measured to the wrong face, a part is dropped or
    // the tool boxes are counted as wood.
    const plan = planAsymmetric96();
    // The arm is structural: axle -> flat outer face = baseToTable + 47mm
    // (dFlat = H - supportDrop - A, A = H - baseToTable - 50).
    const fplan = flipLoad(plan, "fplan");
    assert.equal(
      fplan.counterweightArmMm,
      plan.flipTools.fplan.baseToTable + 47,
    );
    assert.ok(
      Math.abs(fplan.drumMassKg - 23.51) < 0.02,
      `mass ${fplan.drumMassKg}`,
    );
    assert.ok(
      Math.abs(fplan.drumMomentKgM - -1.728) < 0.002,
      `moment ${fplan.drumMomentKgM}`,
    );
    assert.ok(Math.abs(fplan.swingRadiusMm - 485.037) < 0.02);
    const planer = flipAssist(fplan, 30, 200);
    assert.ok(Math.abs(planer.peakMomentKgM - 5.772) < 0.002);
    assert.ok(Math.abs(planer.rimForceN - 116.704) < 0.05);
    assert.ok(Math.abs(planer.neutralCounterweightKg - 29.3) < 0.01);

    const fjoin = flipLoad(plan, "fjoin");
    assert.equal(
      fjoin.counterweightArmMm,
      plan.flipTools.fjoin.baseToTable + 47,
    );
    assert.ok(Math.abs(fjoin.drumMassKg - 22.58) < 0.02);
    assert.ok(Math.abs(fjoin.drumMomentKgM - -1.095) < 0.002);
    assert.ok(Math.abs(fjoin.swingRadiusMm - 379.62) < 0.02);
    const jointer = flipAssist(fjoin, 28, 90);
    assert.ok(Math.abs(jointer.peakMomentKgM - 2.825) < 0.002);
    assert.ok(Math.abs(jointer.rimForceN - 72.98) < 0.05);
    assert.ok(Math.abs(jointer.neutralCounterweightKg - 19.22) < 0.01);
  });

  it("the two moment terms compose as stated", () => {
    const l = flipLoad(planAsymmetric96(), "fplan");
    const a = flipAssist(l, 30, 200);
    // peak = tool point mass at (50 + cg) above the axle + drum's own
    const toolMoment = (30 * (50 + 200)) / 1000;
    assert.ok(Math.abs(a.peakMomentKgM - toolMoment - l.drumMomentKgM) < 1e-12);
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
    // ~0.0336 m3 for the shipped drum; the band is tight enough that
    // counting the vendor tool boxes (~0.032 m3 more) would fail it.
    const volumeM3 = l.drumMassKg / LOCUST_KG_M3;
    assert.ok(volumeM3 > 0.02 && volumeM3 < 0.05, `volume ${volumeM3} m3`);
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
