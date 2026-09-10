// Flip-drum balance: the grid plan's open DECIDE is how to control the
// 180deg flip once the wedge is pulled (gas strut vs a paver in the drum
// base). This module makes that decision arithmetic instead of a guess.
//
// The rotating set alone is flat-heavy: the flat skin sits further below
// the axle than the platform sits above it, so tool-up is the drum's rest
// state. The tool bolted above the axle is the over-center load that wants
// to slam toward stowed. Both terms come from the plan's own geometry:
//
//   peak (90deg) moment = tool mass x CG height above the axle
//                         + drum's own signed moment
//   neutral counterweight = peak moment / free arm below the axle
//
// One material assumption: honey locust glue-up at shop moisture,
// 700 kg/m3 (bracket 650-770 = +/-10%). Tool mass is measured (bathroom
// scale); CG height defaults to mid-envelope but is a --*Cg override.

import type { Box } from "./assembly.ts";
import { flipRectBay, type GridPlan } from "./modules.ts";

/** Honey locust glue-up at shop moisture, kg/m3 (bracket 650-770). */
export const LOCUST_KG_M3 = 700;

const G = 9.80665; // m/s2

export interface FlipLoad {
  bayId: string;
  toolName: string;
  /** Rotating structural parts only (platform, cheeks, flat face), kg. */
  drumMassKg: number;
  /** Signed moment about the axle; negative = flat-heavy (rests tool-up). */
  drumMomentKgM: number;
  /** Axle -> flat-face depth available for a counterweight, mm. */
  counterweightArmMm: number;
  /** Outermost rotating radius, where a hand or luggage scale acts, mm. */
  swingRadiusMm: number;
  /** Axle height above the floor, mm. */
  axleHeightMm: number;
}

export interface FlipAssist {
  toolMassKg: number;
  /** Tool CG above the platform top, mm. */
  cgAbovePlatformMm: number;
  /** Peak (90deg) moment toward stowed, kg.m; <=0 means self-holding. */
  peakMomentKgM: number;
  /** The same peak in N.m. */
  peakTorqueNm: number;
  /** Force at the drum rim to hold the peak, N. */
  rimForceN: number;
  /** Counterweight for a neutral flip at the free arm, kg (0 if none needed). */
  neutralCounterweightKg: number;
}

function partMassKg(b: Box): number {
  return ((b.dx * b.dy * b.dz) / 1e9) * LOCUST_KG_M3;
}

/** Rotating-set balance for one flip bay; needs no tool mass. */
export function flipLoad(plan: GridPlan, bayId: string): FlipLoad {
  const bay = plan.bays.find((b) => b.id === bayId && b.kind === "flip");
  if (!bay) throw new Error(`no flip bay "${bayId}" in plan`);
  const tool = plan.flipTools[bayId];
  if (!tool) throw new Error(`no flip tool for bay "${bayId}"`);
  const drum = flipRectBay(plan.spec, bayId, 0, 0, bay.w, bay.d, tool);
  let drumMassKg = 0;
  let drumMomentKgM = 0;
  let flatOuterMm = Number.NaN;
  for (const b of drum.rotating) {
    // The tool rides with the drum but its mass belongs to the vendor
    // machine, not to the wood: the caller supplies it as a point mass.
    if (b.partId.includes("-tool-")) continue;
    if (b.partId.endsWith("-drum-flat")) flatOuterMm = b.z;
    const m = partMassKg(b);
    drumMassKg += m;
    drumMomentKgM += (m * (b.z + b.dz / 2 - drum.A)) / 1000;
  }
  if (!Number.isFinite(flatOuterMm))
    throw new Error(`bay "${bayId}" has no drum flat face`);
  return {
    bayId,
    toolName: tool.name,
    drumMassKg,
    drumMomentKgM,
    counterweightArmMm: drum.A - flatOuterMm,
    swingRadiusMm: drum.swingRadius,
    axleHeightMm: drum.A,
  };
}

/** Peak flip moment, rim force and neutral counterweight for a tool. */
export function flipAssist(
  l: FlipLoad,
  toolMassKg: number,
  cgAbovePlatformMm: number,
): FlipAssist {
  if (!(toolMassKg > 0)) throw new Error(`tool mass must be > 0 kg`);
  if (!(cgAbovePlatformMm >= 0))
    throw new Error(`tool CG must be >= 0 mm above the platform`);
  // Platform top sits 50mm above the axle; +cg is the tool's own envelope.
  const toolMomentKgM = (toolMassKg * (50 + cgAbovePlatformMm)) / 1000;
  const peakKgM = toolMomentKgM + l.drumMomentKgM;
  const armM = l.counterweightArmMm / 1000;
  return {
    toolMassKg,
    cgAbovePlatformMm,
    peakMomentKgM: peakKgM,
    peakTorqueNm: peakKgM * G,
    rimForceN: (Math.abs(peakKgM) * G) / (l.swingRadiusMm / 1000),
    neutralCounterweightKg: peakKgM > 0 ? peakKgM / armM : 0,
  };
}

/** Default CG estimate when the tool has not been tipped: mid-envelope. */
export function defaultCgMm(baseToTable: number, aboveTable: number): number {
  return (baseToTable + aboveTable) / 2;
}
