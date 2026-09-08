// Plunge + peck tuning (v3 module 3).
//
// Two safe-direction-only rewrites:
//   1. Pure Z-only G1 descents faster than the material's plunge feed get
//      clamped DOWN to it. Z-varying XY cutting moves (e.g. 3D finish
//      passes) are NOT plunges and are never touched.
//   2. G83 peck Q depths larger than the profile max get clamped DOWN.
// Feeds and Q values only ever decrease, never increase.

import { type Block, trackMoves } from "./parser.ts";
import type { MaterialProfile } from "./materials.ts";

export interface PlungeStats {
  plungesRetuned: number;
  pecksClamped: number;
}

const EPS = 1e-9;

/** A plunge is a G1 with zero XY displacement and negative Z displacement. */
export function isPlunge(
  from: [number, number, number],
  to: [number, number, number],
  motion: number | null,
): boolean {
  return (
    motion === 1 &&
    Math.abs(to[0] - from[0]) < EPS &&
    Math.abs(to[1] - from[1]) < EPS &&
    to[2] < from[2] - EPS
  );
}

export function retunePlunges(
  blocks: Block[],
  profile: MaterialProfile,
): { blocks: Block[]; stats: PlungeStats } {
  const moves = trackMoves({ blocks });
  // Map block object identity -> move for plunge detection.
  const moveByBlock = new Map<Block, (typeof moves)[number]>();
  for (const m of moves) moveByBlock.set(m.block, m);

  let plungesRetuned = 0;
  let pecksClamped = 0;
  const out = blocks.map((b) => {
    const m = moveByBlock.get(b);
    if (m && isPlunge(m.from, m.to, b.motion) && b.feed > profile.plungeFeed) {
      plungesRetuned++;
      return {
        ...b,
        coords: { ...b.coords },
        feed: profile.plungeFeed,
        explicitFeed: true,
      };
    }
    // G83 peck: parser stashes G83 and Q in misc (emit ignores raw for
    // motion blocks, so the Q rewrite must target misc).
    if (!b.passthrough && b.misc.some((w) => /^G83$/i.test(w))) {
      const qi = b.misc.findIndex((w) => /^Q/i.test(w));
      const qm = qi >= 0 ? b.misc[qi].match(/^Q(-?[\d.]+)/i) : null;
      if (qi >= 0 && qm && parseFloat(qm[1]) > profile.peckDepth) {
        pecksClamped++;
        const misc = [...b.misc];
        misc[qi] = `Q${profile.peckDepth}`;
        return { ...b, misc };
      }
    }
    return b;
  });
  return { blocks: out, stats: { plungesRetuned, pecksClamped } };
}
