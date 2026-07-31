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

  it("sanity: fixture files actually exist for all three vendors AND the google family (a scanner that finds nothing proves nothing)", () => {
    // Floor raised from 12 by SM-51's google family (8 files). The google/ assertion is what makes this
    // sweep meaningful for §A12's surfaces: without it, deleting every google fixture would leave this
    // file green.
    expect(files.length).toBeGreaterThanOrEqual(20);
    expect(files.some((f) => f.includes(`${join("fixtures", "dataforseo")}`))).toBe(true);
    expect(files.some((f) => f.includes(`${join("fixtures", "semrush")}`))).toBe(true);
    expect(files.some((f) => f.includes(`${join("fixtures", "ahrefs")}`))).toBe(true);
    expect(files.filter((f) => f.includes(`${join("fixtures", "google")}`)).length).toBeGreaterThanOrEqual(8);
  });

  it("every fixture file's own text carries the UNVERIFIED-VENDOR-FIXTURE marker", () => {
    const missing = files.filter((f) => !readFileSync(f, "utf8").includes(MARKER));
    expect(missing, `fixture file(s) missing the ${MARKER} marker:\n${missing.join("\n")}`).toEqual([]);
  });

  it("the marker names the authoring date and the superseding event, not just the bare token", () => {
    // SM-51 widened this from the single SM-49 literal. Two dimensions moved, both deliberately:
    //   * the DATE — the google family was authored 2026-07-30, the three vendor families 2026-07-29;
    //   * the SUPERSEDING EVENT — SM-41 captures vendor recordings, SM-41G captures GOOGLE recordings
    //     (§A12.4). A google fixture claiming "superseded by SM-41" would point the backport duty at
    //     the wrong ticket, so the alternation is the point, not laxity.
    // What did NOT move: every fixture must still name a date AND a superseding ticket. A bare
    // UNVERIFIED-VENDOR-FIXTURE token still fails.
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      expect(text, `${f} should state its authoring date and that it is superseded by SM-41/SM-41G recordings`).toMatch(
        /UNVERIFIED-VENDOR-FIXTURE: authored from docs 2026-07-(29|30); superseded by SM-41G? recordings/,
      );
    }
  });

  it("google fixtures point the backport duty at SM-41G specifically, not at SM-41", () => {
    // The alternation above would otherwise let a google fixture cite SM-41 (the vendor ticket) and stay
    // green. §A12.4 makes SM-41G the Google staging sibling that owns the capture-and-backport duty for
    // these envelopes, so this asserts the google family says so.
    const googleFiles = files.filter((f) => f.includes(`${join("fixtures", "google")}`));
    expect(googleFiles.length).toBeGreaterThanOrEqual(8);
    for (const f of googleFiles) {
      expect(readFileSync(f, "utf8"), `${f} is a Google fixture and must cite SM-41G`).toMatch(
        /superseded by SM-41G recordings/,
      );
    }
  });
});
