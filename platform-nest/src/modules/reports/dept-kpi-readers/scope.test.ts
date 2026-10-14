import { describe, it, expect } from "vitest";
import { deptClientIdsSql, localDateSql, unitSubtreeSql, windowEndSql, windowStartSql } from "./scope";

// DW-6n (BFF §40.5.2): the shared fragments use the caller's placeholders and bind nothing themselves. The rows they
// select are proved by each reader's database test; this pins the text so a reader's parameter numbering stays its own.
describe("dept KPI reader scope fragments", () => {
  it("S(u) is §33's subtree rule on the caller's tenant and unit placeholders", () => {
    const sql = unitSubtreeSql("p.department_id", 1, 2);
    expect(sql).toContain("p.department_id = $2::text");
    expect(sql).toContain("oc.tenant_id = $1::uuid AND oc.ancestor_id = $2::text");
    expect(sql).not.toMatch(/\$3/);
  });

  it("C(u) keeps only not-deleted, non-internal clients of not-deleted projects in S(u)", () => {
    const sql = deptClientIdsSql(3, 7);
    expect(sql).toContain("dp.tenant_id = $3::uuid");
    expect(sql).toContain("dp.deleted_at IS NULL");
    expect(sql).toContain("dc.deleted_at IS NULL AND NOT dc.is_internal");
    expect(sql).toContain("dp.department_id = $7::text");
  });

  it("the window is [start 00:00, end + 1 day 00:00) in the zone", () => {
    expect(windowStartSql(4, 6)).toBe("(($4::date)::timestamp AT TIME ZONE $6::text)");
    expect(windowEndSql(5, 6)).toBe("((($5::date) + 1)::timestamp AT TIME ZONE $6::text)");
    expect(localDateSql("r.closed_at", 6)).toBe("((r.closed_at) AT TIME ZONE $6::text)::date");
  });
});
