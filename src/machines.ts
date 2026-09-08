// Per-machine accel/rapid presets for honest cycle-time estimates.
//
// Unlike materials (unknown names fall back to conservative generic),
// an unknown machine is a HARD error at the call site: estimates are
// the product, and a misspelled machine must never silently rescale
// every number on the page. getMachine returns null; index.ts exits 2
// with the available list.
//
// Only measured presets ship. Adding one requires a stopwatch, not a
// guess: run a representative file, compare the accel-aware estimate,
// adjust --accel until estimate ~= stopwatch (higher accel lowers the
// estimate), then send the triple. One calibrated preset beats ten
// datasheet fantasies.

export interface MachineProfile {
  name: string;
  /** Trapezoid accel in mm/s^2 for the estimator AND rapids time math. */
  accel: number;
  /** Rapid rate in mm/min. */
  rapidRate: number;
  /** Provenance: what machine, how calibrated. */
  note: string;
}

const MACHINES: Record<string, MachineProfile> = {
  shapeoko: {
    name: "shapeoko",
    accel: 400,
    rapidRate: 5000,
    note: "Shapeoko + 2.2kW VFD, metric. Accel model matches stopwatch at ~x1.39 (CC naive under-reads the same file).",
  },
};

/** Null on unknown names — the caller must fail loud (exit 2). */
export function getMachine(name: string): MachineProfile | null {
  return MACHINES[name.toLowerCase()] ?? null;
}

export function machineNames(): string[] {
  return Object.keys(MACHINES);
}

export interface ResolvedRates {
  accel: number;
  rapidRate: number;
  /** Human-readable provenance for the report row. */
  source: string;
}

/**
 * Preset with explicit-flag override: --accel/--rapid always win over
 * the named machine (a calibration run in progress beats the preset).
 * Null override = not passed on the command line.
 */
export function resolveRates(
  machine: MachineProfile,
  accelOverride: number | null,
  rapidOverride: number | null,
): ResolvedRates {
  const accel =
    accelOverride !== null && Number.isFinite(accelOverride)
      ? accelOverride
      : machine.accel;
  const rapidRate =
    rapidOverride !== null && Number.isFinite(rapidOverride)
      ? rapidOverride
      : machine.rapidRate;
  const bits: string[] = [];
  if (accelOverride !== null) bits.push(`accel=${accel}`);
  if (rapidOverride !== null) bits.push(`rapid=${rapidRate}`);
  return {
    accel,
    rapidRate,
    source:
      bits.length > 0 ? `${machine.name} (${bits.join(" ")})` : machine.name,
  };
}
