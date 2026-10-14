// Source hygiene: no raw control bytes in TypeScript/JavaScript source (found 2026-10-14).
//
// Six files on main held raw NUL (and other control) bytes inside string, template and regex literals, where an
// edit through an escape-processing path had turned `\0` / `\x00` escapes into the bytes themselves. Behaviour was
// identical, but git then treats the file as BINARY: `git diff` and `git log -p` print "Binary files differ" and
// plain grep skips it, so later changes to those files (one was rbac/principal.ts, an auth file) were hidden from
// review. Write the escape (`\x00`), never the byte. TAB, LF and CR are the only control characters allowed.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO = join(__dirname, "..", "..");
const ROOTS = ["platform-nest/src", "platform-ui/src", "report-renderer/src"];
const SOURCE = /\.(ts|tsx|js|mjs|cjs)$/;
// Every C0 control byte except TAB (09), LF (0a) and CR (0d), plus DEL (7f).
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

function sources(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // a tree this checkout does not have (e.g. a package-only CI job)
  }
  for (const e of entries) {
    if (e === "node_modules" || e === ".next" || e === "dist") continue;
    const p = join(dir, e);
    const s = statSync(p);
    if (s.isDirectory()) sources(p, out);
    else if (SOURCE.test(e)) out.push(p);
  }
  return out;
}

describe("source files hold no raw control bytes", () => {
  it("every .ts/.tsx/.js file under the app trees is plain text (escapes, never bytes)", () => {
    const files = ROOTS.flatMap((r) => sources(join(REPO, r)));
    expect(files.length).toBeGreaterThan(100); // the walk really ran
    const offenders = files
      .filter((f) => CONTROL.test(readFileSync(f, "latin1")))
      .map((f) => relative(REPO, f).replace(/\\/g, "/"));
    expect(offenders, `raw control bytes (write \\x00-style escapes instead): ${offenders.join(", ")}`).toEqual([]);
  });
});
