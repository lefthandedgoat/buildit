import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parse } from "../src/parser.ts";
import { janitor, emit } from "../src/janitor.ts";
import { applyRestCut } from "../src/restcut.ts";
import { optimizeRapids, findRestSpans } from "../src/rapids.ts";

// Three L-shaped pocket loops deliberately scrambled (x=100, x=0, x=50),
// each with a sharp concave inside corner so --rest-cut fires. v4.2:
// rapids reorder must keep each BUILDIT REST span whole and attached to
// the site containing its parent loop — never split a span across sites.
const THREE_POCKETS = `G90
G21
G0Z4
G0X100Y0
G1Z-1F350
G1X110Y0F1200
G1X110Y4
G1X104Y4
G1X104Y10
G1X100Y10
G1X100Y0
G0Z4
G0X0Y0
G1Z-1F350
G1X10Y0F1200
G1X10Y4
G1X4Y4
G1X4Y10
G1X0Y10
G1X0Y0
G0Z4
G0X50Y0
G1Z-1F350
G1X60Y0F1200
G1X60Y4
G1X54Y4
G1X54Y10
G1X50Y10
G1X50Y0
G0Z4
M02
`;

const OPTS = {
  prevDiameter: 3.175,
  finishDiameter: 0.5,
  plungeFeed: 350,
  feedCap: 500,
  clearance: 5,
  rapidRate: 5000,
  accel: 400,
};

const ROPTS = {
  tsp: true,
  clearance: "auto" as const,
  margin: 1.0,
  rapidRate: 5000,
  accel: 400,
};

function restPipeline() {
  const prog = parse(THREE_POCKETS);
  const { text: jt } = janitor(prog, { tolerance: 0.01, decimals: 3 });
  const jp = parse(jt);
  const rc = applyRestCut(jp.blocks, OPTS);
  assert.ok(rc.regionsCut > 0, "fixture must produce rest cuts");
  const rap = optimizeRapids(rc.blocks, ROPTS);
  return { rc, rap };
}

describe("v4.2 rest spans atomic wrt rapids reorder", () => {
  it("findRestSpans brackets every op with its END", () => {
    const { rc } = restPipeline();
    const spans = findRestSpans(rc.blocks);
    const starts = rc.blocks.filter(
      (b) => b.passthrough && b.raw.includes("BUILDIT REST op="),
    ).length;
    assert.equal(spans.length, starts);
    for (const s of spans) {
      assert.ok(
        rc.blocks[s.to].raw.includes("BUILDIT REST END"),
        "span must end at END marker",
      );
    }
  });

  it("rapids keeps every rest span contiguous and marker-paired", () => {
    const { rap } = restPipeline();
    assert.ok(
      rap.stats.sitesReordered > 0,
      "fixture must actually reorder (else atomicity is vacuous)",
    );
    const spans = findRestSpans(rap.blocks);
    assert.ok(spans.length > 0, "spans must survive rapids");
    const out = emit({ blocks: rap.blocks }, 3, true);
    const starts = out
      .split("\n")
      .filter((l) => l.includes("BUILDIT REST op=")).length;
    const ends = out
      .split("\n")
      .filter((l) => l.includes("BUILDIT REST END")).length;
    assert.equal(starts, ends, "markers must stay paired after reorder");
    assert.equal(spans.length, starts);
    // No site traverse opens inside a span: every span interior block
    // index is strictly between its markers with nothing interleaved.
    for (const s of spans) {
      assert.ok(s.to > s.from + 2, "span must contain cut moves");
      assert.ok(
        rap.blocks[s.from].raw.includes("BUILDIT REST op="),
        "span opens at op marker",
      );
    }
  });

  it("each span keeps its G1 cut order and its own parent after reorder", () => {
    // Strict per-span fingerprint, keyed by op id: G1 XY cut sequence
    // (clearance lowering may rewrite G0 Z, never G1 XY) plus the exact
    // parent loop-end block before START. Micro-site permutation (the
    // pre-v4.2 shattering) scrambles interior G1 order via 2-opt
    // reversals and re-attaches spans to foreign parents — both fail here.
    const spanInfo = (blocks: Block[]) => {
      const out = new Map<string, { g1xy: string[]; parent: string }>();
      for (const s of findRestSpans(blocks)) {
        const op = blocks[s.from].raw.match(/op=\d+/)?.[0] ?? `span@${s.from}`;
        const g1xy: string[] = [];
        for (let i = s.from + 1; i < s.to; i++) {
          const b = blocks[i];
          if (
            !b.passthrough &&
            b.motion === 1 &&
            (b.coords.X !== undefined || b.coords.Y !== undefined)
          )
            g1xy.push(JSON.stringify(b.coords));
        }
        const p = blocks[s.from - 1];
        out.set(op, {
          g1xy,
          parent: `${p.motion}:${JSON.stringify(p.coords)}`,
        });
      }
      return out;
    };
    const { rc, rap } = restPipeline();
    const pre = spanInfo(rc.blocks);
    const post = spanInfo(rap.blocks);
    assert.equal(post.size, pre.size, "span count must survive rapids");
    for (const [op, info] of pre) {
      const after = post.get(op);
      assert.ok(after, `span ${op} lost by rapids`);
      assert.deepEqual(
        after.g1xy,
        info.g1xy,
        `span ${op} interior permuted by site reorder`,
      );
      assert.equal(
        after.parent,
        info.parent,
        `span ${op} re-attached to a foreign parent`,
      );
    }
  });
});
