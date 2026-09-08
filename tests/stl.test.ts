import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { benchAssembly } from "../src/assembly.ts";
import { boxFacets, boxesToStl } from "../src/stl.ts";

const cross = (a: number[], b: number[]): number[] => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const sub = (a: number[], b: number[]): number[] => [
  a[0] - b[0],
  a[1] - b[1],
  a[2] - b[2],
];

describe("stl export", () => {
  const boxes = benchAssembly({ topLen: 1219, topDepth: 457, height: 457 });

  it("emits 12 facets per box", () => {
    assert.equal(boxFacets(boxes[0]).length, 12);
    const stl = boxesToStl(boxes);
    assert.equal(stl.match(/facet normal/g)?.length, boxes.length * 12);
    assert.ok(stl.startsWith("solid "));
    assert.ok(stl.trimEnd().endsWith("endsolid assembly"));
  });

  it("normals are unit and match right-hand winding (outward)", () => {
    for (const b of boxes)
      for (const f of boxFacets(b)) {
        const [nx, ny, nz] = f.normal;
        assert.ok(Math.abs(Math.hypot(nx, ny, nz) - 1) < 1e-9);
        const [p0, p1, p2] = f.verts;
        const w = cross(sub(p1, p0), sub(p2, p0));
        const dot = w[0] * nx + w[1] * ny + w[2] * nz;
        assert.ok(dot > 0, `inward-wound facet on ${b.partId}`);
      }
  });

  it("vertices stay inside the assembly bounding box", () => {
    const stl = boxesToStl(boxes);
    const verts = [
      ...stl.matchAll(/vertex ([-\d.]+) ([-\d.]+) ([-\d.]+)/g),
    ].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
    assert.equal(verts.length, boxes.length * 36);
    for (const [x, y, z] of verts) {
      assert.ok(x >= 0 && x <= 1219);
      assert.ok(y >= 0 && y <= 457);
      assert.ok(z >= 0 && z <= 457);
    }
  });
});
