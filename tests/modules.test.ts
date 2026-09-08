import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  JOINTER_FLIP,
  PLANER_FLIP,
  defaultPlan,
  flipRectBay,
  frameRectBoxes,
  planAsymmetric,
  stowBoxes,
  sweepCollisions,
  sweepHitsZone,
  gridBoxes,
  gridPlanSvg,
  both,
  type FlipTool,
  type GridPlan,
} from "../src/modules.ts";
import { assemblyOverlaps, boxesOverlap } from "../src/assembly.ts";

const plan = defaultPlan();
const g = plan.spec;
const boxes = gridBoxes(plan);

describe("96x48 front-feed grid fit", () => {
  it("footprints 96in x 48in: tool row saw28+planer24+jointer44, back tops", () => {
    const xs = boxes.flatMap((b) => [b.x, b.x + b.dx]);
    const ys = boxes.flatMap((b) => [b.y, b.y + b.dy]);
    assert.equal(Math.max(...xs) - Math.min(...xs), 711 + 610 + 1118);
    assert.equal(Math.max(...ys) - Math.min(...ys), 813 + 406);
    assert.equal(plan.bays.length, 6);
  });

  it("saw stand legs to floor on skids; BASE (not table) fits the stand", () => {
    const legs = boxes.filter((b) => b.partId.includes("-standleg-"));
    assert.equal(legs.length, 4);
    assert.ok(legs.every((l) => l.z === 12));
    const skids = boxes.filter((b) => b.partId.includes("-skid-"));
    assert.equal(skids.length, 4);
    assert.ok(skids.every((s) => s.z === 0 && s.note.includes("UHMW")));
    const plat = boxes.find((b) => b.partId.endsWith("-platform"))!;
    assert.ok(plat.dx - plan.sawBaseW >= 50);
    assert.ok(plat.dy - plan.sawBaseD >= 50);
  });

  it("three back-row panels coplanar at H-3 with movement slop per axis", () => {
    const panels = boxes.filter((b) => b.partId.endsWith("-panel"));
    assert.equal(panels.length, 3);
    for (const p of panels) assert.equal(p.z + p.dz, g.H - g.supportDrop);
  });

  it("saw table on H, feet on floor, flip motors in open air", () => {
    const saw = boxes.find((b) => b.partId.endsWith("-sawbody"))!;
    assert.equal(saw.z + saw.dz, g.H);
    const zs = boxes.flatMap((b) => [b.z]);
    assert.equal(Math.min(...zs), 0);
    const nonTool = boxes.filter((b) => !b.partId.includes("-tool-"));
    assert.ok(Math.max(...nonTool.flatMap((b) => [b.z + b.dz])) <= g.H + 1e-9);
  });

  it("no two parts share interior volume (joinery fits)", () => {
    assert.deepEqual(assemblyOverlaps(boxes), []);
  });
});

describe("grid plan view", () => {
  it("labels bays, tools, feed flows and rollers in inches", () => {
    const svg = gridPlanSvg(plan);
    assert.ok(!/transform/.test(svg));
    assert.ok(svg.includes("SAW"));
    assert.ok(svg.includes("FLIP"));
    assert.ok(svg.includes("TOP"));
    assert.ok(svg.includes("rip stance"));
    assert.ok(svg.includes("crosscut ghost"));
    assert.ok(svg.includes("infeed"));
    assert.ok(svg.includes("exit"));
    assert.ok(svg.includes("roller"));
  });

  it("dual-unit labels read in woodworker fractions", () => {
    assert.ok(both(813).includes('32")'));
    assert.ok(both(725).includes("28-9/16"));
  });
});

describe("flip drums (planer 24in + jointer 44in bays)", () => {
  const cases: [string, FlipTool, number][] = [
    ["planer", PLANER_FLIP, 610],
    ["jointer", JOINTER_FLIP, 1118],
  ];

  for (const [name, tool, W] of cases) {
    const drum = flipRectBay(g, `t-${name}`, 0, 0, W, g.S, tool);
    const allUp = [...drum.frame, ...drum.rotating, ...drum.fixed];

    it(`${name}: tool table lands exactly on H tool-up`, () => {
      const base = drum.rotating.find((b) => b.partId.endsWith("-tool-base"))!;
      assert.equal(base.z + base.dz, g.H);
    });

    it(`${name}: flip frame omits the back rail`, () => {
      assert.ok(!drum.frame.some((b) => b.partId.endsWith("-rail-back")));
    });

    it(`${name}: up-state joinery fits (hardware excluded by design)`, () => {
      assert.deepEqual(assemblyOverlaps(allUp), []);
    });

    it(`${name}: swing clears the floor mid-flip`, () => {
      assert.ok(drum.swingRadius > 0);
      assert.ok(
        drum.A - drum.swingRadius >= 0,
        `axle ${drum.A} < swing ${drum.swingRadius.toFixed(1)} — tool digs the floor`,
      );
    });

    it(`${name}: drum lives between the posts`, () => {
      for (const b of drum.rotating) {
        assert.ok(
          b.x >= 38 - 1e-9 && b.x + b.dx <= W - 38 + 1e-9,
          `${b.partId} enters post planes`,
        );
      }
    });

    it(`${name}: tool fits the drum interior with room to spare`, () => {
      const interior = W - 2 * (38 + 45 + 19);
      assert.ok(interior - tool.tableW >= 5);
    });

    it(`${name}: lock wedges touch bearing rail AND cheek`, () => {
      const wedges = drum.fixed.filter((b) => b.partId.includes("-wedge"));
      assert.equal(wedges.length, 2);
      const rail = drum.fixed.find((b) => b.partId.endsWith("-bearrail-l"))!;
      const cheek = drum.rotating.find((b) => b.partId.endsWith("-cheek-l"))!;
      const w = wedges[0];
      assert.ok(Math.abs(w.x - (rail.x + rail.dx)) < 0.01 + 1e-9);
      assert.ok(Math.abs(w.x + w.dx - cheek.x) < 0.01 + 1e-9);
    });

    it(`${name}: stowed flat at H-3, nothing above H, still fits`, () => {
      const stowed = stowBoxes(drum.rotating, drum.axleY, drum.A);
      const flat = stowed.find((b) => b.partId.includes("-drum-flat"))!;
      assert.equal(flat.z + flat.dz, g.H - g.supportDrop);
      assert.ok(stowed.every((b) => b.z + b.dz <= g.H + 1e-9));
      assert.ok(stowed.every((b) => b.z >= -1e-9));
      assert.deepEqual(
        assemblyOverlaps([...drum.frame, ...stowed, ...drum.fixed]),
        [],
      );
    });

    it(`${name}: sweep never touches back-row posts (outside drum x-planes)`, () => {
      // Post bands only: the drum x-span is excluded on purpose — the
      // panels/front-lip zone is covered by the lift rule, not this test.
      for (const [x0, x1] of [
        [0, 38],
        [W - 38, W],
      ] as const) {
        const postBand = { x0, x1, y0: g.S, y1: g.S + 406, z0: 0, z1: 842 };
        assert.equal(
          sweepHitsZone(drum.rotating, drum.axleY, drum.A, postBand),
          false,
        );
      }
    });

    it(`${name}: back row behind it keeps no front lip (planer sweep zone)`, () => {
      // Back-row bays drop the front ledge grid-wide; panels cantilever.
      const lips = gridBoxes(plan, false).filter(
        (b) => b.partId.includes("-ledge-front") && b.y > g.S - 1,
      );
      assert.deepEqual(lips, []);
    });
  }

  it("exact sweep toward the open side hits nothing (96x48 front-feed)", () => {
    // Flip direction convention: drums rotate AWAY from the neighboring
    // row, so the 180deg arc meets open air, not structure. Exact corner
    // sampling (not the conservative disc): touching is clear.
    assert.deepEqual(sweepForPlan(plan), []);
  });

  it("exact sweep toward the open side hits nothing (76x60 asymmetric)", () => {
    assert.deepEqual(sweepForPlan(planAsymmetric()), []);
  });

  it("jointer flips fence-off (documented on the part)", () => {
    const drum = flipRectBay(g, "t-j", 0, 0, 1118, g.S, JOINTER_FLIP);
    const upper = drum.rotating.find((b) => b.partId.endsWith("-tool-upper"))!;
    assert.ok(upper.note.includes("fence off"));
  });

  it("grid renders both stowed drums coplanar with panels", () => {
    const stowedBoxes = gridBoxes(plan, true);
    const flats = stowedBoxes.filter((b) => b.partId.includes("-drum-flat"));
    assert.equal(flats.length, 2);
    for (const f of flats) assert.equal(f.z + f.dz, g.H - g.supportDrop);
    // Wedges re-seat after the flip (mirrored with the drum), not dropped.
    const wedges = stowedBoxes.filter((b) => b.partId.includes("-wedge"));
    assert.equal(wedges.length, 4);
    assert.deepEqual(assemblyOverlaps(stowedBoxes), []);
  });
});

describe("asymmetric narrow grid (76x60 saw side + flip side)", () => {
  it("modules import (smoke)", async () => {
    const m = await import("../src/modules.ts");
    assert.ok(typeof m.planAsymmetric === "function");
  });

  it("footprints 76in x 60in with saw + both flips", async () => {
    const m = await import("../src/modules.ts");
    const aplan = m.planAsymmetric();
    const gg = aplan.spec;
    const aboxes = m.gridBoxes(aplan);
    const xs = aboxes.flatMap((b) => [b.x, b.x + b.dx]);
    const ys = aboxes.flatMap((b) => [b.y, b.y + b.dy]);
    assert.equal(Math.max(...xs) - Math.min(...xs), 610 + 711 + 610);
    assert.equal(Math.max(...ys) - Math.min(...ys), 711 + 813);
    assert.equal(aplan.bays.length, 5);
    const { assemblyOverlaps: ov } = await import("../src/assembly.ts");
    assert.deepEqual(ov(aboxes), []);
    const saw = aboxes.find((b) => b.partId.endsWith("-sawbody"))!;
    assert.equal(saw.z + saw.dz, gg.H);
    // Both drums land tables on H and flats at H-3 stowed.
    const stowed = m.gridBoxes(aplan, true);
    const flats = stowed.filter((b) => b.partId.includes("-drum-flat"));
    assert.equal(flats.length, 2);
    for (const f of flats) assert.equal(f.z + f.dz, gg.H - gg.supportDrop);
    assert.deepEqual(ov(stowed), []);
    // Planer lateral drum swing still clears the floor in the 32in bay.
    const drum = m.flipRectBay(gg, "t", 0, 0, 813, 813, m.PLANER_LATERAL);
    assert.ok(drum.A - drum.swingRadius >= 0);
  });
});

// Shared exact-sweep prover: every flip drum in a plan rotates 180deg
// toward its open side without touching any obstacle (frames, panels,
// tools, re-seated wedges excluded — pulled to flip; hardware is joint).
function sweepForPlan(p: GridPlan): string[] {
  const all = gridBoxes(p, false);
  const totalD = Math.max(...p.bays.map((b) => b.y + b.d));
  const hits: string[] = [];
  for (const bay of p.bays.filter((b) => b.kind === "flip")) {
    const tool = p.flipTools[bay.id];
    if (tool === undefined) throw new Error(`no tool for ${bay.id}`);
    const dir = bay.flipDir ?? 1;
    const drum = flipRectBay(p.spec, bay.id, 0, 0, bay.w, bay.d, tool);
    const rotatingIds = new Set(drum.rotating.map((b) => b.partId));
    const obstacles = all.filter(
      (b) =>
        !rotatingIds.has(b.partId) &&
        b.hardware !== true &&
        !b.partId.includes("-wedge"),
    );
    const ox = bay.x;
    const oy = totalD - bay.y - bay.d;
    const placed = drum.rotating.map((b) => ({
      ...b,
      x: b.x + ox,
      y: b.y + oy,
    }));
    for (const h of sweepCollisions(
      placed,
      drum.axleY + oy,
      drum.A,
      dir,
      obstacles,
    ))
      hits.push(`${bay.id}:${h.partId}@${h.deg}deg`);
  }
  return hits;
}

describe("full-width asymmetric (96x64 saw side + flip side)", () => {
  it("footprints 96in x 64in, both flips proven, stowed coplanar", async () => {
    const m = await import("../src/modules.ts");
    const { assemblyOverlaps: ov } = await import("../src/assembly.ts");
    const p96 = m.planAsymmetric96();
    const boxes96 = m.gridBoxes(p96);
    const xs = boxes96.flatMap((b) => [b.x, b.x + b.dx]);
    const ys = boxes96.flatMap((b) => [b.y, b.y + b.dy]);
    assert.equal(Math.max(...xs) - Math.min(...xs), 3 * 813);
    assert.equal(Math.max(...ys) - Math.min(...ys), 2 * 813);
    assert.deepEqual(ov(boxes96), []);
    const stowed = m.gridBoxes(p96, true);
    const flats = stowed.filter((b) => b.partId.includes("-drum-flat"));
    assert.equal(flats.length, 2);
    for (const f of flats)
      assert.equal(f.z + f.dz, p96.spec.H - p96.spec.supportDrop);
    assert.deepEqual(ov(stowed), []);
    // Reuse the shared prover for both drums.
    const all = boxes96;
    const totalD = Math.max(...p96.bays.map((b) => b.y + b.d));
    for (const bay of p96.bays.filter((b) => b.kind === "flip")) {
      const tool = p96.flipTools[bay.id]!;
      const dir = bay.flipDir ?? 1;
      const drum = m.flipRectBay(p96.spec, bay.id, 0, 0, bay.w, bay.d, tool);
      assert.ok(drum.A - drum.swingRadius >= 0);
      const rotatingIds = new Set(drum.rotating.map((b) => b.partId));
      const obstacles = all.filter(
        (b) =>
          !rotatingIds.has(b.partId) &&
          b.hardware !== true &&
          !b.partId.includes("-wedge"),
      );
      const ox = bay.x;
      const oy = totalD - bay.y - bay.d;
      const placed = drum.rotating.map((b) => ({
        ...b,
        x: b.x + ox,
        y: b.y + oy,
      }));
      assert.deepEqual(
        m.sweepCollisions(placed, drum.axleY + oy, drum.A, dir, obstacles),
        [],
      );
    }
  });
});

describe("saw-bay frontback yields zero ledges (table overhang forbids the band)", () => {
  it("frontback emits no ledge parts", () => {
    const boxes = frameRectBoxes(g, "s", 0, 0, 813, 813, {
      ledges: "frontback",
    });
    assert.deepEqual(
      boxes.filter((b) => b.partId.includes("-ledge")),
      [],
    );
  });

  it("a hypothetical saw-bay ledge collides with the table in a 28in bay", () => {
    // The 76x60 saw bay is 28in (711mm); the 622-wide table starts 79.5
    // into the 89-deep post zone, so any front/back ledge shares volume
    // with the saw body. This test constructs that ledge explicitly and
    // proves the collision — the reason frontback stays empty.
    const aplan = planAsymmetric();
    const gg = aplan.spec;
    const sawBay = aplan.bays.find((b) => b.kind === "saw")!;
    const all = gridBoxes(aplan);
    const sawBody = all.find((b) => b.partId.endsWith("-sawbody"))!;
    const railTopZ = gg.H - gg.supportDrop - gg.panelT;
    const ledgeZ = railTopZ - gg.ledgeH;
    const totalD = Math.max(...aplan.bays.map((b) => b.y + b.d));
    const oy = totalD - sawBay.y - sawBay.d;
    const frontLedge = {
      partId: "hypo-ledge-front",
      label: "hypothetical saw front ledge",
      x: sawBay.x + gg.frontPostFace,
      y: oy + gg.post - gg.ledgeW,
      z: ledgeZ,
      dx: sawBay.w - 2 * gg.frontPostFace,
      dy: gg.ledgeW,
      dz: gg.ledgeH,
      process: "saw" as const,
      note: "hypothetical",
    };
    assert.ok(
      boxesOverlap(frontLedge, sawBody),
      "expected the hypothetical ledge to hit the table",
    );
  });
});
