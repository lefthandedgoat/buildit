// Modular saw-grid workstation: 2x3 bays of square frames + lift-off
// honey-locust tops + rolling tool carts. Greenfield front-half module.
//
// Datum: H = floor -> tool table (default 34in PLACEHOLDER until the saw
// is measured). Support tops sit 3mm below H so stock never catches an
// edge. Saw lives front-middle: rip feeds front->back onto the back row;
// spin the cart 90 (roll out, turn, roll back) and the side modules catch
// crosscut stock. Front bay side is fully open (no top rail, no bottom
// stretcher) so carts roll straight in.
//
// All dims in mm internally; grid mode speaks inches at the boundary.

import { type Box, assemblyOverlaps } from "./assembly.ts";
import type { ViewerArrow } from "./stlview.ts";

export interface GridSpec {
  S: number; // module side
  H: number; // floor -> tool table datum
  supportDrop: number; // support tops below H
  post: number; // corner post section (89x89 laminated 2x4 / 4x4)
  frontPostFace: number; // front posts present 38 to the opening
  railT: number; // top rail thickness (3 sides only)
  railH: number;
  ledgeW: number; // panel ledge strip width
  ledgeH: number;
  panelT: number; // honey-locust glue-up thickness
  stretcherT: number;
  stretcherH: number;
  cartClear: number; // cart-to-opening total clearance
  cartWall: number;
  platformT: number; // cart platform thickness
  rows: number;
  cols: number;
}

export const DEFAULT_GRID: GridSpec = {
  S: 813, // 32in
  H: 864, // 34in PLACEHOLDER — measure floor->saw-table
  supportDrop: 3,
  post: 89,
  frontPostFace: 38,
  railT: 38,
  railH: 89,
  ledgeW: 19,
  ledgeH: 38,
  panelT: 19, // 3/4 honey locust
  stretcherT: 38,
  stretcherH: 89,
  cartClear: 12,
  cartWall: 19,
  platformT: 19,
  rows: 2,
  cols: 3,
};

/** Bay width the cart must pass: S minus two narrow post faces. */
export function openingOf(g: GridSpec): number {
  return g.S - 2 * g.frontPostFace;
}

/** Square cart outer dimension. */
export function cartOuterOf(g: GridSpec): number {
  return openingOf(g) - g.cartClear;
}

export type StationKind = "top" | "saw" | "bay" | "flip";

export interface FlipTool {
  name: string;
  /** Footprint on the drum platform: W along axle (x), D across (y). */
  tableW: number;
  tableD: number;
  /** Base Miles: platform top -> working table. PLACEHOLDER until measured. */
  baseToTable: number;
  /** Motor/housing height above the working table. */
  aboveTable: number;
  /** Feed direction along +x: +1 feeds west->east, -1 east->west. */
  feedDir: 1 | -1;
  /** Feed axis: lateral (x) or front-back (y). Drums always pivot on X. */
  feedAxis: "x" | "y";
}

export interface Bay {
  id: string;
  x: number;
  y: number;
  w: number;
  d: number;
  kind: StationKind;
  /**
   * Flip direction in RENDER coords (plan-y is mirrored: +y faces the
   * front/aisle). Drums rotate AWAY from the neighboring row: +1 when
   * open air lies toward +y (96x48 front-row flips face the aisle),
   * -1 when it lies toward -y (asymmetric back-row flips face rear air).
   */
  flipDir?: -1 | 1;
}

export interface GridPlan {
  spec: GridSpec;
  /** Explicit bays: saw row 3x32in, flip row 2x48in. Row 0 = front. */
  bays: Bay[];
  /** Saw table footprint on its stand (Hercules 57673: 622 x 552). */
  sawTableW: number;
  sawTableD: number;
  /** Saw BASE footprint bolting to the stand (narrower than the table). */
  sawBaseW: number;
  sawBaseD: number;
  /** Saw base -> table (off-stand body). PLACEHOLDER until measured. */
  sawBaseToTable: number;
  /** Flip drums by bay id. */
  flipTools: Record<string, FlipTool>;
}

/** Hercules 59313 12in planer, ROTATED: long axis front-back (y). */
export const PLANER_FLIP: FlipTool = {
  name: "planer 59313",
  tableW: 362, // 14-1/4in across (x)
  tableD: 591, // 23-1/4in along feed (y)
  baseToTable: 150, // PLACEHOLDER — measure bed above tray
  aboveTable: 250, // motor housing above bed
  feedDir: 1, // front->back onto its outfeed lane
  feedAxis: "y",
};

export function defaultPlan(spec: GridSpec = DEFAULT_GRID): GridPlan {
  // 96x48 front-feed: tool row (saw 28 + planer-rot 24 + jointer 44) with
  // each tool feeding front->back (jointer: lateral exit west), plus a
  // shallow back row of outfeed tops matching the lanes.
  const SAW_W = 711; // 28in (needs base <=22.5in — MEASURE)
  const PLAN_W = 610; // 24in
  const JOIN_W = 1118; // 44in
  const ROW_D = 813; // 32in tool row
  const BACK_D = 406; // 16in outfeed tops
  return {
    spec,
    bays: [
      { id: "saw", x: 0, y: 0, w: SAW_W, d: ROW_D, kind: "saw" },
      {
        id: "fp",
        x: SAW_W,
        y: 0,
        w: PLAN_W,
        d: ROW_D,
        kind: "flip",
        flipDir: 1,
      },
      {
        id: "fj",
        x: SAW_W + PLAN_W,
        y: 0,
        w: JOIN_W,
        d: ROW_D,
        kind: "flip",
        flipDir: 1,
      },
      { id: "t0", x: 0, y: ROW_D, w: SAW_W, d: BACK_D, kind: "top" },
      { id: "t1", x: SAW_W, y: ROW_D, w: PLAN_W, d: BACK_D, kind: "top" },
      {
        id: "t2",
        x: SAW_W + PLAN_W,
        y: ROW_D,
        w: JOIN_W,
        d: BACK_D,
        kind: "top",
      },
    ],
    sawTableW: 622,
    sawTableD: 552,
    sawBaseW: 460, // PLACEHOLDER — measure the base casting, not the table
    sawBaseD: 410, // PLACEHOLDER
    sawBaseToTable: 200, // PLACEHOLDER
    flipTools: { fp: PLANER_FLIP, fj: JOINTER_FLIP },
  };
}

/** Dual-unit label in woodworker fractions: 813 (32"), 725 (28-9/16"). */
export function both(mm: number): string {
  const six = Math.round((mm / 25.4) * 16);
  const whole = Math.floor(six / 16);
  let rem = six % 16;
  let den = 16;
  while (rem % 2 === 0 && den > 1 && rem > 0) {
    rem /= 2;
    den /= 2;
  }
  const frac = rem === 0 ? "" : `${rem}/${den}`;
  const inch =
    whole > 0 && frac !== ""
      ? `${whole}-${frac}`
      : frac === ""
        ? `${whole}`
        : frac;
  return `${Math.round(mm)} (${inch}")`;
}

function box(
  partId: string,
  label: string,
  x: number,
  y: number,
  z: number,
  dx: number,
  dy: number,
  dz: number,
  process: Box["process"],
  note: string,
): Box {
  return { partId, label, x, y, z, dx, dy, dz, process, note };
}

/** One open frame at grid origin (ox, oy). Front (+entry) faces -y.
 * Flip bays pass { backRail: false }: the drum sweep needs front AND back
 * open (proven by the swing test); racking goes through the side
 * stretchers + neighboring frames. */
export function frameBoxes(
  g: GridSpec,
  station: string,
  ox: number,
  oy: number,
  opts: { backRail?: boolean; ledges?: "ring" | "sides" } = {},
): Box[] {
  const {
    S,
    post,
    frontPostFace,
    railT,
    railH,
    ledgeW,
    ledgeH,
    panelT,
    stretcherT,
    stretcherH,
    supportDrop,
    H,
  } = g;
  const railTopZ = H - supportDrop - panelT;
  const out: Box[] = [];
  const P = (
    id: string,
    l: string,
    x: number,
    y: number,
    z: number,
    dx: number,
    dy: number,
    dz: number,
    note: string,
  ) =>
    out.push(
      box(
        `${station}-${id}`,
        `${station} ${l}`,
        ox + x,
        oy + y,
        z,
        dx,
        dy,
        dz,
        "saw",
        note,
      ),
    );
  // Front posts: narrow face to the opening. Back posts: full 89x89.
  // All four posts present the narrow 38 face to the opening so the cart
  // passes full-depth (back 89x89 posts would pinch the interior to S-178).
  P(
    "post-fl",
    `corner post ${post}x${post}`,
    0,
    0,
    0,
    frontPostFace,
    post,
    railTopZ,
    "store 2x4; 38 face to opening",
  );
  P(
    "post-fr",
    `corner post ${post}x${post}`,
    S - frontPostFace,
    0,
    0,
    frontPostFace,
    post,
    railTopZ,
    "store 2x4",
  );
  P(
    "post-bl",
    `corner post ${post}x${post}`,
    0,
    S - post,
    0,
    frontPostFace,
    post,
    railTopZ,
    "store 2x4",
  );
  P(
    "post-br",
    `corner post ${post}x${post}`,
    S - frontPostFace,
    S - post,
    0,
    frontPostFace,
    post,
    railTopZ,
    "store 2x4",
  );
  // Top rails: back + left + right (front open full height for cart entry).
  // Flip bays omit the back rail: the drum sweep needs front AND back open.
  if (opts.backRail !== false)
    P(
      "rail-back",
      `top rail`,
      frontPostFace,
      S - railT,
      railTopZ - railH,
      S - 2 * frontPostFace,
      railT,
      railH,
      "store 2x4; glue+screw into posts",
    );
  P(
    "rail-left",
    `top rail`,
    0,
    post,
    railTopZ - railH,
    railT,
    S - 2 * post,
    railH,
    "store 2x4",
  );
  P(
    "rail-right",
    `top rail`,
    S - railT,
    post,
    railTopZ - railH,
    railT,
    S - 2 * post,
    railH,
    "store 2x4",
  );
  // Ledge ring the loose panel sits on (front ledge screws to side ledges).
  // Flip bays keep side ledges only: front/back ledges would collide with
  // the stowed cheeks, and the flipped flat face cantilevers from the
  // axle + lock wedges (no fixed support can live inside the sweep disc).
  const ledgeZ = railTopZ - ledgeH;
  const wantRing = opts.ledges !== "sides";
  if (wantRing)
    P(
      "ledge-front",
      `panel ledge`,
      frontPostFace,
      post - ledgeW,
      ledgeZ,
      S - 2 * frontPostFace,
      ledgeW,
      ledgeH,
      "19mm strip; clearance for locust movement",
    );
  if (wantRing)
    P(
      "ledge-back",
      `panel ledge`,
      frontPostFace,
      S - post,
      ledgeZ,
      S - 2 * frontPostFace,
      ledgeW,
      ledgeH,
      "19mm strip",
    );
  P(
    "ledge-left",
    `panel ledge`,
    railT,
    post,
    ledgeZ,
    ledgeW,
    S - 2 * post,
    ledgeH,
    "19mm strip",
  );
  P(
    "ledge-right",
    `panel ledge`,
    S - railT - ledgeW,
    post,
    ledgeZ,
    ledgeW,
    S - 2 * post,
    ledgeH,
    "19mm strip",
  );
  // Bottom stretchers: 3 sides (front open for wheels + feet).
  P(
    "stretch-back",
    `stretcher`,
    frontPostFace,
    S - stretcherT,
    0,
    S - 2 * frontPostFace,
    stretcherT,
    stretcherH,
    "store 2x4 at floor",
  );
  P(
    "stretch-left",
    `stretcher`,
    0,
    post,
    0,
    stretcherT,
    S - 2 * post,
    stretcherH,
    "store 2x4 at floor",
  );
  P(
    "stretch-right",
    `stretcher`,
    S - stretcherT,
    post,
    0,
    stretcherT,
    S - 2 * post,
    stretcherH,
    "store 2x4 at floor",
  );
  return out;
}

/** Loose-lay honey-locust panel for a topped station. */
export function panelBox(
  g: GridSpec,
  station: string,
  ox: number,
  oy: number,
  W: number = g.S,
  D: number = g.S,
): Box {
  // Opening assumes narrow-face posts both sides; 3mm/side locust slop.
  const pw = W - 2 * g.frontPostFace - 6;
  const pd = D - 2 * g.frontPostFace - 6;
  const top = g.H - g.supportDrop;
  const offX = (W - pw) / 2;
  const offY = (D - pd) / 2;
  return box(
    `${station}-panel`,
    `${station} locust panel ${both(pw)}x${both(pd)}`,
    ox + offX,
    oy + offY,
    top - g.panelT,
    pw,
    pd,
    g.panelT,
    "laminate",
    "self-milled honey locust glue-up; loose-lay, lifts off for cart bays",
  );
}

/** Rolling cart shell at a station origin. platformTopZ set by caller. */
/**
 * Saw stand: legs to the floor (NO casters — caster-less grid), UHMW skid
 * strips underneath so 63 lb slides out front to spin, then slides back.
 * Dolly for shop transport. Outer circa the bay opening minus wiggle room.
 */
export function standBoxes(
  g: GridSpec,
  station: string,
  ox: number,
  oy: number,
  platformTopZ: number,
  W: number,
  D: number,
): Box[] {
  const C = W - 2 * g.frontPostFace - g.cartClear;
  const Cd = D - 2 * g.frontPostFace - g.cartClear;
  const cx = ox + (W - C) / 2;
  const cy = oy + (D - Cd) / 2;
  const out: Box[] = [];
  const P = (
    id: string,
    l: string,
    x: number,
    y: number,
    z: number,
    dx: number,
    dy: number,
    dz: number,
    note: string,
  ) =>
    out.push(
      box(
        `${station}-${id}`,
        `${station} ${l}`,
        cx + x,
        cy + y,
        z,
        dx,
        dy,
        dz,
        "saw",
        note,
      ),
    );
  // Legs run to the floor; UHMW skids let the stand slide out to spin.
  const legTop = platformTopZ - g.platformT;
  for (const [qx, qy] of [
    [0, 0],
    [C - 38, 0],
    [0, Cd - 89],
    [C - 38, Cd - 89],
  ] as const) {
    P(
      `standleg-${qx}-${qy}`,
      `stand leg`,
      qx,
      qy,
      12,
      38,
      89,
      legTop - 12,
      "store 2x4 to the floor (no casters)",
    );
    P(
      `skid-${qx}-${qy}`,
      `UHMW skid`,
      qx - 5,
      qy - 5,
      0,
      48,
      99,
      12,
      "UHMW strip; stand slides out front to spin, then back",
    );
  }
  P(
    "platform",
    `stand platform ${both(C)}x${both(Cd)}`,
    0,
    0,
    legTop,
    C,
    Cd,
    g.platformT,
    "honey locust glue-up; saw base bolts through slotted holes (wood moves)",
  );
  return out;
}

/**
 * Full grid. Flip bays take `stowedFlip: true` to render the idle state
 * (drums flipped: flat faces at H-3, wedges dropped — they only lock up).
 */
export function gridBoxes(plan: GridPlan, stowedFlip = false): Box[] {
  const { spec: g } = plan;
  const out: Box[] = [];
  // SVG/plan y grows down; grid row 0 (front) sits at -y. Flip the row so
  // front renders at the bottom: oy mirrors the bay y within total depth.
  const totalD = Math.max(...plan.bays.map((b) => b.y + b.d));
  for (const bay of plan.bays) {
    const { id: station, kind } = bay;
    const ox = bay.x;
    const oy = totalD - bay.y - bay.d;
    // Every box pushed for this bay belongs to it: stamp the station for
    // the viewer tree (helpers don't know the bay; stowed copies inherit
    // via the same mark).
    const mark = out.length;
    const stamp = () => {
      for (let i = mark; i < out.length; i++) out[i].station ??= station;
    };
    if (kind === "flip") {
      const tool = plan.flipTools[station];
      if (tool === undefined)
        throw new Error(`flip bay ${station} has no tool in flipTools`);
      const drum = flipRectBay(g, station, ox, oy, bay.w, bay.d, tool);
      // Wedges re-seat after the flip (mirrored with the drum); the rest of
      // the fixed set (axle, pillows, bearing rails) never moves.
      const stayPut = drum.fixed.filter((b) => !b.partId.includes("-wedge"));
      const wedges = drum.fixed.filter((b) => b.partId.includes("-wedge"));
      out.push(...drum.frame, ...stayPut);
      if (stowedFlip)
        out.push(
          ...stowBoxes(drum.rotating, drum.axleY, drum.A),
          ...stowBoxes(wedges, drum.axleY, drum.A),
        );
      else out.push(...drum.rotating, ...wedges);
      stamp();
      continue;
    }
    if (kind === "top") {
      // Full ledge rings everywhere: flips rotate AWAY from neighbors
      // (flipDir), so no sweep ever visits a top bay.
      out.push(...frameRectBoxes(g, station, ox, oy, bay.w, bay.d, {}));
      out.push(panelBox(g, station, ox, oy, bay.w, bay.d));
    }
    if (kind === "saw") {
      // Saw bays take ledges:"frontback" and get zero ledges: no loose
      // panel lives here (the stand rises through the side band) and the
      // table overhang forbids the ledge band (see frameRectBoxes NOTE).
      out.push(
        ...frameRectBoxes(g, station, ox, oy, bay.w, bay.d, {
          ledges: "frontback",
        }),
      );
      const platformTopZ = g.H - plan.sawBaseToTable;
      out.push(...standBoxes(g, station, ox, oy, platformTopZ, bay.w, bay.d));
      // Stand outer circa the opening; the BASE (not the table) must fit it.
      const Cx = bay.w - 2 * g.frontPostFace - g.cartClear;
      const Cy = bay.d - 2 * g.frontPostFace - g.cartClear;
      const cx = ox + (bay.w - Cx) / 2;
      const cy = oy + (bay.d - Cy) / 2;
      out.push(
        box(
          `${station}-sawbody`,
          `${station} Hercules 57673 table ${both(plan.sawTableW)}x${both(plan.sawTableD)}`,
          cx + (Cx - plan.sawTableW) / 2,
          cy + (Cy - plan.sawTableD) / 2,
          platformTopZ,
          plan.sawTableW,
          plan.sawTableD,
          plan.sawBaseToTable,
          "cnc",
          "saw body; table top lands exactly at H datum (table may overhang the stand; the base carries)",
        ),
      );
    }
    stamp();
  }
  return out;
}

// ---- plan view -------------------------------------------------------------

const r2 = (n: number): string => String(Math.round(n * 100) / 100);

/**
 * Feed-direction arrows for one grid plan: one per flip bay, run just above
 * the working table from the infeed end to the outfeed end, extending a
 * little past the tool so the hand-off toward the neighbouring bay reads.
 * The 3D viewer draws these so orientation is unambiguous at any rotation
 * (the top-down plan view carries the same arrows).
 */
export function feedArrows(plan: GridPlan, boxes: Box[]): ViewerArrow[] {
  const out: ViewerArrow[] = [];
  for (const bay of plan.bays.filter((b) => b.kind === "flip")) {
    const tool = plan.flipTools[bay.id];
    const base = boxes.find((b) => b.partId === `${bay.id}-tool-base`);
    if (!tool || !base) continue;
    const fwd = tool.feedDir > 0; // +1 west->east
    const y = base.y + base.dy / 2;
    const z = base.z + base.dz + 6; // just above the tool's working table
    out.push({
      from: [fwd ? base.x - 40 : base.x + base.dx + 40, y, z],
      to: [fwd ? base.x + base.dx + 40 : base.x - 40, y, z],
      label: `${tool.name} feed`,
    });
  }
  return out;
}

/**
 * Top-down bay plan: saw table (rip solid + crosscut ghost), flip tools
 * with feed arrows (infeed at outer ends, exits sharing the center),
 * roller-stand markers outboard of the flip row. Front at the bottom.
 */
export function gridPlanSvg(plan: GridPlan): string {
  const { spec: g } = plan;
  const W = Math.max(...plan.bays.map((b) => b.x + b.w));
  const D = Math.max(...plan.bays.map((b) => b.y + b.d));
  const pad = 40;
  // SVG y down; plan row 0 (front) renders at the bottom.
  const fy = (y: number): number => pad + 14 + (D - y);
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${r2(W + pad * 2)}mm" height="${r2(D + pad * 2 + 30)}mm" viewBox="0 0 ${r2(W + pad * 2)} ${r2(D + pad * 2 + 30)}">`,
    `<title>module grid plan — saw 3x32 + flip 2x48 (front at bottom)</title>`,
    `<text x="${pad}" y="12" font-size="6">module grid — ${both(W)} x ${both(D)} overall, tops at H-3mm (front/operator at bottom)</text>`,
  ];
  for (const bay of plan.bays) {
    const { id, kind } = bay;
    const sx = pad + bay.x;
    const sy = fy(bay.y + bay.d);
    const fill =
      kind === "saw"
        ? "#fef3c7"
        : kind === "flip"
          ? "#e0e7ff"
          : kind === "bay"
            ? "#f3f4f6"
            : "#dcfce7";
    const bayLabel =
      kind === "saw"
        ? "SAW (spin: roll out, turn, roll in)"
        : kind === "flip"
          ? `FLIP (${plan.flipTools[id]?.name ?? "tool"} — up to work, down to stow)`
          : kind === "bay"
            ? "BAY (cart parks here)"
            : "TOP (lift-off locust)";
    out.push(
      `<rect x="${r2(sx)}" y="${r2(sy)}" width="${r2(bay.w)}" height="${r2(bay.d)}" fill="${fill}" stroke="black" stroke-width="0.5"/>`,
      `<text x="${r2(sx + 6)}" y="${r2(sy + 12)}" font-size="6">${bayLabel}</text>`,
    );
    if (kind === "saw") {
      // Rip stance solid; crosscut ghost dashed; feed arrow front->back.
      const Cx = bay.w - 2 * g.frontPostFace - g.cartClear;
      const Cy = bay.d - 2 * g.frontPostFace - g.cartClear;
      const cx0 = sx + (bay.w - Cx) / 2 + (Cx - plan.sawTableW) / 2;
      const cy0 = fy(
        bay.y +
          bay.d -
          ((bay.d - Cy) / 2 + (Cy - plan.sawTableD) / 2) -
          plan.sawTableD,
      );
      out.push(
        `<rect x="${r2(cx0)}" y="${r2(cy0)}" width="${r2(plan.sawTableW)}" height="${r2(plan.sawTableD)}" fill="none" stroke="red" stroke-width="0.6"/>`,
        `<text x="${r2(cx0)}" y="${r2(cy0 - 3)}" font-size="4">rip stance</text>`,
      );
      const gx0 = sx + (bay.w - plan.sawTableD) / 2;
      const gy0 = fy(
        bay.y + bay.d - (bay.d - plan.sawTableW) / 2 - plan.sawTableW,
      );
      out.push(
        `<rect x="${r2(gx0)}" y="${r2(gy0)}" width="${r2(plan.sawTableD)}" height="${r2(plan.sawTableW)}" fill="none" stroke="red" stroke-width="0.4" stroke-dasharray="4 2"/>`,
        `<text x="${r2(gx0)}" y="${r2(gy0 - 3)}" font-size="4">crosscut ghost</text>`,
      );
    }
    if (kind === "flip") {
      const tool = plan.flipTools[id];
      if (tool !== undefined) {
        // Tool footprint + feed arrow. Lateral (x) tools share the old
        // center-exit logic; front-back (y) tools feed from the aisle
        // onto their back-row outfeed lane.
        const tx = sx + (bay.w - tool.tableW) / 2;
        const ty = fy(bay.y + (bay.d + tool.tableD) / 2);
        out.push(
          `<rect x="${r2(tx)}" y="${r2(ty)}" width="${r2(tool.tableW)}" height="${r2(tool.tableD)}" fill="none" stroke="blue" stroke-width="0.6"/>`,
          `<text x="${r2(tx)}" y="${r2(ty - 3)}" font-size="4">${tool.name} (up)</text>`,
        );
        const ah = 6;
        if (tool.feedAxis === "x") {
          const midY = fy(bay.y + bay.d / 2);
          const x0 = tool.feedDir > 0 ? sx + 8 : sx + bay.w - 8;
          const x1 = tool.feedDir > 0 ? sx + bay.w - 8 : sx + 8;
          const tip = tool.feedDir > 0 ? x1 + ah : x1 - ah;
          out.push(
            `<line x1="${r2(x0)}" y1="${r2(midY)}" x2="${r2(x1)}" y2="${r2(midY)}" stroke="green" stroke-width="1.2"/>`,
            `<polygon points="${r2(x1)},${r2(midY - 4)} ${r2(tip)},${r2(midY)} ${r2(x1)},${r2(midY + 4)}" fill="green"/>`,
            `<text x="${r2(tool.feedDir > 0 ? x0 : x1)}" y="${r2(midY - 8)}" font-size="4">infeed (you hold)</text>`,
            `<text x="${r2(tool.feedDir > 0 ? x1 - 60 : x0 + 8)}" y="${r2(midY - 8)}" font-size="4">exit (supported)</text>`,
          );
        } else {
          const midX = sx + bay.w / 2;
          const yTop = fy(bay.y + bay.d) + 8;
          const yBot = fy(bay.y) - 8;
          const y0 = tool.feedDir > 0 ? yBot : yTop;
          const y1 = tool.feedDir > 0 ? yTop : yBot;
          const tip = tool.feedDir > 0 ? y1 - ah : y1 + ah;
          out.push(
            `<line x1="${r2(midX)}" y1="${r2(y0)}" x2="${r2(midX)}" y2="${r2(y1)}" stroke="green" stroke-width="1.2"/>`,
            `<polygon points="${r2(midX - 4)},${r2(y1)} ${r2(midX)},${r2(tip)} ${r2(midX + 4)},${r2(y1)}" fill="green"/>`,
            `<text x="${r2(midX + 8)}" y="${r2(tool.feedDir > 0 ? y0 : y1)}" font-size="4">infeed (you hold)</text>`,
            `<text x="${r2(midX + 8)}" y="${r2(tool.feedDir > 0 ? y1 : y0)}" font-size="4">exit (supported)</text>`,
          );
        }
      }
    }
  }
  // Roller-stand markers: front of saw + planer lanes (their infeeds),
  // east end of the jointer (its infeed). Back row is pure outfeed.
  const sawBay = plan.bays.find((b) => b.kind === "saw");
  const flipBs = plan.bays.filter((b) => b.kind === "flip");
  const markers: [number, number, string][] = [];
  if (sawBay !== undefined)
    markers.push([sawBay.x + sawBay.w / 2 - 50, -140, "roller: saw infeed"]);
  for (const b of flipBs) {
    const tool = plan.flipTools[b.id];
    if (tool?.feedAxis === "y")
      markers.push([b.x + b.w / 2 - 50, -140, `roller: ${tool.name} infeed`]);
    else markers.push([W + 40, b.y, `roller: ${tool?.name ?? "tool"} infeed`]);
  }
  for (const [rx, ry, label] of markers) {
    const my = ry < 0 ? fy(0) + 8 : fy(ry + 100);
    out.push(
      `<rect x="${r2(pad + rx)}" y="${r2(ry < 0 ? fy(0) + 8 : fy(ry))}" width="100" height="${r2(ry < 0 ? 40 : 100)}" fill="none" stroke="gray" stroke-width="0.4" stroke-dasharray="5 3"/>`,
      `<text x="${r2(pad + rx)}" y="${r2(my - 4)}" font-size="4">${label}</text>`,
    );
  }
  out.push("</svg>");
  return out.join("\n") + "\n";
}

// ---- flip-top drums --------------------------------------------------------
//
// A flip bay keeps its tool bolted permanently: the drum (platform +
// cheeks + flat face) rotates 180 about a steel X-axle. Tool-up: working
// table at H. Flipped: flat face at H-3 (support level). Repeatability =
// hardwood wedge locks + shims, not the pivot.
//
// Flip geometry rules (proven in tests): the drum + tool swing a cylinder
// around the axle, so flip bays need front AND back open (frameBoxes takes
// backRail:false), the drum x-extent must live between the posts, and the
// axle must sit at or above the max corner radius (else the tool digs the
// floor mid-flip).

export interface FlipDrum {
  /** Frame (no back rail), panels never. */
  frame: Box[];
  /** Rotating set: drum + tool (mirrored for stowed renders). */
  rotating: Box[];
  /** Fixed set: axle, pillows, bearing rails, wedges (wedges: up-state). */
  fixed: Box[];
  axleY: number;
  A: number;
  /** Max corner radius of the rotating set about the axle. */
  swingRadius: number;
}

const HW: Box["process"] = "saw";

function hw(
  partId: string,
  label: string,
  x: number,
  y: number,
  z: number,
  dx: number,
  dy: number,
  dz: number,
  note: string,
): Box {
  return {
    partId,
    label,
    x,
    y,
    z,
    dx,
    dy,
    dz,
    process: HW,
    note,
    hardware: true,
  };
}

/**
 * Mirror the rotating set 180 about the axle (stowed render + fit check).
 * Wedges only exist tool-up; callers drop `-wedge` boxes when stowed.
 */
export function stowBoxes(rotating: Box[], axleY: number, A: number): Box[] {
  return rotating.map((b) => ({
    ...b,
    partId: `${b.partId}-stowed`,
    label: `${b.label} (stowed)`,
    y: 2 * axleY - b.y - b.dy,
    z: 2 * A - b.z - b.dz,
  }));
}

// ---- rectangular bays (flip row: 2 x 48in) ----------------------------------
// The saw row stays square 32in frames (frameBoxes); the flip row is two
// 48in-wide bays so the jointer's 34in tables fit and both drums get room.
// Same construction language: narrow-face posts, 3-sided rails max,
// ledge options, open front.

export interface RectOpts {
  backRail?: boolean;
  /** ring: all 4; sides: L+R (flip frames); frontback: none (saw bays). */
  ledges?: "ring" | "sides" | "frontback";
  w?: number;
  h?: number;
}

/** Rectangular open frame at (ox, oy), W(x) by D(y). Front (+entry) faces -y. */
export function frameRectBoxes(
  g: GridSpec,
  station: string,
  ox: number,
  oy: number,
  W: number,
  D: number,
  opts: RectOpts = {},
): Box[] {
  const {
    post,
    frontPostFace,
    railT,
    railH,
    ledgeW,
    ledgeH,
    panelT,
    stretcherT,
    stretcherH,
    supportDrop,
    H,
  } = g;
  const railTopZ = H - supportDrop - panelT;
  const out: Box[] = [];
  const P = (
    id: string,
    l: string,
    x: number,
    y: number,
    z: number,
    dx: number,
    dy: number,
    dz: number,
    note: string,
  ) =>
    out.push(
      box(
        `${station}-${id}`,
        `${station} ${l}`,
        ox + x,
        oy + y,
        z,
        dx,
        dy,
        dz,
        "saw",
        note,
      ),
    );
  // All four posts show the narrow 38 face to the opening (cart/drum
  // clearance proven by the overlap + swing tests).
  P(
    "post-fl",
    `corner post`,
    0,
    0,
    0,
    frontPostFace,
    post,
    railTopZ,
    "store 2x4; 38 face to opening",
  );
  P(
    "post-fr",
    `corner post`,
    W - frontPostFace,
    0,
    0,
    frontPostFace,
    post,
    railTopZ,
    "store 2x4",
  );
  P(
    "post-bl",
    `corner post`,
    0,
    D - post,
    0,
    frontPostFace,
    post,
    railTopZ,
    "store 2x4",
  );
  P(
    "post-br",
    `corner post`,
    W - frontPostFace,
    D - post,
    0,
    frontPostFace,
    post,
    railTopZ,
    "store 2x4",
  );
  // Top rails: back + left + right unless omitted (flip sweep needs
  // front AND back open; racking via side stretchers + neighbors).
  if (opts.backRail !== false)
    P(
      "rail-back",
      `top rail`,
      frontPostFace,
      D - railT,
      railTopZ - railH,
      W - 2 * frontPostFace,
      railT,
      railH,
      "store 2x4; glue+screw into posts",
    );
  P(
    "rail-left",
    `top rail`,
    0,
    post,
    railTopZ - railH,
    railT,
    D - 2 * post,
    railH,
    "store 2x4",
  );
  P(
    "rail-right",
    `top rail`,
    W - railT,
    post,
    railTopZ - railH,
    railT,
    D - 2 * post,
    railH,
    "store 2x4",
  );
  // Ledges: ring (all 4), sides (flip frames — front/back would collide
  // with stowed cheeks), frontback (saw bays: yields ZERO ledges — no
  // panel lives there and the table overhang forbids the band; see NOTE
  // below). Stowed flats cantilever from axle + re-seated wedges.
  const ledgeZ = railTopZ - ledgeH;
  const wantFB = opts.ledges === undefined || opts.ledges === "ring";
  // NOTE: there is no frontback arm — saw bays take ledges:"frontback"
  // and get zero ledges on purpose. A saw bay carries no loose panel
  // (the stand rises through it), and the table overhang eats the ledge
  // band: in a 28in bay the 622-wide table starts 79.5 into an 89-deep
  // post zone, colliding with both front and back ledges (proven by
  // the 76x60 overlap test). Ledges are panel supports; no panel here.
  const wantFront = wantFB;
  const wantBack = wantFB;
  const wantSides = wantFB || opts.ledges === "sides";
  if (wantFront)
    P(
      "ledge-front",
      `panel ledge`,
      frontPostFace,
      post - ledgeW,
      ledgeZ,
      W - 2 * frontPostFace,
      ledgeW,
      ledgeH,
      "19mm strip; clearance for locust movement",
    );
  if (wantBack)
    P(
      "ledge-back",
      `panel ledge`,
      frontPostFace,
      D - post,
      ledgeZ,
      W - 2 * frontPostFace,
      ledgeW,
      ledgeH,
      "19mm strip",
    );
  // Side ledges unless frontback (saw bays — zero ledges there anyway).
  if (wantSides)
    P(
      "ledge-left",
      `panel ledge`,
      railT,
      post,
      ledgeZ,
      ledgeW,
      D - 2 * post,
      ledgeH,
      "19mm strip",
    );
  if (wantSides)
    P(
      "ledge-right",
      `panel ledge`,
      W - railT - ledgeW,
      post,
      ledgeZ,
      ledgeW,
      D - 2 * post,
      ledgeH,
      "19mm strip",
    );
  // Bottom stretchers: 3 sides (front open for wheels + feet).
  P(
    "stretch-back",
    `stretcher`,
    frontPostFace,
    D - stretcherT,
    0,
    W - 2 * frontPostFace,
    stretcherT,
    stretcherH,
    "store 2x4 at floor",
  );
  P(
    "stretch-left",
    `stretcher`,
    0,
    post,
    0,
    stretcherT,
    D - 2 * post,
    stretcherH,
    "store 2x4 at floor",
  );
  P(
    "stretch-right",
    `stretcher`,
    W - stretcherT,
    post,
    0,
    stretcherT,
    D - 2 * post,
    stretcherH,
    "store 2x4 at floor",
  );
  return out;
}

/** Hercules 6in jointer with extension tables (fence OFF to flip). */
export const JOINTER_FLIP: FlipTool = {
  name: "jointer 6in",
  tableW: 864, // 34in tables along the axle (wings off over 34in)
  tableD: 603, // 23-3/4in across
  baseToTable: 100, // PLACEHOLDER — measure bed above base
  aboveTable: 80, // bed casting above the tables (fence removed to flip)
  feedDir: -1, // east->west; exit over the STOWED planer flat (one-tool-up)
  feedAxis: "x",
};

/** Feed direction lives on FlipTool.feedDir (+1 west->east). */
export interface FlipRect {
  frame: Box[];
  rotating: Box[];
  fixed: Box[];
  axleY: number;
  A: number;
  swingRadius: number;
}

/**
 * Flip drum in a W(x) by D(y) bay. Same asymmetric recipe as the square
 * drum (platform +50 above axle, flat face lands H-3): 34in jointer tables
 * ride along the axle where length never sweeps.
 */
export function flipRectBay(
  g: GridSpec,
  station: string,
  ox: number,
  oy: number,
  W: number,
  D: number,
  tool: FlipTool,
): FlipRect {
  const { H, railH, panelT, supportDrop } = g;
  const dPlat = 50;
  const cheekT = 19;
  const A = H - tool.baseToTable - dPlat;
  const dFlat = H - g.supportDrop - A;
  const platTop = A + dPlat;
  const flatOuter = A - dFlat;
  const cheekOutL = 38 + 45;
  const cheekOutR = W - 38 - 45;
  const inL = cheekOutL + cheekT;
  const inR = cheekOutR - cheekT;
  const drumDepth = 700;
  const dy0 = (D - drumDepth) / 2;
  const axleY = D / 2;
  const frame = frameRectBoxes(g, station, ox, oy, W, D, {
    backRail: false,
    ledges: "sides",
  });
  const B = (
    partId: string,
    label: string,
    x: number,
    y: number,
    z: number,
    dx: number,
    dy: number,
    dz: number,
    process: Box["process"],
    note: string,
  ): Box =>
    box(
      `${station}-${partId}`,
      `${station} ${label}`,
      ox + x,
      oy + y,
      z,
      dx,
      dy,
      dz,
      process,
      note,
    );
  const toolX0 = (W - tool.tableW) / 2;
  const toolY0 = (D - tool.tableD) / 2;
  const rotating: Box[] = [
    B(
      "drum-platform",
      `drum platform`,
      inL,
      dy0,
      platTop - 19,
      inR - inL,
      drumDepth,
      19,
      "saw",
      "honey locust glue-up; tool bolts through slotted holes (wood moves)",
    ),
    B(
      "drum-flat",
      `drum flat face`,
      inL,
      dy0,
      flatOuter,
      inR - inL,
      drumDepth,
      19,
      "laminate",
      "locust offcut skin; lands at H-3mm stowed",
    ),
    B(
      "drum-cheek-l",
      `drum cheek`,
      cheekOutL,
      dy0,
      flatOuter,
      cheekT,
      drumDepth,
      platTop - flatOuter,
      "saw",
      "honey locust glue-up cheek; grain along the 700mm depth",
    ),
    B(
      "drum-cheek-r",
      `drum cheek`,
      cheekOutR - cheekT,
      dy0,
      flatOuter,
      cheekT,
      drumDepth,
      platTop - flatOuter,
      "saw",
      "honey locust glue-up cheek; grain along the 700mm depth",
    ),
    B(
      "tool-base",
      `${tool.name} base`,
      toolX0,
      toolY0,
      platTop,
      tool.tableW,
      tool.tableD,
      tool.baseToTable,
      "cnc",
      `${tool.name}; working table lands at H`,
    ),
    B(
      "tool-upper",
      `${tool.name} upper`,
      toolX0 + 100,
      toolY0 + 50,
      platTop + tool.baseToTable,
      tool.tableW - 200,
      tool.tableD - 100,
      tool.aboveTable,
      "cnc",
      "housing above the table (fence off to flip)",
    ),
  ];
  // Bearing rails carry the pillows but duck under the side top rails
  // (high axles like the jointer's would otherwise collide with them).
  const railBottomZ = H - supportDrop - panelT - railH;
  const bearTop = Math.min(A + 44, railBottomZ);
  const fixed: Box[] = [
    hw(
      `${station}-axle`,
      `${station} pivot axle`,
      ox + 38,
      oy + axleY - 12.5,
      A - 12.5,
      W - 76,
      25,
      25,
      "25mm steel tube; drum rotates on it",
    ),
    hw(
      `${station}-pillow-l`,
      `${station} pillow block`,
      ox + 38,
      oy + axleY - 40,
      A - 25,
      45,
      80,
      50,
      "pillow block on bearing rail",
    ),
    hw(
      `${station}-pillow-r`,
      `${station} pillow block`,
      ox + W - 38 - 45,
      oy + axleY - 40,
      A - 25,
      45,
      80,
      50,
      "pillow block on bearing rail",
    ),
    box(
      `${station}-bearrail-l`,
      `${station} bearing rail`,
      ox + 0,
      oy + 89,
      bearTop - 89,
      38,
      D - 178,
      89,
      "saw",
      "2x4 flat carries pillow blocks",
    ),
    box(
      `${station}-bearrail-r`,
      `${station} bearing rail`,
      ox + W - 38,
      oy + 89,
      bearTop - 89,
      38,
      D - 178,
      89,
      "saw",
      "2x4 flat carries pillow blocks",
    ),
    box(
      `${station}-wedge-l`,
      `${station} lock wedge`,
      ox + 38,
      oy + axleY - 130,
      A - 34,
      45,
      60,
      60,
      "saw",
      "hardwood wedge screwed to bearing rail; nose touches cheek",
    ),
    box(
      `${station}-wedge-r`,
      `${station} lock wedge`,
      ox + W - 38 - 45,
      oy + axleY - 130,
      A - 34,
      45,
      60,
      60,
      "saw",
      "hardwood wedge; pull to flip",
    ),
  ];
  let swingRadius = 0;
  for (const b of rotating) {
    const bx = b.x - ox;
    const by = b.y - oy;
    for (const wy of [by, by + b.dy]) {
      for (const wz of [b.z, b.z + b.dz]) {
        const r = Math.hypot(wy - axleY, wz - A);
        void bx;
        if (r > swingRadius) swingRadius = r;
      }
    }
  }
  return { frame, rotating, fixed, axleY: oy + axleY, A, swingRadius };
}

// ---- sweep-vs-zone proof -----------------------------------------------------
// A flip drum sweeps a disc (radius = max corner radius) around its axle.
// Anything inside that disc must be open air or a lift-off panel covered by
// a workflow rule. This conservative check (disc, not exact reachability)
// fails safe: unprovable clearance becomes procedure, never assumed.

export interface Zone {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  z0: number;
  z1: number;
}

/** Max corner radius of boxes about (axleY, A) in the Y-Z plane. */
export function swingOf(boxes: Box[], axleY: number, A: number): number {
  let r = 0;
  for (const b of boxes)
    for (const wy of [b.y, b.y + b.dy])
      for (const wz of [b.z, b.z + b.dz]) {
        const d = Math.hypot(wy - axleY, wz - A);
        if (d > r) r = d;
      }
  return r;
}

/**
 * True when the swept disc (at the boxes' x-span) touches a material zone.
 * X must overlap AND the Y-Z disc must reach the zone's Y-Z rect.
 */
export function sweepHitsZone(
  boxes: Box[],
  axleY: number,
  A: number,
  zone: Zone,
): boolean {
  const xs = boxes.flatMap((b) => [b.x, b.x + b.dx]);
  if (Math.max(...xs) < zone.x0 || Math.min(...xs) > zone.x1) return false;
  const r = swingOf(boxes, axleY, A);
  // Closest point of the zone's Y-Z rect to the axle center.
  const qy = Math.min(Math.max(axleY, zone.y0), zone.y1);
  const qz = Math.min(Math.max(A, zone.z0), zone.z1);
  return Math.hypot(qy - axleY, qz - A) <= r;
}

// ---- asymmetric narrow layout (76x60) ----------------------------------------
// Saw side (front): two tops + spin saw. Flip side (back): planer + jointer,
// lateral drums sharing the center exits. Same construction, smaller bays:
// saw 28 + tops 24+24 = 76 wide; planer 32 + jointer 44 = 76 wide.

/** Hercules 59313 planer, LATERAL drum (long axis along X, feeds W->E). */
export const PLANER_LATERAL: FlipTool = {
  name: "planer 59313",
  tableW: 591, // 23-1/4in along X
  tableD: 362, // 14-1/4in across
  baseToTable: 150, // PLACEHOLDER — measure bed above base
  aboveTable: 250, // motor housing above bed
  feedDir: 1, // west->east; exit over the jointer bay
  feedAxis: "x",
};

/** 76x60 asymmetric: saw side 28+24+24 over 28in deep, flip side 32+44. */
export function planAsymmetric(spec: GridSpec = DEFAULT_GRID): GridPlan {
  const IN = 25.4;
  const T24 = Math.round(24 * IN); // 610
  const T28 = Math.round(28 * IN); // 711
  const T32 = Math.round(32 * IN); // 813
  const T44 = Math.round(44 * IN); // 1118
  const T16 = Math.round(16 * IN); // (unused here; back tops live in 96x48)
  void T16;
  return {
    spec,
    bays: [
      { id: "stop-w", x: 0, y: 0, w: T24, d: T28, kind: "top" },
      { id: "saw", x: T24, y: 0, w: T28, d: T28, kind: "saw" },
      { id: "stop-e", x: T24 + T28, y: 0, w: T24, d: T28, kind: "top" },
      { id: "fplan", x: 0, y: T28, w: T32, d: T32, kind: "flip", flipDir: -1 },
      {
        id: "fjoin",
        x: T32,
        y: T28,
        w: T44,
        d: T32,
        kind: "flip",
        flipDir: -1,
      },
    ],
    sawTableW: 622,
    sawTableD: 552,
    sawBaseW: 460, // PLACEHOLDER — measure the base casting, not the table
    sawBaseD: 410, // PLACEHOLDER
    sawBaseToTable: 200, // PLACEHOLDER
    flipTools: { fplan: PLANER_LATERAL, fjoin: JOINTER_FLIP },
  };
}

// ---- exact sweep proof -------------------------------------------------------
// Flip direction is a design variable: drums rotate AWAY from the
// neighboring row (flipDir -1 = front/aisle, +1 = back), so the sweep meets
// open air instead of structure. This samples the true 180deg arc corner by
// corner (not the conservative disc): touching counts as clear, sharing
// volume counts as collision. Wedges are pulled before flipping, hardware
// (axle/pillows) is joint, not obstacle.

export interface SweepHit {
  partId: string;
  corner: number;
  deg: number;
  at: [number, number, number];
}

/** Sampled exact sweep. Empty array = clear. */
export function sweepCollisions(
  rotating: Box[],
  axleY: number,
  A: number,
  dir: -1 | 1,
  obstacles: Box[],
  stepDeg = 3,
): SweepHit[] {
  const hits: SweepHit[] = [];
  const EPS = 1e-6;
  const inside = (b: Box, p: [number, number, number]): boolean =>
    p[0] > b.x + EPS &&
    p[0] < b.x + b.dx - EPS &&
    p[1] > b.y + EPS &&
    p[1] < b.y + b.dy - EPS &&
    p[2] > b.z + EPS &&
    p[2] < b.z + b.dz - EPS;
  rotating.forEach((b) => {
    const corners: [number, number, number][] = [];
    for (const px of [b.x, b.x + b.dx])
      for (const py of [b.y, b.y + b.dy])
        for (const pz of [b.z, b.z + b.dz]) corners.push([px, py, pz]);
    corners.forEach(([px, py, pz], ci) => {
      const r = Math.hypot(py - axleY, pz - A);
      if (r < 1e-9) return;
      const a0 = Math.atan2((py - axleY) * dir, pz - A);
      for (let s = 0; s * stepDeg <= 180; s++) {
        const a = a0 + (s * stepDeg * Math.PI) / 180;
        const q: [number, number, number] = [
          px,
          axleY + Math.sin(a) * r * dir,
          A + Math.cos(a) * r,
        ];
        if (obstacles.some((o) => inside(o, q))) {
          const o = obstacles.find((oo) => inside(oo, q))!;
          hits.push({
            partId: `${b.partId}#${ci}>${o.partId}`,
            corner: ci,
            deg: s * stepDeg,
            at: q,
          });
          return;
        }
      }
    });
  });
  return hits;
}

/**
 * Structural verification for a grid plan: empty array = every invariant
 * the plan promises still holds. Reusable by the CLI (`--verify`) so
 * measured tool numbers can be swapped in without silently breaking the
 * datums the whole plan is built on. Hardware joints are excluded from the
 * no-overlap rule by design (axle/pillows are joint, not interfering).
 */
export function gridPlanIssues(plan: GridPlan): string[] {
  const issues: string[] = [];
  const g = plan.spec;
  const up = gridBoxes(plan);
  const stowed = gridBoxes(plan, true);
  for (const [a, b] of assemblyOverlaps(up))
    issues.push(`up-state overlap: ${a.partId} ~ ${b.partId}`);
  for (const [a, b] of assemblyOverlaps(stowed))
    issues.push(`stowed overlap: ${a.partId} ~ ${b.partId}`);
  // Datums: saw table exactly on H; every support top (loose-lay panel or
  // stowed drum flat) exactly supportDrop below it.
  const saw = up.find((b) => b.partId.endsWith("-sawbody"));
  if (!saw) issues.push("no sawbody box in plan");
  else if (Math.abs(saw.z + saw.dz - g.H) > 1e-9)
    issues.push(`saw table ${saw.z + saw.dz} != H ${g.H}`);
  const supportTop = g.H - g.supportDrop;
  for (const p of up.filter((b) => b.partId.endsWith("-panel")))
    if (Math.abs(p.z + p.dz - supportTop) > 1e-9)
      issues.push(`panel ${p.partId} top ${p.z + p.dz} != ${supportTop}`);
  for (const f of stowed.filter((b) => b.partId.includes("-drum-flat")))
    if (Math.abs(f.z + f.dz - supportTop) > 1e-9)
      issues.push(`flat ${f.partId} top ${f.z + f.dz} != ${supportTop}`);
  // Per drum: tool table on H, no floor dig mid-swing, exact 180deg sweep
  // clear of every non-rotating part (wedges are pulled; hardware is joint).
  const totalD = Math.max(...plan.bays.map((b) => b.y + b.d));
  for (const bay of plan.bays.filter((b) => b.kind === "flip")) {
    const tool = plan.flipTools[bay.id];
    if (!tool) {
      issues.push(`${bay.id}: no flip tool configured`);
      continue;
    }
    const dir = bay.flipDir ?? 1;
    const drum = flipRectBay(g, bay.id, 0, 0, bay.w, bay.d, tool);
    const base = drum.rotating.find((b) => b.partId.endsWith("-tool-base"));
    if (!base || Math.abs(base.z + base.dz - g.H) > 1e-9)
      issues.push(
        `${bay.id}: tool table ${base ? base.z + base.dz : "missing"} != H ${g.H}`,
      );
    if (drum.A - drum.swingRadius < 0)
      issues.push(
        `${bay.id}: axle ${drum.A.toFixed(1)} < swing ${drum.swingRadius.toFixed(1)} — tool digs the floor`,
      );
    const rotatingIds = new Set(drum.rotating.map((b) => b.partId));
    const obstacles = up.filter(
      (b) =>
        !rotatingIds.has(b.partId) &&
        b.hardware !== true &&
        !b.partId.includes("-wedge"),
    );
    const oy = totalD - bay.y - bay.d;
    const placed = drum.rotating.map((b) => ({
      ...b,
      x: b.x + bay.x,
      y: b.y + oy,
    }));
    for (const h of sweepCollisions(
      placed,
      drum.axleY + oy,
      drum.A,
      dir,
      obstacles,
    ))
      issues.push(`${bay.id}: sweep hits ${h.partId} at ${h.deg}deg`);
  }
  return issues;
}

// ---- full-width asymmetric (96x64): saw side 3x32, flip side 2x48 ----------
// Same saw-side/flip-side arrangement as the narrow version, full 8ft wide:
// roomier tops, roomier drums, same proven flip-away backs.

/** 96x64 asymmetric: saw row of 32s, flip row of 48s. */
export function planAsymmetric96(spec: GridSpec = DEFAULT_GRID): GridPlan {
  const T32 = Math.round(32 * 25.4); // 813
  const FW = (3 * T32) / 2; // 48in bays; row still totals 96in
  return {
    spec,
    bays: [
      { id: "stop-w", x: 0, y: 0, w: T32, d: T32, kind: "top" },
      { id: "saw", x: T32, y: 0, w: T32, d: T32, kind: "saw" },
      { id: "stop-e", x: 2 * T32, y: 0, w: T32, d: T32, kind: "top" },
      { id: "fplan", x: 0, y: T32, w: FW, d: T32, kind: "flip", flipDir: -1 },
      { id: "fjoin", x: FW, y: T32, w: FW, d: T32, kind: "flip", flipDir: -1 },
    ],
    sawTableW: 622,
    sawTableD: 552,
    sawBaseW: 460, // PLACEHOLDER — measure the base casting, not the table
    sawBaseD: 410, // PLACEHOLDER
    sawBaseToTable: 200, // PLACEHOLDER
    flipTools: { fplan: PLANER_LATERAL, fjoin: JOINTER_FLIP },
  };
}
