import { describe, it, expect } from "vitest";
import { can, canInUnit, isLeadOf, leadUnits, leadsAnyUnitWith, unitPathOf } from "./rbac";
import type { Me } from "./platform";

const companies = [
  { id: "co-a", name: "Company A", type: "agency" },
  { id: "co-b", name: "Company B", type: "resort" },
];
function me(roles: Me["roles"], comps = companies): Me {
  return { userId: "u", name: "U", email: "u@x.com", title: null, assurance: "high", companies: comps, roles };
}
const lead = (scopeId: string | null) => ({ role: "org_unit_lead", scopeType: "org_unit", scopeId });
const path = ["d-web-frontend", "d-web", "d-gm"];

describe("leadUnits", () => {
  it("dedupes and keeps grant order", () => {
    expect(leadUnits(me([lead("d-web"), lead("d-seo"), lead("d-web")]))).toEqual(["d-web", "d-seo"]);
  });
  it("ignores org_unit_lead at company scope", () => {
    expect(leadUnits(me([{ role: "org_unit_lead", scopeType: "company", scopeId: "co-a" }]))).toEqual([]);
  });
  it("ignores other roles at org_unit scope", () => {
    expect(leadUnits(me([{ role: "manager", scopeType: "org_unit", scopeId: "d-web" }]))).toEqual([]);
  });
  it("ignores a null scopeId", () => {
    expect(leadUnits(me([lead(null)]))).toEqual([]);
  });
});

describe("isLeadOf", () => {
  it("true for the direct unit", () => {
    expect(isLeadOf(me([lead("d-web")]), ["d-web", "d-gm"])).toBe(true);
  });
  it("an ancestor lead cascades to a descendant path", () => {
    expect(isLeadOf(me([lead("d-web")]), path)).toBe(true);
  });
  it("false for a sibling unit", () => {
    expect(isLeadOf(me([lead("d-web")]), ["d-seo", "d-gm"])).toBe(false);
  });
  it("false for an empty path", () => {
    expect(isLeadOf(me([lead("d-web")]), [])).toBe(false);
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
