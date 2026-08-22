// IAM-04b — dual-match pilot verification (pm_task + hr_case). Needs a running Cerbos loaded with
// the CURRENT policy files — set CERBOS_URL (skips otherwise), and remember the staleness trap:
// this suite proves nothing if the container serving CERBOS_URL predates the policy edit (see
// memory `cerbos-new-policy-needs-restart` / this repo's IAM-04 ticket brief). `docker inspect
// gaiada-test-cerbos --format '{{.State.StartedAt}}'` must postdate this file's own edit.
//
// WHAT THIS FILE IS FOR, SPECIFICALLY: the ticket's verification bar warns "a dual-match where only
// the role arm ever matches would pass every test and prove nothing." Every test below therefore
// grants the permission WITHOUT the corresponding role (`roles: []` on the principal) so the ROLE
// ARM CANNOT POSSIBLY BE THE ONE FIRING — if any of these ever regress to a DENY, the permission arm
// broke; if any unexpectedly ALLOW something they shouldn't, the permission arm over-granted. A
// second block asserts the ROLE arm still decides identically to its pre-IAM-04b behavior (i.e. the
// additions are additive, not replacements) by using ONLY named roles with EMPTY `perms`.
import { describe, it, expect } from "vitest";
import { check, type Resource } from "./cerbos";
import type { Principal, RoleGrant, PermissionGrant } from "./principal";

const live = process.env.CERBOS_URL && process.env.CERBOS_URL.length > 0;
const T1 = "aaaaaaaa-0000-0000-0000-000000000001";
const T2 = "aaaaaaaa-0000-0000-0000-000000000002";

// MON-00c: `rootCompanies` defaults to `companies` because in a single-root fixture world the
// principal's root subtree IS the companies under test. Pass it explicitly for a principal with no
// memberships (a global group_executive, or a global permission holder) — an empty set denies, which
// is the boundary working rather than a broken fixture.
function principal(
  roles: RoleGrant[],
  perms: PermissionGrant[],
  companies: string[] = [T1],
  assurance: Principal["assurance"] = "high",
  rootCompanies: string[] = companies,
): Principal {
  return { userId: "u1", assurance, companies, roles, perms, rootCompanies, sessionVersion: 1 };
}

const pmTask: Resource = { kind: "pm_task", id: "task-1", tenantId: T1 };
const hrCase = (subjectUserId?: string): Resource => ({
  kind: "hr_case",
  id: "case-1",
  tenantId: T1,
  module: "hr",
  ...(subjectUserId ? { subjectUserId } : {}),
});
const allow = async (p: Principal, r: Resource, a: string) => (await check(p, r, a)).allow;

describe.skipIf(!live)("IAM-04b dual-match pilot: pm_task", () => {
  it("PERMISSION ARM ALONE (no role grant at all) allows pm.task.read", async () => {
    const p = principal([], [{ key: "pm.task.read", scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, pmTask, "read")).toBe(true);
  });

  it("PERMISSION ARM ALONE does not bleed into a sibling action it wasn't granted", async () => {
    const p = principal([], [{ key: "pm.task.read", scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, pmTask, "update")).toBe(false);
    expect(await allow(p, pmTask, "create")).toBe(false);
    expect(await allow(p, pmTask, "delete")).toBe(false);
    expect(await allow(p, pmTask, "manage")).toBe(false);
  });

  it("PERMISSION ARM ALONE covers every one of the 5 pm.task actions independently", async () => {
    for (const action of ["read", "update", "create", "delete", "manage"]) {
      const p = principal([], [{ key: `pm.task.${action}`, scopeType: "company", scopeId: T1 }]);
      expect(await allow(p, pmTask, action), `pm.task.${action} via permission alone`).toBe(true);
    }
  });

  it("PERMISSION ARM respects the company-scope cascade: does NOT leak cross-tenant", async () => {
    const p = principal([], [{ key: "pm.task.read", scopeType: "company", scopeId: T1 }], [T1, T2]);
    expect(await allow(p, { ...pmTask, tenantId: T2 }, "read")).toBe(false);
  });

  it("PERMISSION ARM: a global-scope grant covers every tenant the principal is authorized for (inTenant is a SEPARATE, unchanged gate — same as the role arm's own global-scope grants, e.g. company_admin@global still needs inTenant)", async () => {
    const p = principal([], [{ key: "pm.task.read", scopeType: "global", scopeId: null }], [T1, T2]);
    expect(await allow(p, pmTask, "read")).toBe(true);
    expect(await allow(p, { ...pmTask, tenantId: T2 }, "read")).toBe(true);
  });

  it("PERMISSION ARM: low assurance still gets nothing (D4 ceiling honored, not bypassed)", async () => {
    const p = principal([], [{ key: "pm.task.read", scopeType: "company", scopeId: T1 }], [T1], "low");
    expect(await allow(p, pmTask, "read")).toBe(false);
  });

  it("ROLE ARM UNCHANGED (empty perms): manager/member/viewer/company_admin decisions match cerbos.test.ts's pre-existing pm_task-equivalent behavior", async () => {
    const manager = principal([{ role: "manager", scopeType: "company", scopeId: T1 }], []);
    expect(await allow(manager, pmTask, "read")).toBe(true);
    expect(await allow(manager, pmTask, "update")).toBe(true);
    expect(await allow(manager, pmTask, "create")).toBe(true);
    expect(await allow(manager, pmTask, "delete")).toBe(true);

    const viewer = principal([{ role: "viewer", scopeType: "company", scopeId: T1 }], []);
    expect(await allow(viewer, pmTask, "read")).toBe(true);
    expect(await allow(viewer, pmTask, "create")).toBe(false);

    const noRole = principal([], []);
    expect(await allow(noRole, pmTask, "read")).toBe(false);
  });

  // HIER-3 (2026-08-11): the "REAL FINDING pin" that used to sit here proved `team_lead`'s
  // role_permissions bundle claimed pm.task.* reach while the role was PROVABLY unreachable on
  // pm_task at any scope (pm.controller.ts never set resource.attr.teamId). `team_lead` is now
  // retired entirely — the role, its Cerbos derived role, its bundle rows, and the exclusion
  // clause the permission arm carried for it are all gone (docs/superpowers/plans/
  // 2026-08-11-hier-3-report.md). There is no longer a real-world instance of this specific
  // dual-match hazard to pin: granting a role name Cerbos no longer recognizes at all is a
  // different (much weaker) claim than the original finding, so the test is removed rather than
  // kept as a vacuously-passing shell.

  it("BOTH ARMS TOGETHER still yield exactly one decision, not a conflicting pair (role grants read, permission independently grants update — both ALLOW, neither denies the other)", async () => {
    const p = principal(
      [{ role: "viewer", scopeType: "company", scopeId: T1 }],
      [{ key: "pm.task.update", scopeType: "company", scopeId: T1 }],
    );
    expect(await allow(p, pmTask, "read")).toBe(true); // via role arm (viewer)
    expect(await allow(p, pmTask, "update")).toBe(true); // via permission arm (viewer alone couldn't update)
    expect(await allow(p, pmTask, "delete")).toBe(false); // neither arm grants this
  });
});

describe.skipIf(!live)("IAM-04b dual-match pilot: hr_case (module-role composition)", () => {
  it("PERMISSION ARM ALONE allows the unconditional tier: update/delete/export", async () => {
    for (const action of ["update", "delete"]) {
      const p = principal([], [{ key: `hr.case.${action}`, scopeType: "company", scopeId: T1 }]);
      expect(await allow(p, hrCase(), action), `hr.case.${action} via permission alone`).toBe(true);
    }
    const exporter = principal([], [{ key: "hr.case.export", scopeType: "company", scopeId: T1 }]);
    expect(await allow(exporter, hrCase(), "export")).toBe(true);
  });

  it("PERMISSION ARM: export still requires HIGH assurance (assurance ceiling not bypassed)", async () => {
    const p = principal([], [{ key: "hr.case.export", scopeType: "company", scopeId: T1 }], [T1], "linked");
    expect(await allow(p, hrCase(), "export")).toBe(false);
  });

  it("PERMISSION ARM ALONE does not bleed update/delete/export into each other", async () => {
    const p = principal([], [{ key: "hr.case.update", scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, hrCase(), "delete")).toBe(false);
    expect(await allow(p, hrCase(), "export")).toBe(false);
  });

  it("PERMISSION ARM ALONE: self-scoped read/create/cancel allow on the caller's OWN case", async () => {
    const p = principal([], [{ key: "hr.case.read", scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, hrCase("u1"), "read")).toBe(true);
    const c = principal([], [{ key: "hr.case.create", scopeType: "company", scopeId: T1 }]);
    expect(await allow(c, hrCase("u1"), "create")).toBe(true);
    const x = principal([], [{ key: "hr.case.cancel", scopeType: "company", scopeId: T1 }]);
    expect(await allow(x, hrCase("u1"), "cancel")).toBe(true);
  });

  it("PERMISSION ARM: the self-scoped tier does NOT widen into unconditional read/create — this is the exact widening the ticket's own analysis flagged (member's self-only bundle entry vs. company_admin's unconditional one, indistinguishable in the flat `perms` array) and it must stay closed", async () => {
    const p = principal([], [{ key: "hr.case.read", scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, hrCase("someone-else"), "read")).toBe(false);
    const c = principal([], [{ key: "hr.case.create", scopeType: "company", scopeId: T1 }]);
    expect(await allow(c, hrCase("someone-else"), "create")).toBe(false);
    // no subjectUserId at all on the resource -> fails closed too (has() guard)
    expect(await allow(p, hrCase(), "read")).toBe(false);
  });

  it("PERMISSION ARM respects the company-scope cascade: does NOT leak cross-tenant", async () => {
    const p = principal([], [{ key: "hr.case.update", scopeType: "company", scopeId: T1 }], [T1, T2]);
    expect(await allow(p, { ...hrCase(), tenantId: T2 }, "update")).toBe(false);
  });

  it("ROLE ARM UNCHANGED: hr_staff/hr_manager/company_admin/group_executive/member-self decisions match the pre-existing behavior (mirrors resource_hr_case.yaml's own rule set, empty perms)", async () => {
    const hrStaff = principal([{ role: "hr_staff", scopeType: "company", scopeId: T1 }], []);
    expect(await allow(hrStaff, hrCase(), "read")).toBe(true);
    expect(await allow(hrStaff, hrCase(), "create")).toBe(true);
    expect(await allow(hrStaff, hrCase(), "delete")).toBe(false); // staff, not manager

    const hrManager = principal([{ role: "hr_manager", scopeType: "company", scopeId: T1 }], []);
    expect(await allow(hrManager, hrCase(), "delete")).toBe(true);
    const hrManagerLinked = principal([{ role: "hr_manager", scopeType: "company", scopeId: T1 }], [], [T1], "linked");
    expect(await allow(hrManagerLinked, hrCase(), "export")).toBe(false); // assurance not high

    // IAM-15: resource_hr_case.yaml's group_executive rule is DELETED, so the exec's cross-company
    // read is now refused. Kept as a DENY rather than removed — this file's claim is "the role arm's
    // decisions are unchanged by the permission arm", and the exec is the case where role-arm and
    // perm-arm reach differed most, so it is still the most informative principal to check.
    const groupExec = principal([{ role: "group_executive", scopeType: "global", scopeId: null }], [], [], "high", [T1, T2]);
    expect(await allow(groupExec, { ...hrCase(), tenantId: T2 }, "read")).toBe(false);

    const member = principal([{ role: "member", scopeType: "company", scopeId: T1 }], []);
    expect(await allow(member, hrCase("u1"), "read")).toBe(true); // self
    expect(await allow(member, hrCase("someone-else"), "read")).toBe(false); // not self
  });
});

describe.skipIf(!live)("IAM-04-ROLLOUT-B12: dual-match isolation across batches 1+2 (26 kinds, 17 SAFE + 9 confirm-reliable module-mechanism)", () => {
  // Every case grants the permission WITHOUT any role at all (roles: []) -- the role arm cannot
  // possibly be what answers. Each case also probes (a) cross-tenant non-leak (same perms, resource
  // moved to T2) and (b) sibling-action non-bleed (a second action on the same kind that this exact
  // permission key must NOT unlock), mirroring the isolation shape this file's pm_task/hr_case
  // blocks already established.

  it("agency_brief.read: PERMISSION ARM ALONE (roles: []) allows; no cross-tenant leak; no sibling-action bleed into .create", async () => {
    const resource: Resource = { kind: "agency_brief", id: "x1", tenantId: T1 };
    const p = principal([], [{ key: "agency.brief.read", scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, resource, "read")).toBe(true);
    expect(await allow(p, { ...resource, tenantId: T2 }, "read")).toBe(false);
    expect(await allow(p, resource, "create")).toBe(false);
  });

  it("agency_campaign.read: PERMISSION ARM ALONE (roles: []) allows; no cross-tenant leak; no sibling-action bleed into .update", async () => {
    const resource: Resource = { kind: "agency_campaign", id: "x1", tenantId: T1 };
    const p = principal([], [{ key: "agency.campaign.read", scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, resource, "read")).toBe(true);
    expect(await allow(p, { ...resource, tenantId: T2 }, "read")).toBe(false);
    expect(await allow(p, resource, "update")).toBe(false);
  });

  it("agency_creative_asset.read: PERMISSION ARM ALONE (roles: []) allows; no cross-tenant leak; no sibling-action bleed into .delete", async () => {
    const resource: Resource = { kind: "agency_creative_asset", id: "x1", tenantId: T1 };
    const p = principal([], [{ key: "agency.creative_asset.read", scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, resource, "read")).toBe(true);
    expect(await allow(p, { ...resource, tenantId: T2 }, "read")).toBe(false);
    expect(await allow(p, resource, "delete")).toBe(false);
  });

  it("chat_group.pin: PERMISSION ARM ALONE (roles: []) allows; no cross-tenant leak; no sibling-action bleed into .remove_member", async () => {
    const resource: Resource = { kind: "chat_group", id: "x1", tenantId: T1 };
    const p = principal([], [{ key: "core.chat_group.pin", scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, resource, "pin")).toBe(true);
    expect(await allow(p, { ...resource, tenantId: T2 }, "pin")).toBe(false);
    expect(await allow(p, resource, "remove_member")).toBe(false);
  });

  it("company.read: PERMISSION ARM ALONE (roles: []) allows; no cross-tenant leak; no sibling-action bleed into .update", async () => {
    const resource: Resource = { kind: "company", id: "x1", tenantId: T1 };
    const p = principal([], [{ key: "core.company.read", scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, resource, "read")).toBe(true);
    expect(await allow(p, { ...resource, tenantId: T2 }, "read")).toBe(false);
    expect(await allow(p, resource, "update")).toBe(false);
  });

  it("compliance_gate.read: PERMISSION ARM ALONE (roles: []) allows; no cross-tenant leak; no sibling-action bleed into .update", async () => {
    const resource: Resource = { kind: "compliance_gate", id: "x1", tenantId: T1 };
    const p = principal([], [{ key: "core.compliance_gate.read", scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, resource, "read")).toBe(true);
    expect(await allow(p, { ...resource, tenantId: T2 }, "read")).toBe(false);
    expect(await allow(p, resource, "update")).toBe(false);
  });

  it("contract.read: PERMISSION ARM ALONE (roles: []) allows; no cross-tenant leak; no sibling-action bleed into .send", async () => {
    const resource: Resource = { kind: "contract", id: "x1", tenantId: T1 };
    const p = principal([], [{ key: "core.contract.read", scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, resource, "read")).toBe(true);
    expect(await allow(p, { ...resource, tenantId: T2 }, "read")).toBe(false);
    expect(await allow(p, resource, "send")).toBe(false);
  });

  it("identity_link.read: PERMISSION ARM ALONE (roles: []) allows; no cross-tenant leak; no sibling-action bleed into .delete", async () => {
    const resource: Resource = { kind: "identity_link", id: "x1", tenantId: T1 };
    const p = principal([], [{ key: "core.identity_link.read", scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, resource, "read")).toBe(true);
    expect(await allow(p, { ...resource, tenantId: T2 }, "read")).toBe(false);
    expect(await allow(p, resource, "delete")).toBe(false);
  });

  it("invoice.read: PERMISSION ARM ALONE (roles: []) allows; no cross-tenant leak; no sibling-action bleed into .delete", async () => {
    const resource: Resource = { kind: "invoice", id: "x1", tenantId: T1 };
    const p = principal([], [{ key: "billing.invoice.read", scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, resource, "read")).toBe(true);
    expect(await allow(p, { ...resource, tenantId: T2 }, "read")).toBe(false);
    expect(await allow(p, resource, "delete")).toBe(false);
  });

  it("knowledge_source.read: PERMISSION ARM ALONE (roles: []) allows; no cross-tenant leak; no sibling-action bleed into .update", async () => {
    const resource: Resource = { kind: "knowledge_source", id: "x1", tenantId: T1 };
    const p = principal([], [{ key: "knowledge.source.read", scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, resource, "read")).toBe(true);
    expect(await allow(p, { ...resource, tenantId: T2 }, "read")).toBe(false);
    expect(await allow(p, resource, "update")).toBe(false);
  });

  it("report_admin.recompute: PERMISSION ARM ALONE (roles: []) allows; no cross-tenant leak", async () => {
    const resource: Resource = { kind: "report_admin", id: "x1", tenantId: T1 };
    const p = principal([], [{ key: "reports.admin.recompute", scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, resource, "recompute")).toBe(true);
    expect(await allow(p, { ...resource, tenantId: T2 }, "recompute")).toBe(false);
  });

  it("rollup.read: PERMISSION ARM ALONE (roles: []) allows; no cross-tenant leak", async () => {
    const resource: Resource = { kind: "rollup", id: "x1", tenantId: T1 };
    const p = principal([], [{ key: "core.rollup.read", scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, resource, "read")).toBe(true);
    expect(await allow(p, { ...resource, tenantId: T2 }, "read")).toBe(false);
  });

  it("rollup_recompute.create: PERMISSION ARM ALONE (roles: []) allows; no cross-tenant leak", async () => {
    const resource: Resource = { kind: "rollup_recompute", id: "x1", tenantId: T1 };
    const p = principal([], [{ key: "core.rollup_recompute.create", scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, resource, "create")).toBe(true);
    expect(await allow(p, { ...resource, tenantId: T2 }, "create")).toBe(false);
  });

  it("service_assignment.read: PERMISSION ARM ALONE (roles: []) now DENIES — perm_service_assignment_read was REMOVED (IAM-04-REG2, 2026-08-12): the role arm's only 'read' path for module-tier roles is gated on resource.attr.module, a CALLER-SUPPLIED value for this kind (service-assignments.controller.ts:186/601/668), not a kind-constant — a flat mirror could not re-check it and over-granted every module-tier role cross-module. Only company_admin's own unconditional rule (untested here directly, see the ROLE ARM UNCHANGED coverage elsewhere) still grants this action.", async () => {
    const resource: Resource = { kind: "service_assignment", id: "x1", tenantId: T1 };
    const p = principal([], [{ key: "core.service_assignment.read", scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, resource, "read")).toBe(false);
    expect(await allow(p, { ...resource, tenantId: T2 }, "read")).toBe(false);
    expect(await allow(p, resource, "propose")).toBe(false);
  });

  it("user.read: PERMISSION ARM ALONE (roles: []) allows; no cross-tenant leak; no sibling-action bleed into .delete", async () => {
    const resource: Resource = { kind: "user", id: "x1", tenantId: T1 };
    const p = principal([], [{ key: "core.user.read", scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, resource, "read")).toBe(true);
    expect(await allow(p, { ...resource, tenantId: T2 }, "read")).toBe(false);
    expect(await allow(p, resource, "delete")).toBe(false);
  });

  it("webdev_change_request.read: PERMISSION ARM ALONE (roles: []) allows; no cross-tenant leak; no sibling-action bleed into .triage", async () => {
    const resource: Resource = { kind: "webdev_change_request", id: "x1", tenantId: T1, module: "webdev" };
    const p = principal([], [{ key: "webdev.change_request.read", scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, resource, "read")).toBe(true);
    expect(await allow(p, { ...resource, tenantId: T2 }, "read")).toBe(false);
    expect(await allow(p, resource, "triage")).toBe(false);
  });

  it("webdev_provisioned_site.read: PERMISSION ARM ALONE (roles: []) allows; no cross-tenant leak; no sibling-action bleed into .provision", async () => {
    const resource: Resource = { kind: "webdev_provisioned_site", id: "x1", tenantId: T1, module: "webdev" };
    const p = principal([], [{ key: "webdev.provisioned_site.read", scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, resource, "read")).toBe(true);
    expect(await allow(p, { ...resource, tenantId: T2 }, "read")).toBe(false);
    expect(await allow(p, resource, "provision")).toBe(false);
  });

  it("hr_record.read: PERMISSION ARM ALONE (roles: []) allows; no cross-tenant leak; no sibling-action bleed into .delete", async () => {
    const resource: Resource = { kind: "hr_record", id: "x1", tenantId: T1, module: "hr" };
    const p = principal([], [{ key: "hr.record.read", scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, resource, "read")).toBe(true);
    expect(await allow(p, { ...resource, tenantId: T2 }, "read")).toBe(false);
    expect(await allow(p, resource, "delete")).toBe(false);
  });

  // IAM-04-REG3 (2026-08-13): perm_hr_record_export was REMOVED by IAM-04-REG2 (wired at
  // `notLow`, which let a "linked"-assurance holder export through the flat arm while the role
  // arm's own D4 tier denied them) and RESTORED here at the CORRECT tier — mirroring
  // hr_case.export's own "PERMISSION ARM: export still requires HIGH assurance" test above
  // (lines ~124-127). Both tiers are asserted so this can never silently regress back to REG2's
  // mistake: a `notLow`-only mirror would make the "linked" case below wrongly ALLOW.
  it("hr_record.export: PERMISSION ARM ALONE (roles: []) allows at HIGH assurance — the restored, correctly-tiered perm_hr_record_export mirror", async () => {
    const resource: Resource = { kind: "hr_record", id: "x1", tenantId: T1, module: "hr" };
    const p = principal([], [{ key: "hr.record.export", scopeType: "company", scopeId: T1 }], [T1], "high");
    expect(await allow(p, resource, "export")).toBe(true);
  });

  it("hr_record.export: PERMISSION ARM ALONE at LINKED assurance DENIES — the exact hole IAM-04-REG2 closed by removal; must stay denied now that the mirror is restored at the high-assurance tier", async () => {
    const resource: Resource = { kind: "hr_record", id: "x1", tenantId: T1, module: "hr" };
    const p = principal([], [{ key: "hr.record.export", scopeType: "company", scopeId: T1 }], [T1], "linked");
    expect(await allow(p, resource, "export")).toBe(false);
  });

  it("agency_approval.approve: PERMISSION ARM ALONE (roles: []) allows; no cross-tenant leak; no sibling-action bleed into .create", async () => {
    const resource: Resource = { kind: "agency_approval", id: "x1", tenantId: T1, module: "agency" };
    const p = principal([], [{ key: "agency.approval.approve", scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, resource, "approve")).toBe(true);
    expect(await allow(p, { ...resource, tenantId: T2 }, "approve")).toBe(false);
    expect(await allow(p, resource, "create")).toBe(false);
  });

  it("resource_search_audit.read: PERMISSION ARM ALONE (roles: []) allows; no cross-tenant leak; no sibling-action bleed into .delete", async () => {
    const resource: Resource = { kind: "resource_search_audit", id: "x1", tenantId: T1, module: "search" };
    const p = principal([], [{ key: "search.audit.read", scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, resource, "read")).toBe(true);
    expect(await allow(p, { ...resource, tenantId: T2 }, "read")).toBe(false);
    expect(await allow(p, resource, "delete")).toBe(false);
  });

  it("resource_search_campaign.read: PERMISSION ARM ALONE (roles: []) allows; no cross-tenant leak; no sibling-action bleed into .launch", async () => {
    const resource: Resource = { kind: "resource_search_campaign", id: "x1", tenantId: T1, module: "search" };
    const p = principal([], [{ key: "search.campaign.read", scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, resource, "read")).toBe(true);
    expect(await allow(p, { ...resource, tenantId: T2 }, "read")).toBe(false);
    expect(await allow(p, resource, "launch")).toBe(false);
  });

  it("resource_search_engagement.read: PERMISSION ARM ALONE (roles: []) allows; no cross-tenant leak; no sibling-action bleed into .set_scope", async () => {
    const resource: Resource = { kind: "resource_search_engagement", id: "x1", tenantId: T1, module: "search" };
    const p = principal([], [{ key: "search.engagement.read", scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, resource, "read")).toBe(true);
    expect(await allow(p, { ...resource, tenantId: T2 }, "read")).toBe(false);
    expect(await allow(p, resource, "set_scope")).toBe(false);
  });

  it("resource_search_keyword.read: PERMISSION ARM ALONE (roles: []) allows; no cross-tenant leak; no sibling-action bleed into .research", async () => {
    const resource: Resource = { kind: "resource_search_keyword", id: "x1", tenantId: T1, module: "search" };
    const p = principal([], [{ key: "search.keyword.read", scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, resource, "read")).toBe(true);
    expect(await allow(p, { ...resource, tenantId: T2 }, "read")).toBe(false);
    expect(await allow(p, resource, "research")).toBe(false);
  });

  it("resource_search_ledger.read: PERMISSION ARM ALONE (roles: []) allows; no cross-tenant leak; no sibling-action bleed into .admin", async () => {
    const resource: Resource = { kind: "resource_search_ledger", id: "x1", tenantId: T1, module: "search" };
    const p = principal([], [{ key: "search.ledger.read", scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, resource, "read")).toBe(true);
    expect(await allow(p, { ...resource, tenantId: T2 }, "read")).toBe(false);
    expect(await allow(p, resource, "admin")).toBe(false);
  });

  it("resource_search_property.read: PERMISSION ARM ALONE (roles: []) allows; no cross-tenant leak; no sibling-action bleed into .delete", async () => {
    const resource: Resource = { kind: "resource_search_property", id: "x1", tenantId: T1, module: "search" };
    const p = principal([], [{ key: "search.property.read", scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, resource, "read")).toBe(true);
    expect(await allow(p, { ...resource, tenantId: T2 }, "read")).toBe(false);
    expect(await allow(p, resource, "delete")).toBe(false);
  });

  it("resource_search_report.read: PERMISSION ARM ALONE (roles: []) allows; no cross-tenant leak; no sibling-action bleed into .approve", async () => {
    const resource: Resource = { kind: "resource_search_report", id: "x1", tenantId: T1, module: "search" };
    const p = principal([], [{ key: "search.report.read", scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, resource, "read")).toBe(true);
    expect(await allow(p, { ...resource, tenantId: T2 }, "read")).toBe(false);
    expect(await allow(p, resource, "approve")).toBe(false);
  });

});

describe.skipIf(!live)("HIER-2 rollout batch 3: checkin's permission arm (Pattern-B self-scoped mirroring; the register's clean self-scope-only kind)", () => {
  const checkin = (subjectUserId?: string): Resource => ({
    kind: "checkin",
    id: "chk-1",
    tenantId: T1,
    ...(subjectUserId !== undefined ? { subjectUserId } : {}),
  });

  it("PERMISSION ARM ALONE (roles: []) allows submit/read on the caller's OWN row", async () => {
    const submitP = principal([], [{ key: "reports.checkin.submit", scopeType: "company", scopeId: T1 }]);
    expect(await allow(submitP, checkin("u1"), "submit")).toBe(true);
    const readP = principal([], [{ key: "reports.checkin.read", scopeType: "company", scopeId: T1 }]);
    expect(await allow(readP, checkin("u1"), "read")).toBe(true);
  });

  it("PERMISSION ARM: submit/read do NOT widen into an unconditional grant — someone else's row, or no subject at all, is denied (mitigation 3: never build an unconditional mirror for a Pattern-B action)", async () => {
    const submitP = principal([], [{ key: "reports.checkin.submit", scopeType: "company", scopeId: T1 }]);
    expect(await allow(submitP, checkin("someone-else"), "submit")).toBe(false);
    expect(await allow(submitP, checkin(), "submit")).toBe(false); // no subjectUserId at all -> has() guard fails closed
    const readP = principal([], [{ key: "reports.checkin.read", scopeType: "company", scopeId: T1 }]);
    expect(await allow(readP, checkin("someone-else"), "read")).toBe(false);
    expect(await allow(readP, checkin(), "read")).toBe(false);
  });

  it("PERMISSION ARM ALONE allows excuse/pending_reminders/missed_by_unit unconditionally (no self path, no team_lead mixing — the plain IAM-04-ROLLOUT-B12-style mirror)", async () => {
    const excuseP = principal([], [{ key: "reports.checkin.excuse", scopeType: "company", scopeId: T1 }]);
    expect(await allow(excuseP, checkin(), "excuse")).toBe(true);
    const pendingP = principal([], [{ key: "reports.checkin.pending_reminders", scopeType: "company", scopeId: T1 }]);
    expect(await allow(pendingP, checkin(), "pending_reminders")).toBe(true);
    const missedP = principal([], [{ key: "reports.checkin.missed_by_unit", scopeType: "company", scopeId: T1 }]);
    expect(await allow(missedP, checkin(), "missed_by_unit")).toBe(true);
  });

  it("PERMISSION ARM ALONE does not bleed any of the 5 checkin actions into each other", async () => {
    const p = principal([], [{ key: "reports.checkin.excuse", scopeType: "company", scopeId: T1 }]);
    for (const action of ["submit", "read", "pending_reminders", "missed_by_unit"]) {
      expect(await allow(p, checkin("u1"), action), `checkin.excuse permission must not unlock .${action}`).toBe(false);
    }
  });

  it("PERMISSION ARM respects the company-scope cascade: does NOT leak cross-tenant", async () => {
    const p = principal([], [{ key: "reports.checkin.excuse", scopeType: "company", scopeId: T1 }], [T1, T2]);
    expect(await allow(p, { ...checkin(), tenantId: T2 }, "excuse")).toBe(false);
  });

  it("PERMISSION ARM: a global-scope grant covers every tenant the principal is authorized for", async () => {
    const p = principal([], [{ key: "reports.checkin.pending_reminders", scopeType: "global", scopeId: null }], [T1, T2]);
    expect(await allow(p, checkin(), "pending_reminders")).toBe(true);
    expect(await allow(p, { ...checkin(), tenantId: T2 }, "pending_reminders")).toBe(true);
  });

  it("PERMISSION ARM: low assurance still gets nothing (D4 ceiling honored)", async () => {
    const p = principal([], [{ key: "reports.checkin.excuse", scopeType: "company", scopeId: T1 }], [T1], "low");
    expect(await allow(p, checkin(), "excuse")).toBe(false);
  });

  it("ROLE ARM UNCHANGED: manager/company_admin/group_executive/hr_people_reader/hr_people_ops/member-self decisions match the pre-existing behavior (empty perms)", async () => {
    const manager = principal([{ role: "manager", scopeType: "company", scopeId: T1 }], []);
    expect(await allow(manager, checkin(), "read")).toBe(true);
    expect(await allow(manager, checkin(), "excuse")).toBe(true);

    const companyAdmin = principal([{ role: "company_admin", scopeType: "company", scopeId: T1 }], []);
    expect(await allow(companyAdmin, checkin(), "pending_reminders")).toBe(true);
    expect(await allow(companyAdmin, checkin(), "missed_by_unit")).toBe(true);

    // IAM-15: resource_checkin.yaml's group_executive rule is DELETED. The hr_manager/hr_staff/member
    // assertions below are the ones carrying this test's actual claim now, and they are untouched.
    const groupExec = principal([{ role: "group_executive", scopeType: "global", scopeId: null }], [], [], "high", [T1, T2]);
    expect(await allow(groupExec, { ...checkin(), tenantId: T2 }, "read")).toBe(false);

    const hrManager = principal([{ role: "hr_manager", scopeType: "company", scopeId: T1 }], []);
    expect(await allow(hrManager, checkin(), "excuse")).toBe(true);
    const hrStaff = principal([{ role: "hr_staff", scopeType: "company", scopeId: T1 }], []);
    expect(await allow(hrStaff, checkin(), "excuse")).toBe(false); // reader tier, not acting tier
    expect(await allow(hrStaff, checkin(), "read")).toBe(true);

    const member = principal([{ role: "member", scopeType: "company", scopeId: T1 }], []);
    expect(await allow(member, checkin("u1"), "submit")).toBe(true); // self
    expect(await allow(member, checkin("someone-else"), "submit")).toBe(false); // not self
  });

  it("BOTH ARMS TOGETHER still yield exactly one decision (role grants read via manager, permission independently grants excuse via the perm arm)", async () => {
    const p = principal(
      [{ role: "manager", scopeType: "company", scopeId: T1 }],
      [{ key: "reports.checkin.pending_reminders", scopeType: "company", scopeId: T1 }],
    );
    expect(await allow(p, checkin(), "read")).toBe(true); // via role arm (manager)
    expect(await allow(p, checkin(), "pending_reminders")).toBe(true); // via permission arm (manager alone couldn't)
    expect(await allow(p, checkin(), "missed_by_unit")).toBe(false); // neither arm grants this
  });
});

describe.skipIf(!live)("IAM-04-ROLLOUT-B4: dual-match isolation across the new-SAFE batch (16 kinds freed by team_lead retirement + IAM-DR12; `portal` deliberately excluded — see the B4 report's STOP)", () => {
  // Same isolation shape as the B12 block above: every case grants the permission WITHOUT any role
  // at all (roles: []) — the role arm cannot possibly be what answers. Each case also probes (a)
  // cross-tenant non-leak (same perms, resource moved to T2) and (b) sibling-action non-bleed where
  // the kind has ≥2 actions.

  it("activity.read: PERMISSION ARM ALONE (roles: []) allows; no cross-tenant leak", async () => {
    const resource: Resource = { kind: "activity", id: "x1", tenantId: T1 };
    const p = principal([], [{ key: "core.activity.read", scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, resource, "read")).toBe(true);
    expect(await allow(p, { ...resource, tenantId: T2 }, "read")).toBe(false);
  });

  it("client.read: PERMISSION ARM ALONE (roles: []) allows; no cross-tenant leak; no sibling-action bleed into .create/.update/.delete", async () => {
    const resource: Resource = { kind: "client", id: "x1", tenantId: T1 };
    const p = principal([], [{ key: "core.client.read", scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, resource, "read")).toBe(true);
    expect(await allow(p, { ...resource, tenantId: T2 }, "read")).toBe(false);
    expect(await allow(p, resource, "create")).toBe(false);
    expect(await allow(p, resource, "update")).toBe(false);
    expect(await allow(p, resource, "delete")).toBe(false);
  });

  it("client.delete: PERMISSION ARM ALONE (roles: []) allows the sensitive action too (delete is `sensitive: true` in the catalog, but the arm itself does not gate on that flag)", async () => {
    const resource: Resource = { kind: "client", id: "x1", tenantId: T1 };
    const p = principal([], [{ key: "core.client.delete", scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, resource, "delete")).toBe(true);
    expect(await allow(p, { ...resource, tenantId: T2 }, "delete")).toBe(false);
  });

  it("client_contact.create: PERMISSION ARM ALONE (roles: []) allows; no cross-tenant leak; no sibling-action bleed into .read/.revoke", async () => {
    const resource: Resource = { kind: "client_contact", id: "x1", tenantId: T1 };
    const p = principal([], [{ key: "core.client_contact.create", scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, resource, "create")).toBe(true);
    expect(await allow(p, { ...resource, tenantId: T2 }, "create")).toBe(false);
    expect(await allow(p, resource, "read")).toBe(false);
    expect(await allow(p, resource, "revoke")).toBe(false);
  });

  it("client_contact.read: PERMISSION ARM ALONE (roles: []) allows (member/viewer tier's own reach, mirrored independently of create/update/revoke's narrower company_admin+manager tier)", async () => {
    const resource: Resource = { kind: "client_contact", id: "x1", tenantId: T1 };
    const p = principal([], [{ key: "core.client_contact.read", scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, resource, "read")).toBe(true);
    expect(await allow(p, { ...resource, tenantId: T2 }, "read")).toBe(false);
  });

  it("comment.read: PERMISSION ARM ALONE (roles: []) allows; no cross-tenant leak; no sibling-action bleed into .create", async () => {
    const resource: Resource = { kind: "comment", id: "x1", tenantId: T1 };
    const p = principal([], [{ key: "core.comment.read", scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, resource, "read")).toBe(true);
    expect(await allow(p, { ...resource, tenantId: T2 }, "read")).toBe(false);
    expect(await allow(p, resource, "create")).toBe(false);
  });

  it("custom_field.update: PERMISSION ARM ALONE (roles: []) allows; no cross-tenant leak; no sibling-action bleed into .read/.create/.delete", async () => {
    const resource: Resource = { kind: "custom_field", id: "x1", tenantId: T1 };
    const p = principal([], [{ key: "core.custom_field.update", scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, resource, "update")).toBe(true);
    expect(await allow(p, { ...resource, tenantId: T2 }, "update")).toBe(false);
    expect(await allow(p, resource, "read")).toBe(false);
    expect(await allow(p, resource, "create")).toBe(false);
    expect(await allow(p, resource, "delete")).toBe(false);
  });

  it("deliverable.create: PERMISSION ARM ALONE (roles: []) allows; no cross-tenant leak; no sibling-action bleed into .read/.update/.delete", async () => {
    const resource: Resource = { kind: "deliverable", id: "x1", tenantId: T1 };
    const p = principal([], [{ key: "core.deliverable.create", scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, resource, "create")).toBe(true);
    expect(await allow(p, { ...resource, tenantId: T2 }, "create")).toBe(false);
    expect(await allow(p, resource, "read")).toBe(false);
    expect(await allow(p, resource, "update")).toBe(false);
    expect(await allow(p, resource, "delete")).toBe(false);
  });

  it("device.update: PERMISSION ARM ALONE (roles: []) allows the company_admin+it_staff combined tier; no cross-tenant leak; no sibling-action bleed into .read", async () => {
    const resource: Resource = { kind: "device", id: "x1", tenantId: T1 };
    const p = principal([], [{ key: "it.device.update", scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, resource, "update")).toBe(true);
    expect(await allow(p, { ...resource, tenantId: T2 }, "update")).toBe(false);
    expect(await allow(p, resource, "read")).toBe(false);
  });

  it("device: ROLE ARM UNCHANGED — the wildcard platform_admin+group_executive tier is still decided by the role arm alone, not mirrored into the permission catalog (IAM-04c)", async () => {
    const resource: Resource = { kind: "device", id: "x1", tenantId: T1 };
    // IAM-15: resource_device.yaml's group_executive wildcard rule is DELETED. This test's subject is
    // "the wildcard TIER is decided by the role arm, never mirrored into the catalog" — that claim is
    // now carried by platform_admin alone, which is the only wildcard tier left on this kind.
    const groupExec = principal([{ role: "group_executive", scopeType: "global", scopeId: null }], [], [], "high", [T1]);
    expect(await allow(groupExec, resource, "delete")).toBe(false);
    const platformAdmin = principal([{ role: "platform_admin", scopeType: "global", scopeId: null }], [], [], "high", [T1]);
    expect(await allow(platformAdmin, resource, "delete")).toBe(true); // the wildcard tier that remains
    // The permission arm's OWN rule still requires inTenant&&notLow (it is not the wildcard rule),
    // so the principal must be a member of the resource's tenant for the global-scope grant to
    // apply here — same "inTenant is a SEPARATE, unchanged gate" shape pm_task's own pilot test
    // documents (§ above, "a global-scope grant covers every tenant the principal is authorized for").
    const permOnly = principal([], [{ key: "it.device.delete", scopeType: "global", scopeId: null }], [T1]);
    expect(await allow(permOnly, resource, "delete")).toBe(true); // via the permission arm's OWN global branch, not the wildcard
  });

  it("file.create: PERMISSION ARM ALONE (roles: []) allows; no cross-tenant leak; no sibling-action bleed into .read/.delete", async () => {
    const resource: Resource = { kind: "file", id: "x1", tenantId: T1 };
    const p = principal([], [{ key: "core.file.create", scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, resource, "create")).toBe(true);
    expect(await allow(p, { ...resource, tenantId: T2 }, "create")).toBe(false);
    expect(await allow(p, resource, "read")).toBe(false);
    expect(await allow(p, resource, "delete")).toBe(false);
  });

  it("meeting_recording.relink: PERMISSION ARM ALONE (roles: []) allows the company_admin-only tier; no cross-tenant leak; no sibling-action bleed into .create/.ingest/.sync_drive", async () => {
    const resource: Resource = { kind: "meeting_recording", id: "x1", tenantId: T1 };
    const p = principal([], [{ key: "core.meeting_recording.relink", scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, resource, "relink")).toBe(true);
    expect(await allow(p, { ...resource, tenantId: T2 }, "relink")).toBe(false);
    expect(await allow(p, resource, "create")).toBe(false);
    expect(await allow(p, resource, "ingest")).toBe(false);
    expect(await allow(p, resource, "sync_drive")).toBe(false);
  });

  it("meeting_recording.create/ingest/sync_drive: PERMISSION ARM ALONE (roles: []) each allows independently, none bleeds into .relink (the company_admin-only tier)", async () => {
    const resource: Resource = { kind: "meeting_recording", id: "x1", tenantId: T1 };
    for (const action of ["create", "ingest", "sync_drive"]) {
      const p = principal([], [{ key: `core.meeting_recording.${action}`, scopeType: "company", scopeId: T1 }]);
      expect(await allow(p, resource, action), `meeting_recording.${action} via permission alone`).toBe(true);
      expect(await allow(p, resource, "relink"), `meeting_recording.${action} must not unlock .relink`).toBe(false);
    }
  });

  it("member.read: PERMISSION ARM ALONE (roles: []) now DENIES — perm_member_read was REMOVED (IAM-04-REG2, 2026-08-12): hr_staff/reports_staff/search_staff/social_staff/webdev_staff hold core.member.read in role-permission-bundles.json only via module_staff's rule, gated on a CALLER-SUPPLIED resource.attr.module (core.controller.ts:292-294) that genuinely varies — the flat mirror could not re-check it and let those roles read the directory via ANY module context, not just their own. company_admin/manager/member/viewer still get this action through their own unconditional role-arm rule directly (untouched by this removal).", async () => {
    const resource: Resource = { kind: "member", id: "x1", tenantId: T1 };
    const p = principal([], [{ key: "core.member.read", scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, resource, "read")).toBe(false);
    expect(await allow(p, { ...resource, tenantId: T2 }, "read")).toBe(false);
  });

  it("member.read: the module_staff tier is DELIBERATELY NOT mirrored — a bare hr_staff role with no module query param still resolves via the (untouched) role arm only, and the permission arm alone does not manufacture a caller-supplied-module grant it cannot re-check", async () => {
    const resource: Resource = { kind: "member", id: "x1", tenantId: T1 };
    const hrStaff = principal([{ role: "hr_staff", scopeType: "company", scopeId: T1 }], []);
    expect(await allow(hrStaff, resource, "read")).toBe(false); // no module attr on the resource -> module_staff's own rule cannot fire
    expect(await allow(hrStaff, { ...resource, module: "hr" }, "read")).toBe(true); // role arm, WITH the module attr the controller sets
  });

  it("notification.read: PERMISSION ARM ALONE (roles: []) allows; no cross-tenant leak; no sibling-action bleed into .create", async () => {
    const resource: Resource = { kind: "notification", id: "x1", tenantId: T1 };
    const p = principal([], [{ key: "core.notification.read", scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, resource, "read")).toBe(true);
    expect(await allow(p, { ...resource, tenantId: T2 }, "read")).toBe(false);
    expect(await allow(p, resource, "create")).toBe(false);
  });

  it("notification.create: PERMISSION ARM ALONE (roles: []) allows the company_admin+manager-only tier; does not bleed into .read/.update", async () => {
    const resource: Resource = { kind: "notification", id: "x1", tenantId: T1 };
    const p = principal([], [{ key: "core.notification.create", scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, resource, "create")).toBe(true);
    expect(await allow(p, resource, "read")).toBe(false);
    expect(await allow(p, resource, "update")).toBe(false);
  });

  it("org_structure.read: PERMISSION ARM ALONE (roles: []) allows the company_admin/manager/member/viewer tier; no cross-tenant leak; no sibling-action bleed into .update", async () => {
    const resource: Resource = { kind: "org_structure", id: "x1", tenantId: T1 };
    const p = principal([], [{ key: "core.org_structure.read", scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, resource, "read")).toBe(true);
    expect(await allow(p, { ...resource, tenantId: T2 }, "read")).toBe(false);
    expect(await allow(p, resource, "update")).toBe(false);
  });

  it("org_structure.update: PERMISSION ARM ALONE (roles: []) allows the company_admin-only tier; the group_executive-only rule remains untouched by this (still decided by the role arm alone)", async () => {
    const resource: Resource = { kind: "org_structure", id: "x1", tenantId: T1 };
    const p = principal([], [{ key: "core.org_structure.update", scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, resource, "update")).toBe(true);
    expect(await allow(p, { ...resource, tenantId: T2 }, "update")).toBe(false);
    // MON-00c: resource_org_structure.yaml's group_executive rule is now `notLow && inRoot` — anchor
    // rootCompanies to include T1 (the resource's tenant) so the untouched role-arm rule still fires.
    // IAM-15: the group_executive-only rule this line guarded is deleted, so the exec is now DENIED.
    // The assertion is kept (inverted) because this test's subject is that the PERMISSION arm's allow
    // above does not depend on the role arm — and a role-arm principal that now reaches nothing is
    // still the cleanest way to show the two arms are independent.
    const groupExec = principal([{ role: "group_executive", scopeType: "global", scopeId: null }], [], [], "high", [T1]);
    expect(await allow(groupExec, resource, "update")).toBe(false);
  });

  it("pm_project.read: PERMISSION ARM ALONE (roles: []) allows; no cross-tenant leak; no sibling-action bleed into .manage", async () => {
    const resource: Resource = { kind: "pm_project", id: "x1", tenantId: T1 };
    const p = principal([], [{ key: "pm.project.read", scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, resource, "read")).toBe(true);
    expect(await allow(p, { ...resource, tenantId: T2 }, "read")).toBe(false);
    expect(await allow(p, resource, "manage")).toBe(false);
  });

  it("pm_project.manage: PERMISSION ARM ALONE (roles: []) allows the company_admin+manager tier; no cross-tenant leak", async () => {
    const resource: Resource = { kind: "pm_project", id: "x1", tenantId: T1 };
    const p = principal([], [{ key: "pm.project.manage", scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, resource, "manage")).toBe(true);
    expect(await allow(p, { ...resource, tenantId: T2 }, "manage")).toBe(false);
  });

  it("report_period.view: PERMISSION ARM ALONE (roles: []) allows the combined company_admin/hr_people_reader/manager/member tier; no cross-tenant leak; no sibling-action bleed into .seal/.amend/.pin", async () => {
    const resource: Resource = { kind: "report_period", id: "x1", tenantId: T1 };
    const p = principal([], [{ key: "reports.period.view", scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, resource, "view")).toBe(true);
    expect(await allow(p, { ...resource, tenantId: T2 }, "view")).toBe(false);
    expect(await allow(p, resource, "seal")).toBe(false);
    expect(await allow(p, resource, "amend")).toBe(false);
    expect(await allow(p, resource, "pin")).toBe(false);
  });

  it("report_period.seal/amend/pin: PERMISSION ARM ALONE (roles: []) each allows the company_admin-only tier independently; group_executive's own rule remains untouched", async () => {
    const resource: Resource = { kind: "report_period", id: "x1", tenantId: T1 };
    for (const action of ["seal", "amend", "pin"]) {
      const p = principal([], [{ key: `reports.period.${action}`, scopeType: "company", scopeId: T1 }]);
      expect(await allow(p, resource, action), `report_period.${action} via permission alone`).toBe(true);
    }
    // MON-00c: resource_report_period.yaml's group_executive rule is now `notLow && inRoot` — anchor
    // rootCompanies to include T1 (the resource's tenant) so the untouched role-arm rule still fires.
    // IAM-15: same inversion as org_structure.update above — the exec's own rule is gone.
    const groupExec = principal([{ role: "group_executive", scopeType: "global", scopeId: null }], [], [], "high", [T1]);
    expect(await allow(groupExec, resource, "seal")).toBe(false);
  });

  it("task.update: PERMISSION ARM ALONE (roles: []) allows; no cross-tenant leak; no sibling-action bleed into .read/.create/.delete", async () => {
    const resource: Resource = { kind: "task", id: "x1", tenantId: T1 };
    const p = principal([], [{ key: "core.task.update", scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, resource, "update")).toBe(true);
    expect(await allow(p, { ...resource, tenantId: T2 }, "update")).toBe(false);
    expect(await allow(p, resource, "read")).toBe(false);
    expect(await allow(p, resource, "create")).toBe(false);
    expect(await allow(p, resource, "delete")).toBe(false);
  });

  it("work_activity.read: PERMISSION ARM ALONE (roles: []) allows the company_admin/manager/member/viewer tier; no cross-tenant leak; no sibling-action bleed into .create", async () => {
    const resource: Resource = { kind: "work_activity", id: "x1", tenantId: T1 };
    const p = principal([], [{ key: "core.work_activity.read", scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, resource, "read")).toBe(true);
    expect(await allow(p, { ...resource, tenantId: T2 }, "read")).toBe(false);
    expect(await allow(p, resource, "create")).toBe(false);
  });

  it("work_activity.create: PERMISSION ARM ALONE (roles: []) allows the company_admin-only tier; group_executive's own read-only rule remains untouched (it never held create anyway)", async () => {
    const resource: Resource = { kind: "work_activity", id: "x1", tenantId: T1 };
    const p = principal([], [{ key: "core.work_activity.create", scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, resource, "create")).toBe(true);
    expect(await allow(p, { ...resource, tenantId: T2 }, "create")).toBe(false);
    const groupExec = principal([{ role: "group_executive", scopeType: "global", scopeId: null }], [], []);
    expect(await allow(groupExec, resource, "create")).toBe(false); // group_executive never held `create` on this kind, role arm or otherwise
  });

  it("PERMISSION ARM: low assurance still gets nothing across a sample of the batch (D4 ceiling honored, not bypassed)", async () => {
    const p = principal([], [{ key: "core.task.read", scopeType: "company", scopeId: T1 }], [T1], "low");
    expect(await allow(p, { kind: "task", id: "x1", tenantId: T1 }, "read")).toBe(false);
  });

  it("PERMISSION ARM: a global-scope grant covers every tenant the principal is authorized for, on a sample of the batch", async () => {
    const p = principal([], [{ key: "core.task.read", scopeType: "global", scopeId: null }], [T1, T2]);
    expect(await allow(p, { kind: "task", id: "x1", tenantId: T1 }, "read")).toBe(true);
    expect(await allow(p, { kind: "task", id: "x1", tenantId: T2 }, "read")).toBe(true);
  });

  it("ROLE ARM UNCHANGED: a sample of the batch's plain role-arm decisions match pre-existing behavior (empty perms) — proves the additions are additive, not replacements", async () => {
    const manager = principal([{ role: "manager", scopeType: "company", scopeId: T1 }], []);
    expect(await allow(manager, { kind: "task", id: "x1", tenantId: T1 }, "update")).toBe(true);
    const viewer = principal([{ role: "viewer", scopeType: "company", scopeId: T1 }], []);
    expect(await allow(viewer, { kind: "task", id: "x1", tenantId: T1 }, "update")).toBe(false);
    expect(await allow(viewer, { kind: "task", id: "x1", tenantId: T1 }, "read")).toBe(true);
  });

  it("BOTH ARMS TOGETHER still yield exactly one decision, not a conflicting pair (role grants read via viewer, permission independently grants update — neither denies the other)", async () => {
    const p = principal(
      [{ role: "viewer", scopeType: "company", scopeId: T1 }],
      [{ key: "core.task.update", scopeType: "company", scopeId: T1 }],
    );
    expect(await allow(p, { kind: "task", id: "x1", tenantId: T1 }, "read")).toBe(true); // via role arm (viewer)
    expect(await allow(p, { kind: "task", id: "x1", tenantId: T1 }, "update")).toBe(true); // via permission arm (viewer alone couldn't update)
    expect(await allow(p, { kind: "task", id: "x1", tenantId: T1 }, "delete")).toBe(false); // neither arm grants this
  });
});
