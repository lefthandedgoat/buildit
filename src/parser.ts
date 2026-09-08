// Grbl-dialect G-code parser with full modal state tracking.
//
// Carbide Create emits modal motion: continuation lines like `X1.2 Z-0.5`
// inherit the last G0/G1. A parser that only counts lines carrying an
// explicit G-word will silently drop ~all blocks (observed: 48,007 real
// segments counted as 4). Every motion block below carries its RESOLVED
// modal motion, so downstream passes never need to care.

export type Motion = 0 | 1 | 2 | 3;

export interface Coords {
  X?: number;
  Y?: number;
  Z?: number;
  I?: number;
  J?: number;
  R?: number;
}

export interface Block {
  /** 1-based source line number. */
  line: number;
  /** Original text (without trailing newline). */
  raw: string;
  /** True for blank lines and comment-only lines; emitted verbatim. */
  passthrough: boolean;
  /** Resolved motion mode for this line (modal). Null when the line has no motion. */
  motion: Motion | null;
  /** True when the line carried an explicit G0..G3 word. */
  explicitMotion: boolean;
  /** Axis words present on this line. */
  coords: Coords;
  /** True when the line carried an explicit F word. */
  explicitFeed: boolean;
  /** Resolved modal feed (mm/min) after this line. 0 when unknown. */
  feed: number;
  /** Other significant words preserved for emit (M codes, S, T). */
  misc: string[];
}

export interface Program {
  blocks: Block[];
}

const WORD = /([A-Z])(-?\d*\.?\d+)/g;

function stripComments(line: string): { code: string; comment: string } {
  // Semicolon comment runs to end of line; paren comments may be inline.
  let code = line;
  let trailing = "";
  const semi = code.indexOf(";");
  if (semi >= 0) {
    trailing = code.slice(semi);
    code = code.slice(0, semi);
  }
  code = code.replace(/\([^)]*\)/g, " ").trim();
  return { code, comment: trailing.trim() };
}

/** Parse full program text. Never throws on unknown words; they pass through. */
export function parse(text: string): Program {
  const blocks: Block[] = [];
  let motion: Motion | null = null;
  let feed = 0;

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const { code, comment } = stripComments(raw);
    if (code === "") {
      // Blank or comment-only: preserve verbatim (keep original raw so
      // paren comments survive round-trip).
      blocks.push({
        line: i + 1,
        raw,
        passthrough: true,
        motion: null,
        explicitMotion: false,
        coords: {},
        explicitFeed: false,
        feed,
        misc: comment ? [comment] : [],
      });
      continue;
    }
    let explicitMotion = false;
    let explicitFeed = false;
    const coords: Coords = {};
    const misc: string[] = [];
    for (const m of code.matchAll(WORD)) {
      const letter = m[1];
      const value = parseFloat(m[2]);
      if (
        letter === "G" &&
        (value === 0 || value === 1 || value === 2 || value === 3)
      ) {
        motion = value as Motion;
        explicitMotion = true;
      } else if (letter === "F") {
        feed = value;
        explicitFeed = true;
      } else if (
        letter === "X" ||
        letter === "Y" ||
        letter === "Z" ||
        letter === "I" ||
        letter === "J" ||
        letter === "R"
      ) {
        coords[letter] = value;
      } else {
        // G90/G21/M/S/T and anything else: preserved verbatim for emit.
        misc.push(m[0]);
      }
    }
    const hasMotion = Object.keys(coords).length > 0;
    blocks.push({
      line: i + 1,
      raw,
      passthrough: false,
      motion: hasMotion ? motion : null,
      explicitMotion,
      coords,
      explicitFeed,
      feed,
      misc,
    });
  }
  return { blocks };
}

/** Absolute tool position after each motion block (X/Y/Z only). */
export interface TrackedMove {
  block: Block;
  /** Position before the move. */
  from: [number, number, number];
  /** Position after the move. */
  to: [number, number, number];
  /** Euclidean distance. */
  dist: number;
}

/** Walk the program tracking absolute position. Non-motion blocks are skipped. */
export function trackMoves(prog: Program): TrackedMove[] {
  const moves: TrackedMove[] = [];
  const pos: [number, number, number] = [0, 0, 0];
  for (const b of prog.blocks) {
    if (b.passthrough || b.motion === null) continue;
    const from: [number, number, number] = [...pos];
    if (b.coords.X !== undefined) pos[0] = b.coords.X;
    if (b.coords.Y !== undefined) pos[1] = b.coords.Y;
    if (b.coords.Z !== undefined) pos[2] = b.coords.Z;
    const dist = Math.hypot(
      pos[0] - from[0],
      pos[1] - from[1],
      pos[2] - from[2],
    );
    moves.push({ block: b, from, to: [...pos], dist });
  }
  return moves;
}
