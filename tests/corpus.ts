// Shared test-corpus location.
//
// The Carbide fixture files live outside the repo, next to the checkout
// (tests/ -> repo root -> projects/ -> carbide). Default resolves relative
// to THIS file so no machine-specific absolute path is committed;
// BUILDIT_CORPUS overrides for any other layout (CI, other machines).
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const CORPUS: string =
  process.env.BUILDIT_CORPUS ??
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "carbide");

/** Absolute path for one corpus fixture file. */
export function corpusFile(name: string): string {
  return join(CORPUS, name);
}
