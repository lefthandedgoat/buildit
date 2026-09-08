import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TOOL_LIBRARY, getTool } from "../src/tools.ts";
import { computeFeeds, normalizeMaterial } from "../src/feeds.ts";
import { parse } from "../src/parser.ts";
import { splitJobs, emitJob, setupSheet } from "../src/jobs.ts";
import { layoutParts, partsToSvg, benchParts } from "../src/svggen.ts";

describe("tool library (owner bits)", () => {
  it("covers all six shop bits", () => {
    assert.equal(TOOL_LIBRARY.length, 6);
    assert.equal(getTool("T2")?.diameterMm, 6.35);
    assert.equal(getTool("T6")?.diameterMm, 0.5);
    assert.equal(getTool("NOPE"), undefined);
  });
});

describe("feeds engine", () => {
  it("normalizes lumber names to spf-pine", () => {
    assert.equal(normalizeMaterial("2x4 SPF"), "spf-pine");
    assert.equal(normalizeMaterial("pine"), "spf-pine");
    assert.equal(normalizeMaterial("walnut"), "walnut");
    assert.equal(normalizeMaterial("baltic birch ply"), "plywood");
  });

  it("1/4 flat in pine pocket: chipload math + plunge capped by profile", () => {
    const t2 = getTool("T2")!;
    const r = computeFeeds(t2, "2x4 SPF", "pocket");
    assert.equal(r.rpm, 16000);
    // 16000 * 2 flutes * 0.05 = 1600
    assert.equal(r.feedMmMin, 1600);
    // 35% = 560 -> capped to generic profile 250
    assert.equal(r.plungeMmMin, 250);
    assert.ok(r.warnings.some((w) => /capped/.test(w)));
    assert.equal(r.docMm, 6.35);
    assert.equal(r.wocMm, 2.54);
  });

  it("locust runs slower than pine on the same bit", () => {
    const t2 = getTool("T2")!;
    const pine = computeFeeds(t2, "pine", "pocket");
    const locust = computeFeeds(t2, "locust", "pocket");
    assert.ok(locust.feedMmMin < pine.feedMmMin);
  });

  it("taper-ball DOC capped at 0.5mm", () => {
    const t6 = getTool("T6")!;
    const r = computeFeeds(t6, "walnut", "finish3d");
    assert.ok(r.docMm <= 0.5);
  });

  it("slot derates feed vs pocket", () => {
    const t2 = getTool("T2")!;
    const slot = computeFeeds(t2, "pine", "slot");
    const pocket = computeFeeds(t2, "pine", "pocket");
    assert.ok(slot.feedMmMin < pocket.feedMmMin);
  });
});

describe("job splitter", () => {
  const TWO_TOOL = `G90
G21
T2M6
G0X0Y0Z5
G1Z-2F500
G1X10Y0F1200
T5M6
G0X0Y0Z5
G1Z-1F300
G1X5Y0F600
M30
`;
  it("splits at T-words into one job per tool", () => {
    const jobs = splitJobs(parse(TWO_TOOL).blocks);
    assert.equal(jobs.length, 2);
    assert.equal(jobs[0].tool, "T2");
    assert.equal(jobs[1].tool, "T5");
  });

  it("single job when no tool changes", () => {
    const jobs = splitJobs(parse("G90\nG21\nG0X0Y0Z5\nG1Z-1F300\n").blocks);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].tool, "unknown");
  });

  it("emitted job wraps motion with spindle prologue/epilogue", () => {
    const [j] = splitJobs(parse(TWO_TOOL).blocks);
    const text = emitJob(j, { rpm: 16000 });
    assert.ok(text.includes("M3S16000"));
    assert.ok(text.includes("M30"));
    // Original motion survives verbatim-ish
    assert.ok(text.includes("X10"));
  });

  it("setup sheet lists each job with est time", () => {
    const jobs = splitJobs(parse(TWO_TOOL).blocks);
    const feeds = new Map([
      [
        "T2",
        {
          rpm: 16000,
          feedMmMin: 1600,
          plungeMmMin: 250,
          docMm: 6.35,
          label: '1/4" flat',
        },
      ],
      [
        "T5",
        {
          rpm: 20000,
          feedMmMin: 640,
          plungeMmMin: 224,
          docMm: 1.59,
          label: '1/16" flat',
        },
      ],
    ]);
    const sheet = setupSheet(jobs, feeds);
    assert.ok(sheet.includes("| 1 | T2 |"));
    assert.ok(sheet.includes("| 2 | T5 |"));
    assert.ok(sheet.includes("Bit changes"));
  });
});

describe("svggen (rectilinear parts)", () => {
  it("packs bench parts and emits transform-free SVG", () => {
    const parts = benchParts(1219, 457, 457);
    assert.ok(parts.find((p) => p.id === "leg")?.qty === 4);
    const placed = layoutParts(parts, { sheetW: 1300, sheetH: 2400 });
    assert.ok(placed.length > 10);
    const svg = partsToSvg(placed, 1300, 2400, "bench");
    assert.ok(!/transform/.test(svg));
    assert.ok(svg.includes("<rect"));
  });

  it("throws on oversize parts instead of silently clipping", () => {
    assert.throws(() =>
      layoutParts([{ id: "x", label: "x", wMm: 9999, hMm: 10, qty: 1 }], {
        sheetW: 100,
        sheetH: 100,
      }),
    );
  });
});
