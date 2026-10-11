// Pack registry (PV1-02): vertical coverage, parity with the `company_verticals` lookup table.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { PACKS, ROW_MODULE, VERTICALS, VERTICAL_PACK, packFor } from "./packs";

const MIGRATION = path.resolve(__dirname, "../../migrations/202610110530_company_verticals.sql");

describe("pack registry", () => {
  it("maps every vertical to a pack; unknown, null and undefined fall back to generic", () => {
    for (const v of VERTICALS) expect(PACKS[VERTICAL_PACK[v]], v).toBeDefined();
    expect(packFor("agency").key).toBe("agency");
    for (const v of VERTICALS.filter((x) => x !== "agency")) expect(packFor(v).key, v).toBe("generic");
    expect(packFor("no-such-vertical")).toBe(PACKS.generic);
    expect(packFor("toString")).toBe(PACKS.generic);
    expect(packFor(null)).toBe(PACKS.generic);
    expect(packFor(undefined)).toBe(PACKS.generic);
  });

  it("VERTICALS equals the ids seeded into company_verticals by the migration", () => {
    expect(
      existsSync(MIGRATION),
      `missing ${MIGRATION}: PV1-01 must write it with an INSERT INTO company_verticals (id, label) VALUES ...`,
    ).toBe(true);
    const sql = readFileSync(MIGRATION, "utf8");
    const stmt = /INSERT\s+INTO\s+company_verticals\s*\(\s*id\s*,\s*label\s*\)\s*VALUES([\s\S]*?);/i.exec(sql);
    expect(stmt, "no INSERT INTO company_verticals (id, label) VALUES ... statement").not.toBeNull();
    const ids = [...stmt![1].matchAll(/\(\s*'([^']+)'/g)].map((m) => m[1]);
    expect(new Set(ids)).toEqual(new Set(VERTICALS));
    expect(ids.length).toBe(VERTICALS.length);
  });

  it("ROW_MODULE keys are agency rows and toolkit departments are unique", () => {
    const rows: readonly string[] = PACKS.agency.agencyRows;
    for (const k of Object.keys(ROW_MODULE)) expect(rows).toContain(k);
    expect(new Set(PACKS.agency.toolkitDepartments).size).toBe(PACKS.agency.toolkitDepartments.length);
    expect(PACKS.generic.agencyRows).toHaveLength(0);
    expect(PACKS.generic.toolkitDepartments).toHaveLength(0);
  });
});
