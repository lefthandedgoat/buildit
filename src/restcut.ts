// v4 rest cleanup cut paths.
//
// Turns v3 rest-region ANALYSIS into emitted G1 cleanup toolpaths for 2.5D
// pockets. Runs on the post-janitor stream (pre-arcs: G1 loops still
// exist), inserting cleanup immediately after each parent pocket loop.
//
// Cleanup strategy per concave corner: serpentine stitch passes with the
// finish tool at the parent loop's own Z depth — never invents depths.
// Candidate points are FILTERED through the containment property and only
// surviving runs are emitted:
//
//   (a) inside the pocket polygon AND >= 0.9*rf from its walls
//       (never cuts the pocket wall — 10% tool-radius margin);
//   (b) within 0.5*rf of the exact rest region
//       (outer A(Rp) boundary minus inner A(Rf) hole, arcs sampled at 1°).
//
// Rest region boundary per corner: V -> T1 (tangent point on edge 1) ->
// minor arc of the tangent circle -> T2 -> V. The minor arc faces V by
// construction (central angle pi-2*beta < pi).
//
// Modal safety: every emitted block is fully explicit (G-word, coords,
// feed). After the retract, a modal-restore line (G1F<prev> or bare G0)
// re-establishes the modal state active before insertion, so following
// original continuation lines inherit exactly what they expect.

import { type Block, trackMoves } from "./parser.ts";
import {
  type CornerGeom,
  type Loop,
  cornerGeoms,
  extractLoops,
  loopRest,
} from "./rest2d.ts";
import { blockTime } from "./estimate.ts";

export interface RestCutOptions {
  prevDiameter: number;
  finishDiameter: number;
  /** Straight-plunge feed for region entries. */
  plungeFeed: number;
  /** Clearance plane for approach/retract. */
  clearance: number;
  /** Rapid rate mm/min for added-time math. */
  rapidRate: number;
  /** Accel mm/s^2 for added-time math. */
  accel: number;
  /** Parent-op feed cap for cleanup cuts. Default 500. */
  feedCap?: number;
  /** Largest loops to consider. Default 8 (matches v3). */
  maxLoops?: number;
}

export interface CutRegion {
  loopZ: number;
  loopPts: [number, number][];
  /** Sampled outer rest boundary polyline (closed). */
  outer: [number, number][];
  /** Sampled inner (already-cleared) boundary polyline (closed). */
  inner: [number, number][];
  rf: number;
}

export interface RestCutResult {
  blocks: Block[];
  /** All inserted motion/comment blocks (for tests). */
  restBlocks: Block[];
  regions: CutRegion[];
  regionsCut: number;
  /** Added machine seconds (honest: rest ADDS time). */
  addedSec: number;
}

type Pt = [number, number];

const EPS = 1e-9;

function distToSeg(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function distToPoly(p: Pt, poly: Pt[]): number {
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) {
    d = Math.min(d, distToSeg(p, poly[i], poly[(i + 1) % poly.length]));
  }
  return d;
}

function insidePoly(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (
      yi > p[1] !== yj > p[1] &&
      p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi
    )
      inside = !inside;
  }
  return inside;
}

/** Sampled circle arc from angle a0 to a1 going the short (minor) way. */
function sampleArc(
  c: Pt,
  r: number,
  a0: number,
  a1: number,
  step = Math.PI / 180,
): Pt[] {
  let d = a1 - a0;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  const n = Math.max(2, Math.ceil(Math.abs(d) / step));
  const pts: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (d * i) / n;
    pts.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]);
  }
  return pts;
}

/** Rest boundary for one tool radius: V -> T1 -> minor arc -> T2 (open). */
function restBoundary(g: CornerGeom, r: number): Pt[] {
  const t = r / Math.tan(g.beta);
  const t1: Pt = [g.v[0] + g.u1[0] * t, g.v[1] + g.u1[1] * t];
  const t2: Pt = [g.v[0] + g.u2[0] * t, g.v[1] + g.u2[1] * t];
  // Bisector into the pocket; tangent-circle center sits along it.
  let mx = -(g.u1[0] + g.u2[0]);
  let my = -(g.u1[1] + g.u2[1]);
  const ml = Math.hypot(mx, my) || 1;
  mx /= ml;
  my /= ml;
  const dc = r / Math.sin(g.beta);
  const c: Pt = [g.v[0] + mx * dc, g.v[1] + my * dc];
  const arc = sampleArc(
    c,
    r,
    Math.atan2(t1[1] - c[1], t1[0] - c[0]),
    Math.atan2(t2[1] - c[1], t2[0] - c[0]),
  );
  return [g.v, t1, ...arc.slice(1, -1), t2];
}

/**
 * The containment property. Exported so tests re-verify every point.
 * `strict` (mm) tightens both margins for generation, so 3-decimal emit
 * rounding can never push an emitted point across the spec bounds.
 */
export function pointContained(
  p: Pt,
  loopPts: Pt[],
  outer: Pt[],
  inner: Pt[],
  rf: number,
  strict = 0,
): boolean {
  if (!insidePoly(p, loopPts)) return false;
  if (distToPoly(p, loopPts) < 0.9 * rf + strict - 1e-9) return false;
  const inOuter = insidePoly(p, outer);
  const inInner = insidePoly(p, inner);
  let dRest: number;
  if (inOuter && !inInner) {
    dRest = 0;
  } else {
    dRest = Math.min(distToPoly(p, outer), distToPoly(p, inner));
  }
  return dRest <= 0.5 * rf - strict + 1e-9;
}

function mkMotion(
  motion: 0 | 1,
  coords: { X?: number; Y?: number; Z?: number },
  feed: number,
): Block {
  return {
    line: 0,
    raw: "",
    passthrough: false,
    motion,
    explicitMotion: true,
    coords,
    // G0 ignores feed: never emit F0 (grbl rejects zero feed).
    explicitFeed: motion === 1,
    feed,
    misc: [],
  };
}

function mkComment(text: string): Block {
  return {
    line: 0,
    raw: `(${text})`,
    passthrough: true,
    motion: null,
    explicitMotion: false,
    coords: {},
    explicitFeed: false,
    feed: 0,
    misc: [],
  };
}

interface Pass {
  pts: Pt[];
}

/** Serpentine candidate passes for one corner, containment-filtered. */
function cornerPasses(
  g: CornerGeom,
  rp: number,
  rf: number,
  loopPts: Pt[],
  outer: Pt[],
  inner: Pt[],
  stepover: number,
): Pass[] {
  let mx = -(g.u1[0] + g.u2[0]);
  let my = -(g.u1[1] + g.u2[1]);
  const ml = Math.hypot(mx, my) || 1;
  mx /= ml;
  my /= ml;
  const nx = -my;
  const ny = mx;
  const tMax = rp / Math.tan(g.beta) + 0.5 * rf;
  const wMax = (rp / Math.tan(g.beta)) * 0.75 + rf;
  const passes: Pass[] = [];
  for (let k = 0; ; k++) {
    const w =
      k === 0 ? 0 : (k % 2 === 1 ? 1 : -1) * Math.ceil(k / 2) * stepover;
    if (Math.abs(w) > wMax + EPS) break;
    const run: Pt[] = [];
    for (let t = 0; t <= tMax + EPS; t += 0.05) {
      const p: Pt = [g.v[0] + mx * t + nx * w, g.v[1] + my * t + ny * w];
      if (pointContained(p, loopPts, outer, inner, rf, 0.002)) run.push(p);
    }
    // Keep maximal contiguous runs (0.05 step => gap > 0.06 splits).
    let cur: Pt[] = [];
    const flush = () => {
      if (cur.length >= 2) {
        const span = Math.hypot(
          cur[cur.length - 1][0] - cur[0][0],
          cur[cur.length - 1][1] - cur[0][1],
        );
        if (span >= 0.1) passes.push({ pts: cur });
      }
      cur = [];
    };
    for (const p of run) {
      if (
        cur.length > 0 &&
        Math.hypot(
          p[0] - cur[cur.length - 1][0],
          p[1] - cur[cur.length - 1][1],
        ) > 0.06
      )
        flush();
      cur.push(p);
    }
    flush();
    if (k > 200) break; // absolute guard
  }
  return passes;
}

/**
 * Build rest cleanup insertions on a post-janitor (pre-arcs) block stream.
 * Returns a NEW block array; input untouched. Disabled-by-default is
 * enforced by the caller (index.ts only calls when --rest-cut is set);
 * maybeApplyRestCut below returns the identical reference when off.
 */
export function applyRestCut(
  blocks: Block[],
  opts: RestCutOptions,
): RestCutResult {
  const rf = opts.finishDiameter / 2;
  const rp = opts.prevDiameter / 2;
  const feedCap = opts.feedCap ?? 500;
  const maxLoops = opts.maxLoops ?? 8;
  const empty: RestCutResult = {
    blocks,
    restBlocks: [],
    regions: [],
    regionsCut: 0,
    addedSec: 0,
  };
  if (opts.prevDiameter <= opts.finishDiameter) return empty;

  const loops: Loop[] = extractLoops(blocks)
    .sort((a, b) => b.area - a.area)
    .slice(0, maxLoops);

  // Stock top for the clearance plane (same convention as rapids).
  let stockTop = -Infinity;
  for (const m of trackMoves({ blocks })) {
    if (m.block.motion === 1) stockTop = Math.max(stockTop, m.to[2]);
  }
  if (!Number.isFinite(stockTop)) stockTop = 0;
  // v4.2: reuse the file's proven traverse height. stockTop can sit
  // ABOVE the file's own clearance when CAM leads with a G1 air-ramp
  // (happy-w-1-16: G1 up to 4.027 vs G0 traverses at 4.0 -> rest at
  // 5.027, ~1mm of pure waste x 148 retracts). The file demonstrably
  // flies XY at `proven` across the job and rest XYs are a subset
  // inside already-cut pockets, so min(auto, proven) is equally safe.
  // Guards: proven must clear the highest parent loop by 0.5mm, and an
  // explicit-high user clearance (opts.clearance > stockTop+1) is
  // preserved verbatim — user intent wins over thrift.
  const autoPlane = Math.max(opts.clearance, stockTop + 1.0);
  let clearance = autoPlane;
  if (opts.clearance <= stockTop + 1.0 + 1e-9) {
    let maxLoopZ = -Infinity;
    for (const l of loops) maxLoopZ = Math.max(maxLoopZ, l.z);
    let proven = Infinity;
    for (const m of trackMoves({ blocks })) {
      if (m.block.motion !== 0 || m.dist <= EPS) continue;
      if (Math.hypot(m.to[0] - m.from[0], m.to[1] - m.from[1]) <= EPS) continue;
      if (m.to[2] >= maxLoopZ + 0.5) proven = Math.min(proven, m.to[2]);
    }
    if (Number.isFinite(proven)) clearance = Math.min(autoPlane, proven);
  }

  // Absolute end position per block, for the position restore below:
  // partial-coordinate continuations after the insertion must inherit
  // the exact position they would have had without us.
  const endPos = new Map<Block, [number, number, number]>();
  for (const m of trackMoves({ blocks })) endPos.set(m.block, m.to);

  interface Insertion {
    at: number;
    blocks: Block[];
  }
  const insertions: Insertion[] = [];
  const regions: CutRegion[] = [];
  const restBlocks: Block[] = [];
  let addedSec = 0;
  let regionsCut = 0;
  let opId = 0;

  for (const loop of loops) {
    const { restArea } = loopRest(loop, opts.prevDiameter, opts.finishDiameter);
    if (restArea <= 0.01) continue;
    const geoms = cornerGeoms(loop);
    if (geoms.length === 0) continue;
    const parentFeed = blocks[loop.endBi]?.feed ?? 0;
    const cutFeed = Math.min(parentFeed > 0 ? parentFeed : feedCap, feedCap);
    const stepover = 0.3 * opts.finishDiameter;

    const seq: Block[] = [
      mkComment(
        `BUILDIT REST op=${opId} tool=${opts.finishDiameter} z=${loop.z}`,
      ),
    ];
    let loopRegions = 0;
    for (const g of geoms) {
      const outer = restBoundary(g, rp);
      const inner = restBoundary(g, rf);
      regions.push({ loopZ: loop.z, loopPts: loop.pts, outer, inner, rf });
      const passes = cornerPasses(g, rp, rf, loop.pts, outer, inner, stepover);
      for (const pass of passes) {
        const [x0, y0] = pass.pts[0];
        seq.push(mkMotion(0, { Z: clearance }, 0));
        addedSec += blockTime(1, opts.rapidRate, opts.accel); // nominal; refined below
        seq.push(mkMotion(0, { X: x0, Y: y0 }, 0));
        seq.push(mkMotion(1, { Z: loop.z }, opts.plungeFeed));
        pass.pts.forEach(([x, y], i) => {
          if (i === 0) return; // plunge point already targeted by the G0
          seq.push(mkMotion(1, { X: x, Y: y }, cutFeed));
        });
        seq.push(mkMotion(0, { Z: clearance }, 0));
        loopRegions++;
      }
    }
    if (loopRegions === 0) {
      // No emittable passes: drop the region records for this loop.
      regions.splice(regions.length - geoms.length, geoms.length);
      continue;
    }
    // Position restore: return to the exact insertion-point position at
    // clearance, then back down (pocket interior here is already cut),
    // so following partial-coordinate continuations inherit correctly.
    // Then the modal restore re-establishes motion+feed.
    const prevMotion = blocks[loop.endBi]?.motion ?? 1;
    const ep = endPos.get(blocks[loop.endBi]) ?? [0, 0, loop.z];
    seq.push(mkMotion(0, { X: ep[0], Y: ep[1] }, 0));
    if (Math.abs(ep[2] - clearance) > 1e-9) {
      seq.push(mkMotion(1, { Z: ep[2] }, opts.plungeFeed));
    }
    if (prevMotion === 1) {
      seq.push({
        line: 0,
        raw: "",
        passthrough: false,
        motion: 1,
        explicitMotion: true,
        coords: {},
        explicitFeed: true,
        feed: parentFeed,
        misc: [],
      });
    } else {
      seq.push({
        line: 0,
        raw: "",
        passthrough: false,
        motion: 0,
        explicitMotion: true,
        coords: {},
        explicitFeed: false,
        feed: parentFeed,
        misc: [],
      });
    }
    opId++;
    regionsCut += loopRegions;
    // Explicit terminator: downstream stages (arcs) and external tools
    // (viewer) must be able to delimit inserted spans. Survives emit as
    // a passthrough comment line.
    seq.push(mkComment("BUILDIT REST END"));
    insertions.push({ at: loop.endBi, blocks: seq });
    restBlocks.push(...seq);
  }

  if (insertions.length === 0) return { ...empty, regions: [] };

  // Recompute added time exactly by tracking the emitted moves.
  addedSec = 0;
  {
    // Walk rest blocks with a virtual position starting at each plunge:
    // G0 legs at rapid rate, G1 at their feed. Positions chain across
    // the sequence; entry G0 Z starts from loop depth (worst case).
    const pos: [number, number, number] = [0, 0, 0];
    let started = false;
    for (const b of restBlocks) {
      if (b.passthrough || b.motion === null) continue;
      const from: [number, number, number] = [...pos];
      if (b.coords.X !== undefined) pos[0] = b.coords.X;
      if (b.coords.Y !== undefined) pos[1] = b.coords.Y;
      if (b.coords.Z !== undefined) pos[2] = b.coords.Z;
      if (!started) {
        // First block of each plunge cycle follows unknown position;
        // count only the Z leg from depth for G0-Z, skip XY (unknown).
        started = true;
        if (
          b.motion === 0 &&
          b.coords.Z !== undefined &&
          b.coords.X === undefined &&
          b.coords.Y === undefined
        ) {
          addedSec += blockTime(1.5, opts.rapidRate, opts.accel);
          continue;
        }
      }
      const d = Math.hypot(
        pos[0] - from[0],
        pos[1] - from[1],
        pos[2] - from[2],
      );
      const f = b.motion === 0 ? opts.rapidRate : b.feed;
      addedSec += blockTime(d, f, opts.accel);
      if (b.motion === 0 && b.coords.Z !== undefined) {
        // Retract ends a cycle; next entry position is unknown again.
        const isRetract = b.coords.X === undefined && b.coords.Y === undefined;
        if (isRetract) started = false;
      }
    }
  }

  // Splice last-to-first so indices stay valid.
  const out = [...blocks];
  insertions
    .sort((a, b) => b.at - a.at)
    .forEach(({ at, blocks: seq }) => {
      out.splice(at + 1, 0, ...seq);
    });
  return { blocks: out, restBlocks, regions, regionsCut, addedSec };
}

/** Disabled-by-default gate: returns the identical reference when off. */
export function maybeApplyRestCut(
  blocks: Block[],
  enabled: boolean,
  opts: RestCutOptions,
): RestCutResult {
  if (!enabled) {
    return {
      blocks,
      restBlocks: [],
      regions: [],
      regionsCut: 0,
      addedSec: 0,
    };
  }
  return applyRestCut(blocks, opts);
}
