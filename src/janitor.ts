// Safe janitor passes over a parsed program.
//
// All passes preserve geometry within `tolerance` and preserve program
// semantics (modal state, feeds, spindle commands, comments). They operate
// on Blocks and return a NEW array; the input is never mutated.

import { type Block, type Motion, type Program, trackMoves } from "./parser.ts";

export interface JanitorOptions {
  /** Douglas-Peucker epsilon in mm for collinear collapse. Default 0.01. */
  tolerance: number;
  /** Decimals for emitted coordinates. Default 3. */
  decimals: number;
}

export interface JanitorStats {
  inputBlocks: number;
  outputBlocks: number;
  droppedZeroLength: number;
  collapsedCollinear: number;
  g1SegmentsBefore: number;
  g1SegmentsAfter: number;
}

function fmt(n: number, decimals: number): string {
  const r = Number(n.toFixed(decimals));
  // Avoid "-0".
  return (Object.is(r, -0) ? 0 : r).toFixed(decimals);
}

/**
 * Drop zero-length motion blocks (position unchanged). Keeps the FIRST
 * block that establishes each position so modal state stays intact, and
 * never drops a block carrying feed/spindle/misc words that could matter.
 */
export function dropZeroLength(blocks: Block[]): {
  blocks: Block[];
  dropped: number;
} {
  const pos: [number, number, number] = [0, 0, 0];
  const out: Block[] = [];
  let dropped = 0;
  for (const b of blocks) {
    if (b.passthrough || b.motion === null) {
      out.push(b);
      continue;
    }
    const nx = b.coords.X ?? pos[0];
    const ny = b.coords.Y ?? pos[1];
    const nz = b.coords.Z ?? pos[2];
    const zero = nx === pos[0] && ny === pos[1] && nz === pos[2];
    pos[0] = nx;
    pos[1] = ny;
    pos[2] = nz;
    if (zero && !b.explicitFeed && b.misc.length === 0 && !b.explicitMotion) {
      dropped++;
      continue;
    }
    out.push(b);
  }
  return { blocks: out, dropped };
}

interface Pt {
  idx: number; // index into the run's block list
  p: [number, number, number];
}

/**
 * Collapse collinear intermediate points within straight G1 runs using
 * Douglas-Peucker. A "run" is a maximal sequence of G1 blocks with no
 * intervening passthrough/misc/feed-change content, so F words and
 * comments are never swallowed. Arcs (G2/G3) and rapids break runs.
 */
export function collapseCollinear(
  blocks: Block[],
  tolerance: number,
): { blocks: Block[]; collapsed: number } {
  // Absolute positions for every motion block.
  const pos: [number, number, number] = [0, 0, 0];
  const abs = new Map<Block, [number, number, number]>();
  for (const b of blocks) {
    if (!b.passthrough && b.motion !== null) {
      if (b.coords.X !== undefined) pos[0] = b.coords.X;
      if (b.coords.Y !== undefined) pos[1] = b.coords.Y;
      if (b.coords.Z !== undefined) pos[2] = b.coords.Z;
      abs.set(b, [...pos]);
    }
  }

  const drop = new Set<Block>();
  const materialize = new Set<Block>();
  let collapsed = 0;
  let run: Block[] = [];
  const flush = () => {
    if (run.length > 2) {
      const pts: Pt[] = run.map((b) => ({ idx: 0, p: abs.get(b)! }));
      pts.forEach((pt, i) => (pt.idx = i));
      const keep = new Set<number>([0, pts.length - 1]);
      dp(pts, 0, pts.length - 1, tolerance, keep);
      let removed = false;
      for (let i = 1; i < pts.length - 1; i++) {
        if (!keep.has(i)) {
          drop.add(run[i]);
          collapsed++;
          removed = true;
        }
      }
      if (removed) {
        // Modal repair: a removed block may have established an axis value
        // that later partial-coordinate blocks inherit. Materialize full
        // XYZ on every kept block of the edited run so inheritance is
        // explicit and geometry is exact.
        for (let i = 0; i < pts.length; i++) {
          if (keep.has(i)) materialize.add(run[i]);
        }
      }
    }
    run = [];
  };

  for (const b of blocks) {
    const continuable =
      !b.passthrough &&
      b.motion === 1 &&
      !b.explicitFeed &&
      b.misc.length === 0 &&
      b.coords.I === undefined &&
      b.coords.J === undefined &&
      b.coords.R === undefined;
    if (continuable) {
      run.push(b);
    } else {
      flush();
    }
  }
  flush();
  const out = blocks
    .filter((b) => !drop.has(b))
    .map((b) => {
      if (!materialize.has(b)) return b;
      const p = abs.get(b)!;
      return {
        ...b,
        coords: { ...b.coords, X: p[0], Y: p[1], Z: p[2] },
      };
    });
  return { blocks: out, collapsed };
}

function perpDist(
  p: [number, number, number],
  a: [number, number, number],
  b: [number, number, number],
): number {
  const abx = b[0] - a[0],
    aby = b[1] - a[1],
    abz = b[2] - a[2];
  const apx = p[0] - a[0],
    apy = p[1] - a[1],
    apz = p[2] - a[2];
  const len2 = abx * abx + aby * aby + abz * abz;
  if (len2 === 0) return Math.hypot(apx, apy, apz);
  const t = Math.max(
    0,
    Math.min(1, (apx * abx + apy * aby + apz * abz) / len2),
  );
  return Math.hypot(apx - t * abx, apy - t * aby, apz - t * abz);
}

function dp(
  pts: Pt[],
  lo: number,
  hi: number,
  eps: number,
  keep: Set<number>,
): void {
  let dmax = 0;
  let imax = -1;
  for (let i = lo + 1; i < hi; i++) {
    const d = perpDist(pts[i].p, pts[lo].p, pts[hi].p);
    if (d > dmax) {
      dmax = d;
      imax = i;
    }
  }
  if (dmax > eps && imax >= 0) {
    keep.add(imax);
    dp(pts, lo, imax, eps, keep);
    dp(pts, imax, hi, eps, keep);
  }
}

/**
 * Emit program text. `minimal` strips redundant modal words: the G-word
 * is emitted only when the motion mode changes, F only when the feed
 * changes. Coordinates keep the original present-axis subset.
 */
export function emit(
  prog: { blocks: Block[] },
  decimals: number,
  minimal: boolean,
): string {
  const lines: string[] = [];
  let lastMotion: Motion | null = null;
  let lastFeed = -1;
  for (const b of prog.blocks) {
    if (b.passthrough) {
      lines.push(b.raw);
      continue;
    }
    const parts: string[] = [];
    if (b.motion !== null && (!minimal || b.motion !== lastMotion)) {
      parts.push(`G${b.motion}`);
      lastMotion = b.motion;
    }
    if (b.coords.X !== undefined) parts.push(`X${fmt(b.coords.X, decimals)}`);
    if (b.coords.Y !== undefined) parts.push(`Y${fmt(b.coords.Y, decimals)}`);
    if (b.coords.Z !== undefined) parts.push(`Z${fmt(b.coords.Z, decimals)}`);
    if (b.coords.I !== undefined) parts.push(`I${fmt(b.coords.I, decimals)}`);
    if (b.coords.J !== undefined) parts.push(`J${fmt(b.coords.J, decimals)}`);
    if (b.coords.R !== undefined) parts.push(`R${fmt(b.coords.R, decimals)}`);
    if (b.explicitFeed && (!minimal || b.feed !== lastFeed)) {
      const f = String(b.feed);
      parts.push(`F${f}`);
    }
    if (b.explicitFeed) lastFeed = b.feed;
    for (const w of b.misc) parts.push(w);
    if (parts.length === 0) continue; // fully redundant line (e.g. repeated F)
    lines.push(parts.join(""));
  }
  return lines.join("\n") + "\n";
}

/** Run the full janitor pipeline. Returns emitted text plus stats. */
export function janitor(
  prog: Program,
  opts: JanitorOptions,
): { text: string; stats: JanitorStats } {
  const before = trackMoves(prog).filter((m) => m.block.motion === 1).length;
  const z = dropZeroLength(prog.blocks);
  const c = collapseCollinear(z.blocks, opts.tolerance);
  const text = emit({ blocks: c.blocks }, opts.decimals, true);
  const after = trackMoves({ blocks: c.blocks }).filter(
    (m) => m.block.motion === 1,
  ).length;
  return {
    text,
    stats: {
      inputBlocks: prog.blocks.length,
      outputBlocks: c.blocks.length,
      droppedZeroLength: z.dropped,
      collapsedCollinear: c.collapsed,
      g1SegmentsBefore: before,
      g1SegmentsAfter: after,
    },
  };
}
