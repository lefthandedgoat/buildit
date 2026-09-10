import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse, trackMoves } from "../src/parser.ts";

import { CORPUS, corpusSkip, listCorpusFiles } from "./corpus.ts";

describe("modal-G1 regression (the 48k-counted-as-4 bug)", () => {
  it("resolves modal motion on continuation lines", () => {
    const prog = parse("G21\nG90\nG0X1Y2Z3\nX4\nG1Z-1F300\nX5Y6\n");
    const moves = trackMoves(prog);
    assert.equal(moves.length, 4);
    assert.deepEqual(
      moves.map((m) => m.block.motion),
      [0, 0, 1, 1],
    );
    assert.deepEqual(moves[1].to, [4, 2, 3]);
    assert.deepEqual(moves[2].to, [4, 2, -1]);
    assert.deepEqual(moves[3].to, [5, 6, -1]);
    assert.equal(moves[2].block.feed, 300);
    assert.equal(moves[3].block.feed, 300); // modal feed carries on
  });

  it("handles Z-only modal lines (peck-drill style)", () => {
    const prog = parse("G0X1Y2Z4\nZ0.25\nG1Z-3F304.8\nG0Z3\nZ-2.9\nG1Z-6\n");
    const moves = trackMoves(prog);
    assert.equal(moves.length, 6);
    assert.deepEqual(
      moves.map((m) => m.block.motion),
      [0, 0, 1, 0, 0, 1],
    );
    assert.deepEqual(moves[1].to, [1, 2, 0.25]);
    assert.deepEqual(moves[4].to, [1, 2, -2.9]);
  });

  it("preserves comments and misc words", () => {
    const prog = parse("(TOOL 121:...)\nM0 ;T121\nM03S24000\nG0X1\n");
    const pass = prog.blocks.filter((b) => b.passthrough);
    assert.ok(pass.length >= 1);
    const m = prog.blocks.find((b) => b.misc.some((w) => w.startsWith("M03")));
    assert.ok(m);
    assert.ok(m.misc.includes("S24000"));
  });
});

describe("corpus parsing", () => {
  for (const f of listCorpusFiles()) {
    it(`parses ${f} with motion blocks`, () => {
      const prog = parse(readFileSync(f, "utf8"));
      const moves = trackMoves(prog);
      assert.ok(moves.length > 10, `expected motion in ${f}`);
    });
  }

  it("counts 48,007 G1 segs in the shark fine-finish file", corpusSkip, () => {
    const prog = parse(
      readFileSync(join(CORPUS, "shark-bottom-finish-fine.c2d.nc"), "utf8"),
    );
    const g1 = trackMoves(prog).filter((m) => m.block.motion === 1);
    assert.equal(g1.length, 48007);
  });
});
