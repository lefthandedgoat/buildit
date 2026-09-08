import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse, trackMoves } from "../src/parser.ts";
import { retunePlunges } from "../src/plunge.ts";
import { getProfile } from "../src/materials.ts";
import { corpusFile } from "./corpus.ts";

const WALNUT = getProfile("walnut");
const LOCUST = getProfile("locust");

describe("materials", () => {
  it("unknown names fall back to the conservative generic profile", () => {
    const g = getProfile("unobtanium");
    assert.equal(g.plungeFeed, 250);
    assert.equal(g.peckDepth, 1.2);
  });
});

describe("plunge retune (safe direction only)", () => {
  const PROG = `G90
G21
G0X0Y0Z5
G1Z-2F600
G0Z5
G0X10Y0
G1Z-1F200
G1X12Y0F600
G0Z5
M05
`;

  it("clamps fast pure-Z plunges, leaves slow ones and XY cuts alone", () => {
    const { blocks, stats } = retunePlunges(parse(PROG).blocks, WALNUT);
    assert.equal(stats.plungesRetuned, 1);
    const moves = trackMoves({ blocks });
    const plunge = moves.find((m) => m.to[0] === 0 && m.to[2] === -2)!;
    assert.equal(plunge.block.feed, 350);
    const slow = moves.find((m) => m.to[0] === 10 && m.to[2] === -1)!;
    assert.equal(slow.block.feed, 200);
    const cut = moves.find((m) => m.to[0] === 12)!;
    assert.equal(cut.block.feed, 600); // XY cutting move untouched
  });

  it("locust profile clamps harder than walnut", () => {
    const { stats } = retunePlunges(parse(PROG).blocks, LOCUST);
    assert.equal(stats.plungesRetuned, 1); // F600->250; F200 already slower
    const { blocks } = retunePlunges(parse(PROG).blocks, LOCUST);
    const descents = trackMoves({ blocks }).filter(
      (m) =>
        m.block.motion === 1 &&
        m.to[2] < m.from[2] - 1e-9 &&
        Math.abs(m.to[0] - m.from[0]) + Math.abs(m.to[1] - m.from[1]) < 1e-9,
    );
    assert.ok(descents.length > 0);
    assert.ok(descents.every((m) => m.block.feed <= 250));
  });

  it("clamps G83 Q down, never up", () => {
    const prog = parse("G90\nG21\nG83X1Y1Z-5Q5R1F200\nG83X2Y2Z-5Q0.5R1F200\n");
    const { blocks, stats } = retunePlunges(prog.blocks, WALNUT);
    assert.equal(stats.pecksClamped, 1);
    const g83 = blocks.filter(
      (b) => !b.passthrough && b.misc.some((w) => /^G83$/i.test(w)),
    );
    assert.equal(g83.length, 2);
    assert.ok(
      g83[0].misc.some((w) => w === "Q2"),
      g83[0].misc.join(""),
    );
    assert.ok(g83[1].misc.some((w) => w === "Q0.5"));
  });

  it("shark 3D finish: zero feed changes on cutting moves", () => {
    const txt = readFileSync(
      corpusFile("shark-bottom-finish-fine.c2d.nc"),
      "utf8",
    );
    const before = trackMoves(parse(txt)).map((m) => m.block.feed);
    const { blocks, stats } = retunePlunges(parse(txt).blocks, WALNUT);
    assert.equal(stats.plungesRetuned, 0);
    assert.equal(stats.pecksClamped, 0);
    const after = trackMoves({ blocks }).map((m) => m.block.feed);
    assert.deepEqual(after, before);
  });
});
