// Job splitter: one output file per tool + a human setup sheet.
//
// Splits a parsed program at tool changes (T-word or M6 in misc) so each
// job runs with a single bit: no mid-file bit swaps, optimal feeds per
// job, honest per-job time estimates. Prologue/epilogue are ADDED per
// job (G90/G21/M3/M5) — original motion blocks are never rewritten.
//
// If the input has no tool changes, the whole program is one job.

import type { Block } from "./parser.ts";
import { emit } from "./janitor.ts";
import { estimate } from "./estimate.ts";

export interface Job {
  /** 1-based job index. */
  index: number;
  /** Tool id from the T-word, or "unknown" when the file has none. */
  tool: string;
  /** Source line where this job starts (for traceability). */
  startLine: number;
  blocks: Block[];
}

const T_WORD = /^T(\d+)/i;

function toolOf(b: Block): string | null {
  if (b.passthrough) return null;
  for (const w of b.misc) {
    const m = w.match(T_WORD);
    if (m) return `T${m[1]}`;
  }
  return null;
}

function isToolChange(b: Block): boolean {
  if (b.passthrough) return false;
  if (toolOf(b) !== null) return true;
  return b.misc.some((w) => /^M0*6\b/i.test(w));
}

/** Split blocks at tool changes. Leading prologue (G90/G21, comments)
 * merges into the first tool job instead of stranding as "unknown". */
export function splitJobs(blocks: Block[]): Job[] {
  const hasMotion = (bs: Block[]): boolean =>
    bs.some((b) => !b.passthrough && b.motion !== null);
  const jobs: Job[] = [];
  let current: Block[] = [];
  let currentTool = "unknown";
  let startLine = blocks[0]?.line ?? 1;

  const flush = () => {
    if (current.length > 0) {
      jobs.push({
        index: jobs.length + 1,
        tool: currentTool,
        startLine,
        blocks: current,
      });
      current = [];
    }
  };

  for (const b of blocks) {
    const t = toolOf(b);
    if (isToolChange(b) && hasMotion(current)) {
      flush();
      startLine = b.line;
      if (t) currentTool = t;
    } else if (t && !hasMotion(current)) {
      // Preamble T-word: the whole job (preamble included) belongs to
      // this tool — the G90/G21 header must not strand as its own job.
      currentTool = t;
    } else if (current.length === 0) {
      startLine = b.line;
    }
    current.push(b);
  }
  flush();
  // Renumber (flush assigns in order already, but keep explicit).
  jobs.forEach((j, i) => (j.index = i + 1));
  return jobs;
}

export interface JobEmitOptions {
  rpm: number;
  /** Safe Z for the epilogue retract. Default 10. */
  safeZ?: number;
  decimals?: number;
}

/** Wrap one job's blocks with prologue/epilogue for a single-bit file. */
export function emitJob(job: Job, opts: JobEmitOptions): string {
  const decimals = opts.decimals ?? 3;
  const safeZ = opts.safeZ ?? 10;
  const body = emit({ blocks: job.blocks }, decimals, false);
  const header = [
    `(job ${job.index} tool ${job.tool})`,
    "G90",
    "G21",
    `M3S${opts.rpm}`,
    "G4P2",
  ].join("\n");
  const footer = [`G0Z${safeZ}`, "M5", "M30"].join("\n");
  return `${header}\n${body}${footer}\n`;
}

export interface SetupRow {
  job: number;
  tool: string;
  toolLabel: string;
  rpm: number;
  feedMmMin: number;
  plungeMmMin: number;
  docMm: number;
  blocks: number;
  estMin: number;
}

export interface SetupSheetOptions {
  accel?: number;
  rapidRate?: number;
}

/**
 * Render a markdown setup sheet: one row per job with feeds + honest
 * accel-aware time, plus a bit-change checklist. Pure report — never
 * edits toolpaths.
 */
export function setupSheet(
  jobs: Job[],
  feedsByTool: Map<
    string,
    {
      rpm: number;
      feedMmMin: number;
      plungeMmMin: number;
      docMm: number;
      label: string;
    }
  >,
  opts: SetupSheetOptions = {},
): string {
  const accel = opts.accel ?? 400;
  const rapidRate = opts.rapidRate ?? 5000;
  const lines: string[] = [
    "# Setup sheet",
    "",
    "| job | tool | bit | rpm | feed | plunge | doc/pass | blocks | est min |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  let total = 0;
  for (const j of jobs) {
    const f = feedsByTool.get(j.tool) ?? feedsByTool.get("unknown");
    const est = estimate({ blocks: j.blocks }, { accel, rapidRate });
    total += est.accelMin;
    lines.push(
      `| ${j.index} | ${j.tool} | ${f?.label ?? "?"} | ${f?.rpm ?? "?"} | ${f?.feedMmMin ?? "?"} | ${f?.plungeMmMin ?? "?"} | ${f?.docMm ?? "?"} | ${j.blocks.length} | ${est.accelMin.toFixed(1)} |`,
    );
  }
  lines.push("", `Total accel-aware: ${total.toFixed(1)} min.`);
  lines.push("");
  lines.push("## Bit changes");
  for (const j of jobs) {
    const f = feedsByTool.get(j.tool);
    lines.push(
      `- Job ${j.index}: load ${j.tool}${f ? ` (${f.label})` : ""}, re-zero Z, run.`,
    );
  }
  return lines.join("\n") + "\n";
}
