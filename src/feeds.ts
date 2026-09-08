// Chipload-based speeds & feeds engine (Shapeoko-class, 2.2kW VFD).
//
// feed = rpm * flutes * chipload. Chiploads below are conservative,
// verified-against-practice starting points for a rigid Shapeoko with a
// VFD spindle — NOT manufacturer max-metal-removal numbers.
//
// Safety tie-in: plunge feed never exceeds the existing material profile
// cap in materials.ts (feeds only move in the safe direction, same rule
// as plunge.ts). DOC/WOC are diameter-ratio rules, capped for tiny tools.

import { getProfile } from "./materials.ts";
import type { CutTool } from "./tools.ts";

export type MaterialId =
  | "spf-pine"
  | "walnut"
  | "locust"
  | "plywood"
  | "generic";

export type OpKind = "slot" | "pocket" | "profile" | "drill" | "finish3d";

export interface FeedsResult {
  material: MaterialId;
  op: OpKind;
  toolId: string;
  rpm: number;
  /** Cutting feed in mm/min. */
  feedMmMin: number;
  /** Straight-plunge feed in mm/min (capped by materials.ts profile). */
  plungeMmMin: number;
  /** Depth of cut per pass in mm. */
  docMm: number;
  /** Width of cut (stepover) in mm. */
  wocMm: number;
  chiploadMm: number;
  warnings: string[];
}

/**
 * Base chipload (mm/tooth at full engagement) keyed by material, then by
 * tool-diameter bucket. Buckets: >=20 (surfacer), >=5 (1/4"), >=2.5 (1/8"),
 * >=1 (1/16"), else sub-mm detail.
 */
const CHIPLOAD: Record<MaterialId, [number, number, number, number, number]> = {
  // [surfacer, quarter, eighth, sixteenth, submm]
  "spf-pine": [0.08, 0.05, 0.03, 0.015, 0.005],
  walnut: [0.06, 0.04, 0.025, 0.012, 0.005],
  locust: [0.04, 0.025, 0.015, 0.008, 0.004],
  plywood: [0.07, 0.045, 0.028, 0.013, 0.005],
  generic: [0.04, 0.025, 0.015, 0.008, 0.004],
};

/** materials.ts profile name per feeds material (plunge-cap tie-in). */
const PROFILE_FOR: Record<MaterialId, string> = {
  "spf-pine": "generic", // no pine profile yet: use conservative generic 250
  walnut: "walnut",
  locust: "locust",
  plywood: "generic",
  generic: "generic",
};

/** Default RPM per diameter bucket on the 2.2kW VFD (8000-24000 range). */
const RPM: [number, number, number, number, number] = [
  12000, 16000, 18000, 20000, 24000,
];

/** Op feed multiplier: slots run hot (full engagement), finish runs light. */
const OP_FEED_MULT: Record<OpKind, number> = {
  slot: 0.7,
  pocket: 1.0,
  profile: 1.0,
  drill: 0.6,
  finish3d: 1.0,
};

/** DOC as fraction of diameter per op (Shapeoko-conservative). */
const OP_DOC_RATIO: Record<OpKind, number> = {
  slot: 0.5,
  pocket: 1.0,
  profile: 1.0,
  drill: 1.5,
  finish3d: 0.15,
};

/** WOC as fraction of diameter per op. */
const OP_WOC_RATIO: Record<OpKind, number> = {
  slot: 1.0,
  pocket: 0.4,
  profile: 0.5,
  drill: 1.0,
  finish3d: 0.1,
};

function bucket(diameterMm: number): number {
  if (diameterMm >= 20) return 0;
  if (diameterMm >= 5) return 1;
  if (diameterMm >= 2.5) return 2;
  if (diameterMm >= 1) return 3;
  return 4;
}

/** Normalize free-text material names ("2x4", "SPF", "pine") to ids. */
export function normalizeMaterial(name: string): MaterialId {
  const n = name.trim().toLowerCase();
  if (/spf|pine|2x4|2x6|fir|spruce/.test(n)) return "spf-pine";
  if (/walnut/.test(n)) return "walnut";
  if (/locust/.test(n)) return "locust";
  if (/ply|birch|baltic|mdf/.test(n)) return "plywood";
  return "generic";
}

export function computeFeeds(
  tool: CutTool,
  materialName: string,
  op: OpKind,
): FeedsResult {
  const material = normalizeMaterial(materialName);
  const b = bucket(tool.diameterMm);
  const warnings: string[] = [];

  const chiploadMm = CHIPLOAD[material][b];
  const rpm = Math.min(RPM[b], tool.maxRpm);
  if (RPM[b] > tool.maxRpm)
    warnings.push(`${tool.id} RPM capped at tool max ${tool.maxRpm}`);

  const feedMmMin = Math.round(
    rpm * tool.flutes * chiploadMm * OP_FEED_MULT[op],
  );

  // Plunge: 35% of cutting feed, capped DOWN by the materials.ts profile
  // (same safe-direction rule as plunge.ts). Never raised.
  const profile = getProfile(PROFILE_FOR[material]);
  const plungeRaw = Math.round(feedMmMin * 0.35);
  const plungeMmMin = Math.min(plungeRaw, profile.plungeFeed);
  if (plungeRaw > profile.plungeFeed)
    warnings.push(
      `plunge ${plungeRaw} capped to ${profile.name} profile ${profile.plungeFeed}`,
    );

  let docMm = tool.diameterMm * OP_DOC_RATIO[op];
  // Tiny-tool guard: taper/detail bits never take more than 0.5mm DOC.
  if (tool.kind === "taper-ball" && docMm > 0.5) {
    docMm = 0.5;
    warnings.push("taper-ball DOC capped at 0.5mm");
  }
  // Surfacer guard: facing passes stay shallow.
  if (tool.kind === "surfacer" && docMm > 1.0) {
    docMm = 1.0;
    warnings.push("surfacer DOC capped at 1.0mm");
  }
  docMm = Math.round(docMm * 100) / 100;

  const wocMm = Math.round(tool.diameterMm * OP_WOC_RATIO[op] * 100) / 100;

  if (tool.kind === "surfacer" && op !== "pocket")
    warnings.push("surfacer is for facing/pocketing, not slotting/profiling");

  return {
    material,
    op,
    toolId: tool.id,
    rpm,
    feedMmMin,
    plungeMmMin,
    docMm,
    wocMm,
    chiploadMm,
    warnings,
  };
}
