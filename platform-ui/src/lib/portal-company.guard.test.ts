import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// PV2-05 guard: no portal file may resolve the company with the staff resolver. If a page and an
// action disagree on the company, a signature or payment goes to the wrong one.
const ROOT = path.resolve(__dirname, "..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe("portal company resolver guard", () => {
  const files = [
    ...walk(path.join(ROOT, "app", "(portal)")).filter((f) => /\.(ts|tsx)$/.test(f)),
    path.join(ROOT, "lib", "portalActions.ts"),
    // WSK-49d: the Website area's own server modules resolve the company the same way.
    path.join(ROOT, "lib", "portalWebsite.ts"),
    path.join(ROOT, "lib", "portalWebsiteActions.ts"),
    path.join(ROOT, "lib", "portalWebsiteDriver.ts"),
    ...walk(path.join(ROOT, "components", "portal", "website")).filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f)),
  ];

  it("finds the portal files (the guard is not vacuous)", () => {
    expect(files.filter((f) => f.endsWith("page.tsx")).length).toBeGreaterThanOrEqual(16);
    expect(files.some((f) => f.endsWith("layout.tsx"))).toBe(true);
  });

  it("no portal file imports or calls getActiveTenant", () => {
    const offenders = files.filter((f) => readFileSync(f, "utf8").includes("getActiveTenant"));
    expect(offenders).toEqual([]);
  });

  it("the Website area's server modules resolve the company through the portal's own resolver", () => {
    for (const f of ["portalWebsite.ts", "portalWebsiteActions.ts"]) {
      expect(readFileSync(path.join(ROOT, "lib", f), "utf8"), f).toContain("getActivePortalCompany");
    }
  });
});
