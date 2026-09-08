// Tool library for Shapeoko-class + 2.2kW VFD spindle (metric).
//
// Greenfield front-half module: does NOT touch the optimizer pipeline
// (parser/janitor/arcs/rapids/restcut). It only describes bits so the
// feeds engine and job splitter can reason about them.
//
// Owner's bits (see HANDOFF.md): 1" surfacer, 1/4" flat upcut, 1/4" ball,
// 1/8" compression, 1/16" flat, 0.5mm tapered ball nose (~5.1deg/side).

export type ToolKind =
  | "surfacer"
  | "flat"
  | "ball"
  | "compression"
  | "taper-ball";

export interface CutTool {
  /** Stable id used in job files, e.g. "T1". */
  id: string;
  label: string;
  kind: ToolKind;
  /** Cutting diameter in mm. */
  diameterMm: number;
  /** Ball radius for ball/taper-ball, else 0. */
  cornerRadiusMm: number;
  flutes: number;
  /** Max RPM this tool should run at on the VFD spindle. */
  maxRpm: number;
  notes?: string;
}

export const TOOL_LIBRARY: CutTool[] = [
  {
    id: "T1",
    label: '1" surfacing insert',
    kind: "surfacer",
    diameterMm: 25.4,
    cornerRadiusMm: 0,
    flutes: 2,
    maxRpm: 12000,
    notes: "Surfacing only; never plunge straight.",
  },
  {
    id: "T2",
    label: '1/4" flat upcut',
    kind: "flat",
    diameterMm: 6.35,
    cornerRadiusMm: 0,
    flutes: 2,
    maxRpm: 18000,
    notes: "Workhorse: profiles, pockets, dados in sheet + solid stock.",
  },
  {
    id: "T3",
    label: '1/4" ball nose',
    kind: "ball",
    diameterMm: 6.35,
    cornerRadiusMm: 3.175,
    flutes: 2,
    maxRpm: 18000,
    notes: "3D finishing only.",
  },
  {
    id: "T4",
    label: '1/8" compression',
    kind: "compression",
    diameterMm: 3.175,
    cornerRadiusMm: 0,
    flutes: 2,
    maxRpm: 18000,
    notes: "Plywood sheet goods; full-depth single pass needs upcut engaged.",
  },
  {
    id: "T5",
    label: '1/16" flat',
    kind: "flat",
    diameterMm: 1.5875,
    cornerRadiusMm: 0,
    flutes: 2,
    maxRpm: 20000,
    notes: "Detail pockets, min feature >= 1.8mm.",
  },
  {
    id: "T6",
    label: "0.5mm tapered ball nose",
    kind: "taper-ball",
    diameterMm: 0.5,
    cornerRadiusMm: 0.25,
    flutes: 2,
    maxRpm: 24000,
    notes: "~5.1deg/side wedge-fit detail bit; DOC <= 0.5mm.",
  },
];

const BY_ID = new Map(TOOL_LIBRARY.map((t) => [t.id, t]));

/** Unknown ids return undefined so callers can report, never guess. */
export function getTool(id: string): CutTool | undefined {
  return BY_ID.get(id);
}

export function toolIds(): string[] {
  return TOOL_LIBRARY.map((t) => t.id);
}
