import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "../src/parser.ts";
import { janitor } from "../src/janitor.ts";
import { auditBlocks, cornerResidue } from "../src/check.ts";
import { cornerGeoms, extractLoops } from "../src/rest2d.ts";

import { CORPUS, corpusSkip } from "./corpus.ts";

// 10x1 slot pocket at z=-1: opposite walls 1.0 apart.
const SLOT1 = `G90
G21
G0Z4
G0X0Y0
G1Z-1F350
G1X10Y0F1200
G1X10Y1
G1X0Y1
G1X0Y0
G0Z4
M02
`;

// Same footprint, 4 wide: fits a 3.175 tool.
const SLOT4 = `G90
G21
G0Z4
G0X0Y0
G1Z-1F350
G1X10Y0F1200
G1X10Y4
G1X0Y4
G1X0Y0
G0Z4
M02
`;

// L pocket with a sharp 90-degree concave corner.
const ELL = `G90
G21
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
M02
`;

function audit(text: string, tool: number, prev?: number) {
  const prog = parse(text);
  const { text: jt } = janitor(prog, { tolerance: 0.01, decimals: 3 });
  return auditBlocks(parse(jt).blocks, {
    toolDiameter: tool,
    prevDiameter: prev,
  });
}

describe("check: narrow channels", () => {
  it("flags a 1mm slot under a 3.175 tool with the true width", () => {
    const r = audit(SLOT1, 3.175);
    assert.equal(r.channels.length, 1);
    assert.ok(
      Math.abs(r.channels[0].width - 1.0) < 0.01,
      `width ${r.channels[0].width}`,
    );
  });

  it("passes a 4mm slot under the same tool", () => {
    const r = audit(SLOT4, 3.175);
    assert.equal(r.channels.length, 0);
    assert.ok(r.clean);
  });
});

describe("check: tiny arcs", () => {
  it("flags input arcs tighter than the tool radius", () => {
    const g = `G90
G21
G0Z4
G0X10Y0
G1Z-1F300
G2X10Y0I-0.5J0F500
G0Z4
M02
`;
    const r = audit(g, 3.175);
    assert.equal(r.tinyArcs.length, 1);
    assert.ok(Math.abs(r.tinyArcs[0].r - 0.5) < 1e-9);
  });

  it("passes arcs the tool can swing", () => {
    const g = `G90
G21
G0Z4
G0X10Y0
G1Z-1F300
G2X10Y0I-10J0F500
G0Z4
M02
`;
    const r = audit(g, 3.175);
    assert.equal(r.tinyArcs.length, 0);
  });
});

describe("check: corner residue", () => {
  it("needs the rough tool: no prev means no corner verdict", () => {
    const r = audit(ELL, 0.5);
    assert.equal(r.corners.length, 0);
  });

  it("flags the 90-degree wedge after a 3.175 rough, 0.5 finish", () => {
    const r = audit(ELL, 0.5, 3.175);
    assert.ok(r.corners.length > 0, "expected residue corners");
    // Analytic wedge for 90 degrees: (Rp^2-Rf^2)(1-pi/4).
    const want = (1.5875 ** 2 - 0.25 ** 2) * (1 - Math.PI / 4);
    const worst = r.corners.reduce((a, c) => Math.max(a, c.residue), 0);
    assert.ok(
      Math.abs(worst - want) < 0.05,
      `worst ${worst} vs analytic ${want}`,
    );
    // ... and the corner is reported as square.
    assert.ok(
      r.corners.some((c) => Math.abs(c.angleDeg - 90) < 1),
      "no 90-degree corner reported",
    );
  });

  it("prev <= finish leaves nothing behind", () => {
    const r = audit(ELL, 3.175, 3.175);
    assert.equal(r.corners.length, 0);
  });

  it("cornerResidue matches the rest2d analytic", () => {
    const prog = parse(ELL);
    const { text: jt } = janitor(prog, { tolerance: 0.01, decimals: 3 });
    const loops = extractLoops(parse(jt).blocks);
    assert.ok(loops.length > 0);
    const geoms = cornerGeoms(loops[0]);
    assert.ok(geoms.length > 0);
    const g = geoms[0];
    const residue = cornerResidue(g, 1.5875, 0.25);
    const want =
      (1.5875 ** 2 - 0.25 ** 2) * (1 / Math.tan(g.beta) - Math.PI / 2 + g.beta);
    assert.ok(Math.abs(residue - want) < 1e-12);
  });
});

describe("check: waist readout (report-only, never graded)", () => {
  it("flags a 1mm slot waist with the true width and wall run", () => {
    const r = audit(SLOT1, 3.175);
    assert.equal(r.waists.length, 1);
    assert.ok(Math.abs(r.waists[0].width - 1.0) < 0.01);
    assert.ok(r.waists[0].runMM >= 3.175, `run ${r.waists[0].runMM}`);
    // Legacy verdict untouched: the narrow flag still stands.
    assert.equal(r.channels.length, 1);
  });

  it("passes a 4mm slot: no waist under the same tool", () => {
    const r = audit(SLOT4, 3.175);
    assert.equal(r.waists.length, 0);
    assert.ok(r.clean);
  });

  it(
    "collapses happy-w-1-16 fold flags toward the genuine waists",
    corpusSkip,
    () => {
      const prog = parse(readFileSync(`${CORPUS}/happy-w-1-16.c2d.nc`, "utf8"));
      const { text: jt } = janitor(prog, { tolerance: 0.01, decimals: 3 });
      const r = auditBlocks(parse(jt).blocks, {
        toolDiameter: 1.5875,
        prevDiameter: 3.175,
      });
      // Legacy readout still buries the file in i/i+2 fold flags.
      assert.equal(r.channels.length, 40);
      // Separation readout collapses toward the ~8 genuine waist loops.
      assert.ok(
        r.waists.length >= 6 && r.waists.length <= 10,
        `waists ${r.waists.length}`,
      );
      assert.ok(r.waists.length < r.channels.length / 2);
      for (const w of r.waists) {
        assert.ok(w.width < 1.5875, `width ${w.width}`);
        assert.ok(w.runMM >= 1.5875, `run ${w.runMM}`);
      }
    },
  );
});

// Boss (island) fixture: 12x12 CCW pocket with a centered 6x6 CW boss.
// Moat is (12-6)/2 = 3.0mm on every side.
const BOSS = `G90
G21
G0Z4
G0X0Y0
G1Z-1F350
G1X12Y0F1200
G1X12Y12
G1X0Y12
G1X0Y0
G0Z4
G0X3Y3
G1Z-1F350
G1X3Y9F1200
G1X9Y9
G1X9Y3
G1X3Y3
G0Z4
M02
`;

// Same footprint, both loops CCW: linked stepover passes, not an island.
const LINKED = `G90
G21
G0Z4
G0X0Y0
G1Z-1F350
G1X12Y0F1200
G1X12Y12
G1X0Y12
G1X0Y0
G0Z4
G0X3Y3
G1Z-1F350
G1X9Y3F1200
G1X9Y9
G1X3Y9
G1X3Y3
G0Z4
M02
`;

describe("check: island candidates (report-only, never graded)", () => {
  it("flags a synthetic OPP boss with the true moat", () => {
    const r = audit(BOSS, 3.175);
    assert.equal(r.islands.length, 1);
    assert.ok(Math.abs(r.islands[0].moat - 3.0) < 0.01);
    // Square boss compactness 4*pi*36/24^2 ~ 0.785.
    assert.ok(Math.abs(r.islands[0].compactness - 0.785) < 0.01);
    // Report-only: the file still audits clean, exit code unaffected.
    assert.ok(r.clean);
  });

  it("ignores same-winding linked passes", () => {
    const r = audit(LINKED, 3.175);
    assert.equal(r.islands.length, 0);
  });

  it(
    "finds no islands on shark-top-clear (same-winding stepovers)",
    corpusSkip,
    () => {
      const prog = parse(
        readFileSync(`${CORPUS}/shark-top-clear.c2d.nc`, "utf8"),
      );
      const { text: jt } = janitor(prog, { tolerance: 0.01, decimals: 3 });
      const r = auditBlocks(parse(jt).blocks, {
        toolDiameter: 1.5875,
        prevDiameter: 3.175,
      });
      assert.equal(r.islands.length, 0);
      assert.equal(r.channels.length, 10);
    },
  );

  it(
    "reports island candidates with gated moats on happy-w-half-mil",
    corpusSkip,
    () => {
      const prog = parse(
        readFileSync(`${CORPUS}/happy-w-half-mil.c2d.nc`, "utf8"),
      );
      const { text: jt } = janitor(prog, { tolerance: 0.01, decimals: 3 });
      const r = auditBlocks(parse(jt).blocks, {
        toolDiameter: 1.5875,
        prevDiameter: 3.175,
      });
      assert.ok(r.islands.length > 0, "expected island candidates");
      for (const isl of r.islands) {
        assert.ok(isl.moat < 1.5875, `moat ${isl.moat}`);
        assert.ok(isl.compactness >= 0.5, `compact ${isl.compactness}`);
      }
    },
  );
});

describe(
  "check: existing verdicts unchanged (report-only guard)",
  corpusSkip,
  () => {
    it("locks graded flag counts on the three spot-check files", () => {
      const cases = [
        {
          file: "shark-top-clear.c2d.nc",
          loops: 10,
          ch: 10,
          tiny: 0,
          corn: 77,
        },
        { file: "happy-w-1-16.c2d.nc", loops: 40, ch: 40, tiny: 0, corn: 44 },
        {
          file: "happy-w-half-mil.c2d.nc",
          loops: 300,
          ch: 300,
          tiny: 0,
          corn: 451,
        },
      ] as const;
      for (const c of cases) {
        const prog = parse(readFileSync(`${CORPUS}/${c.file}`, "utf8"));
        const { text: jt } = janitor(prog, { tolerance: 0.01, decimals: 3 });
        const r = auditBlocks(parse(jt).blocks, {
          toolDiameter: 1.5875,
          prevDiameter: 3.175,
        });
        assert.equal(r.loopsFound, c.loops, c.file);
        assert.equal(r.channels.length, c.ch, c.file);
        assert.equal(r.tinyArcs.length, c.tiny, c.file);
        assert.equal(r.corners.length, c.corn, c.file);
        assert.equal(r.clean, false, c.file);
      }
    });
  },
);
describe("check: corpus", corpusSkip, () => {
  it("runs clean-structured on happy-w-1-16 with 1/16 + 1/8 prev", () => {
    const prog = parse(readFileSync(`${CORPUS}/happy-w-1-16.c2d.nc`, "utf8"));
    const { text: jt } = janitor(prog, { tolerance: 0.01, decimals: 3 });
    const r = auditBlocks(parse(jt).blocks, {
      toolDiameter: 1.5875,
      prevDiameter: 3.175,
    });
    assert.ok(r.loopsFound > 0, "no loops extracted");
    // 144 rest regions get cut on this file: residue must exist.
    assert.ok(r.corners.length > 0, "expected hand-work corners");
    assert.ok(!r.clean, "file with known rest should not audit clean");
  });
});
