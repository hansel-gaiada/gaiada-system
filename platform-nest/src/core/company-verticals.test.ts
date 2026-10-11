import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PV1-01: the vertical backfill runs against real rows only on deploy (the test database is migrated
// empty), so this pins its mapping instead. The migration writes the type → vertical CASE twice, once
// to UPDATE and once to ASSERT; both must be the ticket's mapping, word for word.
const MIGRATION = path.resolve(__dirname, "../../migrations/202610110530_company_verticals.sql");

const EXPECTED: Record<string, string> = {
  agency: "agency",
  resort: "hospitality",
  restaurant: "hospitality",
  bar: "hospitality",
  spa: "hospitality",
  catering: "catering",
  holding: "holding",
};

function caseBlocks(sql: string): { whens: Record<string, string>; otherwise: string | null }[] {
  return [...sql.matchAll(/CASE\s+type([\s\S]*?)END/gi)].map((m) => {
    const body = m[1];
    const whens: Record<string, string> = {};
    for (const w of body.matchAll(/WHEN\s+'([a-z_]+)'\s+THEN\s+'([a-z_]+)'/gi)) whens[w[1]] = w[2];
    const otherwise = body.match(/ELSE\s+'([a-z_]+)'/i)?.[1] ?? null;
    return { whens, otherwise };
  });
}

describe("company vertical backfill mapping (PV1-01)", () => {
  const blocks = caseBlocks(readFileSync(MIGRATION, "utf8"));

  it("the migration has exactly two CASE type blocks (the UPDATE and the assertion)", () => {
    expect(blocks).toHaveLength(2);
  });

  it("both blocks are the ticket's mapping, with everything else → general", () => {
    for (const b of blocks) {
      expect(b.whens).toEqual(EXPECTED);
      expect(b.otherwise).toBe("general");
    }
  });
});
