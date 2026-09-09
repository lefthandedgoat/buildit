import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { benchAssembly } from "../src/assembly.ts";
import { defaultPlan, gridBoxes, planAsymmetric96 } from "../src/modules.ts";
import { boxesToStl } from "../src/stl.ts";
import {
  boxKey,
  detailViews,
  fitScale,
  groupBoxes,
  identicalBoxes,
  stationsOf,
  stlViewerHtml,
} from "../src/stlview.ts";

describe("stl viewer page", () => {
  const boxes = benchAssembly({ topLen: 1219, topDepth: 457, height: 457 });
  const stl = boxesToStl(boxes, "bench");
  const html = stlViewerHtml(stl, "bench");

  it("embeds the model (no fetch, works from file://)", () => {
    assert.ok(html.includes("facet normal"));
    assert.ok(html.includes("requestAnimationFrame"));
  });

  it("is zero-dependency: no external URLs", () => {
    assert.ok(!/src="http/.test(html));
    assert.ok(!/href="http/.test(html));
    assert.ok(!/url\(http/.test(html));
  });

  it("escapes titles and script breakouts", () => {
    const evil = stlViewerHtml(stl, 'bench <b>&"x"');
    assert.ok(evil.includes("bench &lt;b&gt;&amp;"));
    assert.ok(!evil.includes("</script><script>"));
  });

  it("identical parts share a key (legs x4, seat x1)", () => {
    const legs = boxes
      .map((b, i) => ({ b, i }))
      .filter(({ b }) => b.partId === "leg");
    assert.equal(legs.length, 4);
    const keys = new Set(legs.map(({ b }) => boxKey(b)));
    assert.equal(keys.size, 1);
    assert.deepEqual(identicalBoxes(boxes, legs[0].i).length, 4);
    const seat = boxes.findIndex((b) => b.partId === "seat");
    assert.deepEqual(identicalBoxes(boxes, seat), [seat]);
    assert.deepEqual(identicalBoxes(boxes, -1), []);
    assert.deepEqual(identicalBoxes(boxes, boxes.length), []);
  });

  it("embeds boxes + shift-click panel when boxes are passed", () => {
    const rich = stlViewerHtml(stl, "bench", boxes);
    assert.ok(rich.includes('"partId":"leg"'));
    assert.ok(rich.includes("shift+click"));
    assert.ok(rich.includes('id="panel"'));
    assert.ok(rich.includes("PICK_OK"));
    // Two-arg form stays picking-free (old snapshots keep working).
    assert.ok(!html.includes('"partId":"leg"'));
  });

  it("groups identical boxes for the tree (seat/legs/aprons)", () => {
    const groups = groupBoxes(boxes);
    assert.deepEqual(
      groups.map((g) => g.partId),
      ["seat", "leg", "apron-long", "apron-short"],
    );
    assert.deepEqual(
      groups.map((g) => g.indices.length),
      [1, 4, 2, 2],
    );
    assert.deepEqual(groupBoxes([]), []);
  });

  it("embeds tree + resizer when boxes are passed", () => {
    const rich = stlViewerHtml(stl, "bench", boxes);
    assert.ok(rich.includes('id="tree"'));
    assert.ok(rich.includes('id="grip"'));
    assert.ok(rich.includes("buildTree"));
    assert.ok(!html.includes('id="tree"'));
    assert.ok(!html.includes('id="grip"'));
  });

  it("fits the detail SVG into available space (as large as possible)", () => {
    // Apron-short drawn rects: elevation 203x89 over plan 38x203.
    // Width budget binds, W(s) fills availW exactly.
    const s = fitScale(203, 89 + 203, 274, 750);
    assert.ok(Math.abs(s - (274 - 52) / 203) < 1e-9);
    assert.ok(s * 203 + 52 <= 274 + 1e-9);
    // Tight height budget binds instead, H(s) fills maxH exactly.
    const s2 = fitScale(203, 292, 500, 200);
    assert.ok(Math.abs(s2 - (200 - 92) / 292) < 1e-9);
    assert.ok(s2 * 292 + 92 <= 200 + 1e-9);
  });

  it("picks longest-face detail views (wide flats rotated)", () => {
    const byId = (id: string) => boxes.find((b) => b.partId === id)!;
    // Y-running short apron reads edge-on from the front: gets the side view.
    assert.deepEqual(detailViews(byId("apron-short")), {
      ew: 203,
      eh: 89,
      pw: 38,
      ph: 203,
      eLabel: "side 203 x 89mm",
      pLabel: "top 38 x 203mm",
    });
    // X-running long apron: front view + plan, both drawn rotated.
    assert.deepEqual(detailViews(byId("apron-long")), {
      ew: 89,
      eh: 1067,
      pw: 38,
      ph: 1067,
      eLabel: "front 1067 x 89mm (shown rotated)",
      pLabel: "top 1067 x 38mm (shown rotated)",
    });
    // Legs run along Y: side view, no rotation needed.
    assert.deepEqual(detailViews(byId("leg")), {
      ew: 89,
      eh: 419,
      pw: 38,
      ph: 89,
      eLabel: "side 89 x 419mm",
      pLabel: "top 38 x 89mm",
    });
    // Seat: front view rotated, plan stays put (aspect under threshold).
    const seat = detailViews(byId("seat"));
    assert.equal(seat.eLabel, "front 1219 x 38mm (shown rotated)");
    assert.deepEqual(
      [seat.ew, seat.eh, seat.pw, seat.ph],
      [38, 1219, 1219, 457],
    );
  });

  it("tree groups start collapsed, svg is viewport-capped", () => {
    const rich = stlViewerHtml(stl, "bench", boxes);
    assert.ok(rich.includes('sub.style.display="none";'));
    assert.ok(rich.includes("detailSvgEl(b,availW,maxH)"));
    assert.ok(rich.includes("for(const k of panel.children)"));
  });
});

describe("station sections", () => {
  const bench = benchAssembly({ topLen: 1219, topDepth: 457, height: 457 });
  it("stationsOf lists distinct stations first-seen, '' when unset", () => {
    assert.deepEqual(stationsOf([]), []);
    assert.deepEqual(
      stationsOf([
        { station: "saw" },
        {},
        { station: "saw" },
        { station: "fp" },
      ]),
      ["saw", "", "fp"],
    );
  });

  it("grid boxes all carry their bay station (unstowed + stowed)", () => {
    const plan = defaultPlan();
    const ids = new Set(plan.bays.map((b) => b.id));
    for (const stowed of [false, true]) {
      const boxes = gridBoxes(plan, stowed);
      assert.ok(boxes.length > 0);
      for (const b of boxes) {
        assert.ok(
          b.station !== undefined && ids.has(b.station),
          `${b.partId} station=${b.station}`,
        );
      }
      assert.ok(stationsOf(boxes).length > 1);
    }
  });

  it("stationed models embed section machinery; bench stays one flat list", () => {
    const plan = defaultPlan();
    const gboxes = gridBoxes(plan);
    assert.ok(stationsOf(gboxes).length > 1);
    const grid = stlViewerHtml(boxesToStl(gboxes, "grid"), "grid", gboxes);
    assert.ok(grid.includes("[data-station]"));
    assert.ok(grid.includes("STATIONED"));
    // Bench boxes carry no station: single "" section renders flat.
    assert.deepEqual(stationsOf(bench), [""]);
  });

  it("like-part matching is dims-based (corner posts light up together)", () => {
    const boxes96 = gridBoxes(planAsymmetric96());
    const grid = stlViewerHtml(boxesToStl(boxes96, "grid"), "grid", boxes96);
    // Same cut, four corners: dims key must not include the partId.
    assert.ok(
      grid.includes('const b=BOXES[idx], k=r3(b.dx)+"x"+r3(b.dy)+"x"+r3(b.dz)'),
    );
    const posts = boxes96.filter((b) => b.partId.startsWith("stop-w-post-"));
    assert.equal(posts.length, 4);
    // Same cut four times: dims identical, corners distinct.
    const dims = new Set(posts.map((b) => `${b.dx}x${b.dy}x${b.dz}`));
    assert.equal(dims.size, 1);
  });
});
