import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  JOINTER_FLIP,
  PLANER_FLIP,
  defaultPlan,
  drumPlacement,
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
  it("centres the tool on its tight platform, with the drum toward its outfeed", () => {
    const p = planAsymmetric96();
    const bs = gridBoxes(p);
    for (const id of ["fplan", "fjoin"]) {
      const bay = p.bays.find((b) => b.id === id)!;
      const tool = p.flipTools[id]!;
      const pl = drumPlacement(p.spec, bay.w, tool);
      const plat = bs.find((b) => b.partId === `${id}-drum-platform`)!;
      const table = bs.find((b) => b.partId === `${id}-tool-base`)!;
      // On a tight platform there is no travel left to slide through: the
      // tool is centred and the DRUM is what sits off-centre.
      const west = table.x - plat.x;
      const east = plat.x + plat.dx - (table.x + table.dx);
      assert.ok(Math.abs(west - east) < 1e-9, `${id} tool centred`);
      assert.ok(Math.abs(west - (p.spec.drumPad ?? 25)) < 1e-9);
      const gapWest = pl.cheekOutL - 38;
      const gapEast = bay.w - 38 - pl.cheekOutR;
      if (tool.feedDir > 0)
        assert.ok(gapEast < gapWest, `${id} drum sits east`);
      else assert.ok(gapWest < gapEast, `${id} drum sits west`);
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

describe("flip drums are sized by the machine, not by the bay", () => {
  const bayOf = (p: GridPlan, id: string) => p.bays.find((b) => b.id === id)!;
  const padOf = (p: GridPlan) => p.spec.drumPad ?? 25;

  it("platform = tool + 2*pad, band clear of both pillow blocks", () => {
    const p = planAsymmetric96();
    const bs = gridBoxes(p);
    for (const id of ["fplan", "fjoin"]) {
      const bay = bayOf(p, id);
      const tool = p.flipTools[id]!;
      const pl = drumPlacement(p.spec, bay.w, tool);
      assert.equal(pl.platformW, tool.tableW + 2 * padOf(p));
      assert.equal(pl.drumDepth, tool.tableD + 2 * padOf(p));
      // Never into the pillow blocks (they stay on the frame at bay edges).
      assert.ok(pl.cheekOutL >= 83 - 1e-9, `${id} west cheek clears pillow`);
      assert.ok(
        pl.cheekOutR <= bay.w - 83 + 1e-9,
        `${id} east cheek clears pillow`,
      );
      // Far narrower than the old bay-filling platform (bay - 204).
      assert.ok(pl.platformW < bay.w - 205, `${id} drum is narrower`);
      // The tool keeps the feed position the plan was verified with.
      const base = bs.find((b) => b.partId === `${id}-tool-base`)!;
      assert.ok(
        Math.abs(base.x - bay.x - pl.toolX0) < 1e-9,
        `${id} tool stays put`,
      );
      // Every rotating slab really is on the platform.
      for (const r of bs.filter(
        (b) =>
          b.partId.startsWith(`${id}-drum-`) &&
          !b.partId.includes("cheek") &&
          !b.partId.includes("-stowed"),
      )) {
        const rx = r.x - bay.x;
        assert.ok(
          rx >= pl.inL - 1e-9 && rx + r.dx <= pl.inR + 1e-9,
          `${r.partId} on the platform`,
        );
        assert.ok(r.y >= (bay.d - pl.drumDepth) / 2 - 1e-9);
        assert.ok(r.y + r.dy <= (bay.d + pl.drumDepth) / 2 + 1e-9);
      }
    }
  });

  it("narrows further with --drumPad and still verifies", () => {
    const wide = planAsymmetric96();
    const tight = planAsymmetric96({ ...wide.spec, drumPad: 15 });
    const a = gridBoxes(wide).find((b) => b.partId === "fplan-drum-platform")!;
    const b = gridBoxes(tight).find(
      (b2) => b2.partId === "fplan-drum-platform",
    )!;
    assert.ok(Math.abs(b.dx - (a.dx - 20)) < 1e-9, `${b.dx}`);
    assert.deepEqual(gridPlanIssues(tight), []);
  });

  it("the in-bay infeed table reaches the bay edge and stops short of the band", () => {
    const p = planAsymmetric96();
    const bs = gridBoxes(p);
    for (const id of ["fplan", "fjoin"]) {
      const bay = bayOf(p, id);
      const tool = p.flipTools[id]!;
      const pl = drumPlacement(p.spec, bay.w, tool);
      const west = tool.feedDir > 0;
      const tbl = bs.find((b) => b.partId === `${id}-inbay-table`)!;
      const t0 = tbl.x - bay.x;
      const t1 = t0 + tbl.dx;
      // Outer edge meets the bay's infeed edge, flush with the outside table.
      assert.equal(west ? t0 : t1, west ? 0 : bay.w);
      // Inner edge stops 10mm short of the drum's X band.
      const bandEdge = west ? pl.cheekOutL - 10 : pl.cheekOutR + 10;
      assert.ok(Math.abs((west ? t1 : t0) - bandEdge) < 1e-9);
      assert.equal(tbl.dy, tool.tableD);
      assert.equal(tbl.z + tbl.dz, p.spec.H - p.spec.supportDrop);
      // It closes most of the span the outside table could not reach.
      const gap = west ? pl.toolX0 - t1 : t0 - (pl.toolX0 + tool.tableW);
      assert.ok(
        gap > 0 && gap < 100,
        `${id} infeed gap now ${gap.toFixed(1)}mm`,
      );
      // The second post pair stands at the table's inner end, clear of the
      // drum, tied by a full 2x4 top rail and a floor stretcher.
      const posts = bs.filter(
        (b) => b.partId === `${id}-post-in-f` || b.partId === `${id}-post-in-b`,
      );
      assert.equal(posts.length, 2);
      for (const post of posts) {
        assert.equal(post.dx, 38);
        assert.ok(
          post.x + post.dx <= pl.cheekOutL - 10 + 1e-9 ||
            post.x >= pl.cheekOutR + 10 - 1e-9,
          `${post.partId} clear of the band`,
        );
      }
      assert.equal(bs.find((b) => b.partId === `${id}-post-in-b`)!.z, 89);
      assert.equal(bs.find((b) => b.partId === `${id}-rail-in`)!.dx, 38);
      assert.equal(bs.find((b) => b.partId === `${id}-stretch-in`)!.z, 0);
    }
  });
});

describe("the two flip bays are the same assembly", () => {
  const bayOf = (p: GridPlan, id: string) => p.bays.find((b) => b.id === id)!;
  const bent = /-post-in-|-rail-in|-stretch-in|-inbay-table/;
  const hardware = /-drum-|-tool-|-infeed-|wedge|pillow|axle|bearrail/;

  it("frames are part-for-part identical, same place in the bay", () => {
    const p = planAsymmetric96();
    const bs = gridBoxes(p);
    const [a, b] = ["fplan", "fjoin"].map((id) => bayOf(p, id));
    assert.equal(a.w, b.w);
    assert.equal(a.d, b.d);
    const parts = (bay: typeof a) =>
      bs
        .filter(
          (x) =>
            x.partId.startsWith(`${bay.id}-`) &&
            !hardware.test(x.partId) &&
            !bent.test(x.partId),
        )
        .map(
          (x) =>
            `${x.partId.slice(bay.id.length)} ${x.dx}x${x.dy}x${x.dz} ` +
            `@${x.x - bay.x},${x.y - bay.y},${x.z}`,
        )
        .sort();
    // Posts, rails, ledges, stretchers: one cut list, two bays.
    assert.deepEqual(parts(a), parts(b));
  });

  it("hardware is the same part too; only its height differs", () => {
    const p = planAsymmetric96();
    const bs = gridBoxes(p);
    const [a, b] = ["fplan", "fjoin"].map((id) => bayOf(p, id));
    const hw = (bay: typeof a) =>
      bs
        .filter(
          (x) =>
            x.partId.startsWith(`${bay.id}-`) &&
            /-axle|-pillow|-bearrail|-wedge/.test(x.partId),
        )
        .map((x) => [
          x.partId.slice(bay.id.length).replace(/-(l|r)$/, ""),
          x.dx,
          x.dy,
          x.dz,
          x.z,
        ])
        .sort();
    const [pa, pb] = [hw(a), hw(b)];
    assert.equal(pa.length, pb.length);
    for (let i = 0; i < pa.length; i++) {
      // Same part, same size — axle, both pillows, both bearing rails, both
      // wedges.
      assert.deepEqual(pa[i].slice(0, 4), pb[i].slice(0, 4), `${pa[i][0]}`);
      // Height follows the tools' bed heights (A = H - baseToTable - 50),
      // except the bearing rails, which duck under the side top rails.
      const adv =
        p.flipTools[a.id]!.baseToTable - p.flipTools[b.id]!.baseToTable;
      if (String(pa[i][0]).includes("bearrail"))
        assert.ok(
          Math.abs((pb[i][4] as number) - (pa[i][4] as number)) < 45 + 1e-9,
        );
      else
        assert.ok(
          Math.abs((pb[i][4] as number) - ((pa[i][4] as number) + adv)) < 1e-9,
          `${pa[i][0]} height`,
        );
    }
  });

  it("each drum sits stopped against its outfeed-side pillow block", () => {
    const p = planAsymmetric96();
    for (const id of ["fplan", "fjoin"]) {
      const bay = bayOf(p, id);
      const tool = p.flipTools[id]!;
      const pl = drumPlacement(p.spec, bay.w, tool);
      assert.ok(pl.clamped, `${id} drum should be at its stop`);
      if (tool.feedDir > 0)
        assert.ok(
          Math.abs(pl.cheekOutR - (bay.w - 83)) < 1e-9,
          `${id} outfeed (east) cheek against the east pillow`,
        );
      else
        assert.ok(
          Math.abs(pl.cheekOutL - 83) < 1e-9,
          `${id} outfeed (west) cheek against the west pillow`,
        );
    }
  });
});

describe("sweepCollisions has no face-on blind spot", () => {
  it("flags a post under the middle of the platform (no rotating corner lands in it)", () => {
    const p = planAsymmetric96();
    const bay = p.bays.find((b) => b.id === "fplan")!;
    const drum = flipRectBay(
      p.spec,
      bay.id,
      0,
      0,
      bay.w,
      bay.d,
      p.flipTools[bay.id],
    );
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
    // A block 200mm below the axle at the axle's own Y, inside the drum's X
    // band: free space when the drum is up, but the cheeks sweep straight
    // through it. Every rotating corner circle has a radius of 208mm+ (the
    // slab corners sit at the platform's Y extremes), so no sampled corner
    // can ever land in a 40mm-wide block at the axle's Y — this is exactly
    // what the old corner-only sampler reported as "clear".
    const mid = drumPlacement(p.spec, bay.w, p.flipTools[bay.id]!);
    const block = {
      partId: "hypo-in-band-block",
      label: "hypo",
      x: bay.x + (mid.inL + mid.inR) / 2,
      y: oy + bay.d / 2 - 20,
      z: drum.A - 210,
      dx: 38,
      dy: 40,
      dz: 20,
      process: "saw" as const,
      note: "hypo",
    };
    assert.ok(
      sweepCollisions(placed, drum.axleY + oy, drum.A, bay.flipDir ?? 1, [
        ...obstacles,
        block,
      ]).length > 0,
      "a face-on strike must be reported even when no corner lands in it",
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
