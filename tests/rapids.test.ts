import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse, trackMoves } from "../src/parser.ts";
import { optimizeRapids } from "../src/rapids.ts";
import { emit } from "../src/janitor.ts";

import { CORPUS } from "./corpus.ts";
const OPTS = {
  tsp: true,
  clearance: "auto" as const,
  margin: 1.0,
  rapidRate: 5000,
  accel: 400,
};

// Three drill sites deliberately scrambled: x=30 first, then 10, then 20.
const DRILL = `G90
G21
M03S18000
G0X30Y0Z4
Z0.25
G1Z-2F304.8
G0Z3
G0X10Y0
Z0.25
G1Z-2F304.8
G0Z3
G0X20Y0
Z0.25
G1Z-2F304.8
G0Z3
M05
`;

function g1Positions(text: string): string[] {
  return trackMoves(parse(text))
    .filter((m) => m.block.motion === 1)
    .map((m) => m.to.map((v) => v.toFixed(3)).join(","))
    .sort();
}

describe("rapids TSP reorder", () => {
  it("reorders scrambled drill sites to a shorter rapid path", () => {
    const prog = parse(DRILL);
    const { blocks, stats } = optimizeRapids(prog.blocks, OPTS);
    assert.equal(stats.sitesFound, 3);
    assert.equal(stats.sitesReordered, 3);
    assert.ok(stats.rapidDistAfter < stats.rapidDistBefore);
    // Same cuts, different travel: G1 endpoints identical as a multiset.
    assert.deepEqual(
      g1Positions(emit({ blocks }, 3, true)),
      g1Positions(DRILL),
    );
  });

  it("is deterministic across runs", () => {
    const a = emit(
      { blocks: optimizeRapids(parse(DRILL).blocks, OPTS).blocks },
      3,
      true,
    );
    const b = emit(
      { blocks: optimizeRapids(parse(DRILL).blocks, OPTS).blocks },
      3,
      true,
    );
    assert.equal(a, b);
  });

  it("refuses to reorder across spindle commands", () => {
    const withM = DRILL.replace("G0X20Y0", "M05\nG0X20Y0");
    const { stats } = optimizeRapids(parse(withM).blocks, OPTS);
    assert.equal(stats.sitesReordered, 0);
  });

  it("leaves the continuous 3D finish alone (shark file gate)", () => {
    const txt = readFileSync(
      `${CORPUS}/shark-bottom-finish-fine.c2d.nc`,
      "utf8",
    );
    const { stats } = optimizeRapids(parse(txt).blocks, OPTS);
    assert.equal(stats.sitesReordered, 0);
  });
});

describe("rapids adaptive clearance", () => {
  // Fidelity invariant, keyed on move TARGETS (reordered sites legitimately
  // change where a traverse flies *from*, and lowered modal clearance
  // legitimately changes where it flies *to in Z* — never in XY, and
  // never below the plane). Allowed novel targets: pure-Z retracts to
  // the plane, or known-XY targets at/above the plane. The pass never
  // invents a low rapid.
  const g0Key = (m: { to: number[] }) =>
    m.to.map((v) => v.toFixed(4)).join(",");
  const xyKey = (m: { to: number[] }) =>
    m.to
      .slice(0, 2)
      .map((v) => v.toFixed(4))
      .join(",");
  const checkNovelRapids = (
    progBlocks: Parameters<typeof trackMoves>[0],
    outBlocks: Parameters<typeof trackMoves>[0],
    plane: number,
    tag: string,
  ) => {
    const inputSet = new Set(
      trackMoves(progBlocks)
        .filter((m) => m.block.motion === 0)
        .map(g0Key),
    );
    const inputXY = new Set(
      trackMoves(progBlocks)
        .filter((m) => m.block.motion === 0)
        .map(xyKey),
    );
    for (const m of trackMoves(outBlocks)) {
      if (m.block.motion !== 0 || inputSet.has(g0Key(m))) continue;
      const isPureZ =
        Math.abs(m.to[0] - m.from[0]) < 1e-9 &&
        Math.abs(m.to[1] - m.from[1]) < 1e-9;
      if (isPureZ) {
        assert.ok(
          Math.abs(m.to[2] - plane) < 1e-9,
          `${tag}: retract to ${m.to[2]}`,
        );
        continue;
      }
      assert.ok(
        m.to[2] >= plane - 1e-9 && inputXY.has(xyKey(m)),
        `${tag}: novel rapid ${g0Key(m)}`,
      );
    }
  };

  it("lowers pure-Z retracts to stockTop+margin, preserves rapid-to-depth", () => {
    const prog = parse(`G90
G21
G0X0Y0Z4
G1Z0F300
G1Z-2F300
G0Z10
G0X5Y0
Z-1.5
G1Z-3F300
G0Z10
M05
`);
    const { blocks, stats } = optimizeRapids(prog.blocks, OPTS);
    assert.equal(stats.clearancePlane, 1.0); // stockTop 0 + margin 1
    assert.ok(stats.clearanceChanges > 0);
    checkNovelRapids(prog, { blocks }, stats.clearancePlane, "synthetic");
    // The intentional rapid-to-depth survived verbatim.
    assert.ok(
      trackMoves({ blocks }).some(
        (m) => m.block.motion === 0 && Math.abs(m.to[2] - -1.5) < 1e-9,
      ),
    );
  });

  it("corpus: output introduces no novel low rapids", () => {
    for (const f of ["shark-holes.c2d.nc", "happy-w-half-mil.c2d.nc"]) {
      const txt = readFileSync(`${CORPUS}/${f}`, "utf8");
      const prog = parse(txt);
      const { blocks, stats } = optimizeRapids(prog.blocks, OPTS);
      checkNovelRapids(prog, { blocks }, stats.clearancePlane, f);
    }
  });
});
