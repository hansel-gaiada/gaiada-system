// DW-4e-1 (docs/FRONTEND-BFF-CONTRACT.md §40.1): a department's workspace is resolved on the SERVER the way
// `workspaceFor` resolves it here (platform-nest/src/modules/reports/dept-kpis.ts `workspaceSlugFor`), because the
// server picks the department's KPI set. Both sides pin ONE golden table of (vertical, department name -> slug).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { workspaceFor } from "./workspaces";

const THIS_FILE = resolve(__dirname, "./dept-workspace-slugs.test.ts");
const NEST_TWIN = resolve(__dirname, "../../../platform-nest/src/modules/reports/dept-kpis.test.ts");

// ═══════════════════════════════ the slug golden table ═══════════════════════════════
// TWIN: platform-nest/src/modules/reports/dept-kpis.test.ts holds the SAME block, byte for byte, and checks it against
// the server's `workspaceSlugFor`; this file checks it against `workspaceFor`. Each test also compares the two
// blocks' text, so editing one side alone fails both suites.
// <golden:dept-workspace-slugs>
const GOLDEN: ReadonlyArray<readonly [string | null, string, string]> = [
  ["agency", "Web Dev", "web-dev"],
  ["agency", "SEO", "seo"],
  ["agency", "Social Media", "social-media"],
  ["agency", "Creatives", "creatives"],
  ["agency", "GM", "gm"],
  ["agency", "Office of the GM", "generic"],
  ["agency", "HR", "hr"],
  ["agency", "Finance", "finance"],
  ["agency", "IT", "it"],
  ["agency", "Human Resources", "generic"],
  ["agency", "Sales", "generic"],
  ["agency", "  Web   Dev!! ", "web-dev"],
  ["holding", "Web Dev", "generic"],
  ["holding", "HR", "hr"],
  ["general", "Finance", "finance"],
  ["hospitality", "Front Office", "generic"],
  ["catering", "IT", "it"],
  ["unknown-vertical", "SEO", "generic"],
  [null, "Creatives", "generic"],
  [null, "it", "it"],
];
// </golden:dept-workspace-slugs>

function goldenBlock(file: string): string {
  const m = /\/\/ <golden:dept-workspace-slugs>\n([\s\S]*?)\n\/\/ <\/golden:dept-workspace-slugs>/.exec(readFileSync(file, "utf8").replace(/\r\n/g, "\n"));
  if (!m) throw new Error(`no golden block in ${file}`);
  return m[1];
}

describe("DW-4e-1 · department workspace slugs (the client side of the golden table)", () => {
  it("the golden block is byte-identical to its platform-nest twin", () => {
    const mine = goldenBlock(THIS_FILE);
    expect(mine.split("\n").length).toBeGreaterThan(15);
    expect(goldenBlock(NEST_TWIN)).toBe(mine);
  });

  it.each(GOLDEN.map((row) => [...row]))("vertical %s, %j -> %s", (vertical, name, slug) => {
    expect(workspaceFor(vertical as string | null, name as string).key).toBe(slug);
  });
});
