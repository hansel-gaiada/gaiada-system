// SM-49 AC 10 (tracker §6u, design addendum §A10.6) — every vendor-envelope fixture file is authored
// FROM DOCS, not captured from a vendor. This test is the one place that mechanically proves every
// fixture file says so: it walks fixtures/** and asserts each file's own raw text carries the literal
// marker. A fixture missing the marker would silently invite being read as vendor truth — the exact
// §4i circularity §A10.5 names ("a fixture authored from our own reading of the docs agrees with our
// parser BY CONSTRUCTION").
//
// This file lives OUTSIDE src/modules/search/ (this whole directory does — see server.ts's header),
// so it is not subject to (and does not need to update) egress-inventory.test.ts's allowlist.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const FIXTURES_ROOT = join(__dirname, "fixtures");
const MARKER = "UNVERIFIED-VENDOR-FIXTURE";

function listFixtureFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listFixtureFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("SM-49 AC 10 — every vendor-envelope fixture file is marked UNVERIFIED-VENDOR-FIXTURE", () => {
  const files = listFixtureFiles(FIXTURES_ROOT);

  it("sanity: fixture files actually exist for all three vendors (a scanner that finds nothing proves nothing)", () => {
    expect(files.length).toBeGreaterThanOrEqual(12);
    expect(files.some((f) => f.includes(`${join("fixtures", "dataforseo")}`))).toBe(true);
    expect(files.some((f) => f.includes(`${join("fixtures", "semrush")}`))).toBe(true);
    expect(files.some((f) => f.includes(`${join("fixtures", "ahrefs")}`))).toBe(true);
  });

  it("every fixture file's own text carries the UNVERIFIED-VENDOR-FIXTURE marker", () => {
    const missing = files.filter((f) => !readFileSync(f, "utf8").includes(MARKER));
    expect(missing, `fixture file(s) missing the ${MARKER} marker:\n${missing.join("\n")}`).toEqual([]);
  });

  it("the marker names the authoring date and the superseding event, not just the bare token", () => {
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      expect(text, `${f} should state it is superseded by SM-41 recordings`).toMatch(
        /UNVERIFIED-VENDOR-FIXTURE: authored from docs 2026-07-29; superseded by SM-41 recordings/,
      );
    }
  });
});
