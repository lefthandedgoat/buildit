#!/usr/bin/env node
// buildit CLI: optimize grbl G-code and report honest cycle times.
//
// Usage: buildit <input.nc> [-o output.nc] [--machine NAME] [--accel 400]
//        [--rapid 5000] [--junction-deviation MM]
//        [--tolerance 0.01] [--decimals 3] [--arcs|--no-arcs] [--arc-tol 0.02]
//        [--tsp|--no-tsp] [--clearance auto|MM] [--material walnut|locust]
//        [--peck-profile NAME] [--no-plunge] [--rest-2d PREV_D] [--rest-finish D]
//        [--rest-cut --finish-tool D] [--check D [--check-prev P]]

import { readFileSync, writeFileSync } from "node:fs";
import { parse } from "./parser.ts";
import { janitor, emit } from "./janitor.ts";
import { fitArcs } from "./arcs.ts";
import { estimate } from "./estimate.ts";
import { optimizeRapids } from "./rapids.ts";
import { retunePlunges } from "./plunge.ts";
import { getProfile } from "./materials.ts";
import { analyzeRest } from "./rest2d.ts";
import { maybeApplyRestCut } from "./restcut.ts";
import { auditBlocks } from "./check.ts";
import { getMachine, machineNames, resolveRates } from "./machines.ts";
import { stockTopOf } from "./deviation.ts";

function usage(): never {
  console.error(
    "Usage: buildit <input.nc> [-o output.nc] [--machine NAME] [--accel 400] [--rapid 5000] [--junction-deviation MM] [--tolerance 0.01] [--decimals 3] [--arcs|--no-arcs] [--arc-tol 0.02] [--tsp|--no-tsp] [--clearance auto|MM] [--material walnut|locust] [--peck-profile NAME] [--no-plunge] [--rest-2d PREV_D] [--rest-finish D] [--rest-cut --finish-tool D] [--check D [--check-prev P]]",
  );
  process.exit(2);
}

function fail(msg: string): never {
  console.error(msg);
  usage();
}

function readInput(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    console.error(`cannot read input "${path}": ${(e as Error).message}`);
    process.exit(2);
  }
}

function arg(flag: string, def: string | null): string | null {
  const i = process.argv.indexOf(flag);
  if (i < 0 || i + 1 >= process.argv.length) return def;
  return process.argv[i + 1];
}

const input = process.argv[2];
if (!input || input.startsWith("-")) usage();
const output = arg("-o", null);
const machineName = arg("--machine", "shapeoko");
const machine = getMachine(machineName ?? "shapeoko");
if (!machine) {
  console.error(
    `unknown --machine "${machineName}" (available: ${machineNames().join(", ")})`,
  );
  process.exit(2);
}
// Explicit flags beat the preset (a calibration run in progress wins).
// Presence-checked, not value-checked: --accel 400 over shapeoko is
// still an override (same value, explicit provenance).
const accelRaw = process.argv.includes("--accel")
  ? Number(arg("--accel", ""))
  : null;
const rapidRaw = process.argv.includes("--rapid")
  ? Number(arg("--rapid", ""))
  : null;
const rates = resolveRates(machine, accelRaw, rapidRaw);
if (
  (accelRaw !== null && !Number.isFinite(accelRaw)) ||
  (rapidRaw !== null && !Number.isFinite(rapidRaw))
)
  usage(); // typo'd override must fail, never silently fall back
const accel = rates.accel;
const rapid = rates.rapidRate;
// Opt-in grbl-style blending (default 0 = legacy stop-to-stop, the
// stopwatch-calibrated behavior). Stock grbl $11 is 0.010.
const jdRaw = arg("--junction-deviation", null);
const jd = jdRaw === null ? 0 : Number(jdRaw);
if (jdRaw !== null && (!Number.isFinite(jd) || jd < 0)) usage();
const tolerance = Number(arg("--tolerance", "0.01"));
const decimals = Number(arg("--decimals", "3"));
const useArcs = process.argv.includes("--no-arcs")
  ? false
  : process.argv.includes("--arcs")
    ? true
    : true; // on by default
const arcTol = Number(arg("--arc-tol", "0.02"));
const useTsp = process.argv.includes("--no-tsp") ? false : true; // on by default
const clearanceRaw = arg("--clearance", "auto");
const clearance =
  clearanceRaw === "auto" ? ("auto" as const) : Number(clearanceRaw);
const material = getProfile(arg("--material", "walnut") ?? "walnut");
const peckOverride = arg("--peck-profile", null);
const profile = peckOverride
  ? { ...material, peckDepth: getProfile(peckOverride).peckDepth }
  : material;
const usePlunge = !process.argv.includes("--no-plunge");
const restPrevRaw = arg("--rest-2d", null);
const restPrev = restPrevRaw === null ? null : Number(restPrevRaw);
const restFinish = Number(arg("--rest-finish", "1.0"));
const useRestCut = process.argv.includes("--rest-cut");
const finishToolRaw = arg("--finish-tool", null);
const finishTool = finishToolRaw === null ? null : Number(finishToolRaw);
const checkRaw = arg("--check", null);
const checkTool = checkRaw === null ? null : Number(checkRaw);
const checkPrevRaw = arg("--check-prev", null);
const checkPrev = checkPrevRaw === null ? null : Number(checkPrevRaw);
if (checkPrev !== null && checkTool === null) {
  console.error("--check-prev requires --check <toolD>");
  process.exit(2);
}
if (useRestCut && (restPrev === null || finishTool === null)) {
  console.error(
    "--rest-cut requires both --rest-2d <prevD> and --finish-tool <diameter>",
  );
  process.exit(2);
}
if (
  ![accel, rapid, tolerance, decimals, arcTol, restFinish, jd].every(
    Number.isFinite,
  )
)
  usage();
// Range validation: the CLI promises exit 2 on bad input, but these used
// to slip through and produce 0-minute estimates, an uncaught toFixed
// RangeError, or (worst) retracts below the cut via a negative plane.
if (accel <= 0) fail(`--accel must be > 0 (got ${accel})`);
if (rapid <= 0) fail(`--rapid must be > 0 (got ${rapid})`);
if (tolerance < 0) fail(`--tolerance must be >= 0 (got ${tolerance})`);
if (arcTol < 0) fail(`--arc-tol must be >= 0 (got ${arcTol})`);
if (!Number.isInteger(decimals) || decimals < 0 || decimals > 100)
  fail(`--decimals must be an integer 0..100 (got ${decimals})`);
if (restFinish <= 0) fail(`--rest-finish must be > 0 (got ${restFinish})`);
if (restPrev !== null && (!Number.isFinite(restPrev) || restPrev <= 0))
  fail(`--rest-2d must be > 0 (got ${restPrevRaw})`);
if (finishTool !== null && (!Number.isFinite(finishTool) || finishTool <= 0))
  fail(`--finish-tool must be > 0 (got ${finishToolRaw})`);
if (checkTool !== null && (!Number.isFinite(checkTool) || checkTool <= 0))
  fail(`--check must be > 0 (got ${checkRaw})`);
if (checkPrev !== null && (!Number.isFinite(checkPrev) || checkPrev <= 0))
  fail(`--check-prev must be > 0 (got ${checkPrevRaw})`);
if (clearance !== "auto" && (!Number.isFinite(clearance) || clearance <= 0))
  fail(`--clearance must be "auto" or > 0 (got ${clearanceRaw})`);

const text = readInput(input);
const prog = parse(text);
if (/\bG91\b/i.test(text))
  console.error(
    "warning: G91 (incremental) present; positions are tracked as absolute",
  );
const before = estimate(prog, {
  accel,
  rapidRate: rapid,
  junctionDeviation: jd,
});

const { text: janitorText, stats } = janitor(prog, { tolerance, decimals });
const janitorProg = parse(janitorText);
const mid = estimate(janitorProg, {
  accel,
  rapidRate: rapid,
  junctionDeviation: jd,
});

// v4 rest cleanup cuts (opt-in): insert finish-tool cleanup immediately
// after each parent pocket loop, pre-arcs while G1 loops still exist.
let restCutRegions = 0;
let restCutBlocks = 0;
let restCutSec = 0;
let stageProg = janitorProg;
let stageText = janitorText;
if (useRestCut) {
  const rc = maybeApplyRestCut(janitorProg.blocks, true, {
    prevDiameter: restPrev as number,
    finishDiameter: finishTool as number,
    plungeFeed: profile.plungeFeed,
    clearance: clearance === "auto" ? stockTopOf(janitorProg) + 1.0 : clearance,
    rapidRate: rapid,
    accel,
  });
  stageProg = { blocks: rc.blocks };
  restCutRegions = rc.regionsCut;
  restCutBlocks = rc.restBlocks.filter((b) => !b.passthrough).length;
  restCutSec = rc.addedSec;
}

// v2 arcs (optional).
let arcsEmitted = 0;
if (useArcs) {
  const fit = fitArcs(stageProg.blocks, { tolerance: arcTol });
  arcsEmitted = fit.stats.arcsEmitted;
  stageProg = { blocks: fit.blocks };
  stageText = emit(stageProg, decimals, true);
}
const postArcs = estimate(parse(stageText), {
  accel,
  rapidRate: rapid,
  junctionDeviation: jd,
});

// v3 rapids: TSP reorder + adaptive clearance.
const rap = optimizeRapids(stageProg.blocks, {
  tsp: useTsp,
  clearance,
  margin: 1.0,
  rapidRate: rapid,
  accel,
});
stageProg = { blocks: rap.blocks };
stageText = emit(stageProg, decimals, true);
const postRapids = estimate(parse(stageText), {
  accel,
  rapidRate: rapid,
  junctionDeviation: jd,
});

// v3 plunge/peck retune (safe direction only).
let plungesRetuned = 0;
let pecksClamped = 0;
if (usePlunge) {
  const ret = retunePlunges(stageProg.blocks, profile);
  stageProg = { blocks: ret.blocks };
  stageText = emit(stageProg, decimals, true);
  plungesRetuned = ret.stats.plungesRetuned;
  pecksClamped = ret.stats.pecksClamped;
}

// v3 rest analysis (report only, no cut paths). Runs on the post-
// janitor stream: arcs fitting replaces G1 loops with G2/G3, and loop
// extraction is G1-only in v3, so analyze before arcs.
const rest =
  restPrev === null
    ? null
    : analyzeRest(janitorProg.blocks, restPrev, restFinish);

const outText = stageText;
const afterProg = parse(outText);
const after = estimate(afterProg, {
  accel,
  rapidRate: rapid,
  junctionDeviation: jd,
});

if (output) {
  try {
    writeFileSync(output, outText);
  } catch (e) {
    console.error(`cannot write output "${output}": ${(e as Error).message}`);
    process.exit(2);
  }
}

const row = (k: string, a: string, b: string) =>
  `${k.padEnd(22)} ${a.padStart(14)} ${b.padStart(14)}`;
console.log(row("metric", "before", "after"));
console.log(row("machine", rates.source, `A${accel} R${rapid}`));
if (jd > 0) {
  console.log(row("junction-dev (mm)", "-", jd.toFixed(3)));
}
console.log(
  row(
    "motion blocks",
    String(before.g0Blocks + before.g1Blocks + before.arcBlocks),
    String(after.g0Blocks + after.g1Blocks + after.arcBlocks),
  ),
);
console.log(
  row("G1 segments", String(before.g1Blocks), String(after.g1Blocks)),
);
console.log(
  row("G1 segs < 0.2mm", String(before.g1Under02mm), String(after.g1Under02mm)),
);
console.log(row("zero-len dropped", "-", String(stats.droppedZeroLength)));
console.log(row("collinear collapsed", "-", String(stats.collapsedCollinear)));
if (useArcs) {
  console.log(row("arcs emitted (G2/G3)", "-", String(arcsEmitted)));
  console.log(row("accel min, janitor-only", "-", mid.accelMin.toFixed(1)));
  console.log(row("accel min, +arcs", "-", postArcs.accelMin.toFixed(1)));
}
console.log(
  row(
    "rapid dist (mm)",
    rap.stats.rapidDistBefore.toFixed(0),
    rap.stats.rapidDistAfter.toFixed(0),
  ),
);
console.log(
  row(
    "ops reordered / clearance cuts",
    `${rap.stats.sitesFound} found`,
    `${rap.stats.sitesReordered} / ${rap.stats.clearanceChanges}`,
  ),
);
console.log(row("accel min, +rapids", "-", postRapids.accelMin.toFixed(1)));
if (usePlunge) {
  console.log(
    row(`plunges retuned (${profile.name})`, "-", String(plungesRetuned)),
  );
  console.log(row("pecks clamped (Q)", "-", String(pecksClamped)));
}
if (rest) {
  console.log(
    row(
      `rest regions (prev ${restPrev}mm)`,
      `${rest.loopsFound} loops`,
      `${rest.regions.length} / ${rest.totalRestArea.toFixed(2)}mm2`,
    ),
  );
}
// --check min-feature audit (report only, on the post-janitor stream).
// Advisory: the -o file is still written; violations set exit 1.
if (checkTool !== null) {
  const audit = auditBlocks(janitorProg.blocks, {
    toolDiameter: checkTool,
    prevDiameter: checkPrev ?? undefined,
  });
  const bits: string[] = [];
  if (audit.channels.length > 0) {
    const w = audit.channels.reduce((m, c) => Math.min(m, c.width), Infinity);
    const at = audit.channels.find((c) => c.width === w)!;
    bits.push(
      `${audit.channels.length} narrow (min ${w.toFixed(2)} @ ${at.at[0].toFixed(1)},${at.at[1].toFixed(1)} z${at.loopZ})`,
    );
  }
  if (audit.tinyArcs.length > 0) {
    const r = audit.tinyArcs.reduce((m, t) => Math.min(m, t.r), Infinity);
    bits.push(`${audit.tinyArcs.length} tiny-arc (min r${r.toFixed(2)})`);
  }
  if (audit.corners.length > 0) {
    const m = audit.corners.reduce((a, c) => (c.residue > a.residue ? c : a));
    bits.push(
      `${audit.corners.length} corners need hand work (worst ${m.residue.toFixed(2)}mm2 @ ${m.at[0].toFixed(1)},${m.at[1].toFixed(1)} z${m.loopZ})`,
    );
  }
  console.log(
    row(
      `check (tool ${checkTool}mm)`,
      `${audit.loopsFound} loops`,
      bits.length > 0 ? bits.join("; ") : "clean",
    ),
  );
  if (!audit.clean) process.exitCode = 1;
  // Advisory only: never affects clean or the exit code.
  if (audit.waists.length > 0) {
    const w = audit.waists.reduce((m, x) => Math.min(m, x.width), Infinity);
    console.log(
      row(
        `advisory: ${audit.waists.length} waist(s)`,
        `min ${w.toFixed(2)}mm`,
        "report-only",
      ),
    );
  }
  if (audit.islands.length > 0) {
    const m = audit.islands.reduce((a, x) => (x.moat < a.moat ? x : a));
    console.log(
      row(
        `advisory: ${audit.islands.length} island candidate(s)`,
        `min moat ${m.moat.toFixed(2)}mm`,
        "report-only",
      ),
    );
  }
}
if (useRestCut) {
  console.log(row("rest regions cut", "-", String(restCutRegions)));
  console.log(row("rest blocks emitted", "-", String(restCutBlocks)));
  console.log(
    row(
      "+cleanup time (full pockets)",
      "-",
      `${(restCutSec / 60).toFixed(1)} min`,
    ),
  );
}
console.log(
  row(
    "naive (CC-like) min",
    before.naiveMin.toFixed(1),
    after.naiveMin.toFixed(1),
  ),
);
console.log(
  row("accel-aware min", before.accelMin.toFixed(1), after.accelMin.toFixed(1)),
);
const saved = before.accelMin - after.accelMin;
console.log(
  `\nest. machine-time savings: ${saved.toFixed(1)} min (${before.accelMin > 0 ? ((100 * saved) / before.accelMin).toFixed(1) : "0.0"}%)`,
);
if (output) console.log(`wrote ${output}`);
