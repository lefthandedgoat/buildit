// Parametric rectilinear parts -> Carbide-safe SVG.
//
// Front-half step 1 of describe->preview: dimensional-lumber furniture
// (benches, shelves, fixtures) is rects, not sculptures. This module lays
// out named parts on sheet/stock outlines and emits absolute-coord SVG
// (no transform groups — same Carbide-safe rule as the Squonk inlay SVGs).
//
// No optimizer files are touched; output feeds the existing viewer.

export interface Part {
  id: string;
  label: string;
  wMm: number;
  hMm: number;
  qty: number;
}

export interface Placed {
  partId: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutOptions {
  sheetW: number;
  sheetH: number;
  /** Saw kerf / tool gap between parts. Default 3.2 (1/8"). */
  kerf?: number;
  /** Margin from sheet edge. Default 5. */
  margin?: number;
}

/**
 * Shelf-pack parts in rows. Deterministic, first-fit, no rotation (grain
 * matters on lumber/sheet goods). Throws when a part exceeds the sheet.
 */
export function layoutParts(parts: Part[], opts: LayoutOptions): Placed[] {
  const kerf = opts.kerf ?? 3.2;
  const margin = opts.margin ?? 5;
  const placed: Placed[] = [];
  let cx = margin;
  let cy = margin;
  let rowH = 0;

  const expanded: Omit<Part, "qty">[] = [];
  for (const p of parts)
    for (let i = 0; i < p.qty; i++)
      expanded.push({ id: p.id, label: p.label, wMm: p.wMm, hMm: p.hMm });

  for (const p of expanded) {
    if (p.wMm > opts.sheetW - 2 * margin || p.hMm > opts.sheetH - 2 * margin)
      throw new Error(
        `part ${p.id} ${p.wMm}x${p.hMm}mm exceeds sheet ${opts.sheetW}x${opts.sheetH}mm`,
      );
    if (cx + p.wMm > opts.sheetW - margin) {
      cx = margin;
      cy += rowH + kerf;
      rowH = 0;
    }
    if (cy + p.hMm > opts.sheetH - margin + 1e-9)
      throw new Error(`sheet overflow placing ${p.id} at y=${cy.toFixed(1)}`);
    placed.push({
      partId: p.id,
      label: p.label,
      x: cx,
      y: cy,
      w: p.wMm,
      h: p.hMm,
    });
    cx += p.wMm + kerf;
    rowH = Math.max(rowH, p.hMm);
  }
  return placed;
}

/** Emit absolute-coord SVG (mm units, no transforms) for a placed layout. */
export function partsToSvg(
  placed: Placed[],
  sheetW: number,
  sheetH: number,
  title = "parts",
): string {
  const esc = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${sheetW}mm" height="${sheetH}mm" viewBox="0 0 ${sheetW} ${sheetH}">`,
    `<title>${esc(title)}</title>`,
    `<rect x="0" y="0" width="${sheetW}" height="${sheetH}" fill="none" stroke="black" stroke-width="0.5"/>`,
  ];
  for (const p of placed) {
    const r = (n: number): string => (Math.round(n * 100) / 100).toString();
    out.push(
      `<rect x="${r(p.x)}" y="${r(p.y)}" width="${r(p.w)}" height="${r(p.h)}" fill="none" stroke="red" stroke-width="0.3"/>`,
      `<text x="${r(p.x + 2)}" y="${r(p.y + 5)}" font-size="4" fill="black">${esc(p.label)} ${r(p.w)}x${r(p.h)}</text>`,
    );
  }
  out.push("</svg>");
  return out.join("\n") + "\n";
}

/**
 * Demo: 2x4 bench cut list. Top from laminated 2x4s on edge, 4 legs +
 * 2 aprons. All dims in mm. Call with overlength to preview, adjust,
 * then toolpath.
 */
export function benchParts(
  topLenMm = 1219,
  topDepthMm = 457,
  heightMm = 457,
): Part[] {
  // Actual 2x4: 38 x 89mm. Top = N strips on edge (89 tall -> rip to seat?).
  // Keep simple: seat slabs 38 thick laminated to depth.
  const strips = Math.max(1, Math.round(topDepthMm / 38));
  return [
    {
      id: "seat",
      label: "seat strip (2x4 on edge)",
      wMm: topLenMm,
      hMm: 89,
      qty: strips,
    },
    { id: "leg", label: "leg", wMm: 89, hMm: heightMm - 38, qty: 4 },
    {
      id: "apron-long",
      label: "apron long",
      wMm: topLenMm - 2 * 89,
      hMm: 89,
      qty: 2,
    },
    {
      id: "apron-short",
      label: "apron short",
      wMm: topDepthMm - 2 * 89,
      hMm: 89,
      qty: 2,
    },
  ];
}
