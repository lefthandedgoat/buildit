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
      Math.abs(fplan.drumMassKg - 9.73) < 0.02,
      `mass ${fplan.drumMassKg}`,
    );
    assert.ok(
      Math.abs(fplan.drumMomentKgM - -0.715) < 0.002,
      `moment ${fplan.drumMomentKgM}`,
    );
    assert.ok(Math.abs(fplan.swingRadiusMm - 485.037) < 0.02);
    // Machine-sized drum: the tool's own corners set the rim now, not the
    // drum's, and a lighter drum self-counterbalances less, so the assist it
    // needs is bigger than the old bay-filling platform's was.
    const planer = flipAssist(fplan, 30, 200);
    assert.ok(Math.abs(planer.peakMomentKgM - 6.785) < 0.002);
    assert.ok(Math.abs(planer.rimForceN - 137.2) < 0.05);
    assert.ok(Math.abs(planer.neutralCounterweightKg - 34.44) < 0.01);

    const fjoin = flipLoad(plan, "fjoin");
    assert.equal(
      fjoin.counterweightArmMm,
      plan.flipTools.fjoin.baseToTable + 47,
    );
    assert.ok(Math.abs(fjoin.drumMassKg - 19.3) < 0.02);
    assert.ok(Math.abs(fjoin.drumMomentKgM - -0.936) < 0.002);
    // Rim is now the jointer's own table corner (was its cheek's).
    assert.ok(Math.abs(fjoin.swingRadiusMm - 379.21) < 0.02);
    const jointer = flipAssist(fjoin, 28, 90);
    assert.ok(Math.abs(jointer.peakMomentKgM - 2.984) < 0.002);
    assert.ok(Math.abs(jointer.rimForceN - 77.2) < 0.05);
    assert.ok(Math.abs(jointer.neutralCounterweightKg - 20.3) < 0.01);
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
    // ~0.0139 m3 for the shipped drum (machine-sized: 641x412 platform +
    // flat + cheeks); counting the vendor tool boxes would blow past it.
    const volumeM3 = l.drumMassKg / LOCUST_KG_M3;
    assert.ok(volumeM3 > 0.008 && volumeM3 < 0.03, `volume ${volumeM3} m3`);
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
