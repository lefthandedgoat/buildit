import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  benchAssembly,
  assemblyOverlaps,
  elevate,
  elevationSvg,
  explodedIso,
  isoPt,
} from "../src/assembly.ts";

const DIMS = { topLen: 1219, topDepth: 457, height: 457 };

describe("bench assembly", () => {
  const boxes = benchAssembly(DIMS);

  it("is 9 boxes: seat + 4 legs + 4 aprons", () => {
    assert.equal(boxes.length, 9);
    assert.equal(boxes.filter((b) => b.partId === "leg").length, 4);
    assert.equal(boxes.filter((b) => b.partId.startsWith("apron")).length, 4);
  });

  it("seat caps the top, legs stand on the floor", () => {
    const seat = boxes.find((b) => b.partId === "seat")!;
    assert.equal(seat.z + seat.dz, DIMS.height);
    for (const leg of boxes.filter((b) => b.partId === "leg"))
      assert.equal(leg.z, 0);
  });

  it("no two boxes share interior volume (joinery fits)", () => {
    const overlaps = assemblyOverlaps(boxes);
    assert.deepEqual(overlaps, []);
  });

  it("every box has a process and a reason", () => {
    for (const b of boxes) {
      assert.ok(["saw", "cnc", "laminate"].includes(b.process));
      assert.ok(b.note.length > 0);
    }
  });
});

describe("elevations", () => {
  const boxes = benchAssembly(DIMS);

  it("front view spans full length x height", () => {
    const rects = elevate(boxes, "front");
    const xs = rects.flatMap((r) => [r.x, r.x + r.w]);
    const ys = rects.flatMap((r) => [r.y, r.y + r.h]);
    assert.equal(Math.max(...xs) - Math.min(...xs), DIMS.topLen);
    assert.equal(Math.max(...ys) - Math.min(...ys), DIMS.height);
  });

  it("elevation SVG is transform-free with overall dims", () => {
    const svg = elevationSvg(
      elevate(boxes, "side"),
      "side",
      DIMS.topDepth,
      DIMS.height,
    );
    assert.ok(!/transform/.test(svg));
    assert.ok(svg.includes(`${DIMS.topDepth}mm`));
    assert.ok(svg.includes(`${DIMS.height}mm`));
  });
});

describe("exploded iso", () => {
  const boxes = benchAssembly(DIMS);

  it("projects origin to origin", () => {
    assert.deepEqual(isoPt(0, 0, 0), { x: 0, y: 0 });
  });

  it("emits 3 faces per box, transform-free", () => {
    const svg = explodedIso(boxes);
    assert.ok(!/transform/.test(svg));
    assert.equal(svg.match(/<polygon/g)?.length, boxes.length * 3);
  });
});
