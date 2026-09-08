import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// viewer core is dependency-free CJS shared with viewer.html
const core = require("../viewer/core.cjs") as {
  parseNC(text: string): Array<{
    motion: number;
    feed: number;
    from: number[];
    to: number[];
    I?: number;
    J?: number;
    rest: boolean;
  }>;
  samplePath(
    blocks: unknown[],
    maxSegLen: number,
    cap: number,
  ): {
    pts: Array<[number, number, number, string] | null>;
    counts: Record<string, number>;
  };
  deviation(
    a: Array<[number, number, number, string] | null>,
    b: Array<[number, number, number, string] | null>,
    topZ: number,
  ): { max: number; mean: number; maxA: number; maxB: number };
  stockTop(blocks: unknown[]): number;
  tagAddedPlunges(a: unknown[], b: unknown[]): void;
  anomalies(blocks: unknown[]): { count: number; worst: number };
  fmtPt(p: [number, number, number, string] | null): string;
  gradeVerdict(
    maxA: number,
    maxB: number,
    exclMax: number,
  ): { key: string; label: string };
};

import { CORPUS } from "./corpus.ts";

function loadPair(before: string, after: string) {
  const a = core.parseNC(readFileSync(join(CORPUS, before), "utf8"));
  const b = core.parseNC(
    readFileSync(
      after.startsWith("/tmp") ? after : join(CORPUS, after),
      "utf8",
    ),
  );
  core.tagAddedPlunges(a, b);
  const tz = core.stockTop(a);
  // Verdict sampling is UNCAPPED (every endpoint + break retained); only
  // drawing decimates. Capping verdict samples can hide moves (false green).
  const d = core.deviation(
    core.samplePath(a, 0.08, Infinity).pts,
    core.samplePath(b, 0.08, Infinity).pts,
    tz,
  );
  return d;
}

describe("viewer verdicts on shipped pairs", () => {
  it("top-clear preserves geometry within 0.25mm", () => {
    const d = loadPair("shark-top-clear.c2d.nc", "shark-top-clear-buildit.nc");
    assert.ok(d.maxA <= 0.25, `preserve ${d.maxA}`);
  });

  it("bottom-finish preserves geometry within 0.25mm", () => {
    const d = loadPair("shark-bottom-finish-fine.c2d.nc", "/tmp/shark-opt.nc");
    assert.ok(d.maxA <= 0.25, `preserve ${d.maxA}`);
  });

  it("happy-half preserves geometry within 0.5mm", () => {
    const d = loadPair("happy-w-half-mil.c2d.nc", "/tmp/happy-opt.nc");
    assert.ok(d.maxA <= 0.5, `preserve ${d.maxA}`);
  });

  it("identical inputs deviate exactly zero", () => {
    const text = readFileSync(join(CORPUS, "shark-top-clear.c2d.nc"), "utf8");
    const a = core.parseNC(text);
    const b = core.parseNC(text);
    const d = core.deviation(
      core.samplePath(a, 0.1, Infinity).pts,
      core.samplePath(b, 0.1, Infinity).pts,
      core.stockTop(a),
    );
    assert.equal(d.maxA, 0);
    assert.equal(d.maxB, 0);
  });

  it("grades on additions too: distant new cut is not SAFE", () => {
    // Regression for verdict-on-maxA-only: maxA==0, maxB==20 must not grade green.
    const base = "G90\nG21\nG0Z4\nG0X0Y0\nG1Z-1F300\nG1X10Y0F500\nG0Z4\nM02\n";
    const extra = base.replace(
      "M02",
      "G0X100Y100\nG1Z-1F300\nG1X110Y100F500\nG0Z4\nM02",
    );
    const a = core.parseNC(base);
    const b = core.parseNC(extra);
    const d = core.deviation(
      core.samplePath(a, 0.1, Infinity).pts,
      core.samplePath(b, 0.1, Infinity).pts,
      core.stockTop(a),
    );
    assert.equal(d.maxA, 0);
    assert.ok(d.maxB > 10, `maxB ${d.maxB}`);
    const grade = Math.max(d.maxA, d.maxB) <= 0.25 ? "green" : "not-green";
    assert.equal(grade, "not-green");
  });

  it("sees full-circle arcs (no-XYZ IJK blocks are retained)", () => {
    const g = "G90\nG21\nG0Z4\nG0X10Y0\nG1Z-1F300\nG2X10Y0I-10J0\nG0Z4\nM02\n";
    const b = core.parseNC(g);
    const arcs = b.filter((x) => x.motion === 2 || x.motion === 3);
    assert.equal(arcs.length, 1);
    // Removing the circle must show up in the verdict, not vanish.
    const plain = "G90\nG21\nG0Z4\nG0X10Y0\nG1Z-1F300\nG0Z4\nM02\n";
    const a = core.parseNC(plain);
    const d = core.deviation(
      core.samplePath(a, 0.1, Infinity).pts,
      core.samplePath(b, 0.1, Infinity).pts,
      core.stockTop(a),
    );
    assert.ok(d.maxB > 5, `circle invisible? maxB ${d.maxB}`);
  });

  it("tags rest by marker at file clearance (no elevated signature)", () => {
    // v4.2: rest retracts reuse the file's own clearance, so the
    // elevation fingerprint (mx > mode+0.5) goes blind. Markers survive
    // atomic spans — tagging must work with zero elevated clearance.
    const base = "G90\nG21\nG0Z4\nG0X0Y0\nG1Z-1F300\nG1X10Y0F500\nG0Z4\nM02\n";
    const span = [
      "(BUILDIT REST op=0 tool=1 z=-1)",
      "G0Z4",
      "G0X5Y5",
      "G1Z-1F300",
      "G1X6Y5F400",
      "G0Z4",
      "(BUILDIT REST END)",
    ].join("\n");
    const withRest = base.replace("M02", `${span}\nM02`);
    const b = core.parseNC(withRest);
    const rest = b.filter((x) => x.rest);
    assert.ok(rest.length >= 4, `marker span tagged, got ${rest.length}`);
    // Everything before the span stays untagged.
    const first = b.findIndex((x) => x.rest);
    assert.ok(first > 0);
    for (let i = 0; i < first; i++) assert.equal(b[i].rest, false);
    // Rest-tagged cuts are excluded from verdict inputs: A->B preserve
    // holds and the addition does not masquerade as deviation.
    const a = core.parseNC(base);
    const d = core.deviation(
      core.samplePath(a, 0.1, Infinity).pts,
      core.samplePath(b, 0.1, Infinity).pts,
      core.stockTop(a),
    );
    assert.equal(d.maxA, 0);
    assert.ok(d.maxB <= 0.5, `rest leaked into verdict? maxB ${d.maxB}`);
  });

  it("legacy TRUEPATH markers still tag (pre-rename files read)", () => {
    const withLegacy = [
      "G90",
      "G21",
      "G0Z4",
      "(TRUEPATH REST op=0 tool=1 z=-1)",
      "G0X5Y5",
      "G1Z-1F300",
      "G1X6Y5F400",
      "G0Z4",
      "(TRUEPATH REST END)",
      "M02",
    ].join("\n");
    const b = core.parseNC(withLegacy);
    assert.ok(
      b.some((x) => x.rest),
      "pre-rename TRUEPATH span must still tag as rest",
    );
  });

  it("anomaly flag catches a single-point plunge spike", () => {
    // Synthetic mesh glitch: one G1 stab far below its neighbors, amid
    // enough normal points that p10 sits at the working depth.
    const cuts = Array.from(
      { length: 12 },
      (_, i) => `G1X${10 + i}Y0F500`,
    ).join("\n");
    const g = `G90\nG21\nG0Z4\nG0X0Y0\nG1Z-1F300\n${cuts}\nG1X22Y1Z-38F500\nG1X22Y2Z-1F500\nG1X30Y2F500\nG0Z4\nM02\n`;
    const b = core.parseNC(g);
    const an = core.anomalies(b);
    assert.equal(an.count, 1);
    assert.equal(an.worst, -38);
  });

  it("shipped rest pair: preservation and additions pinned separately", () => {
    // Happy-w-1-16 with rest cleanup (v4.2+): 0.33 = TSP pocket-entry
    // dives rerouted (by-design amber), 0.58 = rest additions (by
    // design), mean ~0.003. One-sided upper bounds: improvement must
    // never fail this test, drift must. Separate asserts per norm —
    // a single max would let one side hide behind the other.
    const a = core.parseNC(
      readFileSync(join(CORPUS, "happy-w-1-16.c2d.nc"), "utf8"),
    );
    const b = core.parseNC(
      readFileSync(join(CORPUS, "happy-w-1-16-buildit.nc"), "utf8"),
    );
    assert.ok(
      b.some((x) => x.rest),
      "rest spans must be tagged (markers survived?)",
    );
    core.tagAddedPlunges(a, b);
    const d = core.deviation(
      core.samplePath(a, 0.08, Infinity).pts,
      core.samplePath(b, 0.08, Infinity).pts,
      core.stockTop(a),
    );
    assert.ok(d.maxA <= 0.4, `preservation drifted: maxA ${d.maxA}`);
    assert.ok(d.maxB <= 0.7, `additions drifted: maxB ${d.maxB}`);
    assert.ok(d.mean <= 0.01, `bulk drifted: mean ${d.mean}`);
  });
  it("anomaly flag fires on the shark-bottom Z-38 mesh glitch", () => {
    // Handoff open item: L44200 X33.427Z-38.100 amid Z-14 neighbors.
    // `worst` pinpoints the spike; `count` also sweeps legit deep
    // relief cuts on this file, so only worst is pinned (count merely
    // asserted nonzero — the metric half-lies, reported as such).
    const txt = readFileSync(
      join(CORPUS, "shark-bottom-finish-fine.c2d.nc"),
      "utf8",
    );
    const an = core.anomalies(core.parseNC(txt));
    assert.ok(an.count > 0);
    assert.ok(
      Math.abs(an.worst - -38.1) < 0.01,
      `worst ${an.worst} should be the -38.1 spike`,
    );
  });
});

describe("viewer messaging helpers (render-only, grade-safe)", () => {
  it("grade thresholds stay load-bearing", () => {
    assert.equal(core.gradeVerdict(0.1, 0.1, 0).key, "green");
    assert.equal(core.gradeVerdict(0.25, 0.25, 0.5).key, "green");
    // Just beyond each boundary flips the grade.
    assert.equal(core.gradeVerdict(0.250001, 0.25, 0.5).key, "amber");
    assert.equal(core.gradeVerdict(0.25, 0.25, 0.500001).key, "amber");
    assert.equal(core.gradeVerdict(1.5, 0, 0).key, "amber");
    assert.equal(core.gradeVerdict(1.500001, 0, 0).key, "red");
    // Moved travel caps at amber even when cuts are perfect.
    assert.equal(core.gradeVerdict(0, 0, 3.4).key, "amber");
    assert.equal(core.gradeVerdict(0.33, 0.58, 0.3).key, "amber");
    assert.equal(core.gradeVerdict(2, 0, 0).key, "red");
  });

  it("worst-point callouts format coordinates", () => {
    assert.equal(core.fmtPt(null), "-");
    assert.equal(
      core.fmtPt([1.234, -2, 3.5, "g1"]),
      "X1.23 Y-2.00 Z3.50",
    );
  });
});
