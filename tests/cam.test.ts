import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getTool } from "../src/tools.ts";
import { computeFeeds } from "../src/feeds.ts";
import { parse, trackMoves } from "../src/parser.ts";
import { depthPasses, profileRect, drillHole, camProgram } from "../src/cam.ts";

const T2 = getTool("T2")!;
const T4 = getTool("T4")!;
const PROF = computeFeeds(T2, "2x4 SPF", "profile");
const DRILL = computeFeeds(T4, "2x4 SPF", "drill");

describe("depth passes", () => {
  it("exact division ends exactly on target", () => {
    assert.deepEqual(depthPasses(-12, 6), [-6, -12]);
  });
  it("ceilings up with an exact final pass", () => {
    const p = depthPasses(-38, 6.35);
    assert.equal(p.length, 6);
    assert.equal(p[p.length - 1], -38);
    assert.ok(p.every((z, i) => i === 0 || z < p[i - 1]));
  });
  it("rejects non-negative targets and non-positive docs", () => {
    assert.throws(() => depthPasses(5, 6));
    assert.throws(() => depthPasses(-5, 0));
  });
});

describe("rect profile", () => {
  const OP = {
    partId: "leg",
    x: 10,
    y: 20,
    w: 89,
    h: 100,
    targetZ: -38,
    overshoot: 1,
  };
  const body = profileRect(OP, PROF, T2.diameterMm);
  const moves = trackMoves(parse(body));

  it("cuts the part rect expanded by tool radius (geometry preserved)", () => {
    const r = T2.diameterMm / 2;
    const xy = moves.filter((m) => m.block.motion === 1);
    const xs = xy.flatMap((m) => [m.from[0], m.to[0]]);
    const ys = xy.flatMap((m) => [m.from[1], m.to[1]]);
    assert.ok(Math.abs(Math.min(...xs) - (OP.x - r)) < 0.01);
    assert.ok(Math.abs(Math.max(...xs) - (OP.x + OP.w + r)) < 0.01);
    assert.ok(Math.abs(Math.min(...ys) - (OP.y - r)) < 0.01);
    assert.ok(Math.abs(Math.max(...ys) - (OP.y + OP.h + r)) < 0.01);
  });

  it("steps depth by DOC with exact final floor, never below", () => {
    const floor = OP.targetZ - OP.overshoot!;
    const zs = moves.filter((m) => m.block.motion === 1).map((m) => m.to[2]);
    assert.equal(Math.min(...zs), floor);
    assert.ok(zs.every((z) => z >= floor - 1e-9));
    const floors = new Set(
      zs.filter((z) => z < -1e-9).map((z) => z.toFixed(3)),
    );
    assert.equal(floors.size, Math.ceil(Math.abs(floor) / PROF.docMm));
  });

  it("plunges at plunge feed, cuts XY at cutting feed", () => {
    const plunges = moves.filter(
      (m) =>
        m.block.motion === 1 &&
        Math.abs(m.to[0] - m.from[0]) < 1e-9 &&
        Math.abs(m.to[1] - m.from[1]) < 1e-9 &&
        m.to[2] < m.from[2] - 1e-9,
    );
    assert.ok(plunges.length > 0);
    assert.ok(plunges.every((m) => m.block.feed === PROF.plungeMmMin));
    const cuts = moves.filter(
      (m) =>
        m.block.motion === 1 &&
        Math.hypot(m.to[0] - m.from[0], m.to[1] - m.from[1]) > 1e-9 &&
        Math.abs(m.to[2] - m.from[2]) < 1e-9,
    );
    assert.ok(cuts.length > 0);
    assert.ok(cuts.every((m) => m.block.feed === PROF.feedMmMin));
  });

  it("rejects non-positive dims", () => {
    assert.throws(() => profileRect({ ...OP, w: 0 }, PROF, T2.diameterMm));
  });
});

describe("drill", () => {
  it("emits G83 with Q and reaches target depth at the hole XY", () => {
    const body = drillHole(
      { partId: "pilot", x: 5, y: 6, targetZ: -38 },
      DRILL,
    );
    assert.ok(body.includes("G83"));
    assert.ok(body.includes("Q2"));
    assert.ok(body.includes("Z-38"));
    assert.ok(body.includes("G80"));
    // Parses clean with motion present (G83 words ride in misc).
    const moves = trackMoves(parse(body));
    assert.ok(
      moves.some(
        (m) => Math.abs(m.to[0] - 5) < 1e-9 && Math.abs(m.to[1] - 6) < 1e-9,
      ),
    );
  });
});

describe("program assembly", () => {
  it("headers G90/G21 and strips parens from titles", () => {
    const t = camProgram("bench (v2)", ["G0X0Y0Z10\n"]);
    assert.ok(t.includes("G90"));
    assert.ok(t.includes("G21"));
    assert.ok(t.startsWith("(bench v2)"));
  });
});
