// GH-03 — resource_github.yaml's role x action x scope matrix, LIVE against Cerbos (same convention
// as cerbos-webdev-matrix.test.ts: talks to the real policy engine, needs CERBOS_URL, skips
// otherwise). Six actions per docs/blueprints/github-integration-foundation.md §4.2: read, push,
// merge, deploy, secret_write, create_repo, delete_repo.
import { describe, it, expect } from "vitest";
import { check, type Resource } from "./cerbos";
import type { Principal, RoleGrant } from "./principal";

const live = process.env.CERBOS_URL && process.env.CERBOS_URL.length > 0;
const T1 = "aaaaaaaa-6060-0000-0000-000000000001"; // home tenant
const T2 = "aaaaaaaa-6060-0000-0000-000000000002"; // rival tenant
const PROJ = "bbbbbbbb-6060-0000-0000-000000000001";
const OTHER_PROJ = "bbbbbbbb-6060-0000-0000-000000000009";

function principal(role: string, scopeType: RoleGrant["scopeType"], scopeId: string | null, opts: Partial<Principal> = {}): Principal {
  return {
    userId: "u1",
    assurance: "high",
    companies: [T1],
    rootCompanies: [T1],
    roles: [{ role, scopeType, scopeId }],
    sessionVersion: 1,
    ...opts,
  };
}
const allow = async (p: Principal, r: Resource, a: string) => (await check(p, r, a)).allow;

const repo: Resource = { kind: "github_repo", id: "gaiadabali/site-a", tenantId: T1 };
const repoInProj: Resource = { kind: "github_repo", id: "gaiadabali/site-b", tenantId: T1, projectId: PROJ };
const repoOtherTenant: Resource = { kind: "github_repo", id: "gaiadabali/other-org-repo", tenantId: T2 };

describe.skipIf(!live)("GH-03 Cerbos matrix — github_repo", () => {
  it("denies everything with no roles", async () => {
    const p = principal("nothing", "company", T1);
    p.roles = [];
    for (const a of ["read", "push", "merge", "deploy", "secret_write", "create_repo", "delete_repo"]) {
      expect(await allow(p, repo, a)).toBe(false);
    }
  });

  it("platform_admin: full access, every action, any tenant, no approvalId needed", async () => {
    const p = principal("platform_admin", "global", null, { companies: [] });
    for (const a of ["read", "push", "merge", "deploy", "secret_write", "create_repo", "delete_repo"]) {
      expect(await allow(p, repo, a)).toBe(true);
      expect(await allow(p, repoOtherTenant, a)).toBe(true);
    }
  });

  const APPROVED = "11111111-2222-3333-4444-555555555555";

  it("company_admin: read/push/merge allowed within tenant with NO approval needed", async () => {
    const p = principal("company_admin", "company", T1);
    for (const a of ["read", "push", "merge"]) {
      expect(await allow(p, repo, a)).toBe(true);
    }
  });

  it("company_admin: deploy/secret_write/create_repo/delete_repo ALL DENIED with no approvalId — role tier alone is not enough for any of the four", async () => {
    const p = principal("company_admin", "company", T1);
    for (const a of ["deploy", "secret_write", "create_repo", "delete_repo"]) {
      expect(await allow(p, repo, a)).toBe(false);
    }
  });

  it("company_admin: all four D14 actions ALLOWED once a verified approvalId is attached", async () => {
    const p = principal("company_admin", "company", T1);
    const approved: Resource = { ...repo, approvalId: APPROVED };
    for (const a of ["deploy", "secret_write", "create_repo", "delete_repo"]) {
      expect(await allow(p, approved, a)).toBe(true);
    }
  });

  it("an empty-string approvalId does NOT satisfy the gate (fail-closed, not merely 'attribute present')", async () => {
    const p = principal("company_admin", "company", T1);
    const emptyApproval: Resource = { ...repo, approvalId: "" };
    expect(await allow(p, emptyApproval, "create_repo")).toBe(false);
    expect(await allow(p, emptyApproval, "deploy")).toBe(false);
  });

  it("D14 actions stay denied cross-tenant even WITH an approvalId", async () => {
    const p = principal("company_admin", "company", T1);
    const approvedOtherTenant: Resource = { ...repoOtherTenant, approvalId: APPROVED };
    expect(await allow(p, approvedOtherTenant, "create_repo")).toBe(false);
    expect(await allow(p, approvedOtherTenant, "deploy")).toBe(false);
  });

  it("manager: push/merge/read allowed with no approval; deploy needs approval even for manager; secret_write/create/delete stay out of reach entirely", async () => {
    const p = principal("manager", "company", T1);
    for (const a of ["read", "push", "merge"]) {
      expect(await allow(p, repo, a)).toBe(true);
    }
    expect(await allow(p, repo, "deploy")).toBe(false);
    const approved: Resource = { ...repo, approvalId: APPROVED };
    expect(await allow(p, approved, "deploy")).toBe(true); // manager IS on deploy's tier once approved
    expect(await allow(p, approved, "secret_write")).toBe(false); // manager is never on secret_write's tier
    expect(await allow(p, approved, "create_repo")).toBe(false); // manager is never on create/delete's tier
  });

  it("member: read-only — push/merge and all four D14 actions denied, approval or not", async () => {
    const p = principal("member", "company", T1);
    expect(await allow(p, repo, "read")).toBe(true);
    for (const a of ["push", "merge", "deploy", "secret_write", "create_repo", "delete_repo"]) {
      expect(await allow(p, repo, a)).toBe(false);
    }
    const approved: Resource = { ...repo, approvalId: APPROVED };
    for (const a of ["deploy", "secret_write", "create_repo", "delete_repo"]) {
      expect(await allow(p, approved, a)).toBe(false);
    }
  });

  it("project-scope manager grant cascades to a repo linked to THAT project, not another (push, unapproved)", async () => {
    const p = principal("manager", "project", PROJ);
    expect(await allow(p, repoInProj, "push")).toBe(true);
    const repoOtherProj: Resource = { ...repoInProj, id: "gaiadabali/site-c", projectId: OTHER_PROJ };
    expect(await allow(p, repoOtherProj, "push")).toBe(false);
  });

  it("module_staff (webdev) can push/merge/read a webdev-linked repo with no approval; deploy needs approval even for module_staff", async () => {
    const p = principal("webdev_staff", "company", T1);
    const webdevRepo: Resource = { ...repo, module: "webdev" };
    for (const a of ["read", "push", "merge"]) {
      expect(await allow(p, webdevRepo, a)).toBe(true);
    }
    expect(await allow(p, webdevRepo, "deploy")).toBe(false);
    const approved: Resource = { ...webdevRepo, approvalId: APPROVED };
    expect(await allow(p, approved, "deploy")).toBe(true);
    expect(await allow(p, approved, "secret_write")).toBe(false); // module_staff never reaches secret_write
    expect(await allow(p, approved, "create_repo")).toBe(false);
  });

  it("module_staff reach does NOT leak to a repo with no module set", async () => {
    const p = principal("webdev_staff", "company", T1);
    expect(await allow(p, repo, "push")).toBe(false);
  });

  it("module_manager (webdev) reaches secret_write once approved; module_staff never does, approved or not", async () => {
    const webdevRepo: Resource = { ...repo, module: "webdev" };
    const approved: Resource = { ...webdevRepo, approvalId: APPROVED };
    const staff = principal("webdev_staff", "company", T1);
    const manager = principal("webdev_manager", "company", T1);
    expect(await allow(staff, approved, "secret_write")).toBe(false);
    expect(await allow(manager, webdevRepo, "secret_write")).toBe(false); // unapproved: still denied
    expect(await allow(manager, approved, "secret_write")).toBe(true);
  });

  it("read/link/unlink carry NO module gate — a company_admin reaches an unlinked, module-less repo (no-module-wall ruling)", async () => {
    const p = principal("company_admin", "company", T1);
    for (const a of ["read", "link", "unlink"]) {
      expect(await allow(p, repo, a)).toBe(true);
    }
  });

  it("link/unlink need NO approval — company_admin/manager reach them unconditionally within tenant", async () => {
    const admin = principal("company_admin", "company", T1);
    const manager = principal("manager", "company", T1);
    for (const a of ["link", "unlink"]) {
      expect(await allow(admin, repo, a)).toBe(true);
      expect(await allow(manager, repo, a)).toBe(true);
    }
  });

  it("member can read but not link/unlink", async () => {
    const p = principal("member", "company", T1);
    expect(await allow(p, repo, "read")).toBe(true);
    expect(await allow(p, repo, "link")).toBe(false);
    expect(await allow(p, repo, "unlink")).toBe(false);
  });

  it("low assurance denies everything, regardless of role", async () => {
    const p = principal("company_admin", "company", T1, { assurance: "low" });
    for (const a of ["read", "push"]) {
      expect(await allow(p, repo, a)).toBe(false);
    }
  });

  it("cross-tenant company_admin gets nothing", async () => {
    const p = principal("company_admin", "company", T1);
    for (const a of ["read", "push", "merge", "deploy"]) {
      expect(await allow(p, repoOtherTenant, a)).toBe(false);
    }
  });
});
