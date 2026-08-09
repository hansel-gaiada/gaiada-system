// PRV-00 AC 10 — every mock-provision fixture file is authored FROM DOCS (provision-erp-seam-design),
// not captured from a live provision instance. This test proves every fixture file says so by
// walking fixtures/** and asserting each carries the UNVERIFIED-VENDOR-FIXTURE marker (PRV-00 traps
// §04 subheading "Mark fixture data as fixture data").
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

describe("PRV-00 AC 10 — every mock-provision fixture file is marked UNVERIFIED-VENDOR-FIXTURE", () => {
  const files = listFixtureFiles(FIXTURES_ROOT);

  it("sanity: fixture files exist for provision responses", () => {
    expect(files.length).toBeGreaterThanOrEqual(2);
    expect(files.some((f) => f.includes("success-provision"))).toBe(true);
    expect(files.some((f) => f.includes("project-status"))).toBe(true);
  });

  it("every fixture file's own text carries the UNVERIFIED-VENDOR-FIXTURE marker", () => {
    const missing = files.filter((f) => !readFileSync(f, "utf8").includes(MARKER));
    expect(missing, `fixture file(s) missing the ${MARKER} marker:\n${missing.join("\n")}`).toEqual([]);
  });

  it("the marker names the authoring date and the superseding event", () => {
    // PRV-00 fixtures are authored from provision-erp-seam-design (live docs), superseded by
    // PRV-02's live integration test against the real provision service.
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      expect(text, `${f} should state its authoring date and that it is superseded by PRV-02 live recordings`).toMatch(
        /UNVERIFIED-VENDOR-FIXTURE: authored from docs 2026-08-08; superseded by PRV-02 live recordings/,
      );
    }
  });
});
