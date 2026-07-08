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

function principal(roles: RoleGrant[], companies: string[] = [T1], assurance: Principal["assurance"] = "high"): Principal {
  return { userId: "u1", assurance, companies, roles, sessionVersion: 1 };
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

  it("group_executive reads cross-company ONLY through rollups", async () => {
    const p = principal([{ role: "group_executive", scopeType: "global", scopeId: null }], []);
    expect(await allow(p, { kind: "rollup", tenantId: T2 }, "read")).toBe(true);
    expect(await allow(p, { kind: "project", tenantId: T2 }, "read")).toBe(false);
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

  it("team_lead grant covers that team's resources only (5b.7)", async () => {
    const p = principal([{ role: "team_lead", scopeType: "team", scopeId: "team-9" }]);
    expect(await allow(p, { kind: "task", tenantId: T1, teamId: "team-9" }, "update")).toBe(true);
    expect(await allow(p, { kind: "task", tenantId: T1, teamId: "team-8" }, "update")).toBe(false);
  });

  it("PlanResources (D16): admin → always-allowed, no-role → always-denied", async () => {
    const admin = principal([{ role: "platform_admin", scopeType: "global", scopeId: null }], []);
    expect((await planResources(admin, "project", "read")).kind).toBe("always-allowed");
    expect((await planResources(principal([]), "project", "read")).kind).toBe("always-denied");
  });
});
