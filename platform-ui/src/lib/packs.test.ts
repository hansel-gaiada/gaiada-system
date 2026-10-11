// Pack registry parity (PV1-02): the UI registry must equal platform-nest's. Drift fails.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PACKS, packFor } from "./packs";

const UI_FILE = resolve(__dirname, "./packs.ts");
const PN_FILE = resolve(__dirname, "../../../platform-nest/src/core/packs.ts");
const TOOLKITS_FILE = resolve(__dirname, "./deptToolkits.ts");

/** The `export const PACK_DATA = {...} as const;` block, whitespace-normalised. */
function packData(file: string): string {
  const m = /export const PACK_DATA = [\s\S]*?\n\} as const;/.exec(readFileSync(file, "utf8"));
  if (!m) throw new Error(`no PACK_DATA block in ${file}`);
  return m[0].replace(/\s+/g, " ").trim();
}

describe("pack registry parity", () => {
  it("PACK_DATA is identical in the UI and platform-nest registries", () => {
    const ui = packData(UI_FILE);
    expect(ui.length).toBeGreaterThan(200);
    expect(ui).toBe(packData(PN_FILE));
  });

  it("only the agency pack has content; unknown values resolve to generic", () => {
    expect(packFor("agency").key).toBe("agency");
    expect(packFor("catering")).toBe(PACKS.generic);
    expect(packFor("nope")).toBe(PACKS.generic);
    expect(packFor(null)).toBe(PACKS.generic);
    expect(PACKS.generic.agencyRows).toHaveLength(0);
  });

  it("every agency toolkit slug is a bespoke toolkit in deptToolkits.ts", () => {
    const src = readFileSync(TOOLKITS_FILE, "utf8");
    for (const slug of PACKS.agency.toolkitDepartments) {
      expect(src, slug).toContain(`slug: "${slug}"`);
    }
  });
});
