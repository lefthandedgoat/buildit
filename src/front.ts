// Front-half demo CLI: describe a 2x4 bench -> SVG cut map + per-tool
// G-code + setup sheet. Separate entry point from index.ts (the optimizer
// CLI) so this track never edits shared ground:
//
//   node dist/front.js [--material "2x4 SPF"] [--out examples/bench-2x4]
//                      [--topLen 1219] [--topDepth 457] [--height 457]
//
// Pipeline (all greenfield modules): benchParts -> layoutParts ->
// partsToSvg (preview) + profileRect/drillHole per tool (CAM) ->
// emitJob (single-bit files) + setupSheet (bit-change checklist).
// Times come from the existing honest estimator (estimate.ts, read-only).

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getTool } from "./tools.ts";
import { computeFeeds } from "./feeds.ts";
import { parse } from "./parser.ts";
import { estimate } from "./estimate.ts";
import { emitJob, setupSheet, type Job } from "./jobs.ts";
import { benchParts, layoutParts, partsToSvg } from "./svggen.ts";
import {
  benchAssembly,
  elevate,
  elevationSvg,
  explodedIso,
} from "./assembly.ts";
import { boxesToStl } from "./stl.ts";
import { stlViewerHtml } from "./stlview.ts";
import {
  DEFAULT_GRID,
  both,
  defaultPlan,
  planAsymmetric,
  planAsymmetric96,
  gridBoxes,
  gridPlanSvg,
} from "./modules.ts";
import { profileRect, drillHole, camProgram } from "./cam.ts";

function arg(flag: string, def: string): string {
  const i = process.argv.indexOf(flag);
  return i < 0 || i + 1 >= process.argv.length ? def : process.argv[i + 1];
}

export interface BenchPlan {
  material: string;
  outDir: string;
  topLen: number;
  topDepth: number;
  height: number;
}

export function planBench(): BenchPlan {
  return {
    material: arg("--material", "2x4 SPF"),
    outDir: arg("--out", "examples/bench-2x4"),
    topLen: Number(arg("--topLen", "1219")),
    topDepth: Number(arg("--topDepth", "457")),
    height: Number(arg("--height", "457")),
  };
}

/** Grid mode speaks inches (--S 32 --H 34 --panelT 0.75). No casters: dolly + skids.
 * --layout frontfeed (96x48) | asymmetric (76x60) | asymmetric96 (96x64, default). */
function mainGrid(): void {
  const IN = 25.4;
  const g = {
    ...DEFAULT_GRID,
    S: Number(arg("--S", "32")) * IN,
    H: Number(arg("--H", "34")) * IN,
    panelT: Number(arg("--panelT", "0.75")) * IN,
  };
  const layout = arg("--layout", "asymmetric96");
  if (
    layout !== "frontfeed" &&
    layout !== "asymmetric" &&
    layout !== "asymmetric96"
  )
    throw new Error(
      `--layout must be frontfeed|asymmetric|asymmetric96, got ${layout}`,
    );
  const plan =
    layout === "asymmetric"
      ? planAsymmetric(g)
      : layout === "asymmetric96"
        ? planAsymmetric96(g)
        : defaultPlan(g);
  const boxes = gridBoxes(plan);
  const outDir = arg("--out", "examples/grid-2x3");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "grid-plan.svg"), gridPlanSvg(plan));
  const elevW = Math.max(...plan.bays.map((b) => b.x + b.w));
  writeFileSync(
    join(outDir, "grid-front.svg"),
    elevationSvg(elevate(boxes, "front"), "grid front", elevW, g.H),
  );
  writeFileSync(join(outDir, "grid-iso.svg"), explodedIso(boxes, 40));
  const stowedBoxes = gridBoxes(plan, true);
  writeFileSync(
    join(outDir, "grid-iso-stowed.svg"),
    explodedIso(stowedBoxes, 40),
  );
  writeFileSync(
    join(outDir, "view-grid-stowed.html"),
    stlViewerHtml(
      boxesToStl(stowedBoxes, "grid-stowed"),
      "saw grid stowed — drag to rotate",
      stowedBoxes,
      "light",
    ),
  );
  writeFileSync(join(outDir, "grid.stl"), boxesToStl(boxes, "grid"));
  writeFileSync(
    join(outDir, "view-grid.html"),
    stlViewerHtml(
      boxesToStl(boxes, "grid"),
      "saw grid — drag to rotate",
      boxes,
      "light",
    ),
  );
  const cutlist =
    [
      "# Cut list — saw grid (layout: " + layout + ", saw vs CNC vs mill)",
      "",
      "## Workflow rules (load-bearing)",
      "",
      "1. One tool up at a time: stow both flips before ripping.",
      "2. Blade down whenever the saw table serves as side support.",
      "3. Flip AWAY from the neighboring row (push, don't pull): front-row flips toward the aisle, back-row flips toward rear air. Keep that side clear.",
      "4. Stow flips + spin saw 90deg for crosscut mode (neighbors become support).",
      "5. Park the rip fence or stow the planer before ripping wide (fence overhangs east).",
      "6. Jointer flips fence-off; fence lives on wall hooks.",
      "",
      "| part | size | origin | process | note |",
      "| --- | --- | --- | --- | --- |",
      ...boxes.map(
        (b) =>
          `| ${b.label} | ${both(b.dx)} x ${both(b.dy)} x ${both(b.dz)} | (${Math.round(b.x)},${Math.round(b.y)},${Math.round(b.z)}) | ${b.process} | ${b.note} |`,
      ),
    ].join("\n") + "\n";
  writeFileSync(join(outDir, "CUTLIST-grid.md"), cutlist);
  const totalW = Math.max(...plan.bays.map((b) => b.x + b.w));
  const totalD = Math.max(...plan.bays.map((b) => b.y + b.d));
  console.log(
    `grid ${both(totalW)} x ${both(totalD)}, datum H=${both(g.H)}, ${boxes.length} parts`,
  );
  console.log(
    `wrote ${outDir}/grid-plan.svg grid-front.svg grid-iso.svg grid-iso-stowed.svg grid.stl view-grid.html view-grid-stowed.html CUTLIST-grid.md`,
  );
  for (const w of [
    `MEASURE: H floor->saw-table (using ${both(g.H)} — override --H)`,
    `MEASURE: saw base footprint (using 460x410mm — override in GridPlan)`,
    `MEASURE: saw base->table off-stand (using 200mm — stand legs to suit)`,
    `MEASURE: planer bed above base (using 150mm — drum math)`,
    `MEASURE: jointer bed above base (using 100mm — drum math)`,
    `DECIDE: jointer flip counterweight (gas strut vs paver in drum base)`,
  ])
    console.log(`warn: ${w}`);
}

function main(): void {
  if (arg("--project", "bench") === "grid") {
    mainGrid();
    return;
  }
  const plan = planBench();
  const parts = benchParts(plan.topLen, plan.topDepth, plan.height);
  // Virtual 4x8 sheet as the cut map (lumber: read rows as board rips).
  const placed = layoutParts(parts, { sheetW: 1300, sheetH: 2500 });

  const t2 = getTool("T2")!;
  const t4 = getTool("T4")!;
  const profFeeds = computeFeeds(t2, plan.material, "profile");
  const drillFeeds = computeFeeds(t4, plan.material, "drill");

  // One profile op per placed part (38mm stock, 1mm overshoot through-cut).
  const profiles = placed.map((p) =>
    profileRect(
      {
        partId: p.partId,
        x: p.x,
        y: p.y,
        w: p.w,
        h: p.h,
        targetZ: -38,
        overshoot: 1,
      },
      profFeeds,
      t2.diameterMm,
    ),
  );
  // Two bolt pilots per leg, on the leg centerline.
  const drills = placed
    .filter((p) => p.partId === "leg")
    .flatMap((p) => [
      drillHole(
        {
          partId: "leg-pilot",
          x: p.x + p.w / 2,
          y: p.y + p.h * 0.25,
          targetZ: -38,
        },
        drillFeeds,
      ),
      drillHole(
        {
          partId: "leg-pilot",
          x: p.x + p.w / 2,
          y: p.y + p.h * 0.75,
          targetZ: -38,
        },
        drillFeeds,
      ),
    ]);

  const t2Body = camProgram("bench profiles T2 1/4-flat", profiles);
  const t4Body = camProgram("bench pilots T4 1/8-drill", drills);

  const jobs: Job[] = [
    { index: 1, tool: "T2", startLine: 1, blocks: parse(t2Body).blocks },
    { index: 2, tool: "T4", startLine: 1, blocks: parse(t4Body).blocks },
  ];
  const nc2 = emitJob(jobs[0], { rpm: profFeeds.rpm });
  const nc4 = emitJob(jobs[1], { rpm: drillFeeds.rpm });

  mkdirSync(plan.outDir, { recursive: true });
  writeFileSync(
    join(plan.outDir, "parts.svg"),
    partsToSvg(placed, 1300, 2500, "bench cut map"),
  );
  // Assembly visualization: elevations + exploded iso + cut list.
  const assembly = benchAssembly({
    topLen: plan.topLen,
    topDepth: plan.topDepth,
    height: plan.height,
  });
  const views: [string, string][] = [
    [
      "assembly-front.svg",
      elevationSvg(
        elevate(assembly, "front"),
        "front",
        plan.topLen,
        plan.height,
      ),
    ],
    [
      "assembly-side.svg",
      elevationSvg(
        elevate(assembly, "side"),
        "side",
        plan.topDepth,
        plan.height,
      ),
    ],
    [
      "assembly-top.svg",
      elevationSvg(elevate(assembly, "top"), "top", plan.topLen, plan.topDepth),
    ],
    ["assembly-iso.svg", explodedIso(assembly)],
  ];
  for (const [name, svg] of views) writeFileSync(join(plan.outDir, name), svg);
  const cutlist =
    [
      "# Cut list — saw vs CNC",
      "",
      "| part | size (mm) | origin | process | note |",
      "| --- | --- | --- | --- | --- |",
      ...assembly.map(
        (b) =>
          `| ${b.label} | ${b.dx}x${b.dy}x${b.dz} | (${b.x},${b.y},${b.z}) | ${b.process} | ${b.note}${b.qtyNote ? ` (${b.qtyNote})` : ""} |`,
      ),
    ].join("\n") + "\n";
  writeFileSync(join(plan.outDir, "CUTLIST.md"), cutlist);
  writeFileSync(join(plan.outDir, "bench.stl"), boxesToStl(assembly, "bench"));
  writeFileSync(
    join(plan.outDir, "view-bench.html"),
    stlViewerHtml(
      boxesToStl(assembly, "bench"),
      "bench — drag to rotate",
      assembly,
      "light",
    ),
  );
  writeFileSync(join(plan.outDir, "bench-T2-profile.nc"), nc2);
  writeFileSync(join(plan.outDir, "bench-T4-pilots.nc"), nc4);
  const feedsMap = new Map([
    [
      "T2",
      {
        rpm: profFeeds.rpm,
        feedMmMin: profFeeds.feedMmMin,
        plungeMmMin: profFeeds.plungeMmMin,
        docMm: profFeeds.docMm,
        label: t2.label,
      },
    ],
    [
      "T4",
      {
        rpm: drillFeeds.rpm,
        feedMmMin: drillFeeds.feedMmMin,
        plungeMmMin: drillFeeds.plungeMmMin,
        docMm: drillFeeds.docMm,
        label: t4.label,
      },
    ],
  ]);
  writeFileSync(join(plan.outDir, "SETUP.md"), setupSheet(jobs, feedsMap));

  for (const [name, body] of [
    ["bench-T2-profile.nc", nc2],
    ["bench-T4-pilots.nc", nc4],
  ] as const) {
    const est = estimate(parse(body), { accel: 400, rapidRate: 5000 });
    console.log(
      `${name}: ${est.accelMin.toFixed(1)} min accel-aware (${est.g1Blocks} G1 + ${est.arcBlocks} arcs)`,
    );
  }
  console.log(`wrote ${plan.outDir}/parts.svg + 2 job files + SETUP.md`);
  for (const w of [...profFeeds.warnings, ...drillFeeds.warnings])
    console.log(`warn: ${w}`);
}

main();
