// Box assembly: rectilinear furniture as placed 3D boxes -> SVG views.
//
// The visualization half of describe->preview: a bench is 9 boxes with
// positions, not a pile of flat parts. From the assembly we derive plan
// (top), front/side elevations with overall dimensions, and an exploded
// isometric for at-a-glance proportions — all absolute-coord SVG, no
// transforms (same Carbide-safe rule as svggen).
//
// Each box carries its process assignment: saw work gets dimensions,
// CNC work gets toolpaths. Nobody CNCs a straight 2x4 rip.

export type Process = "saw" | "cnc" | "laminate";

export interface Box {
  partId: string;
  label: string;
  qtyNote?: string;
  /** Lower-corner position, mm. */
  x: number;
  y: number;
  z: number;
  /** Extents, mm. */
  dx: number;
  dy: number;
  dz: number;
  process: Process;
  /** Why this box needs (or skips) the CNC. */
  note: string;
  /**
   * Hardware (axles, bearings, pins): bolted THROUGH wood, so it shares
   * volume by design. Overlap checks skip hardware-involved pairs.
   */
  hardware?: boolean;
}

export interface BenchDims {
  topLen: number;
  topDepth: number;
  height: number;
  /** 2x4 actual: 38 x 89. */
  lumberT?: number;
  lumberW?: number;
}

/** 2x4 bench assembly: laminated seat slab, 4 legs, 4 aprons. */
export function benchAssembly(d: BenchDims): Box[] {
  const t = d.lumberT ?? 38;
  const w = d.lumberW ?? 89;
  const seatZ = d.height - t;
  const inset = t; // legs flush-ish, one thickness in from edges
  const boxes: Box[] = [];
  boxes.push({
    partId: "seat",
    label: `seat slab ${d.topLen}x${d.topDepth}x${t}`,
    qtyNote: `laminate ${Math.round(d.topDepth / t)} strips on edge`,
    x: 0,
    y: 0,
    z: seatZ,
    dx: d.topLen,
    dy: d.topDepth,
    dz: t,
    process: "laminate",
    note: "table saw rips + glue-up; CNC only if adding inlay or edge detail",
  });
  const legH = seatZ;
  const legPos: [number, number][] = [
    [inset, inset],
    [d.topLen - inset - t, inset],
    [inset, d.topDepth - inset - w],
    [d.topLen - inset - t, d.topDepth - inset - w],
  ];
  legPos.forEach(([lx, ly], i) =>
    boxes.push({
      partId: "leg",
      label: `leg ${t}x${w}x${legH} #${i + 1}`,
      x: lx,
      y: ly,
      z: 0,
      dx: t,
      dy: w,
      dz: legH,
      process: "saw",
      note: "miter saw crosscuts; CNC bolt pilots only",
    }),
  );
  const apronH = w;
  const apronZ = seatZ - apronH;
  const innerX0 = inset + t;
  const innerX1 = d.topLen - inset - t;
  const innerY0 = inset + w;
  const innerY1 = d.topDepth - inset - w;
  // Long aprons run along X at front/back, between the legs.
  for (const [i, ay] of [inset, d.topDepth - inset - t].entries())
    boxes.push({
      partId: "apron-long",
      label: `apron long ${innerX1 - innerX0}x${t}x${apronH} ${i === 0 ? "front" : "back"}`,
      x: innerX0,
      y: ay,
      z: apronZ,
      dx: innerX1 - innerX0,
      dy: t,
      dz: apronH,
      process: "saw",
      note: "saw cuts; optional CNC dado for leg joint",
    });
  // Short aprons run along Y at the ends.
  for (const [i, ax] of [inset, d.topLen - inset - t].entries())
    boxes.push({
      partId: "apron-short",
      label: `apron short ${t}x${innerY1 - innerY0}x${apronH} ${i === 0 ? "left" : "right"}`,
      x: ax,
      y: innerY0,
      z: apronZ,
      dx: t,
      dy: innerY1 - innerY0,
      dz: apronH,
      process: "saw",
      note: "saw cuts; optional CNC dado for leg joint",
    });
  return boxes;
}

/** True when two boxes share interior volume (touching faces are fine). */
export function boxesOverlap(a: Box, b: Box): boolean {
  if (a.hardware === true || b.hardware === true) return false;
  const eps = 1e-9;
  return (
    a.x + eps < b.x + b.dx &&
    b.x + eps < a.x + a.dx &&
    a.y + eps < b.y + b.dy &&
    b.y + eps < a.y + a.dy &&
    a.z + eps < b.z + b.dz &&
    b.z + eps < a.z + a.dz
  );
}

export function assemblyOverlaps(boxes: Box[]): [Box, Box][] {
  const out: [Box, Box][] = [];
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++)
      if (boxesOverlap(boxes[i], boxes[j])) out.push([boxes[i], boxes[j]]);
  return out;
}

// ---- 2D projection -------------------------------------------------------

export interface Rect2 {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  process: Process;
}

export type Elevation = "front" | "side" | "top";

/** Orthographic projection of boxes onto an elevation plane. */
export function elevate(boxes: Box[], plane: Elevation): Rect2[] {
  return boxes.map((b) => {
    if (plane === "front")
      return {
        x: b.x,
        y: b.z,
        w: b.dx,
        h: b.dz,
        label: b.label,
        process: b.process,
      };
    if (plane === "side")
      return {
        x: b.y,
        y: b.z,
        w: b.dy,
        h: b.dz,
        label: b.label,
        process: b.process,
      };
    return {
      x: b.x,
      y: b.y,
      w: b.dx,
      h: b.dy,
      label: b.label,
      process: b.process,
    };
  });
}

const PROCESS_STROKE: Record<Process, string> = {
  saw: "blue",
  cnc: "red",
  laminate: "green",
};

const r2 = (n: number): string => String(Math.round(n * 100) / 100);

/** One dimensioned elevation view (overall W x H + per-box outlines). */
export function elevationSvg(
  rects: Rect2[],
  title: string,
  dimW: number,
  dimH: number,
): string {
  const pad = 30;
  const allX = rects.flatMap((r) => [r.x, r.x + r.w]);
  const allY = rects.flatMap((r) => [r.y, r.y + r.h]);
  const minX = Math.min(...allX);
  const maxX = Math.max(...allX);
  const minY = Math.min(...allY);
  const maxY = Math.max(...allY);
  // SVG y grows down: flip.
  const fy = (y: number): number => pad + 14 + (maxY - y);
  const W = maxX - minX + pad * 2;
  const H = maxY - minY + pad * 2 + 14;
  const esc = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${r2(W)}mm" height="${r2(H)}mm" viewBox="0 0 ${r2(W)} ${r2(H)}">`,
    `<title>${esc(title)}</title>`,
    `<text x="${pad}" y="12" font-size="6">${esc(title)} — overall ${r2(dimW)} x ${r2(dimH)}mm</text>`,
  ];
  for (const r of rects) {
    const sx = pad + (r.x - minX);
    out.push(
      `<rect x="${r2(sx)}" y="${r2(fy(r.y + r.h))}" width="${r2(r.w)}" height="${r2(r.h)}" fill="none" stroke="${PROCESS_STROKE[r.process]}" stroke-width="0.4"/>`,
    );
  }
  // Overall width dimension below, height dimension left.
  const yDim = fy(minY) + 8;
  out.push(
    `<line x1="${pad}" y1="${r2(yDim)}" x2="${r2(pad + (maxX - minX))}" y2="${r2(yDim)}" stroke="black" stroke-width="0.3"/>`,
    `<text x="${r2(pad + (maxX - minX) / 2 - 10)}" y="${r2(yDim + 5)}" font-size="5">${r2(dimW)}mm</text>`,
    `<line x1="${pad - 8}" y1="${r2(fy(maxY))}" x2="${pad - 8}" y2="${r2(fy(minY))}" stroke="black" stroke-width="0.3"/>`,
    `<text x="2" y="${r2((fy(maxY) + fy(minY)) / 2)}" font-size="5">${r2(dimH)}mm</text>`,
  );
  out.push("</svg>");
  return out.join("\n") + "\n";
}

// ---- exploded isometric ---------------------------------------------------

interface Pt {
  x: number;
  y: number;
}

const COS30 = Math.cos(Math.PI / 6);
const SIN30 = 0.5;

/** Isometric projection: x right-down, y left-down, z up. */
export function isoPt(x: number, y: number, z: number): Pt {
  return { x: (x - y) * COS30, y: (x + y) * SIN30 - z };
}

export interface IsoFace {
  pts: Pt[];
  shade: string;
  label?: string;
  depth: number;
}

const SHADES: Record<Process, [string, string, string]> = {
  saw: ["#dbeafe", "#bfdbfe", "#93c5fd"],
  cnc: ["#fee2e2", "#fecaca", "#fca5a5"],
  laminate: ["#dcfce7", "#bbf7d0", "#86efac"],
};

/** One box as 3 visible iso faces (top, front-x, side-y). */
export function boxFaces(b: Box, liftedZ: number): IsoFace[] {
  const [top, front, side] = SHADES[b.process];
  const { x, y, dx, dy, dz } = b;
  const z = b.z + liftedZ;
  const c000 = isoPt(x, y, z);
  const c100 = isoPt(x + dx, y, z);
  const c010 = isoPt(x, y + dy, z);
  const c110 = isoPt(x + dx, y + dy, z);
  const c001 = isoPt(x, y, z + dz);
  const c101 = isoPt(x + dx, y, z + dz);
  const c011 = isoPt(x, y + dy, z + dz);
  const c111 = isoPt(x + dx, y + dy, z + dz);
  const depth = x + y + z; // painter key: far (small) first
  return [
    { pts: [c001, c101, c111, c011], shade: top, label: b.label, depth },
    { pts: [c000, c100, c101, c001], shade: front, depth: depth + 0.1 },
    { pts: [c010, c110, c111, c011], shade: side, depth: depth + 0.2 },
  ];
}

/**
 * Exploded iso: boxes lifted apart vertically in assembly order (seat
 * highest) so joinery interfaces read at a glance. Painter-sorted.
 */
export function explodedIso(boxes: Box[], gapMm = 60): string {
  const faces: IsoFace[] = [];
  const order = [...boxes].sort((a, b) => b.z - a.z || b.y - a.y);
  order.forEach((b, i) => faces.push(...boxFaces(b, i * gapMm)));
  faces.sort((a, b) => a.depth - b.depth);

  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  for (const f of faces)
    for (const p of f.pts) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
  const pad = 20;
  const W = maxX - minX + pad * 2;
  const H = maxY - minY + pad * 2 + 14;
  const esc = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const poly = (f: IsoFace): string =>
    `<polygon points="${f.pts.map((p) => `${r2(p.x - minX + pad)},${r2(p.y - minY + pad + 14)}`).join(" ")}" fill="${f.shade}" stroke="black" stroke-width="0.3"/>`;
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${r2(W)}mm" height="${r2(H)}mm" viewBox="0 0 ${r2(W)} ${r2(H)}">`,
    `<title>exploded assembly (blue=saw, green=laminate, red=CNC)</title>`,
    `<text x="${pad}" y="12" font-size="6">exploded assembly (blue=saw, green=laminate, red=CNC)</text>`,
    ...faces.map(poly),
  ];
  // Labels for the large faces only (seat + legs), anchored at face centroid.
  for (const f of faces) {
    if (!f.label) continue;
    const cx = f.pts.reduce((s, p) => s + p.x, 0) / f.pts.length - minX + pad;
    const cy =
      f.pts.reduce((s, p) => s + p.y, 0) / f.pts.length - minY + pad + 14;
    out.push(
      `<text x="${r2(cx - 30)}" y="${r2(cy)}" font-size="4">${esc(f.label)}</text>`,
    );
  }
  out.push("</svg>");
  return out.join("\n") + "\n";
}
