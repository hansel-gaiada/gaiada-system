import { describe, it, expect } from "vitest";
import { assignmentInclusion, servedCompanyBadge, servedScopesByCompany, type AssignmentSummary } from "./serviceAssignments";
import type { Me } from "./platform";

const base: Pick<AssignmentSummary, "status" | "unitStatus"> = { status: "active", unitStatus: "active" };

describe("assignmentInclusion", () => {
  it("active + a live unit is included", () => {
    expect(assignmentInclusion(base)).toEqual({ included: true, reason: undefined });
  });
  it("suspended is excluded with reason=suspended", () => {
    expect(assignmentInclusion({ ...base, status: "suspended" })).toEqual({ included: false, reason: "suspended" });
  });
  it("proposed (not yet accepted) is excluded with reason=not_served", () => {
    expect(assignmentInclusion({ ...base, status: "proposed" })).toEqual({ included: false, reason: "not_served" });
  });
  it("revoked is excluded with reason=not_served", () => {
    expect(assignmentInclusion({ ...base, status: "revoked" })).toEqual({ included: false, reason: "not_served" });
  });
  it("an orphaned unit overrides an otherwise-active assignment", () => {
    expect(assignmentInclusion({ status: "active", unitStatus: "orphaned" })).toEqual({ included: false, reason: "error" });
  });
});

function me(over: Partial<Me>): Me {
  return { userId: "u1", name: "U", email: "u@x.com", title: null, assurance: "high", companies: [], roles: [], ...over };
}

describe("servedCompanyBadge", () => {
  it("null when the user has no service scope for that company", () => {
    expect(servedCompanyBadge(me({}), "co-a")).toBeNull();
  });
  it("renders the module name when a service scope exists", () => {
    const m = me({ serviceScopes: [{ companyId: "co-a", companyName: "Agency", assignmentId: "a1", module: "hr", unitName: "HR", role: "staff" }] });
    expect(servedCompanyBadge(m, "co-a")).toBe("via HR");
    expect(servedCompanyBadge(m, "co-b")).toBeNull();
  });
});

describe("servedScopesByCompany", () => {
  it("groups scopes by companyId, preserving multiple grants per company", () => {
    const scopes = [
      { companyId: "co-a", companyName: "Agency", assignmentId: "a1", module: "hr" as const, unitName: "HR", role: "staff" as const },
      { companyId: "co-a", companyName: "Agency", assignmentId: "a2", module: "it" as const, unitName: "IT", role: "manager" as const },
      { companyId: "co-b", companyName: "Resort", assignmentId: "a3", module: "hr" as const, unitName: "HR", role: "staff" as const },
    ];
    const grouped = servedScopesByCompany(scopes);
    expect(grouped.get("co-a")?.length).toBe(2);
    expect(grouped.get("co-b")?.length).toBe(1);
    expect(grouped.get("co-c")).toBeUndefined();
  });
  it("empty map when undefined", () => {
    expect(servedScopesByCompany(undefined).size).toBe(0);
  });
});
