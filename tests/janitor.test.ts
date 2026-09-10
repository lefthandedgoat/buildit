import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse, trackMoves } from "../src/parser.ts";
import { janitor } from "../src/janitor.ts";

import { listCorpusFiles } from "./corpus.ts";
const EPS = 0.01;

describe("janitor fidelity (every corpus file)", () => {
  for (const f of listCorpusFiles()) {
    it(`round-trips ${f} within tolerance`, () => {
      const orig = parse(readFileSync(f, "utf8"));
      const { text } = janitor(orig, { tolerance: EPS, decimals: 3 });
      const opt = parse(text);
      const m0 = trackMoves(orig);
      const m1 = trackMoves(opt);
      // Same endpoints: final position identical.
      assert.deepEqual(m1[m1.length - 1].to, m0[m0.length - 1].to);
      // Segment count never grows.
      const g0 = m0.filter((m) => m.block.motion === 1).length;
      const g1 = m1.filter((m) => m.block.motion === 1).length;
      assert.ok(g1 <= g0, `G1 grew in ${f}: ${g0} -> ${g1}`);
      // Total cut distance preserved within 0.5%.
      const d0 = m0.reduce(
        (s, m) => s + (m.block.motion === 1 ? m.dist : 0),
        0,
      );
      const d1 = m1.reduce(
        (s, m) => s + (m.block.motion === 1 ? m.dist : 0),
        0,
      );
      assert.ok(Math.abs(d1 - d0) / d0 < 0.005, `distance drift in ${f}`);
      // Every optimized endpoint must coincide (within rounding) with an
      // original endpoint: DP only removes points, never invents them.
      const key = (p: readonly number[]) =>
        p.map((v) => v.toFixed(3)).join(",");
      const origEnds = new Set(m0.map((m) => key(m.to)));
      origEnds.add(key([0, 0, 0]));
      for (const m of m1) {
        assert.ok(origEnds.has(key(m.to)), `invented point in ${f}`);
      }
    });
  }

  it("collapses a straight run", () => {
    const prog = parse("G21\nG90\nG1X0Y0F400\nX1Y0\nX2Y0\nX3Y0\nX3Y1\n");
    const { text, stats } = janitor(prog, { tolerance: EPS, decimals: 3 });
    // X1..X3 form the collapsible run (the X0 block carries the F-word,
    // which correctly terminates run-splitting, so only X2 collapses).
    assert.equal(stats.collapsedCollinear, 1);
    const m1 = trackMoves(parse(text));
    assert.deepEqual(m1[m1.length - 1].to, [3, 1, 0]);
  });
});
