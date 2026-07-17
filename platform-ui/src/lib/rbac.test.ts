import { describe, it, expect } from "vitest";
import { can, isElevated, canManageIT, accessibleCompanies, canSwitchCompany } from "./rbac";
import type { Me } from "./platform";

const companies = [
  { id: "co-a", name: "Company A", type: "agency" },
  { id: "co-b", name: "Company B", type: "resort" },
];
function me(roles: Me["roles"], comps = companies): Me {
  return { userId: "u", name: "U", email: "u@x.com", title: null, assurance: "high", companies: comps, roles };
}

describe("can() — capability + scope", () => {
  const admin = me([{ role: "platform_admin", scopeType: "global", scopeId: null }]);
  const exec = me([{ role: "group_executive", scopeType: "global", scopeId: null }]);
  const mgrA = me([{ role: "manager", scopeType: "company", scopeId: "co-a" }]);
  const coAdminA = me([{ role: "company_admin", scopeType: "company", scopeId: "co-a" }]);
  const member = me([{ role: "member", scopeType: "company", scopeId: "co-a" }]);

  it("global superadmin can do everything, everywhere", () => {
    expect(can(admin, "admin.access", "co-a")).toBe(true);
    expect(can(admin, "rollups.view")).toBe(true);
    expect(can(admin, "it.manage", "co-b")).toBe(true);
    expect(isElevated(admin)).toBe(true);
    expect(isElevated(exec)).toBe(true);
  });

  it("manager can manage PM only in their own company", () => {
    expect(can(mgrA, "pm.manage", "co-a")).toBe(true);
    expect(can(mgrA, "pm.manage", "co-b")).toBe(false);
    expect(can(mgrA, "admin.access", "co-a")).toBe(false);
    expect(can(mgrA, "rollups.view")).toBe(false); // cross-company needs a global grant
    expect(isElevated(mgrA)).toBe(false);
  });

  it("company_admin has admin.access + it.manage scoped to their company", () => {
    expect(can(coAdminA, "admin.access", "co-a")).toBe(true);
    expect(can(coAdminA, "admin.access", "co-b")).toBe(false);
    expect(can(coAdminA, "it.manage", "co-a")).toBe(true);
  });

  it("a plain member can do none of the privileged actions", () => {
    for (const cap of ["admin.access", "pm.manage", "it.manage", "org.edit", "rollups.view"] as const) {
      expect(can(member, cap, "co-a")).toBe(false);
    }
  });
});

describe("canManageIT", () => {
  const itA = me([{ role: "it_admin", scopeType: "company", scopeId: "co-a" }]);
  it("scoped to a company when given, else 'anywhere'", () => {
    expect(canManageIT(itA, "co-a")).toBe(true);
    expect(canManageIT(itA, "co-b")).toBe(false);
    expect(canManageIT(itA)).toBe(true); // has it.manage somewhere
    expect(canManageIT(me([{ role: "member", scopeType: "company", scopeId: "co-a" }]))).toBe(false);
  });
});

describe("accessibleCompanies / canSwitchCompany", () => {
  it("elevated reaches every company they belong to", () => {
    const admin = me([{ role: "platform_admin", scopeType: "global", scopeId: null }]);
    expect(accessibleCompanies(admin).map((c) => c.id)).toEqual(["co-a", "co-b"]);
    expect(canSwitchCompany(admin)).toBe(true);
  });
  it("a company-scoped user reaches only their granted companies", () => {
    const mgrA = me([{ role: "manager", scopeType: "company", scopeId: "co-a" }]);
    expect(accessibleCompanies(mgrA).map((c) => c.id)).toEqual(["co-a"]);
    expect(canSwitchCompany(mgrA)).toBe(false);
  });
});
