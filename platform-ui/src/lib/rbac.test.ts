import { describe, it, expect } from "vitest";
import { can, isElevated, canManageIT, accessibleCompanies, canSwitchCompany, isManagerTier, isClient, isStaff, isClientOnly } from "./rbac";
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

describe("hr caps (hr_staff/hr_manager)", () => {
  const staff = me([{ role: "hr_staff", scopeType: "company", scopeId: "co-a" }]);
  const manager = me([{ role: "hr_manager", scopeType: "company", scopeId: "co-a" }]);

  it("hr_staff can view but not manage, scoped to their company", () => {
    expect(can(staff, "hr.view", "co-a")).toBe(true);
    expect(can(staff, "hr.manage", "co-a")).toBe(false);
    expect(can(staff, "hr.view", "co-b")).toBe(false);
  });

  it("hr_manager can view and manage in their company only", () => {
    expect(can(manager, "hr.view", "co-a")).toBe(true);
    expect(can(manager, "hr.manage", "co-a")).toBe(true);
    expect(can(manager, "hr.manage", "co-b")).toBe(false);
  });

  it("company_admin gets both hr caps in their own company", () => {
    const coAdminA = me([{ role: "company_admin", scopeType: "company", scopeId: "co-a" }]);
    expect(can(coAdminA, "hr.view", "co-a")).toBe(true);
    expect(can(coAdminA, "hr.manage", "co-a")).toBe(true);
  });
});

describe("scopeCovers — A4 fixes (no over-grant)", () => {
  it("a null-scope company grant does NOT cover any company (not a wildcard)", () => {
    const nullScoped = me([{ role: "manager", scopeType: "company", scopeId: null }]);
    expect(can(nullScoped, "pm.manage", "co-a")).toBe(false);
    expect(can(nullScoped, "pm.manage", "co-b")).toBe(false);
  });

  it("a team-scoped grant does not blanket-cover the whole company", () => {
    const teamScoped = me([{ role: "manager", scopeType: "team", scopeId: "div-1" }]);
    expect(can(teamScoped, "pm.manage", "co-a")).toBe(false);
    expect(can(teamScoped, "pm.manage", "co-b")).toBe(false);
  });

  it("hr_staff scoped to company B covers only B, never A", () => {
    const staffB = me([{ role: "hr_staff", scopeType: "company", scopeId: "co-b" }]);
    expect(can(staffB, "hr.view", "co-b")).toBe(true);
    expect(can(staffB, "hr.view", "co-a")).toBe(false);
  });

  it("hr_manager scoped to company B covers only B, never A", () => {
    const managerB = me([{ role: "hr_manager", scopeType: "company", scopeId: "co-b" }]);
    expect(can(managerB, "hr.manage", "co-b")).toBe(true);
    expect(can(managerB, "hr.manage", "co-a")).toBe(false);
  });

  it("global/elevated grants are unaffected — still cover every company", () => {
    const admin = me([{ role: "platform_admin", scopeType: "global", scopeId: null }]);
    const exec = me([{ role: "group_executive", scopeType: "global", scopeId: null }]);
    expect(can(admin, "hr.manage", "co-a")).toBe(true);
    expect(can(admin, "hr.manage", "co-b")).toBe(true);
    expect(can(exec, "hr.manage", "co-a")).toBe(true);
    expect(can(exec, "hr.manage", "co-b")).toBe(true);
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

describe("isManagerTier — UX-2 §1.3 Home role boundary", () => {
  it("platform_admin/group_executive/company_admin/manager/it_admin/it_manager are manager-tier", () => {
    for (const role of ["platform_admin", "group_executive", "company_admin", "manager", "it_admin", "it_manager"] as const) {
      expect(isManagerTier(me([{ role, scopeType: "company", scopeId: "co-a" }]))).toBe(true);
    }
  });

  it("member/it/hr_staff/hr_manager get the Queue+Agenda hybrid (not manager-tier)", () => {
    for (const role of ["member", "it", "hr_staff", "hr_manager"] as const) {
      expect(isManagerTier(me([{ role, scopeType: "company", scopeId: "co-a" }]))).toBe(false);
    }
  });

  it("holding_head is NOT manager-tier — D-UX-4/A4 dropped the role entirely", () => {
    // holding_head no longer exists as a Role; a stale grant string from an old
    // session should simply not match any known tier, not crash or over-grant.
    expect(isManagerTier(me([{ role: "holding_head", scopeType: "global", scopeId: null }]))).toBe(false);
  });

  it("any manager-tier grant wins even alongside a member grant elsewhere (tie-break rule)", () => {
    const mixed = me([
      { role: "manager", scopeType: "company", scopeId: "co-a" },
      { role: "member", scopeType: "company", scopeId: "co-b" },
    ]);
    expect(isManagerTier(mixed)).toBe(true);
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

// The rule that decides WHERE a user lands. `(app)/page.tsx` redirects `isClient && !isElevated` to
// /portal and `navFor` gates on the identical pair, so these two predicates together are the routing
// contract for external clients. Untested before: a client used to land on the staff dashboard because
// nothing consulted them outside nav.
describe("isClient — external client routing", () => {
  const client = me([{ role: "client", scopeType: "company", scopeId: "co-a" }]);

  it("a client-only user is routed to the portal", () => {
    expect(isClient(client)).toBe(true);
    expect(isStaff(client)).toBe(false);
    expect(isClientOnly(client)).toBe(true);
  });

  it("staff are not clients, so the staff home is never taken away from them", () => {
    for (const role of ["member", "manager", "company_admin", "group_executive", "platform_admin"] as const) {
      const u = me([{ role, scopeType: role === "group_executive" || role === "platform_admin" ? "global" : "company", scopeId: role === "group_executive" || role === "platform_admin" ? null : "co-a" }]);
      expect(isClient(u)).toBe(false);
    }
  });

  it("a MANAGER who is also a client contact keeps the staff surface — the bug this rule replaces", () => {
    // Real case: an internal PM added as a contact on their own client. The old rule was
    // `isClient && !isElevated`, and isElevated covers ONLY global platform_admin/group_executive —
    // so a manager matched it, navFor handed them portal-only navigation, and the redirect added here
    // would have locked them out of the app entirely. Any staff role must win.
    const both = me([
      { role: "manager", scopeType: "company", scopeId: "co-a" },
      { role: "client", scopeType: "company", scopeId: "co-a" },
    ]);
    expect(isClient(both)).toBe(true);
    expect(isElevated(both)).toBe(false);   // <- exactly why the old guard misfired
    expect(isStaff(both)).toBe(true);
    expect(isClientOnly(both)).toBe(false); // <- keeps the staff home
  });

  it("every staff tier that is also a client keeps the staff surface", () => {
    for (const role of ["member", "manager", "company_admin"] as const) {
      const u = me([
        { role, scopeType: "company", scopeId: "co-a" },
        { role: "client", scopeType: "company", scopeId: "co-a" },
      ]);
      expect(isClientOnly(u)).toBe(false);
    }
  });

  it("a client cannot reach staff capabilities", () => {
    // Nav and routing are cosmetic; this asserts the capability model agrees, so a client who types a
    // staff URL is not merely un-navigated but un-permitted. Cerbos + the portal BFF remain authority.
    for (const cap of ["admin.access", "people.directory", "pm.manage", "approvals.decide"] as const) {
      expect(can(client, cap, "co-a")).toBe(false);
    }
  });
});
