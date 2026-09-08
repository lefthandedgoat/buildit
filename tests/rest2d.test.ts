import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "../src/parser.ts";
import { extractLoops, analyzeRest, loopRest } from "../src/rest2d.ts";
import { corpusFile } from "./corpus.ts";

const SQUARE = `G90
G21
G0X0Y0Z5
G1Z-1F300
G1X10Y0
G1X10Y10
G1X0Y10
G1X0Y0
G0Z5
`;

// 10x10 L with a 6x6 notch removed: one 90-degree concave corner.
const ELL = `G90
G21
G0X0Y0Z5
G1Z-1F300
G1X10Y0
G1X10Y4
G1X4Y4
G1X4Y10
G1X0Y10
G1X0Y0
G0Z5
`;

describe("rest2d loops", () => {
  it("finds closed constant-Z loops, skips open paths", () => {
    assert.equal(extractLoops(parse(SQUARE).blocks).length, 1);
    const open = parse("G90\nG21\nG1X10Y0F300\nG1X10Y5\nM05\n");
    assert.equal(extractLoops(open.blocks).length, 0);
  });

  it("convex square has zero rest at any tool size", () => {
    for (const pd of [6.0, 3.175, 2.0]) {
      const r = analyzeRest(parse(SQUARE).blocks, pd, 1.0);
      assert.equal(r.totalRestArea, 0);
    }
  });

  it("90-degree corner matches the analytic (Rp^2-Rf^2)(1-pi/4)", () => {
    const loops = extractLoops(parse(ELL).blocks);
    assert.equal(loops.length, 1);
    const { restArea, corners } = loopRest(loops[0], 6.0, 1.0);
    assert.equal(corners, 1);
    const expected = (9 - 0.25) * (1 - Math.PI / 4);
    assert.ok(
      Math.abs(restArea - expected) < 1e-6,
      `${restArea} vs ${expected}`,
    );
  });

  it("rest is monotone in prev diameter and empty when prev <= finish", () => {
    const rs = [6.0, 3.175, 2.0].map(
      (pd) => analyzeRest(parse(ELL).blocks, pd, 1.0).totalRestArea,
    );
    assert.ok(rs[0] > rs[1] && rs[1] > rs[2], rs.join(","));
    assert.equal(analyzeRest(parse(ELL).blocks, 1.0, 1.0).totalRestArea, 0);
    assert.equal(analyzeRest(parse(ELL).blocks, 0.5, 1.0).totalRestArea, 0);
  });

  it("winding-independent: CW loop gives the same rest", () => {
    const cw = `G90
G21
G0X0Y0Z5
G1Z-1F300
G1X0Y10
G1X4Y10
G1X4Y4
G1X10Y4
G1X10Y0
G1X0Y0
G0Z5
`;
    const a = analyzeRest(parse(ELL).blocks, 3.175, 1.0).totalRestArea;
    const b = analyzeRest(parse(cw).blocks, 3.175, 1.0).totalRestArea;
    assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
  });

  it("happy pocket file: loops found, analysis runs clean", () => {
    const txt = readFileSync(
      corpusFile("happy-w-half-mil.c2d.nc"),
      "utf8",
    );
    const r = analyzeRest(parse(txt).blocks, 3.175, 1.0);
    assert.ok(r.loopsFound > 0, "expected pocket loops");
    assert.ok(r.totalRestArea >= 0);
  });
});
