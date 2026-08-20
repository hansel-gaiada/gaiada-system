// 5b.4 behavioral-parity gate: the same role × scope matrix the in-code check() enforced,
// now decided by LIVE Cerbos over the versioned policy repo. Needs a running Cerbos —
// set CERBOS_URL (skips otherwise). `docker run -p 3592:3592 -v .../cerbos/policies:/policies ghcr.io/cerbos/cerbos`.
import { describe, it, expect } from "vitest";
import { check, planResources, type Resource } from "./cerbos";
import type { Principal, RoleGrant } from "./principal";

const live = process.env.CERBOS_URL && process.env.CERBOS_URL.length > 0;
const T1 = "aaaaaaaa-0000-0000-0000-000000000001";
const T2 = "aaaaaaaa-0000-0000-0000-000000000002";
const PROJ = "bbbbbbbb-0000-0000-0000-000000000001";

// MON-00c: `rootCompanies` defaults to `companies` because in a single-root fixture world the
// principal's root subtree IS the companies under test. It must be passed EXPLICITLY for a
// principal with no memberships (a global group_executive) — that is the case the boundary
// exists for, and an empty set denies by design.
function principal(roles: RoleGrant[], companies: string[] = [T1], assurance: Principal["assurance"] = "high", rootCompanies: string[] = companies): Principal {
  return { userId: "u1", assurance, companies, roles, rootCompanies, sessionVersion: 1 };
}
const project: Resource = { kind: "project", id: PROJ, tenantId: T1, ownerId: "owner-x" };
const taskInProj: Resource = { kind: "task", tenantId: T1, projectId: PROJ };
const allow = async (p: Principal, r: Resource, a: string) => (await check(p, r, a)).allow;

describe.skipIf(!live)("Cerbos policy parity (role × scope matrix)", () => {
  it("denies everything with no roles", async () => {
    expect(await allow(principal([]), project, "read")).toBe(false);
  });

  it("platform_admin (global) can do anything anywhere", async () => {
    const p = principal([{ role: "platform_admin", scopeType: "global", scopeId: null }], []);
    expect(await allow(p, project, "delete")).toBe(true);
    expect(await allow(p, { kind: "company", tenantId: T2 }, "update")).toBe(true);
  });

  // MON-00c: this test's SUBJECT is the rollup-vs-project distinction — an exec reads aggregates
  // across the companies it oversees, never their underlying records. That is orthogonal to the root
  // boundary, so the principal is given a root that CONTAINS T2. Before this, it passed `companies:
  // []`, which (since `rootCompanies` defaults to `companies`) left the root EMPTY, so `inRoot` was
  // false and the rollup read was denied for a reason this test is not about — the assertion failed
  // while the behaviour it names was in fact intact.
  it("group_executive reads cross-company ONLY through rollups (within its own root)", async () => {
    const p = principal([{ role: "group_executive", scopeType: "global", scopeId: null }], [], "high", [T2]);
    expect(await allow(p, { kind: "rollup", tenantId: T2 }, "read")).toBe(true);
    expect(await allow(p, { kind: "project", tenantId: T2 }, "read")).toBe(false);
  });

  // The other half of the same rule, which the version above can no longer express now that it
  // supplies a root: the aggregate path is bounded too. An exec is not a SaaS operator, so a rollup
  // belonging to a company OUTSIDE its root is a cross-customer read and must be refused.
  it("group_executive is refused even on a rollup OUTSIDE its root (MON-00c)", async () => {
    const p = principal([{ role: "group_executive", scopeType: "global", scopeId: null }], [], "high", [T1]);
    expect(await allow(p, { kind: "rollup", tenantId: T2 }, "read")).toBe(false);
    // Positive control — without this the assertion above passes vacuously for any principal that
    // simply cannot read rollups at all.
    expect(await allow(p, { kind: "rollup", tenantId: T1 }, "read")).toBe(true);
  });

  it("company-scope grants cascade down to the company's projects and tasks", async () => {
    const p = principal([{ role: "manager", scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, project, "update")).toBe(true);
    expect(await allow(p, taskInProj, "create")).toBe(true);
    expect(await allow(p, { kind: "company", tenantId: T1 }, "update")).toBe(false);
  });

  it("project-scope grants do NOT leak to other projects", async () => {
    const p = principal([{ role: "manager", scopeType: "project", scopeId: PROJ }]);
    expect(await allow(p, taskInProj, "update")).toBe(true);
    expect(await allow(p, { kind: "task", tenantId: T1, projectId: "cccccccc-0000-0000-0000-000000000009" }, "update")).toBe(false);
  });

  it("member: reads all in tenant, writes tasks, cannot delete projects it doesn't own", async () => {
    const p = principal([{ role: "member", scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, project, "read")).toBe(true);
    expect(await allow(p, taskInProj, "update")).toBe(true);
    expect(await allow(p, project, "delete")).toBe(false);
    expect(await allow({ ...p, userId: "owner-x" }, project, "update")).toBe(true);
  });

  it("viewer: read-only", async () => {
    const p = principal([{ role: "viewer", scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, project, "read")).toBe(true);
    expect(await allow(p, taskInProj, "create")).toBe(false);
  });

  it("tenant not in the authorized set → deny, regardless of roles", async () => {
    const p = principal([{ role: "company_admin", scopeType: "company", scopeId: T2 }], [T1]);
    expect(await allow(p, { kind: "project", tenantId: T2 }, "read")).toBe(false);
  });

  it("low-assurance principals get NO company data (D4 ceiling)", async () => {
    const p = principal([{ role: "company_admin", scopeType: "company", scopeId: T1 }], [T1], "low");
    expect(await allow(p, project, "read")).toBe(false);
  });

  it("verified-link (linked) assurance gets standard in-tenant access", async () => {
    const p = principal([{ role: "member", scopeType: "company", scopeId: T1 }], [T1], "linked");
    expect(await allow(p, project, "read")).toBe(true);
  });

  it("module approver authorizes only its module's approve action", async () => {
    const p = principal([{ role: "agency_approver", scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, { kind: "agency_approval", tenantId: T1, module: "agency" }, "approve")).toBe(true);
    expect(await allow(p, project, "update")).toBe(false);
  });

  // HIER-3 (2026-08-11): the "team_lead grant covers that team's resources only (5b.7)" case that
  // used to sit here is REMOVED, not replaced — `team_lead`, the `team` scope_type, and the `team`
  // Cerbos kind are all retired (docs/superpowers/plans/2026-08-11-hier-3-report.md). The
  // replacement mechanism (`org_unit_lead`'s subtree cascade, HIER-2) is exercised end-to-end by
  // `src/rbac/cerbos-org-unit-lead-cascade.test.ts`, not here — it depends on
  // `resource.attr.unitAncestors`, which the generic `task`/`project` kinds this file tests never
  // carry, so there is no like-for-like drop-in replacement in this matrix.

  it("PlanResources (D16): admin → always-allowed, no-role → always-denied", async () => {
    const admin = principal([{ role: "platform_admin", scopeType: "global", scopeId: null }], []);
    expect((await planResources(admin, "project", "read")).kind).toBe("always-allowed");
    expect((await planResources(principal([]), "project", "read")).kind).toBe("always-denied");
  });

  // P1-04: work_activity — read is member-level; ingest ("create") is admin/service only.
  it("work_activity: any member reads, but cannot ingest", async () => {
    const p = principal([{ role: "member", scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, { kind: "work_activity", tenantId: T1 }, "read")).toBe(true);
    expect(await allow(p, { kind: "work_activity", tenantId: T1 }, "create")).toBe(false);
  });

  it("work_activity: company_admin can ingest within its tenant, not a rival tenant", async () => {
    const p = principal([{ role: "company_admin", scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, { kind: "work_activity", tenantId: T1 }, "create")).toBe(true);
    expect(await allow(p, { kind: "work_activity", tenantId: T2 }, "create")).toBe(false);
  });

  it("work_activity: platform_admin (global) can ingest anywhere", async () => {
    const p = principal([{ role: "platform_admin", scopeType: "global", scopeId: null }], []);
    expect(await allow(p, { kind: "work_activity", tenantId: T2 }, "create")).toBe(true);
  });

  it("work_activity: a manager (non-admin) cannot ingest", async () => {
    const p = principal([{ role: "manager", scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, { kind: "work_activity", tenantId: T1 }, "create")).toBe(false);
  });

  it("work_activity: low-assurance gets no read (D4 ceiling)", async () => {
    const p = principal([{ role: "member", scopeType: "company", scopeId: T1 }], [T1], "low");
    expect(await allow(p, { kind: "work_activity", tenantId: T1 }, "read")).toBe(false);
  });
});
