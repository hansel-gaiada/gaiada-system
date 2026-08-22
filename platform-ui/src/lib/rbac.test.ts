import { describe, it, expect } from "vitest";
import { can, isElevated, canManageIT, accessibleCompanies, canSwitchCompany, isManagerTier, isClient, isStaff, isClientOnly, CAPABILITIES } from "./rbac";
import { CAPABILITY_MAP } from "./rbac-capability-map";
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
  const exec = me([{ role: "platform_admin", scopeType: "global", scopeId: null }]);
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
  it("platform_admin holds every known Capability (IAM-15: group_executive, the other ALL-holder, is gone)", () => {
    const admin = me([{ role: "platform_admin", scopeType: "global", scopeId: null }]);
    const exec = me([{ role: "platform_admin", scopeType: "global", scopeId: null }]);
    for (const cap of CAPABILITIES) {
      expect(can(admin, cap, "co-a"), `platform_admin missing ${cap}`).toBe(true);
      expect(can(exec, cap, "co-a"), `platform_admin (exec fixture) missing ${cap}`).toBe(true);
      // Global grants must also answer true with NO companyId (cross-company questions).
      expect(can(admin, cap), `platform_admin missing ${cap} (no companyId)`).toBe(true);
      expect(can(exec, cap), `platform_admin (exec fixture) missing ${cap} (no companyId)`).toBe(true);
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
    // IAM-02a-FIX / DR-1 — manager no longer decides either. Before this fix the line below read
    // `.toBe(true)` with the comment "manager still decides"; that was the drift register's
    // finding #5 (11 live managers saw a dead Approve/Reject button on automation/agency/
    // pipeline-gate decisions — Cerbos never granted `manager` `decide` on any of the three backing
    // policies). See the `manager` entry's DR-1 comment in rbac.ts for the full evidence trail.
    expect(can(mgrA, "approvals.decide", "co-a")).toBe(false);
  });

  // IAM-02a-FIX / DR-1 (drift register finding #5) — pins the correction directly, independent of
  // the approvals.retry test above. VERIFIED against all three backing policies in rbac.ts's
  // `manager` comment: resource_automation_approval.yaml (decide/retry -> company_admin/
  // group_executive only), resource_agency_approval.yaml (approve -> company_admin/module_approver
  // only), resource_pipeline_gate.yaml (decide -> company_admin/group_executive only). Cerbos is
  // unchanged; this is the mirror catching up to what Cerbos always said.
  it("DR-1: manager no longer holds approvals.decide (Cerbos never granted it)", () => {
    expect(can(mgrA, "approvals.decide", "co-a")).toBe(false);
    // company_admin/platform_admin/group_executive are unaffected — they still decide everywhere.
    expect(can(coAdminA, "approvals.decide", "co-a")).toBe(true);
    expect(can(admin, "approvals.decide", "co-a")).toBe(true);
    expect(can(exec, "approvals.decide", "co-a")).toBe(true);
  });

  // IAM-02a-FIX / DR-2a (drift register finding #3) — `people.directory` for member/viewer.
  // resource_member.yaml's baseline tenant-directory read rule is the only Cerbos signal, and it
  // lists member/viewer on the same line as company_admin/manager/team_lead — the identical
  // reasoning this file already used to justify team_lead's grant (see rbac.ts's `member` comment).
  it("DR-2a: member and viewer hold people.directory", () => {
    const viewerA = me([{ role: "viewer", scopeType: "company", scopeId: "co-a" }]);
    expect(can(member, "people.directory", "co-a")).toBe(true);
    expect(can(viewerA, "people.directory", "co-a")).toBe(true);
    // still company-scoped like every other capability here — no cross-company over-grant.
    expect(can(member, "people.directory", "co-b")).toBe(false);
    expect(can(viewerA, "people.directory", "co-b")).toBe(false);
  });
});

// IAM-02a-FIX / DR-2b (drift register finding #1) — `agency_approver` was entirely absent from
// `Role`/`ROLE_CAPS`: a live-held role (1 real holder, IAM-02a-0) that resolved zero capabilities
// anywhere in the UI. Its verified Cerbos reach is exactly `agency_approval:approve` (via
// `module_approver`, module hardcoded "agency" at every `agency.controller.ts` call site) — nothing
// else, not even a baseline read on that same resource kind. See rbac.ts's `agency_approver`
// comment for the full derivation and why `approvals.decide` (not a copy of any other role) is the
// correct, non-invented mapping.
describe("agency_approver (DR-2b) — mirrors exactly what Cerbos grants, nothing borrowed", () => {
  const approver = me([{ role: "agency_approver", scopeType: "company", scopeId: "co-a" }]);

  it("holds approvals.decide (the only capability gating agency_approval:approve in this UI)", () => {
    expect(can(approver, "approvals.decide", "co-a")).toBe(true);
    expect(can(approver, "approvals.decide", "co-b")).toBe(false);
  });

  it("holds NOTHING else — not pm, not hr, not people.directory, not approvals.retry, not pipeline/webdev", () => {
    for (const cap of [
      "admin.access", "company.manage", "org.edit", "people.directory", "rollups.view",
      "pm.manage", "pm.contribute", "it.manage", "approvals.retry", "knowledge.review",
      "hr.view", "hr.manage", "search.view", "search.manage",
      "reports.person.view", "reports.company.view", "checkin.read", "appraisal.read",
      // IAM-02a-FIX-2 — agency_approver's entire verified Cerbos reach is agency_approval:approve
      // (via module_approver); it appears in NONE of the pipeline/scope_signoff/webdev policies.
      "pipeline.write", "pipeline.manage", "webdev.provision",
    ] as const) {
      expect(can(approver, cap, "co-a"), cap).toBe(false);
    }
  });

  it("was previously capability-invisible entirely — the exact bug shape this closes", () => {
    // Before DR-2b, `Role` had no `agency_approver` member and `ROLE_CAPS` had no entry for it, so
    // `can()`'s `ROLE_CAPS[g.role as Role]` resolved `undefined` and the `!!caps` guard made every
    // single capability question resolve false for this role — a live account with zero UI
    // capabilities, full stop. `Me.roles[].role` is typed as a plain `string` (not the `Role` union
    // — `platform.ts`), so nothing here would have failed to compile before the fix; the only thing
    // that changed is that `ROLE_CAPS["agency_approver"]` now exists. Re-asserted here (redundant
    // with the "holds approvals.decide" case above) so the regression this ticket closes is pinned
    // by name, not just by consequence.
    expect(can(approver, "approvals.decide", "co-a")).toBe(true);
  });
});

// IAM-02a-FIX-2 (2026-08-10) — repairs DR-1's own collateral damage: `approvals.decide` was ALSO the
// sole UI gate for 8 pipeline/webdev-provisioning server actions Cerbos genuinely grants `manager`
// (and, for a subset, `member`) — see rbac.ts's `pipeline.write`/`pipeline.manage`/`webdev.provision`
// comments on `CAPABILITIES` for the full per-policy citation. Pinned here so the exact role sets
// cannot silently drift again — a future edit that widens or narrows one of these three without
// touching this test will fail loudly.
describe("pipeline.write / pipeline.manage / webdev.provision (IAM-02a-FIX-2) — exact role sets", () => {
  const admin = me([{ role: "platform_admin", scopeType: "global", scopeId: null }]);
  const exec = me([{ role: "platform_admin", scopeType: "global", scopeId: null }]);
  const coAdminA = me([{ role: "company_admin", scopeType: "company", scopeId: "co-a" }]);
  const mgrA = me([{ role: "manager", scopeType: "company", scopeId: "co-a" }]);
  const memberA = me([{ role: "member", scopeType: "company", scopeId: "co-a" }]);
  const viewerA = me([{ role: "viewer", scopeType: "company", scopeId: "co-a" }]);
  // HIER-3: was `team_lead` (retired). `org_unit_lead` is the successor and, like `team_lead`
  // before it, holds none of these three pipeline/webdev capabilities — its whole grant is
  // `reports.department.view` + `appraisal.read` (see rbac.ts's `org_unit_lead` entry). Company-
  // scoped here (synthetic, not the real org_unit shape) to isolate "what does ROLE_CAPS contain"
  // from the scope-cascade question, same as every other fixture in this describe block.
  const orgUnitLeadA = me([{ role: "org_unit_lead", scopeType: "company", scopeId: "co-a" }]);
  const approver = me([{ role: "agency_approver", scopeType: "company", scopeId: "co-a" }]);

  // resource_pipeline_run.yaml (create/update), resource_pipeline_stage.yaml (create),
  // resource_pipeline_gate.yaml (create) — all three: company_admin, manager, member.
  it("pipeline.write: company_admin, manager, member (platform_admin/group_executive via ALL) — NOT viewer, org_unit_lead, agency_approver", () => {
    for (const who of [admin, exec, coAdminA, mgrA, memberA]) {
      expect(can(who, "pipeline.write", "co-a")).toBe(true);
    }
    for (const who of [viewerA, orgUnitLeadA, approver]) {
      expect(can(who, "pipeline.write", "co-a")).toBe(false);
    }
    // company-scoped, not global, for the non-elevated roles.
    expect(can(mgrA, "pipeline.write", "co-b")).toBe(false);
    expect(can(memberA, "pipeline.write", "co-b")).toBe(false);
  });

  // resource_pipeline_stage.yaml (update) and resource_scope_signoff.yaml (create) both explicitly
  // exclude member (and, for scope_signoff, team_lead/org_unit_lead) — company_admin, manager only
  // (+ ALL roles).
  it("pipeline.manage: company_admin, manager — member and org_unit_lead explicitly excluded", () => {
    for (const who of [admin, exec, coAdminA, mgrA]) {
      expect(can(who, "pipeline.manage", "co-a")).toBe(true);
    }
    for (const who of [memberA, viewerA, orgUnitLeadA, approver]) {
      expect(can(who, "pipeline.manage", "co-a")).toBe(false);
    }
    expect(can(mgrA, "pipeline.manage", "co-b")).toBe(false);
  });

  // resource_webdev_provisioned_site.yaml's in-tenant tier: company_admin, manager only ("never a
  // plain-member action", the policy's own header).
  it("webdev.provision: company_admin, manager — never member", () => {
    for (const who of [admin, exec, coAdminA, mgrA]) {
      expect(can(who, "webdev.provision", "co-a")).toBe(true);
    }
    for (const who of [memberA, viewerA, orgUnitLeadA, approver]) {
      expect(can(who, "webdev.provision", "co-a")).toBe(false);
    }
    expect(can(mgrA, "webdev.provision", "co-b")).toBe(false);
  });

  // DR-1 must still stand: fixing the collateral damage never restores approvals.decide to manager.
  it("DR-1 still stands — manager holds the new capabilities but NOT approvals.decide", () => {
    expect(can(mgrA, "pipeline.write", "co-a")).toBe(true);
    expect(can(mgrA, "pipeline.manage", "co-a")).toBe(true);
    expect(can(mgrA, "webdev.provision", "co-a")).toBe(true);
    expect(can(mgrA, "approvals.decide", "co-a")).toBe(false);
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

// HIER-3 (2026-08-11) — `team_lead` is RETIRED (zero live grants; ~23 policies named it but only
// two handlers ever wired `teamId` into authorization). The "Gap 2 sweep" describe block that used
// to pin its capability set is removed with the role. Its successor, `org_unit_lead` (HIER-2), is
// covered by its own describe block below (`org_unit_lead caps (HIER-2)`), including the exact
// exclusion sweep this block used to run for `team_lead`.
// NOTE: a company-scoped fixture is used deliberately here (not the real org_unit-scoped shape,
// which is covered separately in `scopeCovers — A4 fixes` below) so this describe block tests
// ONLY "what does ROLE_CAPS.org_unit_lead contain", isolated from the scope-cascade question
// `scopeCovers` already answers — same discipline the retired team_lead sweep used.
describe("org_unit_lead caps (HIER-2) — exactly its two bundled permissions, no more", () => {
  const leadA = me([{ role: "org_unit_lead", scopeType: "company", scopeId: "co-a" }]);

  it("has the dept-lead reporting + appraisal tier it was actually wired for", () => {
    expect(can(leadA, "reports.department.view", "co-a")).toBe(true);
    expect(can(leadA, "appraisal.read", "co-a")).toBe(true);
  });

  it("does NOT get PM, checkin, approvals, hr, search, it.manage, person/project reports, or the exec-only reporting tier", () => {
    // HIER-2 deliberately left read_person/read_project unwired (no handler resolves a unit
    // ancestor list there) and appraisal.score/PM/etc. were never part of org_unit_lead's bundle —
    // see rbac.ts's `org_unit_lead` comment and the HIER-2 report (§5) for the full citation.
    for (const cap of [
      "pm.manage", "pm.contribute",
      "reports.person.view", "reports.project.view",
      "appraisal.score",
      "checkin.read", "checkin.excuse",
      "approvals.decide", "approvals.retry",
      "hr.view", "hr.manage",
      "search.view", "search.manage",
      "it.manage", "people.directory",
      "admin.access", "org.edit", "rollups.view", "knowledge.review", "company.manage",
      "reports.company.view", "reports.period.seal", "reports.facts.admin", "reports.ops.poll",
      "appraisal.cycle.admin",
      "pipeline.write", "pipeline.manage", "webdev.provision",
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

  it("an org_unit-scoped grant does not blanket-cover the whole company", () => {
    const unitScoped = me([{ role: "manager", scopeType: "org_unit", scopeId: "d-web" }]);
    expect(can(unitScoped, "pm.manage", "co-a")).toBe(false);
    expect(can(unitScoped, "pm.manage", "co-b")).toBe(false);
  });

  // HIER-2's real-world case, not a stand-in role: derived_roles.yaml's `org_unit_lead` derived
  // role matches ONLY `g.scopeType == "org_unit"` — an org_unit_lead grant is never company/global-
  // scoped in practice, unlike the synthetic "manager-with-org_unit-scope" fixture above. Pin it
  // directly so the role never quietly starts blanket-covering a company from a unit grant (that
  // would be the over-grant this ticket's A4 discipline exists to prevent, even though the framing
  // elsewhere treats over-grant as the "merely 403s" safe direction — scope cascade is the one
  // place this file already decided over-granting is not acceptable, and that has not changed).
  // This is exactly the shape `team_lead` used to occupy here before HIER-3 retired it.
  it("a real org_unit_lead grant (scopeType: org_unit) does not cover any company", () => {
    const orgUnitLead = me([{ role: "org_unit_lead", scopeType: "org_unit", scopeId: "d-web" }]);
    for (const cap of ["reports.department.view", "appraisal.read"] as const) {
      expect(can(orgUnitLead, cap, "co-a")).toBe(false);
      expect(can(orgUnitLead, cap, "co-b")).toBe(false);
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
    const exec = me([{ role: "platform_admin", scopeType: "global", scopeId: null }]);
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
  it("platform_admin/company_admin/manager/it_admin/it_manager are manager-tier (IAM-15 dropped group_executive)", () => {
    for (const role of ["platform_admin", "company_admin", "manager", "it_admin", "it_manager"] as const) {
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
    for (const role of ["member", "manager", "company_admin", "platform_admin"] as const) {
      const u = me([{ role, scopeType: role === "platform_admin" ? "global" : "company", scopeId: role === "platform_admin" ? null : "co-a" }]);
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

// IAM-DR67 / DR-6 (drift register finding #7, owner-decided 2026-08-10) — `it_admin` no longer
// holds `company.manage`. Verified against resource_device.yaml (it_admin's entire Cerbos reach:
// it.device.create/update/delete) vs. company.manage's ten-permission ANY set (integration
// connections, company update, billing, automation retry) — zero overlap. Cerbos is unchanged;
// this pins the mirror-only correction so a future edit cannot silently reintroduce the over-claim.
describe("IAM-DR67 / DR-6 — it_admin no longer holds company.manage", () => {
  const itAdminA = me([{ role: "it_admin", scopeType: "company", scopeId: "co-a" }]);

  it("it_admin keeps it.manage but not company.manage, in their own company", () => {
    expect(can(itAdminA, "it.manage", "co-a")).toBe(true);
    expect(can(itAdminA, "company.manage", "co-a")).toBe(false);
  });

  it("it_manager and it (never had company.manage) are unaffected", () => {
    const itManagerA = me([{ role: "it_manager", scopeType: "company", scopeId: "co-a" }]);
    const itA = me([{ role: "it", scopeType: "company", scopeId: "co-a" }]);
    expect(can(itManagerA, "it.manage", "co-a")).toBe(true);
    expect(can(itManagerA, "company.manage", "co-a")).toBe(false);
    expect(can(itA, "it.manage", "co-a")).toBe(true);
    expect(can(itA, "company.manage", "co-a")).toBe(false);
  });
});

// IAM-DR67 / DR-7 (owner-decided 2026-08-10) — `people.directory` granted to the three
// `module_staff`-tier roles (resource_member.yaml's unconditioned module_staff read rule), and
// deliberately NOT to their `_manager` siblings, which that rule does not name.
describe("IAM-DR67 / DR-7 — people.directory for hr_staff/search_staff/reports_staff only", () => {
  it("hr_staff/search_staff/reports_staff hold people.directory, scoped to their company", () => {
    const hrStaffA = me([{ role: "hr_staff", scopeType: "company", scopeId: "co-a" }]);
    const searchStaffA = me([{ role: "search_staff", scopeType: "company", scopeId: "co-a" }]);
    const reportsStaffA = me([{ role: "reports_staff", scopeType: "company", scopeId: "co-a" }]);
    for (const who of [hrStaffA, searchStaffA, reportsStaffA]) {
      expect(can(who, "people.directory", "co-a")).toBe(true);
      expect(can(who, "people.directory", "co-b")).toBe(false);
    }
  });

  it("hr_manager/search_manager/reports_manager do NOT gain people.directory — Cerbos names only module_staff", () => {
    const hrManagerA = me([{ role: "hr_manager", scopeType: "company", scopeId: "co-a" }]);
    const searchManagerA = me([{ role: "search_manager", scopeType: "company", scopeId: "co-a" }]);
    const reportsManagerA = me([{ role: "reports_manager", scopeType: "company", scopeId: "co-a" }]);
    for (const who of [hrManagerA, searchManagerA, reportsManagerA]) {
      expect(can(who, "people.directory", "co-a")).toBe(false);
    }
  });
});

// IAM-DR67 MAP DEFECT — `hr.manage`'s permission set no longer includes `hr.case.cancel`.
// resource_hr_case.yaml grants `cancel` only to `group_executive` (wholesale) and `member`-self
// (subjectUserId == principal.id) — never to `module_manager`/`company_admin` under any condition.
// Including it made `hr.manage` unsatisfiable under `all` semantics for company_admin/hr_manager
// (IAM-05b-3 report findings #6/#7). Pinned here directly against CAPABILITY_MAP (not the parity
// guard, which this ticket must not edit) so a future re-add of hr.case.cancel to this set fails
// loudly rather than silently reproducing the two false over-claims.
describe("IAM-DR67 map defect — hr.manage excludes hr.case.cancel", () => {
  it("hr.manage's permission set has no hr.case.cancel member", () => {
    expect(CAPABILITY_MAP["hr.manage"].permissions).not.toContain("hr.case.cancel");
  });

  it("hr.manage still requires every genuine hr_case/hr_record write action", () => {
    expect(CAPABILITY_MAP["hr.manage"].permissions).toEqual(
      expect.arrayContaining([
        "hr.case.create", "hr.case.update", "hr.case.delete",
        "hr.record.create", "hr.record.update", "hr.record.delete",
      ]),
    );
  });
});
