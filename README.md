# buildit

grbl G-code optimizer and honest cycle-time estimator for Shapeoko-class
machines. Takes Carbide Create (or any grbl-dialect) `.nc` output, applies
safe size/time optimizations, and reports what the machine will *actually*
do — not the CAM's distance-over-feed fantasy.

## Why

Carbide Create's time estimate for a 3D finish file said **38 min**; the
machine took **54 min**. Profiling showed why: 48,007 G1 micro-segments
(median 0.29 mm), and the estimator assumes instant acceleration. buildit
reproduces both numbers (naive 39.0 / accel-aware 54.0 on
`shark-bottom-finish-fine.c2d.nc`) and shrinks the gap from the G-code side.

## Usage

```sh
npm run build
node dist/index.js <input.nc> [-o output.nc] [--machine NAME] [--accel 400] [--rapid 5000] \
  [--tolerance 0.01] [--decimals 3] [--arcs|--no-arcs] [--arc-tol 0.02] \
  [--tsp|--no-tsp] [--clearance auto|MM] [--material walnut|locust] \
  [--peck-profile NAME] [--no-plunge] [--rest-2d PREV_D] [--rest-finish D] \
  [--rest-cut --finish-tool D] [--check D [--check-prev P]]
```

Machines (`--machine`, default `shapeoko`): named accel/rapid presets so
calibration travels with the machine, not the command line. Only
measured presets ship — today that's `shapeoko` (Shapeoko + 2.2kW VFD,
A400 R5000, stopwatch-matched at ~×1.39). Explicit `--accel`/`--rapid`
always beat the preset (a calibration run in progress wins); unknown
names exit 2 instead of silently rescaling every estimate. To add
yours: time a representative cut, tweak `--accel` until the
accel-aware estimate matches (higher accel lowers it), send the
triple — one stopwatch preset beats ten datasheet fantasies.

Example output:

```text
metric                         before          after
motion blocks                   48009          33479
G1 segments                     48007          33477
G1 segs < 0.2mm                 17320           5616
naive (CC-like) min              39.0           39.0
accel-aware min                  54.0           49.4

est. machine-time savings: 4.5 min (8.4%)
```

## What it does (v1)

- **Parser** (`src/parser.ts`) — full modal state tracking (motion, feed,
  position). Continuation lines without a G-word resolve correctly; this
  exact bug once undercounted 48k segments as 4, and a regression test
  guards it.
- **Janitor** (`src/janitor.ts`) — drops zero-length moves, collapses
  collinear points (Douglas-Peucker, default ε 0.01 mm), normalizes to 3
  decimals, strips redundant modal words. Includes a *modal-repair* step:
  when collapsing edits a run of partial-coordinate lines, kept blocks get
  full XYZ so downstream modal inheritance stays exact.
- **Estimator** (`src/estimate.ts`) — naive plus trapezoidal accel-aware
  model (default 400 mm/s², rapid 5000 mm/min).

## What it does (v2: arc fitting)

After the janitor, an `--arcs` pass (on by default, `--no-arcs` to
compare) converts dense constant-Z G1 runs back into **G2/G3 arcs with
IJK incremental centers** — never R-word (avoids the >180° ambiguity),
max 90° sweep per block so minor/major interpretation is unambiguous by
construction. Greedy longest-first merging within `--arc-tol`
(default 0.02 mm); spans under 5° sweep or 0.3 mm long stay G1.

Safety rules:

- **Planar only.** Runs split whenever Z drifts more than 0.005 mm, so
  steep 3D finishes (e.g. `shark-bottom-finish-fine`: median |dZ| 0.1 mm
  per move) correctly yield ~zero arcs instead of forced ones. 2.5D
  pocketing is where it pays: `happy-w-half-mil` went 79,373 G1 +
  0 arcs → 4,772 G1 + 8,533 arcs, accel-aware 74.5 → **52.4 min
  (−30%)**, naive estimate unchanged (48.2 → 48.1), proving geometry
  preserved.
- **Explicit state.** Every emitted arc carries G-word, XYZ, IJ, and F —
  downstream modal inheritance stays exact (regression-tested).
- **Verified, not trusted.** The corpus fidelity test re-derives every
  emitted arc's covered span and asserts each original point lies within
  tolerance of the fitted circle. This harness caught two real bugs
  during development: a run-start off-by-one (arcs shifted one block of
  travel) and a dot-product typo that defeated the sweep guard.

Tolerance guidance for `--arc-tol`: **0.01** tight/display faces,
**0.02** default, **0.05** fast/rough. grbl note: arcs assume G17 (what
CC emits; preserved verbatim) and radii ≥ 0.05 mm.

## What it does (v3: rapids, rest analysis, plunge tuning)

Pipeline order: janitor -> arcs -> rapids -> plunge -> emit, with rest
analysis (report only) read off the post-janitor stream.

- **Rapids + retracts** (`src/rapids.ts`, `--tsp`/`--no-tsp`,
  `--clearance auto|MM`). Splits the program into *sites* at G0 XY
  traverses: a site is one traverse plus following work with no XY
  motion below the relocation plane, ending back at/above it. Whole
  sites are reordered (nearest-neighbor + 2-opt, deterministic, first
  site pinned); continuous-engagement paths like 3D finishes yield ~no
  sites and stay in order. Hard gates — any violation skips the reorder:
  every site must end high, and no M/S/T word may sit inside a moved
  span (prologue/epilogue stay pinned). Adaptive clearance lowers
  pure-Z G0 retracts to `stockTop + 1.0mm` (`auto`, the default) or an
  absolute plane; G0 moves at/below the plane (e.g. CC's rapid-to-depth
  peck steps) are never touched, and the plane is never raised.
  Fidelity invariant (tested): every output rapid target either existed
  in the input or is a lowered retract / known-XY flight at/above the
  plane — no new low rapid is ever invented. Measured: 33 pocket
  entries reordered on `happy-w-half-mil` (rapid distance 734 -> 632mm);
  single-hole `shark-holes` correctly yields nothing to reorder (one
  site) with clearance-only savings; `shark-bottom-finish-fine`
  reorders 0 ops, proving the safety gate.
- **2.5D rest analysis** (`src/rest2d.ts`, `--rest-2d PREV_D
  [--rest-finish D]`, report only — no cut paths yet). Finds closed
  constant-Z G1 pocket loops and computes exact concave-corner rest:
  per corner, `(Rp^2-Rf^2)(cot(b)-pi/2+b)` with wedge half-angle `b`
  (reduces to the familiar `(1-pi/4)` term for 90-degree inside
  corners). Convex loops report exactly 0; rest is monotone in prev
  diameter and empty when prev <= finish (all asserted). Deliberately
  no general polygon clipper: `clipper2-js` was vetted and rejected —
  its erosion applied nonlinear wrong magnitudes and boolean
  Difference/Xor returned unions (10x10 minus 6x6 -> 136), while only
  dilation/Intersection/Union were sound. Corner analysis needs none
  of it. v4 (cut paths) may revisit the clipper question.
- **Plunge + peck tuning** (`src/plunge.ts`, `src/materials.ts`,
  `--material walnut|locust`, `--peck-profile NAME`, `--no-plunge`).
  Pure Z-only G1 descents faster than the profile plunge feed are
  clamped DOWN (walnut 350, locust 250 mm/min); G83 Q deeper than the
  profile max is clamped DOWN (walnut 2.0, locust 1.2mm). Feeds and Q
  only ever decrease. Z-varying XY cutting moves are not plunges and
  are never touched — asserted on the shark 3D finish (zero feed
  changes).

Safety principles, v3: feeds/Q move in the safe direction only; rapids
never enter material the input didn't already enter; arcs stay planar
IJK (v2 rules unchanged).

- G90/G21 assumed (what CC emits); G91 programs parse but positions track
  as if absolute — flagged, not silently handled.
- No G2/G3 in the test corpus; arc *parsing* is supported, arc *generation*
  is v2.
- The accel model is per-block trapezoidal; it ignores junction-deviation
  blending, so it still reads ~5–10% high on very dense paths. Calibrate
  with a stopwatch and your machine's `$120–$122`.

## What it does (v4: rest cleanup cut paths)

`--rest-cut` (off by default; requires `--rest-2d PREV_D` plus
`--finish-tool D`) turns the v3 analysis into emitted G1 cleanup
toolpaths, inserted immediately after each parent pocket loop (pre-arcs,
while G1 loops still exist). Per concave corner it emits serpentine
stitch passes with the finish tool at the parent loop's own depth —
depths are reused, never invented — feed capped at min(parent feed,
500 mm/min), straight plunge entries, retract to clearance between
passes, then a position + modal restore so following original
continuation lines inherit exactly what they expect.

Containment is the safety property, enforced by construction AND
re-tested per point: every emitted XY point must lie inside the pocket
(>= 0.9 tool-radii from its walls — the wall is never cut) AND within
0.5 tool-radii of the exact rest region (outer A(Rp) boundary minus
inner A(Rf) hole, arcs sampled at 1 degree). Generation filters with a
0.002 mm strict margin so 3-decimal emit rounding can never push a
point across the spec bounds.

Honest guidance: **rest ADDS time — it buys completeness.** Reported
as `+cleanup time (full pockets)` alongside the savings rows. On
`happy-w-1-16` (prev 3.175, finish 1.5875): 144 regions, +5.9 min for
fully cleaned corners with no hand work. And the tool knows when to
decline: faceted-curve micro-rest (`happy-w-half-mil`, median corner
75 degrees) is physically unfinishable without touching walls — the
previous tool already got within 0.1 mm, and the finish wall pass
clears the sliver — so v4 emits nothing there instead of overcutting
(asserted in-tree). Use `--rest-cut` when hand cleanup of sharp
inside corners costs more than the added minutes.

Example:

```sh
node dist/index.js pocket.nc --rest-2d 3.175 --finish-tool 1.5875 \
  --rest-cut -o pocket-rest.nc
```

```text
rest regions cut                    -            144
rest blocks emitted                 -           3280
+cleanup time (full pockets)              -        5.9 min
```

## What it does (v5: --check min-feature audit)

`--check D [--check-prev P]` audits the input for geometry finer than
tool diameter D — report only, file still written, violations set exit 1
(clean exits 0, `--check-prev` without `--check` exits 2). Three exact
checks over closed constant-Z G1 loops, no clipper needed:

- **Narrow spots**: min distance between non-adjacent edges of one
  loop (segment-segment exact). Under D the tool body cannot pass.
- **Tiny arcs**: input G2/G3 with radius under D/2. Rare, catastrophic.
- **Corner residue** (needs P): per-corner wedge after rough tool P,
  flagged above 0.01mm² — answers "will my finish bit clean this, or
  do I owe the taper pass / hand work?" Analytic 90° check included.

Scope honesty: same-loop pairs only (wall-to-outside gaps are stock,
island-to-wall gaps unaudited — same pocket-interior scope as v4
rest). On 3D finish files, near-touching contour folds report as
narrow spots: judge at the printed location, seconds with the render.
On 2.5D pockets they read literally (1mm slot under 3.175: flagged at
1.00; 4mm slot: clean). On happy-w-1-16 (1.5875 + prev 3.175):
40 narrow + 44 hand-work corners — consistent with the 144 rest
regions v4 cuts there.

## Roadmap

- **v2: done** — single-arc G2/G3 fitting with exact span verification
  (see above). Biarc follow-up DECLINED with measurement (2026-09-07):
  median joint discontinuity is already 1.7°; of 1080 hard joints
  (>30°) on happy-w-1-16, 996 are genuine polyline cusps that must
  stay split (v4.1 directedSweep territory) and only 84 are smooth
  S-artifacts (1.6% of joints) — a solver risks the fitter for an
  unmeasurable-in-tree gain (the estimator ignores blending).
- **v4: done** — rest cleanup cut paths (`--rest-cut`), containment-
  filtered, declined-on-faceted-curves (see above). No general clipper
  was needed: exact corner math covers pockets; the clipper question
  stays closed unless non-corner rest (channels, islands) is required.
- **v5: done** — `--check` min-feature audit (see above).
- **v5.1: done** — machine profiles (`--machine`, default `shapeoko`:
  A400 R5000 stopwatch-calibrated; explicit flags override, unknown
  names exit 2). Only measured presets ship.
- `--check` mode: min-feature audit (flag geometry finer than a given tool).

## Viewer (`viewer/`)

Zero-dependency before/after G-code diff. Open `viewer/viewer.html` in a
browser (double-click works — no server, no build), drop the original and
optimized `.nc` files, get a verdict:

- **SAFE TO CARVE** (cuts ≤ 0.25mm AND moved travel ≤ 0.5mm),
  **INSPECT** (cuts ≤ 1.5mm, with the worst coordinate), **DO NOT RUN** (above).
  Travel the optimizer moved (lowered clearance, TSP reorder) can never
  grade green — lowered rapids could meet a clamp, so that needs eyes,
  not trust. The render makes it a ten-second check.
- Layers: before cuts/arcs (red/orange), after (green/cyan), rest additions
  (purple), rapids/travel (gray). Overlay or split view.
- Deep-plunge anomaly flag (mesh-glitch spikes like a Z-38 single point).

Method (`viewer/core.cjs`, shared with the page, covered by
`tests/viewer.test.ts`): modal parser → subdivision sampling with air-break
sentinels → point-to-segment Hausdorff over the material zone only. Travel,
links, rapids, and rest additions are render layers, never verdict inputs —
comparing them would punish the optimizer for its own advertised wins
(clearance lowering, TSP reorder, rest cleanup). Rest passes are
fingerprinted by their elevated-clearance signature, not by comments
(rapids reorder shatters comment pairing).

Known limitation: verdict identity holds for the shipped corpus pairs
(0.17 / 0.34 / 0.22mm preserve); rest-heavy files lean on the render +
containment suite rather than a single number.

## v4.2 fixes (rest efficiency + verdict integrity)

Two rest items from the v4.1 open list, both verified by falsifying tests
(each test fails with its fix reverted):

- **Rest spans atomic wrt rapids reorder.** Interior rest traverses used
  to open TSP sites mid-span, scattering cleanup across sites (moves are
  absolute so cuts survived, but markers stranded). `findRestSpans`
  brackets `BUILDIT REST op= ... END`; interior traverses never open
  sites, so each span travels whole with its parent loop. Strict test:
  per-span G1 cut order + same-parent attachment preserved across a
  3-site reorder (proven to fail without the guard).
- **Rest reuses the file's proven clearance.** stockTop can sit above
  the file's own traverses when CAM leads with a G1 air-ramp
  (happy-w-1-16: G1 4.027 vs G0 4.0 → rest retracted to 5.027).
  Rest now uses min(auto, lowest G0-XY-traverse ≥ maxLoopZ+0.5);
  explicit-high `--clearance` is preserved verbatim. Measured: 148
  rest retracts 5.027 → 4.0, cleanup 5.9 → 5.4 min.
- **Viewer tags rest by marker.** With no elevated clearance left, the
  elevation fingerprint goes blind — and on shattered spans it was worse
  than blind: pass-machine leakage overtagged original cuts as rest,
  reporting maxA 9.28 / mean 1.23 on geometry that was always fine.
  Marker tagging (plus unmatched-OPEN-to-EOF safety) gives surgical
  spans. Lesson kept: the 9.28 was a verdict error, not a geometry
  error — reported as such, not as a fix.

## v4.3 fixes (arc inter-point bulge — a real geometry bug)

Chasing the regenerated pair's maxA 0.55 to its block found a true
fitter hole, the 4th real bug caught metric-vs-reality: `bestFrom`
verified covered *points* against the circle but never the *chords*
between them. A 3.95mm sparse chord (one straight CAM block in dense
confetti) passed endpoint checks while its midpoint bulged 0.55 off
the emitted arc — exact sagitta match, 27x over tolerance. Worse, the
check loop stopped at e-1, leaving even the final chord unexamined
(the harness caught that too).

- Fitter: covered endpoints within tol/2 radially, every covered chord
  (s..e inclusive) sagitta within tol/2 — chord midpoints stay within
  tol, the documented contract. Dense-file behavior unchanged
  (0.3mm-chord sagitta is ~1e-4); sparse bows stay G1.
- Harness `verifyArcSpans` now asserts the same at tol (sagitta +
  midpoint per covered segment) and happy-w-1-16 joins the fidelity
  corpus as a falsifying regression test (fails with gates reverted).
- Measured: pair maxA 0.55 → 0.33, mean 0.008 → 0.003. Residual 0.33
  bisected to TSP pocket-entry dives (same G1 targets, rerouted
  approaches from Z4 at F400 inside the cleared pocket mouth —
  by-design amber, render-check per policy, not a bug). Price of
  honesty: fewer/longer arcs declined, savings 39.1 → 33.5 min on
  this file. Correctness over compression, always.

The viewer caught two buildit bugs, both fixed + regression-tested:

- **Arc direction on cusps**: the fitter validated points against the
  undirected circle and emitted the chord-sign direction, shortcutting
  sharp Vs by up to ~0.9mm (found: happy half-mil cusp). Fix: `directedSweep`
  requires the mid anchor on the directed arc; emission uses the
  through-mid direction; `verifyArcSpans` asserts directed coverage.
- **Modal restore eaten by arcs**: v4's coordless feed/motion restore was
  absorbed as a zero-length fit run and dropped. Fix: `splitRuns` passes
  coordless explicit blocks through; rest spans also carry explicit
  `BUILDIT REST END` markers. Shipped `.nc` files regenerated.
