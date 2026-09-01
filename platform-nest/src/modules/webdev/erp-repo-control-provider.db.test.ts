// WSK-D33 — `ErpRepoControlProvider` against REAL Postgres (RLS, FORCE, the automation_approvals
// wall) with `githubRequest` (GH-01/GH-02's chokepoint) MOCKED — same discipline
// `repo-creation.db.test.ts` and `repo-sync.service.test.ts` already established: never call the
// live GitHub API from a test.
//
// WHAT THIS SUITE IS TRYING TO FALSIFY:
//   1. `createProject` files a real GH-12 `automation_approvals` row (origin='github',
//      workflow_id='github:create_repo') from the CONFIGURED per-kind template — never a hardcoded
//      name — and the row is genuinely tenant-scoped (RLS-visible only inside `withTenants([T])`).
//   2. `wp` is now provisionable end-to-end when `ERP_REPO_TEMPLATE_WP` is configured, and refused
//      HONESTLY (422, naming the missing env var) when it is not — never a blanket refusal.
//   3. CRASH-RESUME: a second `createProject` call for the same name (simulating
//      `reconcileProvisionedSite`'s resume arm re-firing before `provider_ref` was ever recorded)
//      ADOPTS the existing pending/approved request instead of filing a duplicate — the structural
//      guard against two humans independently approving two repos for the same slug.
//   4. `getProject` correctly distinguishes pending / rejected / approved-and-live /
//      approved-but-not-yet-visible, using GitHub (mocked) as the source of truth once approved —
//      never trusting the approval row alone for the terminal state.
//   5. The full `provisionSite()` -> `ErpRepoControlProvider` path (PRV-02's idempotency core,
//      unmodified) produces a `webdev_provisioned_sites` row with `provider='erp_repo'`,
//      `provider_ref` = the approval id, `status='pending'`.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createUser, addMembership } from "../../testing/fixtures";
import { newId, withTenants } from "../../db";
import { config } from "../../config";
import * as githubAppService from "../../core/github/github-app.service";
import { GithubApiError } from "../../core/github/errors";
import { GITHUB_CREATE_REPO_WORKFLOW } from "../../core/github/repo-creation";
import { ErpRepoControlProvider, createErpRepoControlProvider, ErpRepoControlNotConfiguredError } from "./erp-repo-control-provider";
import { provisionSite, reconcileProvisionedSite } from "./provisioning.service";
import { fileAutomationApproval } from "../../core/approval-filing";

vi.mock("../../core/github/github-app.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/github/github-app.service")>();
  return { ...actual, githubRequest: vi.fn() };
});

const live = Boolean(TEST_URL);

describe.skipIf(!live)("ErpRepoControlProvider (real Postgres, mocked GitHub)", () => {
  let T: string;
  let userId: string;
  const savedOrg = config.githubOrg;
  const savedTemplates = { ...config.erpRepoTemplates };

  async function approvalRow(id: string): Promise<{ status: string; tool_args: Record<string, unknown> } | null> {
    const r = await adminPool().query(
      `SELECT status, tool_args FROM automation_approvals WHERE id = $1`,
      [id],
    );
    return r.rows[0] ?? null;
  }

  async function countApprovalsForName(name: string): Promise<number> {
    const r = await adminPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM automation_approvals
        WHERE origin = 'github' AND workflow_id = $1 AND tool_args->>'name' = $2`,
      [GITHUB_CREATE_REPO_WORKFLOW, name],
    );
    return Number(r.rows[0]?.n ?? "0");
  }

  beforeAll(async () => {
    await initTestDb();
    T = await createCompany("ERP Repo Control Co", ["webdev"]);
    userId = await createUser("erp-repo-control@ex.test", "ERP Repo Control User");
    await addMembership(T, userId);
  });

  afterAll(async () => {
    config.githubOrg = savedOrg;
    Object.assign(config.erpRepoTemplates, savedTemplates);
    await teardownTestDb();
  });

  beforeEach(() => {
    vi.mocked(githubAppService.githubRequest).mockReset();
    config.githubOrg = "gaiadabali";
    config.erpRepoTemplates.static = "gaiadabali/erp-repo-template-static";
    config.erpRepoTemplates.fullstack = "gaiadabali/erp-repo-template-fullstack";
    config.erpRepoTemplates.wp = ""; // unset by default — each test that needs it sets it explicitly
  });

  describe("driver construction", () => {
    it("throws ErpRepoControlNotConfiguredError when GITHUB_ORG is unset", () => {
      config.githubOrg = "";
      expect(() => createErpRepoControlProvider(T, userId)).toThrow(ErpRepoControlNotConfiguredError);
    });

    it("constructs cleanly when GITHUB_ORG is set, independent of any per-kind template", () => {
      expect(() => createErpRepoControlProvider(T, userId)).not.toThrow();
    });
  });

  describe("createProject", () => {
    it("files a real GH-12 approval from the CONFIGURED static template, never a hardcoded name", async () => {
      const provider = new ErpRepoControlProvider(T, userId);
      const name = `site-${newId().slice(0, 8)}`;
      const result = await provider.createProject({ name, framework: "vite", devName: "Test Site" });
      expect(result.outcome).toBe("accepted");
      if (result.outcome !== "accepted") return;
      expect(result.project.status).toBe("pending");
      expect(result.project.repoUrl).toBeNull();

      const row = await approvalRow(result.project.id);
      expect(row).not.toBeNull();
      expect(row!.status).toBe("pending");
      expect(row!.tool_args).toMatchObject({
        name,
        private: true,
        templateOwner: "gaiadabali",
        templateRepo: "erp-repo-template-static",
      });
    });

    it("maps astro/node aliases to the same static/fullstack templates as vite/nextjs", async () => {
      const provider = new ErpRepoControlProvider(T, userId);
      const astroName = `astro-${newId().slice(0, 8)}`;
      const nodeName = `node-${newId().slice(0, 8)}`;
      const astroResult = await provider.createProject({ name: astroName, framework: "astro", devName: "x" });
      const nodeResult = await provider.createProject({ name: nodeName, framework: "node", devName: "x" });
      expect(astroResult.outcome).toBe("accepted");
      expect(nodeResult.outcome).toBe("accepted");
      if (astroResult.outcome !== "accepted" || nodeResult.outcome !== "accepted") return;
      const astroRow = await approvalRow(astroResult.project.id);
      const nodeRow = await approvalRow(nodeResult.project.id);
      expect(astroRow!.tool_args).toMatchObject({ templateOwner: "gaiadabali", templateRepo: "erp-repo-template-static" });
      expect(nodeRow!.tool_args).toMatchObject({ templateOwner: "gaiadabali", templateRepo: "erp-repo-template-fullstack" });
    });

    it("refuses wp HONESTLY (422, naming the missing env var) when ERP_REPO_TEMPLATE_WP is unset", async () => {
      const provider = new ErpRepoControlProvider(T, userId);
      const name = `wp-${newId().slice(0, 8)}`;
      const result = await provider.createProject({ name, framework: "wp", devName: "x" });
      expect(result.outcome).toBe("rejected");
      if (result.outcome !== "rejected") return;
      expect(result.status).toBe(422);
      expect(result.reason).toContain("ERP_REPO_TEMPLATE_WP");
      expect(await countApprovalsForName(name)).toBe(0);
    });

    it("PROVISIONS wp once ERP_REPO_TEMPLATE_WP is configured — the whole point of lifting the old refusal", async () => {
      config.erpRepoTemplates.wp = "gaiadabali/erp-repo-template-wp";
      const provider = new ErpRepoControlProvider(T, userId);
      const name = `wp-${newId().slice(0, 8)}`;
      const result = await provider.createProject({ name, framework: "wp", devName: "x" });
      expect(result.outcome).toBe("accepted");
      if (result.outcome !== "accepted") return;
      const row = await approvalRow(result.project.id);
      expect(row!.tool_args).toMatchObject({ templateOwner: "gaiadabali", templateRepo: "erp-repo-template-wp" });
    });

    it("refuses (422) when no authenticated requester is available", async () => {
      const provider = new ErpRepoControlProvider(T, null);
      const result = await provider.createProject({ name: `anon-${newId().slice(0, 8)}`, framework: "vite", devName: "x" });
      expect(result.outcome).toBe("rejected");
      if (result.outcome !== "rejected") return;
      expect(result.status).toBe(422);
    });

    it("CRASH-RESUME: a second call for the same name ADOPTS the existing pending request, never files a duplicate", async () => {
      const provider = new ErpRepoControlProvider(T, userId);
      const name = `resume-${newId().slice(0, 8)}`;
      const first = await provider.createProject({ name, framework: "vite", devName: "x" });
      const second = await provider.createProject({ name, framework: "vite", devName: "x" });
      expect(first.outcome).toBe("accepted");
      expect(second.outcome).toBe("accepted");
      if (first.outcome !== "accepted" || second.outcome !== "accepted") return;
      expect(second.project.id).toBe(first.project.id);
      expect(await countApprovalsForName(name)).toBe(1);
    });

    it("CRASH-RESUME also adopts an already-APPROVED request (not just pending)", async () => {
      const provider = new ErpRepoControlProvider(T, userId);
      const name = `resume-approved-${newId().slice(0, 8)}`;
      const first = await provider.createProject({ name, framework: "vite", devName: "x" });
      if (first.outcome !== "accepted") throw new Error("setup failed");
      await adminPool().query(`UPDATE automation_approvals SET status = 'approved' WHERE id = $1`, [first.project.id]);

      const second = await provider.createProject({ name, framework: "vite", devName: "x" });
      expect(second.outcome).toBe("accepted");
      if (second.outcome !== "accepted") return;
      expect(second.project.id).toBe(first.project.id);
      expect(await countApprovalsForName(name)).toBe(1);
    });

    it("does NOT adopt a REJECTED request — files a fresh one instead (a decline is not in-flight)", async () => {
      const provider = new ErpRepoControlProvider(T, userId);
      const name = `resume-rejected-${newId().slice(0, 8)}`;
      const first = await provider.createProject({ name, framework: "vite", devName: "x" });
      if (first.outcome !== "accepted") throw new Error("setup failed");
      await adminPool().query(`UPDATE automation_approvals SET status = 'rejected' WHERE id = $1`, [first.project.id]);

      const second = await provider.createProject({ name, framework: "vite", devName: "x" });
      expect(second.outcome).toBe("accepted");
      if (second.outcome !== "accepted") return;
      expect(second.project.id).not.toBe(first.project.id);
      expect(await countApprovalsForName(name)).toBe(2);
    });
  });

  describe("getProject", () => {
    it("returns 'pending' for a still-pending approval, without ever asking GitHub", async () => {
      const provider = new ErpRepoControlProvider(T, userId);
      const name = `poll-pending-${newId().slice(0, 8)}`;
      const filed = await fileAutomationApproval({
        tenantId: T, workflowId: GITHUB_CREATE_REPO_WORKFLOW, toolName: "github.createRepo",
        toolArgs: { name, private: true }, impact: "high", origin: "github", requestedBy: userId,
      });
      const project = await provider.getProject(filed.id);
      expect(project).toMatchObject({ status: "pending", name, repoUrl: null });
      expect(githubAppService.githubRequest).not.toHaveBeenCalled();
    });

    it("returns 'failed' for a rejected approval", async () => {
      const provider = new ErpRepoControlProvider(T, userId);
      const name = `poll-rejected-${newId().slice(0, 8)}`;
      const filed = await fileAutomationApproval({
        tenantId: T, workflowId: GITHUB_CREATE_REPO_WORKFLOW, toolName: "github.createRepo",
        toolArgs: { name, private: true }, impact: "high", origin: "github", requestedBy: userId,
      });
      await adminPool().query(`UPDATE automation_approvals SET status = 'rejected' WHERE id = $1`, [filed.id]);
      const project = await provider.getProject(filed.id);
      expect(project).toMatchObject({ status: "failed" });
    });

    it("returns 'live' + the real repoUrl once approved AND GitHub confirms the repo exists", async () => {
      const provider = new ErpRepoControlProvider(T, userId);
      const name = `poll-live-${newId().slice(0, 8)}`;
      const filed = await fileAutomationApproval({
        tenantId: T, workflowId: GITHUB_CREATE_REPO_WORKFLOW, toolName: "github.createRepo",
        toolArgs: { name, private: true }, impact: "high", origin: "github", requestedBy: userId,
      });
      await adminPool().query(`UPDATE automation_approvals SET status = 'approved' WHERE id = $1`, [filed.id]);
      vi.mocked(githubAppService.githubRequest).mockResolvedValueOnce({
        data: { full_name: `gaiadabali/${name}`, html_url: `https://github.com/gaiadabali/${name}` },
        status: 200,
      } as never);

      const project = await provider.getProject(filed.id);
      expect(project).toMatchObject({ status: "live", repoUrl: `https://github.com/gaiadabali/${name}` });
      // Least privilege: the poll goes through the READ-ONLY 'agents' App, not 'erp'.
      expect(githubAppService.githubRequest).toHaveBeenCalledWith(
        T, "agents", expect.any(String),
        expect.objectContaining({ method: "GET", path: `/repos/gaiadabali/${name}` }),
      );
    });

    it("stays 'pending' when approved but GitHub has not made the repo visible yet (404) — honest, not final", async () => {
      const provider = new ErpRepoControlProvider(T, userId);
      const name = `poll-not-yet-${newId().slice(0, 8)}`;
      const filed = await fileAutomationApproval({
        tenantId: T, workflowId: GITHUB_CREATE_REPO_WORKFLOW, toolName: "github.createRepo",
        toolArgs: { name, private: true }, impact: "high", origin: "github", requestedBy: userId,
      });
      await adminPool().query(`UPDATE automation_approvals SET status = 'approved' WHERE id = $1`, [filed.id]);
      vi.mocked(githubAppService.githubRequest).mockRejectedValueOnce(new GithubApiError("get repo", 404, "Not Found"));

      const project = await provider.getProject(filed.id);
      expect(project).toMatchObject({ status: "pending" });
    });

    it("returns null for an approval id that does not exist (RLS-invisible or gone)", async () => {
      const provider = new ErpRepoControlProvider(T, userId);
      expect(await provider.getProject(newId())).toBeNull();
    });
  });

  describe("findProjectByName", () => {
    it("returns the live repo when GitHub has it", async () => {
      const provider = new ErpRepoControlProvider(T, userId);
      vi.mocked(githubAppService.githubRequest).mockResolvedValueOnce({
        data: { full_name: "gaiadabali/existing-repo", html_url: "https://github.com/gaiadabali/existing-repo" },
        status: 200,
      } as never);
      const project = await provider.findProjectByName("existing-repo");
      expect(project).toMatchObject({ status: "live", repoUrl: "https://github.com/gaiadabali/existing-repo" });
    });

    it("returns null when the name is free", async () => {
      const provider = new ErpRepoControlProvider(T, userId);
      vi.mocked(githubAppService.githubRequest).mockRejectedValueOnce(new GithubApiError("get repo", 404));
      expect(await provider.findProjectByName("free-name")).toBeNull();
    });
  });

  describe("end to end through provisionSite() (PRV-02's idempotency core, unmodified)", () => {
    it("produces a webdev_provisioned_sites row with provider='erp_repo' and provider_ref=the approval id", async () => {
      const provider = new ErpRepoControlProvider(T, userId);
      const slug = `e2e-${newId().slice(0, 8)}`;
      const outcome = await provisionSite({
        tenantId: T, provider, runId: null, slug, framework: "vite",
        requestedBy: userId, requestedByName: "Test User",
      });
      expect(outcome.outcome).toBe("created");
      if (outcome.outcome !== "created") return;
      expect(outcome.site.provider).toBe("erp_repo");
      expect(outcome.site.status).toBe("pending");
      expect(outcome.site.providerRef).toBeTruthy();

      const row = await approvalRow(outcome.site.providerRef!);
      expect(row).not.toBeNull();
      expect(row!.tool_args).toMatchObject({ name: slug });
    });

    it("stack='wp' selects the wp kind end to end when ERP_REPO_TEMPLATE_WP is configured", async () => {
      config.erpRepoTemplates.wp = "gaiadabali/erp-repo-template-wp";
      const provider = new ErpRepoControlProvider(T, userId);
      const slug = `e2e-wp-${newId().slice(0, 8)}`;
      const outcome = await provisionSite({
        tenantId: T, provider, runId: null, slug, stack: "wp",
        requestedBy: userId, requestedByName: "Test User",
      });
      expect(outcome.outcome).toBe("created");
      if (outcome.outcome !== "created") return;
      expect(outcome.site.framework).toBe("wp");
      const row = await approvalRow(outcome.site.providerRef!);
      expect(row!.tool_args).toMatchObject({ templateOwner: "gaiadabali", templateRepo: "erp-repo-template-wp" });
    });

    it("CRASH-RESUME at the reconcile layer: a 'requested' row whose approval was already filed adopts it, never files a second", async () => {
      // Simulates the exact residual window this file's header documents: `fileAutomationApproval`'s
      // OWN transaction committed (the approval row is real and durable) but the OUTER
      // `provisionSite`/`performEgress` transaction never got to write `provider_ref` back onto the
      // site row — built by hand here because provoking the real race is what
      // `provisioning-idempotency.test.ts` already does for the OTHER driver; this test proves the
      // NEW driver's OWN dedup closes the gap that race would otherwise reopen.
      const slug = `crash-resume-${newId().slice(0, 8)}`;
      const filed = await fileAutomationApproval({
        tenantId: T, workflowId: GITHUB_CREATE_REPO_WORKFLOW, toolName: "github.createRepo",
        toolArgs: {
          name: slug, private: true, templateOwner: "gaiadabali", templateRepo: "erp-repo-template-static",
        },
        impact: "high", origin: "github", requestedBy: userId,
      });
      const siteId = newId();
      await withTenants(
        [T],
        (c) =>
          c.query(
            `INSERT INTO webdev_provisioned_sites
               (id, tenant_id, provider, slug, framework, status, requested_by, origin_site)
             VALUES ($1, $2, 'erp_repo', $3, 'vite', 'requested', $4, 'main')`,
            [siteId, T, slug, userId],
          ),
        { modules: ["webdev"] },
      );

      const provider = new ErpRepoControlProvider(T, userId);
      const result = await reconcileProvisionedSite({
        tenantId: T, siteId, provider, requestedByName: "Test User",
      });
      expect(result.outcome).toBe("created");
      if (result.outcome !== "created") return;
      expect(result.site.providerRef).toBe(filed.id);
      expect(await countApprovalsForName(slug)).toBe(1);
    });
  });
});
