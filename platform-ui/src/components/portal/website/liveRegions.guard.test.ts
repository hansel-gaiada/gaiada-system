import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// WSK-49d: progress and outcomes in the portal's Website area are POLITE. No assertive live region, no `role="alert"`, no `role="log"`
// in any new client component, page or state (a conditional `role={... ? "alert" : ...}` counts too).
const DIRS = [__dirname, path.join(__dirname, "..", "..", "..", "app", "(portal)", "portal", "website")];
const files = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(d, e.name)) : [path.join(d, e.name)]));

describe("the portal Website components never use an assertive live region", () => {
  const sources = DIRS.flatMap(files).filter((f) => /\.tsx$/.test(f) && !/\.test\./.test(f));
  it("finds the components (the guard is not vacuous)", () => { expect(sources.length).toBeGreaterThanOrEqual(12); });
  it.each(sources.map((f) => [path.relative(path.join(__dirname, "..", "..", ".."), f), f]))("%s", (_n, f) => {
    const src = readFileSync(f, "utf8");
    expect(src).not.toMatch(/role=(\{[^}]*)?["']alert["']/);
    expect(src).not.toMatch(/role=["']log["']/);
    expect(src).not.toMatch(/aria-live=["']assertive["']/);
  });
});
