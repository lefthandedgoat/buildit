// ASCII STL export from a box assembly (src/assembly.ts).
//
// Zero-dependency rotatable preview: axis-aligned boxes decompose into
// 12 triangles each with outward normals and right-hand-rule winding.
// Open the output in macOS Preview (or Quick Look) and drag to rotate.
// ASCII, not binary: diffable in git, parseable in tests.

import type { Box } from "./assembly.ts";

type V = [number, number, number];

interface Facet {
  normal: V;
  verts: [V, V, V];
}

/** 12 outward-wound facets for one axis-aligned box. */
export function boxFacets(b: Box): Facet[] {
  const x0 = b.x,
    x1 = b.x + b.dx;
  const y0 = b.y,
    y1 = b.y + b.dy;
  const z0 = b.z,
    z1 = b.z + b.dz;
  const A: V = [x0, y0, z0],
    B: V = [x1, y0, z0];
  const C: V = [x1, y1, z0],
    D: V = [x0, y1, z0];
  const E: V = [x0, y0, z1],
    F: V = [x1, y0, z1];
  const G: V = [x1, y1, z1],
    H: V = [x0, y1, z1];
  return [
    { normal: [0, 0, -1], verts: [A, C, B] },
    { normal: [0, 0, -1], verts: [A, D, C] },
    { normal: [0, 0, 1], verts: [E, F, G] },
    { normal: [0, 0, 1], verts: [E, G, H] },
    { normal: [0, -1, 0], verts: [A, B, F] },
    { normal: [0, -1, 0], verts: [A, F, E] },
    { normal: [0, 1, 0], verts: [D, H, G] },
    { normal: [0, 1, 0], verts: [D, G, C] },
    { normal: [-1, 0, 0], verts: [A, E, H] },
    { normal: [-1, 0, 0], verts: [A, H, D] },
    { normal: [1, 0, 0], verts: [B, C, G] },
    { normal: [1, 0, 0], verts: [B, G, F] },
  ];
}

const num = (n: number): string => String(Math.round(n * 1000) / 1000);

/** Full ASCII STL document for a set of boxes. */
export function boxesToStl(boxes: Box[], name = "assembly"): string {
  const L: string[] = [`solid ${name}`];
  for (const b of boxes)
    for (const f of boxFacets(b)) {
      L.push(
        `  facet normal ${f.normal.map(num).join(" ")}`,
        "    outer loop",
        ...f.verts.map((v) => `      vertex ${v.map(num).join(" ")}`),
        "    endloop",
        "  endfacet",
      );
    }
  L.push(`endsolid ${name}`);
  return L.join("\n") + "\n";
}
