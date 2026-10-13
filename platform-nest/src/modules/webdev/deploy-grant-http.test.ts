// M6-P4g — `POST` / `DELETE /api/:tenantId/modules/webdev/provisioned-sites/:id/deploy-grant` over HTTP, isolated app
// (WebdevController only, the scaffold-commit-http.test.ts posture), with REAL Postgres and REAL Cerbos and GitHub faked at
// the chokepoint (`githubRequest` -> core/github/git-data.testkit.ts). What only this layer can prove:
//   * the two existing gates, unchanged policy: `webdev_provisioned_site · provision` on the request tenant and
//     `github_repo · push` on the org tenant — a member is refused (with a VALID body, so validation cannot pre-empt
//     the authorization under test), a manager passes;
//   * a revoke's reason is validated only after authorization;
//   * a refusal answers its token as `{error, reason}` with the token's status, never a body-less 500;
//   * `GET provisioned-sites/:id` shows the grant as the additive `deployGrant` object.
import { createHash } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { HttpErrorFilter } from "../../http-error.filter";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../../testing/fixtures";
import { newId } from "../../db";
import * as githubAppService from "../../core/github/github-app.service";
import { FakeGithub } from "../../core/github/git-data.testkit";
import { GITHUB_CREATE_REPO_WORKFLOW } from "../../core/github/repo-creation";
import { fileAutomationApproval } from "../../core/approval-filing";
import { WebdevController } from "./webdev.controller";
import { siteDeploySecretName } from "./deploy-grant";

vi.mock("../../core/github/github-app.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/github/github-app.service")>();
  return { ...actual, githubRequest: vi.fn() };
});

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const ORG = "acme-org";
const GRANT = "WEBDESK_DEPLOY_GRANT";
const REASON = { reason: "the client's contract ended" };
const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

async function buildIsolatedApp(): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({ controllers: [WebdevController] }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: false, abortOnError: false });
  app.useGlobalFilters(new HttpErrorFilter());
  await app.init();
  return app;
}

describe.skipIf(!TEST_URL)("M6-P4g · deploy-grant routes (HTTP, isolated app, real Cerbos)", () => {
  let app: NestFastifyApplication;
  let tenant: string;
  let manager: string;
  let member: string;
  let gh: FakeGithub;
  const saved = { org: config.githubOrg, orgTenant: config.githubOrgTenantId, names: config.webdeskDeploySecretNames };

  /** A provisioned, completed site whose scaffold is committed (lock on the default branch), with its fake repo. */
  async function committedSite(opts: { committed?: boolean; siteSecret?: boolean } = {}) {
    const slug = `p4gh-${newId().slice(-12)}`; // uuidv7: the first 8 hex are a timestamp prefix (shared for ~65 s), the tail is random
    const runId = newId();
    const db = adminPool();
    await db.query(`INSERT INTO pipeline_runs (id, tenant_id, status, origin_site) VALUES ($1, $2, 'delivery_active', 'main')`, [runId, tenant]);
    const filed = await fileAutomationApproval({
      tenantId: tenant, workflowId: GITHUB_CREATE_REPO_WORKFLOW, toolName: "github.createRepo",
      toolArgs: { name: slug, private: true }, impact: "high", origin: "github", requestedBy: manager,
    });
    await db.query(`UPDATE automation_approvals SET status = 'approved' WHERE id = $1`, [filed.id]);
    const webdevSiteId = newId();
    await db.query(
      `INSERT INTO webdev_sites (id, tenant_id, domain, environment, kind, repo_url, adoption, origin, origin_site)
       VALUES ($1, $2, $3, 'staging', 'static', $4, 'mandated', 'provisioned', 'main')`,
      [webdevSiteId, tenant, `${slug}.provisioned.invalid`, `https://github.com/${ORG}/${slug}`],
    );
    const snapshotId = newId();
    const contentHash = `sha256:${sha256(Buffer.from(slug))}`;
    await db.query(
      `INSERT INTO webdev_contract_snapshots (id, tenant_id, webdesk_tenant_slug, contract_version, vocabulary_version, content_hash, artifacts, origin_site)
       VALUES ($1, $2, $3, '1.0.0', '1.1.0', $4, '{}'::jsonb, 'main')`,
      [snapshotId, tenant, slug, contentHash],
    );
    const id = newId();
    await db.query(
      `INSERT INTO webdev_provisioned_sites
         (id, tenant_id, pipeline_run_id, provider, provider_ref, slug, framework, status, repo_url, requested_by, origin_site,
          completion_state, webdev_site_id, webdesk_tenant_slug, contract_snapshot_id, completion_updated_at)
       VALUES ($1, $2, $3, 'erp_repo', $4, $5, 'astro', 'live', $6, $7, 'main', 'complete', $8, $5, $9, now())`,
      [id, tenant, runId, filed.id, slug, `https://github.com/${ORG}/${slug}`, manager, webdevSiteId, snapshotId],
    );
    gh = new FakeGithub(ORG, slug);
    const base = gh.seedTemplate({ "README.md": "# template\n" });
    const lock = JSON.stringify({ blockLibraryVersion: "", contentHash, contractVersion: "1.0.0", snapshotId, vocabularyVersion: "1.1.0" }, null, 2) + "\n";
    const commit = gh.pushHumanCommit({ "CONTRACT.lock": lock });
    gh.addOrgSecret(GRANT);
    // M6-P6f: the per-site name ends in the repository id (the fake repo's), which a site's own workflow knows as github.repository_id
    const siteSecret = siteDeploySecretName({ slug, environment: "staging", repositoryId: gh.repoId });
    if (opts.siteSecret !== false) gh.addOrgSecret(siteSecret);
    if (opts.committed !== false) {
      await db.query(
        `UPDATE webdev_provisioned_sites
            SET scaffold_state = 'committed', scaffold_manifest_sha256 = $2, scaffold_snapshot_id = $3, scaffold_branch = 'main',
                scaffold_base_sha = $4, scaffold_tree_sha = $5, scaffold_commit_sha = $5, scaffold_committed_at = now()
          WHERE id = $1`,
        [id, "d".repeat(64), snapshotId, base, commit],
      );
    }
    const call = gh.caller();
    vi.mocked(githubAppService.githubRequest).mockImplementation(((_t: string, _r: string, _a: string, req: never) => call(req)) as never);
    return { id, slug, siteSecret };
  }

  const url = (siteId: string) => `/api/${tenant}/modules/webdev/provisioned-sites/${siteId}/deploy-grant`;
  const grant = (siteId: string, user: string) => app.inject({ method: "POST", url: url(siteId), headers: asUser(user) });
  const revoke = (siteId: string, user: string, payload: unknown) =>
    app.inject({ method: "DELETE", url: url(siteId), headers: asUser(user), payload: payload as Record<string, unknown> });

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    tenant = await createCompany("P4g HTTP Co", ["webdev"]);
    manager = await createUser("p4g-http-manager@a.test", "P4g Manager");
    member = await createUser("p4g-http-member@a.test", "P4g Member");
    await addMembership(tenant, manager);
    await addMembership(tenant, member);
    await grantRole(manager, await createRole("manager"), "company", tenant);
    await grantRole(member, await createRole("member"), "company", tenant);
    config.githubOrg = ORG;
    config.githubOrgTenantId = tenant;
    config.webdeskDeploySecretNames = "";
    app = await buildIsolatedApp();
  });
  afterAll(async () => {
    config.githubOrg = saved.org;
    config.githubOrgTenantId = saved.orgTenant;
    config.webdeskDeploySecretNames = saved.names;
    await app.close();
    await teardownTestDb();
  });
  // A block body on purpose: a function RETURNED from beforeEach is a cleanup hook, and mockReset() returns the mock,
  // so vitest would call githubRequest with no arguments after every test.
  beforeEach(() => {
    vi.mocked(githubAppService.githubRequest).mockReset();
  });

  it("401 without a credential, on both routes", async () => {
    expect((await app.inject({ method: "POST", url: url(newId()) })).statusCode).toBe(401);
    expect((await app.inject({ method: "DELETE", url: url(newId()), payload: REASON })).statusCode).toBe(401);
  });

  it("403 for a member on POST and on DELETE with a VALID reason (no `provision`); GitHub is never asked", async () => {
    const s = await committedSite();
    expect((await grant(s.id, member)).statusCode).toBe(403);
    expect((await revoke(s.id, member, REASON)).statusCode).toBe(403);
    // and a malformed body does not change the answer: authorization comes first
    expect((await revoke(s.id, member, { reason: "x" })).statusCode).toBe(403);
    expect(githubAppService.githubRequest).not.toHaveBeenCalled();
  });

  it("200 for a manager: grant, GET shows `deployGrant`, revoke with a reason; every call is the ERP App on the org tenant", async () => {
    const s = await committedSite();
    const g = await grant(s.id, manager);
    expect(g.statusCode).toBe(200);
    expect(g.json()).toMatchObject({
      outcome: "granted", state: "granted", repo: `${ORG}/${s.slug}`, siteSecretName: s.siteSecret, pending: [],
      secrets: [{ name: GRANT, result: "granted" }, { name: s.siteSecret, result: "granted" }],
    });
    expect(gh.orgSecrets.get(GRANT)!.repos.has(gh.repoId)).toBe(true);
    for (const c of vi.mocked(githubAppService.githubRequest).mock.calls) expect(c.slice(0, 2)).toEqual([tenant, "erp"]);

    const again = await grant(s.id, manager);
    expect(again.json()).toMatchObject({ outcome: "granted", state: "granted" });

    const got = await app.inject({ method: "GET", url: `/api/${tenant}/modules/webdev/provisioned-sites/${s.id}`, headers: asUser(manager) });
    expect(got.statusCode).toBe(200);
    expect(got.json().deployGrant).toMatchObject({
      state: "granted", secretNames: [GRANT, s.siteSecret], siteSecretName: s.siteSecret, siteSecretNote: null, pendingNames: [], repositoryId: gh.repoId, error: null,
    });

    const short = await revoke(s.id, manager, { reason: "no" });
    expect(short.statusCode).toBe(422);
    expect(short.json()).toMatchObject({ error: "deploy_grant_reason_required" });

    const r = await revoke(s.id, manager, REASON);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ outcome: "revoked", state: "revoked" });
    expect(gh.orgSecrets.get(GRANT)!.repos.size).toBe(0);
    const after = await app.inject({ method: "GET", url: `/api/${tenant}/modules/webdev/provisioned-sites/${s.id}`, headers: asUser(manager) });
    expect(after.json().deployGrant).toMatchObject({ state: "revoked", secretNames: [], revokeReason: REASON.reason });
  });

  it("refusals carry their token and status: 409 not committed, 503 permission missing (organization_secrets), 404 bad id", async () => {
    const uncommitted = await committedSite({ committed: false });
    const r1 = await grant(uncommitted.id, manager);
    expect(r1.statusCode).toBe(409);
    expect(r1.json()).toMatchObject({ error: "deploy_grant_not_committed" });

    const s = await committedSite();
    gh.orgSecretsPermission = false;
    const r2 = await grant(s.id, manager);
    expect(r2.statusCode).toBe(503);
    expect(r2.json()).toMatchObject({ error: "github_permission_missing" });
    expect(String(r2.json().reason)).toMatch(/^organization_secrets: /);

    expect((await grant("not-a-uuid", manager)).statusCode).toBe(404);
    expect((await revoke("not-a-uuid", manager, REASON)).statusCode).toBe(404);
  });

  it("a per-site secret the owner has not created yet: 200 `pending`, the name reported, no error", async () => {
    const s = await committedSite({ siteSecret: false });
    const r = await grant(s.id, manager);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ outcome: "pending", state: "pending", pending: [s.siteSecret], error: null });
  });
});
