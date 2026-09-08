// CAM kernel v0: rectilinear 2.5D ops -> G-code text.
//
// Greenfield front-half module. Takes placed rects (svggen) + a feeds
// result (feeds.ts) and emits single-tool G-code bodies: outside profiles
// with multi-pass depth stepping, and G83 peck-drilled pilots.
//
// Conventions (grbl/Carbide-safe, metric):
// - Top of stock is Z0; target depths are negative numbers.
// - Outside profiles are offset outward by toolRadius so the PART comes
//   out to size (cutter comp done geometrically, never G41/G42).
// - Every descent is a straight Z-only plunge at feeds.plungeMmMin;
//   every XY cut runs at feeds.feedMmMin. No helical entry in v0.
// - Output is a body (no M3/M30): the caller wraps it per job (jobs.ts).
// - Comments name the op + source part so the setup sheet traces back.

import type { FeedsResult } from "./feeds.ts";

export interface ProfileOp {
  /** Part id from svggen (traceability only). */
  partId: string;
  /** Lower-left corner of the INTENDED part rect, mm. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Final floor depth, negative (e.g. -38 for through a 2x4 on edge). */
  targetZ: number;
  /** Through-cuts overshoot below the part so no skin remains. */
  overshoot?: number;
  /** Safe travel height. Default 10. */
  clearanceZ?: number;
}

export interface DrillOp {
  partId: string;
  x: number;
  y: number;
  /** Final depth, negative. */
  targetZ: number;
  /** Peck increment (Q). Default 2.0. */
  peckMm?: number;
  clearanceZ?: number;
}

const r3 = (n: number): string => {
  const r = Math.round(n * 1000) / 1000;
  return String(Object.is(r, -0) ? 0 : r);
};

/** Depth passes from Z0 to targetZ stepping by docMm (last pass exact). */
export function depthPasses(targetZ: number, docMm: number): number[] {
  if (!(targetZ < 0))
    throw new Error(`targetZ must be negative, got ${targetZ}`);
  if (!(docMm > 0)) throw new Error(`docMm must be positive, got ${docMm}`);
  const depth = Math.abs(targetZ);
  const n = Math.max(1, Math.ceil(depth / docMm));
  const passes: number[] = [];
  for (let i = 1; i <= n; i++)
    passes.push(i === n ? targetZ : -(depth * (i / n)));
  return passes;
}

/**
 * Outside profile of one rect. Returns G-code body text. Cut path is the
 * part rect expanded by toolRadius on all sides (verified in tests via
 * bounding box of parsed XY moves).
 */
export function profileRect(
  op: ProfileOp,
  feeds: FeedsResult,
  toolDiameterMm: number,
): string {
  if (!(op.w > 0 && op.h > 0))
    throw new Error(`profile dims must be positive, got ${op.w}x${op.h}`);
  const r = toolDiameterMm / 2;
  const floor = op.targetZ - (op.overshoot ?? 0);
  const clearance = op.clearanceZ ?? 10;
  const passes = depthPasses(floor, feeds.docMm);
  const x0 = op.x - r;
  const y0 = op.y - r;
  const x1 = op.x + op.w + r;
  const y1 = op.y + op.h + r;

  const L: string[] = [];
  L.push(
    `(profile ${op.partId} ${op.w}x${op.h} tool-d${toolDiameterMm} passes=${passes.length})`,
  );
  L.push(`G0X${r3(x0)}Y${r3(y0)}Z${r3(clearance)}`);
  for (const z of passes) {
    L.push(`G0X${r3(x0)}Y${r3(y0)}`);
    L.push(`G1Z${r3(z)}F${feeds.plungeMmMin}`);
    L.push(`G1X${r3(x1)}Y${r3(y0)}F${feeds.feedMmMin}`);
    L.push(`G1X${r3(x1)}Y${r3(y1)}`);
    L.push(`G1X${r3(x0)}Y${r3(y1)}`);
    L.push(`G1X${r3(x0)}Y${r3(y0)}`);
  }
  L.push(`G0Z${r3(clearance)}`);
  return L.join("\n") + "\n";
}

/** G83 peck-drill pilot at (x, y) down to targetZ. */
export function drillHole(op: DrillOp, feeds: FeedsResult): string {
  if (!(op.targetZ < 0))
    throw new Error(`targetZ must be negative, got ${op.targetZ}`);
  const peck = op.peckMm ?? 2.0;
  if (!(peck > 0)) throw new Error(`peckMm must be positive, got ${peck}`);
  const clearance = op.clearanceZ ?? 10;
  return (
    [
      `(drill ${op.partId} @${op.x},${op.y} to ${op.targetZ} Q${peck})`,
      `G0X${r3(op.x)}Y${r3(op.y)}Z${r3(clearance)}`,
      `G83X${r3(op.x)}Y${r3(op.y)}Z${r3(op.targetZ)}Q${r3(peck)}R${r3(clearance)}F${feeds.plungeMmMin}`,
      `G80`,
      `G0Z${r3(clearance)}`,
    ].join("\n") + "\n"
  );
}

/** Assemble op bodies into one program body (header/footer added by jobs.emitJob). */
export function camProgram(title: string, bodies: string[]): string {
  const esc = title.replace(/[()]/g, "");
  return [`(${esc})`, "G90", "G21", "", ...bodies].join("\n");
}
