// Shared scan for the reader-degrade RATCHET over `src/app` and `src/components` (T4 of the
// agentic-native close-out audit). Kept out of the test file so the allowlist can be regenerated with
// the same code the guard runs. No imports from the app; plain node only.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * A "degrade site" folds a failed read into a value that reads as "nothing here":
 *   - `.catch(() => [])`, `.catch((e) => null)`, `.catch(() => undefined)`
 *   - `.catch(() => ({ items: [], ... }))` (an empty envelope is the same lie)
 *   - a local `safe` / `skipMissing` / `settle` helper definition (the bare-catch family the lib
 *     guard hunts; one definition counts once)
 * Absence-only handling that inspects the error (`instanceof PlatformError`, status checks) does not
 * match: none of the patterns fire on a catch that names what it caught.
 */
const SITE_PATTERNS: RegExp[] = [
  /\.catch\(\s*(?:async\s*)?\(\s*\w*\s*\)\s*=>\s*(?:\[\]|null|undefined)(?![\w.])/g,
  /\.catch\(\s*(?:async\s*)?\(\s*\w*\s*\)\s*=>\s*\(\{[^)]*\[\][^)]*\}\)/g,
  /\bfunction (?:safe|skipMissing|settle)\b/g,
];

export function countDegradeSites(src: string): number {
  let n = 0;
  for (const re of SITE_PATTERNS) n += [...src.matchAll(re)].length;
  return n;
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) {
      out.push(p);
    }
  }
}

/** path (relative to `src`, forward slashes) -> count, for every file under app/ and components/ with >= 1 site. */
export function scanAppAndComponents(srcRoot: string): Record<string, number> {
  const files: string[] = [];
  for (const d of ["app", "components"]) walk(join(srcRoot, d), files);
  const out: Record<string, number> = {};
  for (const f of files.sort()) {
    const n = countDegradeSites(readFileSync(f, "utf8"));
    if (n > 0) out[relative(srcRoot, f).split(sep).join("/")] = n;
  }
  return out;
}
