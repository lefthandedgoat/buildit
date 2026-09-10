import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  JOINTER_FLIP,
  PLANER_FLIP,
  defaultPlan,
  feedArrows,
  flipRectBay,
  frameRectBoxes,
  planAsymmetric,
  planAsymmetric96,
  stowBoxes,
  sweepCollisions,
  sweepHitsZone,
  gridBoxes,
  gridPlanIssues,
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
    // The infeed support tables are auxiliary furniture outboard of the
    // grid; the frame footprint is what these numbers describe.
    const grid = boxes.filter((b) => !b.partId.includes("-infeed-"));
    const xs = grid.flatMap((b) => [b.x, b.x + b.dx]);
    const ys = grid.flatMap((b) => [b.y, b.y + b.dy]);
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
    const grid = aboxes.filter((b) => !b.partId.includes("-infeed-"));
    const xs = grid.flatMap((b) => [b.x, b.x + b.dx]);
    const ys = grid.flatMap((b) => [b.y, b.y + b.dy]);
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

describe("feed arrows (3D viewer hint)", () => {
  it("one per flip bay, along the feed axis, above the tool table", () => {
    const p = planAsymmetric96();
    const bs = gridBoxes(p);
    const arrows = feedArrows(p, bs);
    assert.equal(arrows.length, 2);
    const byLabel = Object.fromEntries(arrows.map((a) => [a.label, a]));
    const planer = byLabel["planer 59313 feed"];
    const jointer = byLabel["jointer 6in feed"];
    assert.ok(planer, "planer arrow present");
    assert.ok(jointer, "jointer arrow present");
    // Planer feeds west->east; the jointer feeds east->west into it.
    assert.ok(planer.to[0] > planer.from[0], "planer must point +x");
    assert.ok(jointer.to[0] < jointer.from[0], "jointer must point -x");
    for (const a of arrows) {
      assert.equal(a.from[1], a.to[1], "arrow stays in one row");
      assert.ok(
        Math.abs(a.from[2] - (p.spec.H + 6)) < 1e-9,
        "arrow floats just above the working table",
      );
    }
    // The planer's arrow starts west of the jointer's tool and points at it.
    assert.ok(
      planer.to[0] < jointer.from[0],
      "hand-off runs toward the jointer",
    );
  });
});

describe("tool massing reads as a machine", () => {
  it("working table on H, inset body below, head standing centred on it", () => {
    const p = planAsymmetric96();
    const bs = gridBoxes(p);
    const at = (id: string, part: string) => {
      const b = bs.find((x) => x.partId === `${id}-${part}`);
      assert.ok(b, `${id} ${part} present`);
      return b;
    };
    for (const bay of p.bays.filter((b) => b.kind === "flip")) {
      const tool = p.flipTools[bay.id];
      const table = at(bay.id, "tool-base");
      const body = at(bay.id, "tool-body");
      const head = at(bay.id, "tool-upper");
      // The H datum lives on the table slab's top face.
      assert.equal(table.z + table.dz, p.spec.H);
      assert.equal(table.dx, tool.tableW);
      assert.equal(table.dy, tool.tableD);
      assert.ok(table.dz <= 25, "table is a slab, not a block");
      // Cast body sits on the platform and meets the table underside.
      assert.equal(body.z, p.spec.H - tool.baseToTable);
      assert.equal(body.z + body.dz, table.z);
      assert.ok(body.dx < table.dx && body.dy < table.dy, "body inset");
      // Head stands on the table, centred on the feed axis.
      assert.equal(head.z, p.spec.H);
      assert.equal(head.x, table.x + (table.dx - head.dx) / 2);
      assert.equal(head.y, table.y + (table.dy - head.dy) / 2);
      assert.equal(head.dz, tool.aboveTable);
      // Everything stays inside the tool's own envelope.
      assert.ok(head.dx <= table.dx && head.dy <= table.dy);
    }
  });
});

describe("outfeed shift + outboard infeed support", () => {
  it("slides each lateral tool toward its outfeed, staying on the platform", () => {
    const p = planAsymmetric96();
    const bs = gridBoxes(p);
    for (const id of ["fplan", "fjoin"]) {
      const plat = bs.find((b) => b.partId === `${id}-drum-platform`)!;
      const table = bs.find((b) => b.partId === `${id}-tool-base`)!;
      const tool = p.flipTools[id];
      assert.ok(table.x >= plat.x && table.x + table.dx <= plat.x + plat.dx);
      const west = table.x - plat.x;
      const east = plat.x + plat.dx - (table.x + table.dx);
      if (tool.feedDir > 0) assert.ok(east < west, `${id} should sit east`);
      else assert.ok(west < east, `${id} should sit west`);
      assert.ok(Math.min(west, east) > 5, `${id} keeps clearance`);
    }
  });

  it("puts a leg-carried infeed table outboard at each grid edge", () => {
    const p = planAsymmetric96();
    const bs = gridBoxes(p);
    const totalW = Math.max(...p.bays.map((b) => b.x + b.w));
    const tables = bs.filter((b) => b.partId.endsWith("-infeed-table"));
    const legs = bs.filter((b) => b.partId.endsWith("-infeed-leg"));
    assert.equal(tables.length, 2);
    assert.equal(legs.length, 2);
    const planer = tables.find((b) => b.partId.startsWith("fplan"))!;
    const jointer = tables.find((b) => b.partId.startsWith("fjoin"))!;
    assert.ok(planer.x + planer.dx <= 0, "planer table is west of the grid");
    assert.ok(jointer.x >= totalW, "jointer table is east of the grid");
    for (const t of tables) {
      assert.equal(t.z + t.dz, p.spec.H - p.spec.supportDrop);
      assert.ok(t.dy >= 300, "wide enough to carry a board");
    }
    for (const l of legs) {
      assert.equal(l.z, 0);
      assert.equal(l.dz, p.spec.H - p.spec.supportDrop - 19);
    }
  });
});

describe("inboard post pair (flip bay stiffening)", () => {
  it("sits in the 45mm strip, clear of the drum's X band, and is tied top+bottom", () => {
    const p = planAsymmetric96();
    const bs = gridBoxes(p);
    for (const id of ["fplan", "fjoin"]) {
      const posts = bs.filter(
        (b) => b.partId === `${id}-post-in-f` || b.partId === `${id}-post-in-b`,
      );
      assert.equal(posts.length, 2);
      const drumX0 = Math.min(
        ...bs.filter((b) => b.partId.startsWith(`${id}-drum-`)).map((b) => b.x),
      );
      for (const post of posts) {
        assert.ok(
          post.x + post.dx <= drumX0 + 1e-9,
          `${post.partId} must clear the drum's X band`,
        );
        assert.equal(post.dx, 38);
      }
      // The back post lands on the existing floor stretcher (z = 89).
      const back = bs.find((b) => b.partId === `${id}-post-in-b`)!;
      assert.equal(back.z, 89);
      // Ties: 19mm strip at the top, stretcher at the floor.
      const tie = bs.find((b) => b.partId === `${id}-rail-in`)!;
      assert.equal(tie.dx, 19);
      assert.equal(tie.z + tie.dz, p.spec.H - p.spec.supportDrop - p.spec.panelT);
      assert.ok(bs.some((b) => b.partId === `${id}-stretch-in`));
    }
  });
});

describe("sweepCollisions has no face-on blind spot", () => {
  it("flags a post under the middle of the platform (no rotating corner lands in it)", () => {
    const p = planAsymmetric96();
    const bay = p.bays.find((b) => b.id === "fplan")!;
    const drum = flipRectBay(p.spec, bay.id, 0, 0, bay.w, bay.d, p.flipTools[bay.id]);
    const all = gridBoxes(p);
    const totalD = Math.max(...p.bays.map((b) => b.y + b.d));
    const oy = totalD - bay.y - bay.d;
    const rotatingIds = new Set(drum.rotating.map((b2) => b2.partId));
    const obstacles = all.filter(
      (b2) =>
        !rotatingIds.has(b2.partId) &&
        b2.hardware !== true &&
        !b2.partId.includes("-wedge"),
    );
    const placed = drum.rotating.map((b2) => ({
      ...b2,
      x: b2.x + bay.x,
      y: b2.y + oy,
    }));
    const post = {
      partId: "hypo-inboard-post",
      label: "hypo",
      x: 600,
      y: oy,
      z: 0,
      dx: 38,
      dy: 89,
      dz: 842,
      process: "saw" as const,
      note: "hypo",
    };
    assert.ok(
      sweepCollisions(placed, drum.axleY + oy, drum.A, bay.flipDir ?? 1, [
        ...obstacles,
        post,
      ]).length > 0,
      "a face-on strike must be reported even when no corner lands in the post",
    );
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
    // Footprint = the grid frames; the infeed support tables sit outboard.
    const grid96 = boxes96.filter((b) => !b.partId.includes("-infeed-"));
    const xs = grid96.flatMap((b) => [b.x, b.x + b.dx]);
    const ys = grid96.flatMap((b) => [b.y, b.y + b.dy]);
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

describe("grid plan verification (CLI --verify)", () => {
  it("passes the shipped 96x64 plan", () => {
    assert.deepEqual(gridPlanIssues(planAsymmetric96()), []);
  });

  it("catches an impossible measured bed height", () => {
    // A jointer/planer that stands 350mm above its base puts the axle so
    // high that the drum underside sweeps the floor and the frame. The
    // checker is the guard against entering a bad measurement by hand.
    const bad = planAsymmetric96();
    bad.flipTools.fplan = { ...bad.flipTools.fplan, baseToTable: 350 };
    const issues = gridPlanIssues(bad);
    assert.ok(issues.length > 0, "expected failures");
    assert.ok(
      issues.some((i) => i.includes("digs the floor")),
      `expected a floor-dig issue, got: ${issues.join("; ")}`,
    );
  });
});
