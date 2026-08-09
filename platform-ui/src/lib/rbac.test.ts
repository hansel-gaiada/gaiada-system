import { describe, it, expect } from "vitest";
import { can, isElevated, canManageIT, accessibleCompanies, canSwitchCompany, isManagerTier, isClient, isStaff, isClientOnly, CAPABILITIES } from "./rbac";
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

  // Gap 3 (2026-08 sweep): resource_integration_connection.yaml's own header names this the
  // "company.manage tier" and lists `company_admin`/`manager` together for it — `manager` was
  // missing the capability entirely, so `departments/[deptId]/connections`'s admin seat-mapping
  // button was silently hidden from every manager even though Cerbos would have allowed the write
  // (the dangerous under-grant direction this whole ticket is about). Widening it is a deliberate,
  // reported judgement call: `company.manage` also gates billing/company-edit/automation-retry
  // surfaces where Cerbos stays company_admin-only (resource_invoice.yaml, resource_company.yaml,
  // resource_automation_approval.yaml's `retry`) — a manager will now see those too and get a
  // clean 403, which is the SAFE direction (visible refusal, not a silent one).
  it("manager holds company.manage (Gap 3: resource_integration_connection.yaml grants manager the company.manage tier)", () => {
    expect(can(mgrA, "company.manage", "co-a")).toBe(true);
    expect(can(mgrA, "company.manage", "co-b")).toBe(false);
  });

  // Gap 1 (2026-08 owner audit): `can()` does NOT special-case platform_admin/group_executive —
  // it looks up ROLE_CAPS[role] like any other role — so "superadmin/owner can do anything" is
  // kept true only by ROLE_CAPS actually holding every capability that exists. Before the fix,
  // `Capability` was a hand-written type union and `ALL` was a SEPARATE hand-written array; a
  // capability added to the type and forgotten in `ALL` would silently and permanently deny it to
  // the owner's own account. `CAPABILITIES` is now the ONE list `Capability` and `ALL` both derive
  // from, so this loop can never go stale by construction — but pin it anyway so a future
  // refactor that reintroduces a second hand-maintained list (e.g. someone "simplifying" ALL back
  // into a literal array) fails here immediately instead of silently regressing.
  it("platform_admin and group_executive hold every known Capability", () => {
    const admin = me([{ role: "platform_admin", scopeType: "global", scopeId: null }]);
    const exec = me([{ role: "group_executive", scopeType: "global", scopeId: null }]);
    for (const cap of CAPABILITIES) {
      expect(can(admin, cap, "co-a"), `platform_admin missing ${cap}`).toBe(true);
      expect(can(exec, cap, "co-a"), `group_executive missing ${cap}`).toBe(true);
      // Global grants must also answer true with NO companyId (cross-company questions).
      expect(can(admin, cap), `platform_admin missing ${cap} (no companyId)`).toBe(true);
      expect(can(exec, cap), `group_executive missing ${cap} (no companyId)`).toBe(true);
    }
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

  // D14-08 — `approvals.retry` must be NARROWER than `approvals.decide`: the backend Cerbos
  // grant for the retry action is superadmin/company_admin/group_executive, deliberately
  // excluding manager (retry re-attempts a write that already failed once). A plain `can()` check
  // is what the approvals list uses to decide whether to render the Retry button at all, so this
  // pins the exact gap that matters for that decision.
  it("approvals.retry is granted to admin/exec/company_admin but NOT manager", () => {
    expect(can(admin, "approvals.retry", "co-a")).toBe(true);
    expect(can(exec, "approvals.retry", "co-a")).toBe(true);
    expect(can(coAdminA, "approvals.retry", "co-a")).toBe(true);
    expect(can(mgrA, "approvals.retry", "co-a")).toBe(false);
    expect(can(member, "approvals.retry", "co-a")).toBe(false);
    // manager still decides — retry is a strictly narrower cut of the same surface, not a
    // replacement for approvals.decide.
    expect(can(mgrA, "approvals.decide", "co-a")).toBe(true);
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

// Gap 2 — team_lead was entirely absent from Role/ROLE_CAPS despite being a real, granted Cerbos
// derived role. This pins the exact capability sweep documented in rbac.ts's `team_lead` entry.
// NOTE: a company-scoped fixture is used deliberately here (not the real team-scoped shape, which
// is covered separately above and below) so this describe block tests ONLY "what does ROLE_CAPS.
// team_lead contain", isolated from the scope-cascade question `scopeCovers — A4 fixes` already
// answers. Real team_lead grants are always team-scoped — see that describe block.
describe("team_lead caps (Gap 2 sweep) — mirrors what Cerbos actually grants team_lead", () => {
  const leadA = me([{ role: "team_lead", scopeType: "company", scopeId: "co-a" }]);

  it("has full PM parity with manager (resource_pm_task.yaml + resource_pm_project.yaml)", () => {
    expect(can(leadA, "pm.manage", "co-a")).toBe(true);
    expect(can(leadA, "pm.contribute", "co-a")).toBe(true);
  });

  it("has the dept-lead reporting + appraisal tier (resource_report_document.yaml + resource_appraisal.yaml)", () => {
    expect(can(leadA, "reports.person.view", "co-a")).toBe(true);
    expect(can(leadA, "reports.project.view", "co-a")).toBe(true);
    expect(can(leadA, "reports.department.view", "co-a")).toBe(true);
    expect(can(leadA, "appraisal.read", "co-a")).toBe(true);
    expect(can(leadA, "appraisal.score", "co-a")).toBe(true);
  });

  it("does NOT get checkin, approvals, hr, search, it.manage, or the exec-only reporting tier", () => {
    // Every one of these is a resource/action pair where team_lead is either absent from the
    // policy entirely (checkin, automation/agency approvals, scope_signoff, hr, search) or
    // explicitly excluded from the elevated rule (device create/update/delete is company_admin +
    // it_staff only) — see rbac.ts's team_lead comment for the file-by-file citation.
    for (const cap of [
      "checkin.read", "checkin.excuse",
      "approvals.decide", "approvals.retry",
      "hr.view", "hr.manage",
      "search.view", "search.manage",
      "it.manage",
      "admin.access", "org.edit", "rollups.view", "knowledge.review", "company.manage",
      "reports.company.view", "reports.period.seal", "reports.facts.admin", "reports.ops.poll",
      "appraisal.cycle.admin",
    ] as const) {
      expect(can(leadA, cap, "co-a"), cap).toBe(false);
    }
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

  // Gap 2's real-world case, not a stand-in role: derived_roles.yaml's `team_lead` derived role
  // matches ONLY `g.scopeType == "team"` — a team_lead grant is never company/global-scoped in
  // practice, unlike the synthetic "manager-with-team-scope" fixture above. Pin it directly so
  // adding the role never quietly starts blanket-covering a company from a team grant (that would
  // be the over-grant this ticket's A4 discipline exists to prevent, even though the framing
  // elsewhere treats over-grant as the "merely 403s" safe direction — scope cascade is the one
  // place this file already decided over-granting is not acceptable, and that has not changed).
  it("a real team_lead grant (scopeType: team) does not cover any company", () => {
    const teamLead = me([{ role: "team_lead", scopeType: "team", scopeId: "team-1" }]);
    for (const cap of ["pm.manage", "pm.contribute", "reports.person.view", "appraisal.score"] as const) {
      expect(can(teamLead, cap, "co-a")).toBe(false);
      expect(can(teamLead, cap, "co-b")).toBe(false);
    }
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

// Owner decision 2026-08-06: "anyone can pass the ball." The UI capability model MIRRORS Cerbos —
// resource_pm_task.yaml grants `update` to member/viewer/team_lead/manager/company_admin and
// reserves `manage` for leads/admins. Before this, the UI gated the ball on `pm.manage`, which made
// a hand-off leads-only and was STRICTER than the server: the client refused what the API allowed.
describe("pm.contribute mirrors Cerbos pm_task:update", () => {
  const memberA = me([{ role: "member", scopeType: "company", scopeId: "co-a" }]);
  const mgrA = me([{ role: "manager", scopeType: "company", scopeId: "co-a" }]);
  const adminA = me([{ role: "company_admin", scopeType: "company", scopeId: "co-a" }]);
  const superAdmin = me([{ role: "platform_admin", scopeType: "global", scopeId: null }]);

  it("a plain member may contribute (pass the ball) but may not manage", () => {
    expect(can(memberA, "pm.contribute", "co-a")).toBe(true);
    expect(can(memberA, "pm.manage", "co-a")).toBe(false);
  });

  it("still respects company scope — a member of A cannot contribute in B", () => {
    expect(can(memberA, "pm.contribute", "co-b")).toBe(false);
  });

  it("every role that can manage can also contribute — manage implies contribute", () => {
    for (const [label, who] of [["manager", mgrA], ["company_admin", adminA], ["platform_admin", superAdmin]] as const) {
      if (!can(who, "pm.manage", "co-a")) continue;
      expect(can(who, "pm.contribute", "co-a"), label).toBe(true);
    }
  });
});
