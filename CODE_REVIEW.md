# Code review — buildit

Date: 2026-09-09
Scope: all files in `src/` (23), `viewer/core.cjs`, `viewer/viewer.html`,
all 20 test files, `package.json` / `tsconfig.json` / `.gitignore`, and the
shipped docs.

Baseline: `npm run build` clean; `npm test` = 364 pass / 0 fail (~21 s);
zero LSP errors. Findings below are ordered by severity and were verified
empirically where a reproduction is shown.

## Findings

### 1. CRITICAL — TSP reorder can raise cutting feeds (modal-F corruption)

`src/rapids.ts` permutes whole "site" spans, but `emit(..., minimal=true)`
(`src/janitor.ts:207`) only re-emits **explicit** `F` words. A block whose
feed was inherited modally from another site's `F` therefore inherits a
different feed after reordering. The safety gate `spanHasMST`
(`src/rapids.ts:213`) checks `M/S/T` but not `F`.

Reproduction (resolved feeds via the parser):

```text
INPUT  G1 feeds: 300,300,200,200,200,200,400,400
OUTPUT G1 feeds: 300,300,300,300,200,200,400,400   <- site that inherited F200 now runs at F300
```

Four `G0 X..Y..Z5` drill sites; the F200-setting site is reordered *after* a
site that inherited from it. This violates the project's own safety
principle ("feeds only ever move in the safe direction") and silently
changes both the emitted program and the estimate. Modal-feed inheritance
is exactly the case this codebase exists to handle, so implicit-feed sites
are realistic.

Fix: materialize an explicit `F` on the first cutting block of each site
after reordering, or gate reorder on every moved cut block carrying
`explicitFeed`. Add a regression test asserting the resolved feed sequence
is unchanged across reorder.

### 2. CRITICAL — negative `--clearance` drives retracts below the cut

`src/index.ts:81,110-117` accepts any finite `--clearance`. With
`--clearance -5` the adaptive-clearance pass lowers pure-Z retracts to
`Z-5`:

```text
G1Z-1.000F300
G0Z-5.000     <- retract 4 mm below the floor cut
```

`stockTop` is derived from G1 endpoints, so a negative plane is below
material. This breaches "rapids never enter material the input didn't
already enter". `--accel 0/-1`, `--rapid 0`, `--rest-finish <= 0`,
`--finish-tool <= 0`, and `--check <= 0` are likewise accepted and produce
meaningless or `Infinity` results.

Fix: reject `clearance <= 0` and require positivity for accel/rapid/tool
diameters.

### 3. HIGH — test suite is not reproducible and partly validates stale artifacts

- Every corpus test reads `../../carbide` (untracked, machine-local) via
  `tests/corpus.ts`; there is no CI config and no fixture step. On a clean
  clone `npm test` throws `ENOENT` at import (`readdirSync` in
  `tests/parser.test.ts:11` / `tests/janitor.test.ts:11`) rather than
  skipping.
- `tests/viewer.test.ts:72,77` read pre-generated `/tmp/shark-opt.nc` and
  `/tmp/happy-opt.nc` (dated 2026-09-07) that no test regenerates. Those two
  verdict tests validate an out-of-band artifact, not current optimizer
  output — a pipeline regression would not be caught unless someone
  manually re-ran `buildit`.

Fix: make corpus-dependent tests skip when the corpus is absent; generate
the viewer pair in-test from the optimizer; add a minimal CI workflow.

### 4. MEDIUM — CLI contract broken: invalid input crashes instead of exiting 2

README documents "exit 2 = usage error ... non-numeric values". Actual:

- `--decimals -1` -> uncaught `RangeError` from `toFixed`
  (`src/janitor.ts:8`), stack trace, exit 1.
- `--accel -1` -> silently prints `accel-aware min 0.0`.
- Nonexistent input file -> uncaught `ENOENT` stack (`src/index.ts:120`).
- Negative `--tolerance` / `--arc-tol` / `--rest-finish` / `--finish-tool`
  / `--check` accepted.

### 5. MEDIUM — `tagAddedPlunges` never wired into the shipped viewer

`viewer/core.cjs:588` exists, is exported, is documented as the fallback for
rest retracts that rapids rewrote to file clearance, and is called by
`tests/viewer.test.ts:53,214` — but `viewer/viewer.html` never calls it.
The real UI can misclassify rewritten rest passes as cuts/additions,
producing verdicts that differ from the tests.

### 6. MEDIUM — `parseNC` `nearA` stride bug (`i += 3` over pairs)

`viewer/core.cjs:592,595`: `aPts.push(b.from, b.to)` stores 2 points per
block, but the loop strides 3. Only ~1/3 of A points are sampled, at
inconsistent parity. `tagAddedPlunges` can then fail to recognize a plunge
that is near original geometry, tag original geometry as "added rest", and
hide it from the verdict — a false-green risk. Every entry must be sampled
(stride 1; stride 2 samples only the from-points).

### 7. MEDIUM — `sitesFound` reported as 0 when the reorder is declined

`src/rapids.ts:206-307`: the `else` at line 307 belongs to the inner
`if (gated && sites.length >= 2)`, not to `if (sealed)`. When
`sealed === false` the count is never written, so the report says "0 found"
even though sites were detected (verified: `travIdx=2, sites=2,
sealed=false -> sitesFound 0`).

### 8. LOW — nits and polish

- `src/janitor.ts:224` — dead ternary:
  `Number.isInteger(b.feed) ? String(b.feed) : String(b.feed)`.
- `src/rapids.ts:25` — imports `blockTime` but never uses it; `finishStats`
  reimplements the trapezoid and divides by `opts.accel` (Infinity at 0).
- `src/rapids.ts:124` — `out.indexOf(m.block)` per move -> O(n^2).
- `src/rapids.ts:232-236` — comment says interstitial blocks travel with the
  *following* site; the splice attaches them to the *preceding* site.
- Duplicated `stockTopOf` (`src/index.ts:158`, `src/deviation.ts:82`);
  `src/index.ts:13-14` two imports from `./janitor.ts`.
- `package.json` — `typescript` is a runtime dependency though build-only;
  no `prepare`, no `engines`; `bin -> dist/index.js` (gitignored) is absent
  on a fresh install.
- `src/front.ts:329` — `main()` runs at import, so the front CLI is
  untested end-to-end.
- `src/parser.ts` — lowercase G-words not recognized; inline `(...)`
  comments on motion lines dropped; README says G91 is "flagged" but no
  flag exists.
- `src/deviation.ts:189` — `nearest()` early-return conservatively
  overstates deviation; 24-ring cap returns `Infinity` for far outliers.
- `src/restcut.ts` — modal-restore block can emit `F0` if `parentFeed` is 0.
- `src/arcs.ts` — `bestFrom` worst-case O(n^2..n^3)/run and recursive `dp`
  (deep-run stack risk).
- No lint/format config committed despite repeated "pi-lens formatting pass"
  commits; no CI.

## What is genuinely good

- Safety-first test design: falsifying regression tests, per-point
  containment re-verification, the arc-span fidelity harness,
  "declines instead of overcutting" assertions, corpus round-trip
  invariants.
- Correct modal parser, guarded by the exact historical bug it fixes.
- Pure passes (new arrays, input never mutated), deterministic (no
  randomness).
- Correct, well-tested estimator math.
- Honest reporting: rest surfaced as *added* time; declined fits explained;
  rejected approaches (clipper2-js, biarcs) documented with measurements.
- Viewer security hygiene: titles escaped, `</script>` breakout escaped,
  box JSON `<` escaped, detail SVGs built with DOM APIs.

## Fix order applied

All findings were fixed in this change set; verification below.

1. Modal-F on reorder (feed corruption): `optimizeRapids` now materializes
   an explicit F with each site's own resolved feed on its first cut before
   splicing. Falsifying regression test added
   (`tests/rapids.test.ts` "reorder never changes a resolved modal feed").
2. Clearance/rate validation: `src/index.ts` rejects non-positive
   `--clearance`/`--accel`/`--rapid`/`--rest-2d`/`--rest-finish`/
   `--finish-tool`/`--check`/`--check-prev`, negative `--tolerance`/
   `--arc-tol`, and `--decimals` outside integer 0..100; input/output I/O
   failures exit 2 with a message instead of an uncaught stack.
3. Viewer: `viewer.html` now calls `tagAddedPlunges` (both files present,
   before sampling); `nearA` samples every entry (stride 1). Integration +
   stride regression tests added.
4. Test reproducibility: `tests/corpus.ts` exposes `CORPUS_AVAILABLE` /
   `corpusSkip` / `listCorpusFiles`; corpus-dependent tests skip cleanly;
   `tests/viewer.test.ts` regenerates its optimized pairs in-process
   instead of reading stale `/tmp/*.nc`; `.github/workflows/ci.yml` added.
5. `sitesFound` now always reports the detected site count (was 0 when the
   sealed gate declined); plus janitor dead ternary, rapids unused import /
   accel guard / O(n) index map, parser lowercase G-words, restcut `F0`
   guard, `front.ts` import side-effect guard, package.json engine/devDeps,
   and README corrections.

Verification: `npm run build` clean; `npm test` = 367 pass / 0 fail with
corpus; with `BUILDIT_CORPUS` pointed at a missing directory = 169 pass /
16 skipped / 0 fail (clean-clone behavior). CLI edge cases exercised
(`--decimals -1`, `--accel -1`, `--rapid 0`, `--clearance -5`, negative
tool/rest/check values, missing file) all exit 2 with a clear message.
