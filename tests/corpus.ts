// Shared test-corpus location.
//
// The Carbide fixture files live outside the repo, next to the checkout
// (tests/ -> repo root -> projects/ -> carbide). Default resolves relative
// to THIS file so no machine-specific absolute path is committed;
// BUILDIT_CORPUS overrides for any other layout (CI, other machines).
//
// When the corpus is absent (clean clone, CI) corpus-dependent tests must
// SKIP, not throw ENOENT at import. Use `CORPUS_AVAILABLE` / `corpusSkip`
// and `listCorpusFiles()` below.
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const CORPUS: string =
    process.env.BUILDIT_CORPUS ??
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "carbide");

/** True when the external fixture directory is present. */
export const CORPUS_AVAILABLE: boolean = existsSync(CORPUS);

/** node:test options spread: `it("...", corpusSkip, fn)`. */
export const corpusSkip: { skip: boolean } = { skip: !CORPUS_AVAILABLE };

/** Absolute path for one corpus fixture file. */
export function corpusFile(name: string): string {
    return join(CORPUS, name);
}

/** Every `.nc` file under the corpus tree, or [] when the corpus is absent. */
export function listCorpusFiles(): string[] {
    if (!CORPUS_AVAILABLE) return [];
    const out: string[] = [];
    const walk = (d: string): void => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
            const p = join(d, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.name.endsWith(".nc")) out.push(p);
        }
    };
    walk(CORPUS);
    return out.sort();
}
