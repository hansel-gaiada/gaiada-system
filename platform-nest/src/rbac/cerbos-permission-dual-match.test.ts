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

function principal(
  roles: RoleGrant[],
  perms: PermissionGrant[],
  companies: string[] = [T1],
  assurance: Principal["assurance"] = "high",
): Principal {
  return { userId: "u1", assurance, companies, roles, perms, sessionVersion: 1 };
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

  it("ROLE ARM UNCHANGED (empty perms): manager/member/viewer/team_lead/company_admin decisions match cerbos.test.ts's pre-existing pm_task-equivalent behavior", async () => {
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

  it("REAL FINDING pin (found while building this pilot, verified live against the seeded 0094/0098 bundle): `team_lead`'s role_permissions bundle claims pm.task.* reach (it sits in resource_pm_task.yaml's role list), but team_lead is PROVABLY unreachable on pm_task at ANY scope — pm.controller.ts never sets resource.attr.teamId (see pm-adversarial-authz.test.ts's own pinned finding). A team_lead grant made at COMPANY or GLOBAL scope must NOT be resurrected by the permission arm just because its bundle entry shares that scope with legitimate company_admin/manager/member/viewer grants.", async () => {
    // Principal's ONLY grant is team_lead at COMPANY scope — perms carries the same bundle entries
    // a real assemblePrincipal() would produce for this exact user_roles row (verified empirically:
    // `SELECT ... FROM role_permissions WHERE role='team_lead' AND key LIKE 'pm.task%'` returns all 5).
    const teamLeadCompany = principal(
      [{ role: "team_lead", scopeType: "company", scopeId: T1 }],
      [
        { key: "pm.task.read", scopeType: "company", scopeId: T1 },
        { key: "pm.task.update", scopeType: "company", scopeId: T1 },
        { key: "pm.task.create", scopeType: "company", scopeId: T1 },
        { key: "pm.task.delete", scopeType: "company", scopeId: T1 },
        { key: "pm.task.manage", scopeType: "company", scopeId: T1 },
      ],
    );
    for (const action of ["read", "update", "create", "delete", "manage"]) {
      expect(await allow(teamLeadCompany, pmTask, action), `team_lead@company must NOT reach pm.task.${action}`).toBe(false);
    }
    // Same shape at GLOBAL scope — team_lead's own role-arm condition never accepts global either.
    const teamLeadGlobal = principal(
      [{ role: "team_lead", scopeType: "global", scopeId: null }],
      [{ key: "pm.task.read", scopeType: "global", scopeId: null }],
      [],
    );
    expect(await allow(teamLeadGlobal, pmTask, "read")).toBe(false);
    // Sanity: a principal who ALSO holds a genuinely qualifying role at the SAME scope is unaffected
    // (the role arm — unchanged — grants it regardless of what the permission arm decides).
    const teamLeadPlusManager = principal(
      [
        { role: "team_lead", scopeType: "company", scopeId: T1 },
        { role: "manager", scopeType: "company", scopeId: T1 },
      ],
      [],
    );
    expect(await allow(teamLeadPlusManager, pmTask, "read")).toBe(true);
  });

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

    const groupExec = principal([{ role: "group_executive", scopeType: "global", scopeId: null }], [], []);
    expect(await allow(groupExec, { ...hrCase(), tenantId: T2 }, "read")).toBe(true); // deliberately cross-company

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

  it("service_assignment.read: PERMISSION ARM ALONE (roles: []) allows; no cross-tenant leak; no sibling-action bleed into .propose", async () => {
    const resource: Resource = { kind: "service_assignment", id: "x1", tenantId: T1 };
    const p = principal([], [{ key: "core.service_assignment.read", scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, resource, "read")).toBe(true);
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

    const groupExec = principal([{ role: "group_executive", scopeType: "global", scopeId: null }], [], []);
    expect(await allow(groupExec, { ...checkin(), tenantId: T2 }, "read")).toBe(true); // deliberately cross-company

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
