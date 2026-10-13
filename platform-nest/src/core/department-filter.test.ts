import { describe, expect, it } from "vitest";
import { BadRequestException } from "@nestjs/common";
import { DEPARTMENT_ID_MAX, departmentFilterSql, parseDepartmentFilter } from "./department-filter";

// DW-6d / DW-6g, contract §33.2. The parser answers 400 for a malformed id (it is not fail-open like
// parseClientFilter: a bad id cannot be a typo for "everything"), and an absent id means no filter.

function refusal(raw: unknown): { message?: string; field?: string } | null {
  try {
    parseDepartmentFilter(raw);
    return null;
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestException);
    return (e as BadRequestException).getResponse() as { message?: string; field?: string };
  }
}

describe("parseDepartmentFilter", () => {
  it("treats an absent, empty or whitespace-only parameter as 'all'", () => {
    expect(parseDepartmentFilter(undefined)).toEqual({ kind: "all" });
    expect(parseDepartmentFilter(null)).toEqual({ kind: "all" });
    expect(parseDepartmentFilter("")).toEqual({ kind: "all" });
    expect(parseDepartmentFilter("   ")).toEqual({ kind: "all" });
    expect(parseDepartmentFilter(" \t ")).toEqual({ kind: "all" });
  });

  it("trims and returns the node id", () => {
    expect(parseDepartmentFilter("d-webdev")).toEqual({ kind: "unit", nodeId: "d-webdev" });
    expect(parseDepartmentFilter("  d-webdev  ")).toEqual({ kind: "unit", nodeId: "d-webdev" });
    expect(parseDepartmentFilter("019fb652-c708-71f8-a348-91247b5abf2e")).toEqual({
      kind: "unit", nodeId: "019fb652-c708-71f8-a348-91247b5abf2e",
    });
  });

  it("accepts exactly 200 characters and refuses 201 with a 400 naming the field", () => {
    expect(DEPARTMENT_ID_MAX).toBe(200);
    expect(parseDepartmentFilter("a".repeat(200))).toEqual({ kind: "unit", nodeId: "a".repeat(200) });
    expect(refusal("a".repeat(201))?.field).toBe("departmentId");
    expect(refusal("a".repeat(201))?.message).toBeTruthy();
    // The bound applies to the TRIMMED value.
    expect(parseDepartmentFilter(` ${"a".repeat(200)} `)).toEqual({ kind: "unit", nodeId: "a".repeat(200) });
  });

  it("refuses a control character anywhere in the id", () => {
    for (const bad of ["a\u0000b", "a\nb", "a\tb", "a\u001fb", "a\u007fb", "\u0007x"]) {
      expect(refusal(bad)?.field, JSON.stringify(bad)).toBe("departmentId");
    }
  });

  it("refuses a repeated parameter (an array) rather than guessing", () => {
    expect(refusal(["a", "b"])?.field).toBe("departmentId");
  });
});

describe("departmentFilterSql", () => {
  it("'all' is TRUE with no params, so it always ANDs in safely", () => {
    expect(departmentFilterSql({ kind: "all" }, "p.department_id", 1, 2)).toEqual({ sql: "TRUE", params: [] });
  });

  it("a unit matches the node itself or anything under it in the SAME company's closure", () => {
    const f = departmentFilterSql({ kind: "unit", nodeId: "d1" }, "dp.department_id", 3, 4);
    expect(f.params).toEqual(["d1"]);
    expect(f.sql).toContain("dp.department_id = $4::text");
    expect(f.sql).toContain("FROM org_unit_closure oc");
    expect(f.sql).toContain("oc.tenant_id = $3::uuid");
    expect(f.sql).toContain("oc.ancestor_id = $4::text");
    expect(f.sql).toContain("oc.descendant_id");
  });
});
