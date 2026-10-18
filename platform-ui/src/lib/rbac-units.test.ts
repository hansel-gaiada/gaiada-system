import { describe, it, expect } from "vitest";
import { can, canInUnit, isLeadOf, leadUnits, leadsAnyUnitWith, canWorkOnCourse, unitPathOf } from "./rbac";
import type { Me } from "./platform";

const companies = [
  { id: "co-a", name: "Company A", type: "agency" },
  { id: "co-b", name: "Company B", type: "resort" },
];
function me(roles: Me["roles"], comps = companies): Me {
  return { userId: "u", name: "U", email: "u@x.com", title: null, assurance: "high", companies: comps, roles };
}
// DW-10g-2: a lead grant carries the companies whose own lead seat backs it. Default: the fixture company co-a.
const lead = (scopeId: string | null, tenantIds: string[] = ["co-a"]) => ({ role: "org_unit_lead", scopeType: "org_unit", scopeId, tenantIds });
const path = ["d-web-frontend", "d-web", "d-gm"];

describe("leadUnits", () => {
  it("dedupes and keeps grant order", () => {
    expect(leadUnits(me([lead("d-web"), lead("d-seo"), lead("d-web")]), "co-a")).toEqual(["d-web", "d-seo"]);
  });
  it("ignores org_unit_lead at company scope", () => {
    expect(leadUnits(me([{ role: "org_unit_lead", scopeType: "company", scopeId: "co-a" }]), "co-a")).toEqual([]);
  });
  it("ignores other roles at org_unit scope", () => {
    expect(leadUnits(me([{ role: "manager", scopeType: "org_unit", scopeId: "d-web" }]), "co-a")).toEqual([]);
  });
  it("ignores a null scopeId", () => {
    expect(leadUnits(me([lead(null)]), "co-a")).toEqual([]);
  });
});

describe("isLeadOf", () => {
  it("true for the direct unit", () => {
    expect(isLeadOf(me([lead("d-web")]), ["d-web", "d-gm"], "co-a")).toBe(true);
  });
  it("an ancestor lead cascades to a descendant path", () => {
    expect(isLeadOf(me([lead("d-web")]), path, "co-a")).toBe(true);
  });
  it("false for a sibling unit", () => {
    expect(isLeadOf(me([lead("d-web")]), ["d-seo", "d-gm"], "co-a")).toBe(false);
  });
  it("false for an empty path", () => {
    expect(isLeadOf(me([lead("d-web")]), [], "co-a")).toBe(false);
  });
});

describe("DW-10g-2: a lead grant counts only in a company whose own lead seat backs it (`tenantIds`)", () => {
  it("leadUnits and isLeadOf answer per company: the seat's company yes, another company no, no company no", () => {
    const m = me([lead("d-web", ["co-a"])]);
    expect(leadUnits(m, "co-a")).toEqual(["d-web"]);
    expect(leadUnits(m, "co-b")).toEqual([]);
    expect(leadUnits(m, null)).toEqual([]);
    expect(isLeadOf(m, path, "co-b")).toBe(false);
  });
  it("THE FOREIGN GRANT: a member of co-a and co-b whose seat is in co-b is no head of co-a's same-id unit", () => {
    const m = me([lead("d-web", ["co-b"])]);
    expect(canInUnit(m, "lms.authoring", "co-a", path)).toBe(false);
    expect(leadsAnyUnitWith(m, "lms.authoring", "co-a")).toBe(false);
    expect(canInUnit(m, "lms.authoring", "co-b", path)).toBe(true);
  });
  it("a grant WITHOUT tenantIds (an older payload) counts nowhere, as the server's has() guard", () => {
    const m = me([{ role: "org_unit_lead", scopeType: "org_unit", scopeId: "d-web" }]);
    expect(leadUnits(m, "co-a")).toEqual([]);
    expect(canInUnit(m, "lms.authoring", "co-a", path)).toBe(false);
  });
});

describe("canInUnit", () => {
  const l = me([lead("d-web")]);
  it("lead gets lms.authoring in a company they belong to", () => {
    expect(canInUnit(l, "lms.authoring", "co-a", path)).toBe(true);
  });
  it("false for a company the person is not in", () => {
    expect(canInUnit(l, "lms.authoring", "co-z", path)).toBe(false);
  });
  it("false with a null/undefined companyId", () => {
    expect(canInUnit(l, "lms.authoring", null, path)).toBe(false);
    expect(canInUnit(l, "lms.authoring", undefined, path)).toBe(false);
  });
  it("false for a cap org_unit_lead lacks (lms.waive)", () => {
    expect(canInUnit(l, "lms.waive", "co-a", path)).toBe(false);
  });
  it("false when the unit is outside the led subtree", () => {
    expect(canInUnit(l, "lms.authoring", "co-a", ["d-seo", "d-gm"])).toBe(false);
  });
  it("a synthetic manager@org_unit grant does not count", () => {
    const m = me([{ role: "manager", scopeType: "org_unit", scopeId: "d-web" }]);
    expect(canInUnit(m, "lms.authoring", "co-a", path)).toBe(false);
  });
  it("a company-scoped grant still answers via can()", () => {
    const admin = me([{ role: "company_admin", scopeType: "company", scopeId: "co-a" }]);
    expect(can(admin, "lms.authoring", "co-a")).toBe(true);
    expect(canInUnit(admin, "lms.authoring", "co-a", [])).toBe(true);
  });
  it("company-wide can() stays false for the unit lead (no loosening)", () => {
    expect(can(l, "lms.authoring", "co-a")).toBe(false);
    expect(can(l, "lms.authoring")).toBe(false);
  });
});

describe("unitPathOf", () => {
  const tree = {
    id: "holding",
    children: [
      { id: "d-gm", children: [{ id: "d-web", children: [{ id: "d-web-frontend", children: [] }] }] },
      { id: "d-seo", children: [] },
    ],
  };
  it("returns the inclusive nearest-first path", () => {
    expect(unitPathOf(tree, "d-web-frontend")).toEqual(["d-web-frontend", "d-web", "d-gm", "holding"]);
    expect(unitPathOf(tree, "holding")).toEqual(["holding"]);
  });
  it("returns [] for an unknown id", () => {
    expect(unitPathOf(tree, "nope")).toEqual([]);
  });
});

describe("leadsAnyUnitWith (DW-4g)", () => {
  it("offers a lead the authoring and publishing rights org_unit_lead carries, in their own company", () => {
    const l = me([lead("d-web")]);
    expect(leadsAnyUnitWith(l, "lms.authoring", "co-a")).toBe(true);
    expect(leadsAnyUnitWith(l, "lms.publish", "co-a")).toBe(true);
  });
  it("never offers what org_unit_lead lacks: waiving", () => {
    expect(leadsAnyUnitWith(me([lead("d-web")]), "lms.waive", "co-a")).toBe(false);
  });
  it("is false with no led unit, for a company they do not belong to, or with no company", () => {
    expect(leadsAnyUnitWith(me([{ role: "manager", scopeType: "company", scopeId: "co-a" }]), "lms.authoring", "co-a")).toBe(false);
    expect(leadsAnyUnitWith(me([lead("d-web")]), "lms.authoring", "co-z")).toBe(false);
    expect(leadsAnyUnitWith(me([lead("d-web")]), "lms.authoring", null)).toBe(false);
  });
});

describe("canWorkOnCourse (DW-4g)", () => {
  // d-web holds a division; d-seo is a sibling department.
  const tree = {
    id: "co-root", children: [
      { id: "d-web", children: [{ id: "dv-frontend", children: [] }] },
      { id: "d-seo", children: [] },
    ],
  };
  const dept = (unitNodeId: string | null) => ({ track: "department", unitNodeId });
  const head = me([lead("d-web")]);
  const admin = me([{ role: "company_admin", scopeType: "company", scopeId: "co-a" }]);

  it("a company-wide author may work on any course, general track included", () => {
    expect(canWorkOnCourse(admin, "lms.authoring", "co-a", tree, dept("d-seo"))).toBe(true);
    expect(canWorkOnCourse(admin, "lms.publish", "co-a", tree, { track: "general", unitNodeId: null })).toBe(true);
  });
  it("the d-web head works on a d-web course and on a d-web DIVISION course, authoring and publishing", () => {
    expect(canWorkOnCourse(head, "lms.authoring", "co-a", tree, dept("d-web"))).toBe(true);
    expect(canWorkOnCourse(head, "lms.authoring", "co-a", tree, dept("dv-frontend"))).toBe(true);
    expect(canWorkOnCourse(head, "lms.publish", "co-a", tree, dept("dv-frontend"))).toBe(true);
  });
  it("the d-web head does not work on a d-seo course, or on a unit missing from the tree", () => {
    expect(canWorkOnCourse(head, "lms.authoring", "co-a", tree, dept("d-seo"))).toBe(false);
    expect(canWorkOnCourse(head, "lms.authoring", "co-a", tree, dept("d-nope"))).toBe(false);
  });
  it("the d-web head does not work on a general-track course, even one carrying a unit id", () => {
    expect(canWorkOnCourse(head, "lms.authoring", "co-a", tree, { track: "general", unitNodeId: null })).toBe(false);
    expect(canWorkOnCourse(head, "lms.authoring", "co-a", tree, { track: "general", unitNodeId: "d-web" })).toBe(false);
  });
  it("a department course with no unit is company-wide only", () => {
    expect(canWorkOnCourse(head, "lms.authoring", "co-a", tree, dept(null))).toBe(false);
  });
  it("a null tree leaves can() alone: a head gets nothing, a company-wide author still has it", () => {
    expect(canWorkOnCourse(head, "lms.authoring", "co-a", null, dept("d-web"))).toBe(false);
    expect(canWorkOnCourse(admin, "lms.authoring", "co-a", null, dept("d-web"))).toBe(true);
  });
  it("never offers waiving, and not in a company the person does not belong to", () => {
    expect(canWorkOnCourse(head, "lms.waive", "co-a", tree, dept("d-web"))).toBe(false);
    expect(canWorkOnCourse(head, "lms.authoring", "co-z", tree, dept("d-web"))).toBe(false);
  });
});
