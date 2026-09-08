import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "../src/parser.ts";
import { emit, janitor } from "../src/janitor.ts";
import {
  applyRestCut,
  maybeApplyRestCut,
  pointContained,
  type RestCutOptions,
} from "../src/restcut.ts";
import { analyzeRest } from "../src/rest2d.ts";
import { trackMoves } from "../src/parser.ts";

import { CORPUS } from "./corpus.ts";
const SHARP = `${CORPUS}/happy-w-1-16.c2d.nc`; // sharp concave corners
const FACETED = `${CORPUS}/happy-w-half-mil.c2d.nc`; // faceted micro-corners

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

function janitorBlocks(path: string) {
  const prog = parse(readFileSync(path, "utf8"));
  return parse(janitor(prog, { tolerance: 0.01, decimals: 3 }).text).blocks;
}

function stockTop(blocks: ReturnType<typeof janitorBlocks>): number {
  let top = -Infinity;
  for (const m of trackMoves({ blocks })) {
    if (m.block.motion === 1) top = Math.max(top, m.to[2]);
  }
  return Number.isFinite(top) ? top : 0;
}

const sharpBlocks = janitorBlocks(SHARP);
const sharpClear = stockTop(sharpBlocks) + 1.0;
const OPTS: RestCutOptions = {
  prevDiameter: 3.175,
  finishDiameter: 1.5875,
  plungeFeed: 350,
  clearance: sharpClear,
  rapidRate: 5000,
  accel: 400,
};
const res = applyRestCut(sharpBlocks, OPTS);

describe("restcut v4", () => {
  it("emits rest blocks on sharp-corner corpus geometry", () => {
    assert.ok(res.regionsCut > 0, "expected >0 regions cut");
    assert.ok(res.restBlocks.length > 0);
    assert.ok(res.addedSec > 0);
  });

  it("(a) every emitted cut point is contained", () => {
    // Index walk over restBlocks: G1 blocks WITH XY are cut moves and
    // must lie in a rest region at the current depth. Z-only G1s are
    // plunge entries (XY = contained pass start) or the reposition tail
    // (XY = already-cut loop end, followed by the coord-less restore).
    const pos: [number, number, number] = [0, 0, 0];
    let checked = 0;
    const atZ = (z: number) =>
      res.regions.filter((r) => Math.abs(r.loopZ - z) < 1e-9);
    const containedAt = (x: number, y: number, z: number) =>
      atZ(z).some((r) =>
        pointContained([x, y], r.loopPts, r.outer, r.inner, r.rf),
      );
    for (let i = 0; i < res.restBlocks.length; i++) {
      const b = res.restBlocks[i];
      if (b.passthrough || b.motion === null) continue;
      if (b.coords.X !== undefined) pos[0] = b.coords.X;
      if (b.coords.Y !== undefined) pos[1] = b.coords.Y;
      if (b.coords.Z !== undefined) pos[2] = b.coords.Z;
      if (b.motion !== 1) continue;
      if (b.coords.X !== undefined) {
        assert.ok(
          containedAt(pos[0], pos[1], pos[2]),
          `uncontained cut ${pos[0]},${pos[1]} @ z=${pos[2]}`,
        );
        checked++;
      } else if (b.coords.Z !== undefined) {
        // Z-only G1: plunge entry or reposition tail.
        if (!containedAt(pos[0], pos[1], pos[2])) {
          const nxt = res.restBlocks[i + 1];
          assert.ok(
            nxt && !nxt.passthrough && Object.keys(nxt.coords).length === 0,
            `non-contained Z-only G1 not followed by restore`,
          );
        } else {
          checked++;
        }
      }
    }
    assert.ok(checked > 0, "no cut points checked");
  });

  it("(b) Z depths only ever equal parent-op depths", () => {
    const zs = [...new Set(res.regions.map((r) => r.loopZ))];
    assert.ok(zs.length > 0);
    // Re-walk with block identity to skip the coord-less modal restore.
    const pos: [number, number, number] = [0, 0, 0];
    for (const b of res.restBlocks) {
      if (b.passthrough || b.motion === null) continue;
      if (Object.keys(b.coords).length === 0) continue; // restore line
      if (b.coords.X !== undefined) pos[0] = b.coords.X;
      if (b.coords.Y !== undefined) pos[1] = b.coords.Y;
      if (b.coords.Z !== undefined) pos[2] = b.coords.Z;
      if (b.motion !== 1) continue;
      assert.ok(
        zs.some((z) => Math.abs(z - pos[2]) < 1e-9),
        `rest Z ${pos[2]} not a parent loop depth`,
      );
    }
  });

  it("(c) entry/exit via clearance: proven file height, not stockTop+1", () => {
    // v4.2: rest reuses the file's proven traverse height (4.0) instead
    // of the blind stockTop+1 plane (5.027 — the stockTop is a G1
    // air-ramp endpoint, not material). Re-derive the expectation here:
    // min(auto, lowest G0-XY-traverse >= maxLoopZ+0.5).
    let maxLoopZ = -Infinity;
    for (const r of res.regions) maxLoopZ = Math.max(maxLoopZ, r.loopZ);
    let proven = Infinity;
    for (const m of trackMoves({ blocks: sharpBlocks })) {
      if (m.block.motion !== 0 || m.dist <= 1e-9) continue;
      if (Math.hypot(m.to[0] - m.from[0], m.to[1] - m.from[1]) <= 1e-9)
        continue;
      if (m.to[2] >= maxLoopZ + 0.5) proven = Math.min(proven, m.to[2]);
    }
    const C = Math.min(sharpClear, proven);
    assert.equal(C, 4.0);
    assert.ok(C < sharpClear, "reuse must fire on this corpus");
    const zs = new Set(res.regions.map((r) => r.loopZ));
    // Split into cycles at wrapper comments.
    const cycles: (typeof res.restBlocks)[] = [];
    let cur: typeof res.restBlocks = [];
    for (const b of res.restBlocks) {
      if (b.passthrough && b.raw.includes("BUILDIT REST")) {
        if (cur.length > 0) cycles.push(cur);
        cur = [];
      } else {
        cur.push(b);
      }
    }
    if (cur.length > 0) cycles.push(cur);
    assert.ok(cycles.length > 0);
    for (const cyc of cycles) {
      // Trailing modal-restore: coord-less explicit block.
      const last = cyc[cyc.length - 1];
      assert.equal(Object.keys(last.coords).length, 0);
      const body = cyc.slice(0, -1);
      let z = NaN;
      let i = 0;
      let sawCut = false;
      while (i < body.length) {
        // Reposition tail (per-loop, after all plunge cycles): G0 XY.
        if (sawCut && body[i].motion === 0 && body[i].coords.X !== undefined)
          break;
        // G0 Z clearance
        assert.equal(body[i].motion, 0);
        assert.ok(body[i].coords.Z !== undefined);
        z = body[i].coords.Z as number;
        assert.ok(Math.abs(z - C) < 1e-9, `retract not at clearance: ${z}`);
        i++;
        // G0 XY at clearance
        assert.equal(body[i].motion, 0);
        assert.ok(body[i].coords.X !== undefined);
        assert.ok(Math.abs(z - C) < 1e-9);
        i++;
        // G1 Z-only plunge to a loop depth
        assert.equal(body[i].motion, 1);
        assert.equal(body[i].coords.X, undefined);
        assert.equal(body[i].coords.Y, undefined);
        z = body[i].coords.Z as number;
        assert.ok(zs.has(z), `plunge to non-parent depth ${z}`);
        i++;
        // G1 XY cuts at depth
        let n = 0;
        while (
          i < body.length &&
          body[i].motion === 1 &&
          body[i].coords.X !== undefined
        ) {
          n++;
          sawCut = true;
          i++;
        }
        assert.ok(n >= 1, "plunge with no cut moves");
        // G0 Z retract
        assert.equal(body[i].motion, 0);
        z = body[i].coords.Z as number;
        assert.ok(Math.abs(z - C) < 1e-9);
        i++;
      }
      assert.ok(sawCut);
      // Optional position restore: G0 XY at clearance (+ G1 Z-only back
      // to loop-end depth), returning to the exact insertion position.
      if (
        i < body.length &&
        body[i].motion === 0 &&
        body[i].coords.X !== undefined
      ) {
        i++;
      }
      if (
        i < body.length &&
        body[i].motion === 1 &&
        body[i].coords.X === undefined &&
        body[i].coords.Y === undefined
      ) {
        i++;
      }
      // Trailing modal-restore already verified above via `last`;
      // body must be fully consumed (restore was sliced off).
      assert.equal(i, body.length);
    }
  });

  it("(f) explicit-high user clearance is preserved, not thriftily lowered", () => {
    // --clearance 99 means tall clamps: user intent wins over reuse.
    const b = parse(ELL).blocks;
    const r = applyRestCut(b, {
      prevDiameter: 6,
      finishDiameter: 1,
      plungeFeed: 300,
      clearance: 99,
      rapidRate: 5000,
      accel: 400,
    });
    assert.ok(r.regionsCut > 0);
    const retracts = new Set<number>();
    for (const blk of r.restBlocks) {
      if (
        !blk.passthrough &&
        blk.motion === 0 &&
        blk.coords.Z !== undefined &&
        blk.coords.X === undefined &&
        blk.coords.Y === undefined
      )
        retracts.add(blk.coords.Z);
    }
    assert.deepEqual([...retracts], [99]);
  });

  it("(g) no qualifying traverse falls back to stockTop+1", () => {
    // All G0 XY motion at/below the loops: nothing proven safe above,
    // so the conservative plane stands. stockTop here is -1 -> plane 0.
    const LOW = `G90
G21
G0Z-0.9
G0X0Y0
G1Z-1F300
G1X10Y0
G1X10Y4
G1X4Y4
G1X4Y10
G1X0Y10
G1X0Y0
G0Z-0.9
`;
    const b = parse(LOW).blocks;
    const r = applyRestCut(b, {
      prevDiameter: 6,
      finishDiameter: 1,
      plungeFeed: 300,
      clearance: 0, // auto-like: below stockTop+1, reuse gate open
      rapidRate: 5000,
      accel: 400,
    });
    assert.ok(r.regionsCut > 0, "expected rest cuts on L pocket");
    const retracts = new Set<number>();
    for (const blk of r.restBlocks) {
      if (
        !blk.passthrough &&
        blk.motion === 0 &&
        blk.coords.Z !== undefined &&
        blk.coords.X === undefined &&
        blk.coords.Y === undefined
      )
        retracts.add(blk.coords.Z);
    }
    assert.deepEqual([...retracts], [0]);
  });
  it("(d) disabled-by-default returns the identical reference", () => {
    const off = maybeApplyRestCut(sharpBlocks, false, OPTS);
    assert.equal(off.blocks, sharpBlocks, "flag-off must not copy blocks");
    assert.equal(off.restBlocks.length, 0);
    const defCLI = maybeApplyRestCut(sharpBlocks, false, {
      ...OPTS,
      clearance: 99,
    });
    assert.equal(defCLI.blocks, sharpBlocks);
  });

  it("(e) appended blocks survive the fidelity round-trip", () => {
    const out = emit({ blocks: res.blocks }, 3, true);
    const rp = parse(out);
    // Reparse appends one trailing empty passthrough for the final newline.
    assert.ok(
      rp.blocks.length === res.blocks.length ||
        (rp.blocks.length === res.blocks.length + 1 &&
          rp.blocks[rp.blocks.length - 1].passthrough),
      "emit must be 1:1 (plus trailing newline block)",
    );
    const restSet = new Set(res.restBlocks);
    const intended = trackMoves({ blocks: res.blocks }).filter((m) =>
      restSet.has(m.block),
    );
    assert.ok(intended.length > 0, "no rest moves to verify");
    // Pairwise move comparison (emit is 1:1 except fully-redundant
    // coord-less restores, which grbl-equivalent minimal emit drops).
    const allIntended = trackMoves({ blocks: res.blocks });
    const allActual = trackMoves(rp);
    const nz = (m: { dist: number }) => m.dist > 1e-9;
    const iMoves = allIntended.filter(nz);
    const aMoves = allActual.filter(nz);
    assert.equal(aMoves.length, iMoves.length);
    for (let i = 0; i < iMoves.length; i++) {
      const a = iMoves[i];
      const b = aMoves[i];
      assert.ok(
        Math.hypot(b.to[0] - a.to[0], b.to[1] - a.to[1], b.to[2] - a.to[2]) <
          0.001,
        `round-trip drift at move ${i}`,
      );
    }
    assert.ok(intended.length > 0);
  });

  it("original stream untouched: non-rest moves identical", () => {
    const restSet = new Set(res.restBlocks);
    const origMoves = trackMoves({ blocks: sharpBlocks });
    const kept = trackMoves({ blocks: res.blocks }).filter(
      (m) => !restSet.has(m.block),
    );
    assert.equal(kept.length, origMoves.length);
    for (let i = 0; i < origMoves.length; i++) {
      const a = origMoves[i];
      const b = kept[i];
      assert.equal(b.block.motion, a.block.motion);
      assert.equal(b.block.feed, a.block.feed);
      assert.ok(Math.hypot(b.to[0] - a.to[0], b.to[1] - a.to[1]) < 1e-9);
    }
  });

  it("ELL synthetic: sharp 90-degree corner emits at loop depth", () => {
    const b = parse(ELL).blocks;
    const r = applyRestCut(b, {
      prevDiameter: 6,
      finishDiameter: 1,
      plungeFeed: 300,
      clearance: 5,
      rapidRate: 5000,
      accel: 400,
    });
    assert.ok(r.regionsCut > 0);
    for (const m of trackMoves({ blocks: r.blocks })) {
      if (!new Set(r.restBlocks).has(m.block)) continue;
      if (m.block.motion !== 1) continue;
      if (Object.keys(m.block.coords).length === 0) continue; // modal restore
      assert.ok(Math.abs(m.to[2] - -1) < 1e-9);
    }
  });

  it("faceted micro-corners: rest exists but correctly declined (no overcut)", () => {
    const fb = janitorBlocks(FACETED);
    const a = analyzeRest(fb, 3.175, 1.0);
    assert.ok(a.totalRestArea > 0.1, "rest must exist for this verdict");
    const r = applyRestCut(fb, {
      prevDiameter: 3.175,
      finishDiameter: 1.0,
      plungeFeed: 350,
      clearance: stockTop(fb) + 1.0,
      rapidRate: 5000,
      accel: 400,
    });
    assert.equal(
      r.regionsCut,
      0,
      "faceted micro-rest is uncontainable: must decline, not overcut",
    );
    assert.equal(r.restBlocks.length, 0);
  });
});

describe("rest span end markers (v4.1)", () => {
  it("emits one BUILDIT REST END per span", async () => {
    const { janitor } = await import("../src/janitor.ts");
    const { maybeApplyRestCut } = await import("../src/restcut.ts");
    const { emit } = await import("../src/janitor.ts");
    const { parse } = await import("../src/parser.ts");
    // Synthetic pocket: square loop at two depths, prev tool leaves corners.
    const prog = parse(
      [
        "G90",
        "G21",
        "G0Z4",
        "G0X0Y0",
        "G1Z-1F350",
        "G1X0Y10F1200",
        "G1X10Y10",
        "G1X10Y0",
        "G1X0Y0",
        "G0Z4",
        "M02",
        "",
      ].join("\n"),
    );
    const { text: jt } = janitor(prog, { tolerance: 0.01, decimals: 3 });
    const jp = parse(jt);
    const rc = maybeApplyRestCut(jp.blocks, true, {
      prevDiameter: 3.175,
      finishDiameter: 0.5,
      plungeFeed: 350,
      feedCap: 500,
      clearance: 5,
      rapidRate: 5000,
      accel: 400,
    });
    const out = emit({ blocks: rc.blocks }, 3, true);
    const starts = out
      .split("\n")
      .filter((l) => l.includes("BUILDIT REST op="));
    const ends = out.split("\n").filter((l) => l.includes("BUILDIT REST END"));
    assert.equal(ends.length, starts.length);
  });
});
