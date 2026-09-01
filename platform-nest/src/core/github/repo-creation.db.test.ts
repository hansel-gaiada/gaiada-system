// GH-12 — the whole in-band execution path against REAL Postgres + REAL Cerbos.
// `githubRequest` is the ONLY thing mocked (GH-01/GH-02's chokepoint — same discipline
// repo-sync.service.test.ts already established: never call the live GitHub API from a test).
// Everything else — the migration's widened `origin` CHECK, `resource_github_repo.yaml`'s real
// `create_repo` rule (unmodified), and `core/github/ledger.ts`'s real `activities` writes — runs for
// real. This is what proves the D14 gate is the ACTUAL Cerbos policy, not a stand-in for it.
import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from "vitest";
import { ForbiddenException } from "@nestjs/common";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../../testing/fixtures";
import { assemblePrincipal } from "../../rbac/principal";
import { newId, withTenants } from "../../db";
import { config } from "../../config";
import * as githubAppService from "./github-app.service";
import {
  GITHUB_CREATE_REPO_WORKFLOW,
  executeApprovedGithubRepoCreation,
  isGithubRepoCreationRequest,
} from "./repo-creation";
import type { Principal } from "../../rbac/principal";

vi.mock("./github-app.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./github-app.service")>();
  return { ...actual, githubRequest: vi.fn() };
});

const live = TEST_URL && process.env.CERBOS_URL && process.env.CERBOS_URL.length > 0;

describe.skipIf(!live)("GH-12 — executeApprovedGithubRepoCreation (real Postgres + real Cerbos)", () => {
  let T: string;
  let companyAdmin: Principal;
  let plainManager: Principal;
  let plainMember: Principal;
  const savedOrg = config.githubOrg;

  async function fileRow(workflowId: string, toolArgs: Record<string, unknown>, requestedBy: string): Promise<string> {
    const id = newId();
    await withTenants([T], (c) =>
      c.query(
        `INSERT INTO automation_approvals
           (id, tenant_id, workflow_id, tool_name, tool_args, impact, requested_by, origin, origin_site)
         VALUES ($1,$2,$3,'github.createRepo',$4,'high',$5,'github','main')`,
        [id, T, workflowId, JSON.stringify(toolArgs), requestedBy],
      ),
    );
    return id;
  }

  /** Scoped to ONE repo's own `repo` metadata field — several tests share tenant `T`, and an
   *  unscoped query would accumulate every prior test's rows into the same result. */
  async function activityOutcomes(repoFullName: string): Promise<string[]> {
    const { rows } = await withTenants([T], (c) =>
      c.query<{ outcome: string }>(
        `SELECT metadata->>'outcome' AS outcome FROM activities
          WHERE tenant_id = $1 AND verb = 'github.create_repo' AND metadata->>'repo' = $2
          ORDER BY occurred_at ASC`,
        [T, repoFullName],
      ),
    );
    return rows.map((r) => r.outcome);
  }

  beforeAll(async () => {
    await initTestDb();
    T = await createCompany("GH-12 Co");
    const adminUserId = await createUser("gh12-admin@ex.test", "GH12 Admin");
    await addMembership(T, adminUserId);
    const adminRoleId = await createRole("company_admin", null);
    await grantRole(adminUserId, adminRoleId, "company", T);
    const p1 = await assemblePrincipal(adminUserId, "high");
    if (!p1) throw new Error("could not assemble company_admin principal");
    companyAdmin = p1;

    const managerUserId = await createUser("gh12-manager@ex.test", "GH12 Manager");
    await addMembership(T, managerUserId);
    const managerRoleId = await createRole("manager", null);
    await grantRole(managerUserId, managerRoleId, "company", T);
    const p2 = await assemblePrincipal(managerUserId, "high");
    if (!p2) throw new Error("could not assemble manager principal");
    plainManager = p2;

    const memberUserId = await createUser("gh12-member@ex.test", "GH12 Member");
    await addMembership(T, memberUserId);
    const memberRoleId = await createRole("member", null);
    await grantRole(memberUserId, memberRoleId, "company", T);
    const p3 = await assemblePrincipal(memberUserId, "high");
    if (!p3) throw new Error("could not assemble member principal");
    plainMember = p3;
  });

  afterAll(async () => {
    await teardownTestDb();
    config.githubOrg = savedOrg;
  });

  beforeEach(() => {
    vi.mocked(githubAppService.githubRequest).mockReset();
    config.githubOrg = "gaiadabali";
  });

  it("the migration widened origin to admit 'github' — the INSERT itself is the proof", async () => {
    const id = await fileRow(GITHUB_CREATE_REPO_WORKFLOW, { name: "proof-repo" }, companyAdmin.userId!);
    expect(isGithubRepoCreationRequest("github", GITHUB_CREATE_REPO_WORKFLOW)).toBe(true);
    const { rows } = await withTenants([T], (c) =>
      c.query<{ origin: string }>(`SELECT origin FROM automation_approvals WHERE id = $1`, [id]),
    );
    expect(rows[0]?.origin).toBe("github");
  });

  it("🔴 THE REAL GATE — a plain member (no create_repo reach in resource_github_repo.yaml) is DENIED, real Cerbos, zero GitHub calls", async () => {
    const id = await fileRow(GITHUB_CREATE_REPO_WORKFLOW, { name: "member-repo" }, companyAdmin.userId!);
    await expect(executeApprovedGithubRepoCreation(T, id, { name: "member-repo" }, plainMember)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(githubAppService.githubRequest).not.toHaveBeenCalled();
  });

  it("🔴 a plain manager (create_repo is company_admin-ONLY in the policy) is ALSO denied", async () => {
    const id = await fileRow(GITHUB_CREATE_REPO_WORKFLOW, { name: "manager-repo" }, companyAdmin.userId!);
    await expect(executeApprovedGithubRepoCreation(T, id, { name: "manager-repo" }, plainManager)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(githubAppService.githubRequest).not.toHaveBeenCalled();
  });

  it("company_admin with this approval's own id as approvalId is ALLOWED — the ledger records attempted then succeeded", async () => {
    vi.mocked(githubAppService.githubRequest).mockResolvedValue({
      data: { full_name: "gaiadabali/admin-repo", html_url: "https://github.com/gaiadabali/admin-repo", default_branch: "main" },
      status: 201,
      rateLimit: { limit: 12500, remaining: 12499, resetAtMs: null },
    });
    const id = await fileRow(GITHUB_CREATE_REPO_WORKFLOW, { name: "admin-repo" }, companyAdmin.userId!);
    const result = await executeApprovedGithubRepoCreation(T, id, { name: "admin-repo" }, companyAdmin);
    expect(result.fullName).toBe("gaiadabali/admin-repo");
    expect(githubAppService.githubRequest).toHaveBeenCalledTimes(1);

    // §4.3: the row is written BEFORE the call — both rows must exist, attempted first.
    const outcomes = await activityOutcomes("gaiadabali/admin-repo");
    expect(outcomes).toContain("attempted");
    expect(outcomes).toContain("succeeded");
    expect(outcomes.indexOf("attempted")).toBeLessThan(outcomes.indexOf("succeeded"));
  });

  it("🔴 a failed GitHub call still leaves an 'attempted' + 'failed' ledger pair — §4.3's crash-still-leaves-evidence guarantee", async () => {
    vi.mocked(githubAppService.githubRequest).mockRejectedValue(new Error("422 name already exists"));
    const id = await fileRow(GITHUB_CREATE_REPO_WORKFLOW, { name: "dup-repo" }, companyAdmin.userId!);
    await expect(executeApprovedGithubRepoCreation(T, id, { name: "dup-repo" }, companyAdmin)).rejects.toThrow(
      /422 name already exists/,
    );
    const outcomes = await activityOutcomes("gaiadabali/dup-repo");
    expect(outcomes).toContain("attempted");
    expect(outcomes).toContain("failed");
  });
});
