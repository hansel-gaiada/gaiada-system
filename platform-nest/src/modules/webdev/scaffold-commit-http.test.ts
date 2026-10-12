// M6-P4b2 — `POST /api/:tenantId/modules/webdev/provisioned-sites/:id/scaffold-commit` over HTTP, isolated app
// (WebdevController only, the console-reads-http.test.ts posture), with REAL Postgres and REAL Cerbos and GitHub faked at
// the chokepoint (`githubRequest` -> core/github/git-data.testkit.ts). What only this layer can prove:
//   * the two existing gates, unchanged policy: `webdev_provisioned_site · provision` on the request tenant and
//     `github_repo · push` on the org tenant — a member is refused, a manager (the wf:delivery tier) passes;
//   * a refusal answers its token as `{error, reason}` with the token's status, never a body-less 500;
//   * `GET provisioned-sites/:id` shows the result as the additive `scaffold` object.
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

vi.mock("../../core/github/github-app.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/github/github-app.service")>();
  return { ...actual, githubRequest: vi.fn() };
});

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const ORG = "acme-org";
const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
const file = (path: string, content: string) => {
  const b = Buffer.from(content, "utf8");
  return { path, base64: b.toString("base64"), sha256: sha256(b), bytes: b.byteLength };
};

async function buildIsolatedApp(): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({ controllers: [WebdevController] }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: false, abortOnError: false });
  app.useGlobalFilters(new HttpErrorFilter());
  await app.init();
  return app;
}

describe.skipIf(!TEST_URL)("M6-P4b2 · scaffold-commit route (HTTP, isolated app, real Cerbos)", () => {
  let app: NestFastifyApplication;
  let tenant: string;
  let manager: string;
  let member: string;
  let gh: FakeGithub;
  const saved = { org: config.githubOrg, orgTenant: config.githubOrgTenantId };

  async function completeSite() {
    const slug = `p4b2h-${newId().slice(-12)}`; // uuidv7: the first 8 hex are a timestamp prefix (shared for ~65 s), the tail is random
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
    gh.seedTemplate({ "README.md": "# template\n" });
    const call = gh.caller();
    vi.mocked(githubAppService.githubRequest).mockImplementation(((_t: string, _r: string, _a: string, req: never) => call(req)) as never);
    const lock = JSON.stringify({ blockLibraryVersion: "", contentHash, contractVersion: "1.0.0", snapshotId, vocabularyVersion: "1.1.0" }, null, 2) + "\n";
    const files = [file("CONTRACT.lock", lock), file("src/pages/index.astro", "<h1>Home</h1>\n")];
    return { id, runId, slug, files };
  }

  const post = (siteId: string, user: string, payload: unknown) =>
    app.inject({ method: "POST", url: `/api/${tenant}/modules/webdev/provisioned-sites/${siteId}/scaffold-commit`, headers: asUser(user), payload: payload as Record<string, unknown> });

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    tenant = await createCompany("P4b2 HTTP Co", ["webdev"]);
    manager = await createUser("p4b2-http-manager@a.test", "P4b2 Manager");
    member = await createUser("p4b2-http-member@a.test", "P4b2 Member");
    await addMembership(tenant, manager);
    await addMembership(tenant, member);
    await grantRole(manager, await createRole("manager"), "company", tenant);
    await grantRole(member, await createRole("member"), "company", tenant);
    config.githubOrg = ORG;
    config.githubOrgTenantId = tenant;
    app = await buildIsolatedApp();
  });
  afterAll(async () => {
    config.githubOrg = saved.org;
    config.githubOrgTenantId = saved.orgTenant;
    await app.close();
    await teardownTestDb();
  });
  // A block body on purpose: a function RETURNED from beforeEach is a cleanup hook, and mockReset() returns the mock,
  // so vitest would call githubRequest with no arguments after every test.
  beforeEach(() => {
    vi.mocked(githubAppService.githubRequest).mockReset();
  });

  it("401 without a credential", async () => {
    const r = await app.inject({ method: "POST", url: `/api/${tenant}/modules/webdev/provisioned-sites/${newId()}/scaffold-commit`, payload: {} });
    expect(r.statusCode).toBe(401);
  });

  it("403 for a member (no `provision` on webdev_provisioned_site); GitHub is never asked", async () => {
    const s = await completeSite();
    const r = await post(s.id, member, { runId: s.runId, files: s.files });
    expect(r.statusCode).toBe(403);
    expect(githubAppService.githubRequest).not.toHaveBeenCalled();
  });

  it("200 for a manager: the first fill lands, and GET shows `scaffold`", async () => {
    const s = await completeSite();
    const r = await post(s.id, manager, { runId: s.runId, files: s.files });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { outcome: string; commitSha: string; repo: string };
    expect(body).toMatchObject({ outcome: "committed", repo: `${ORG}/${s.slug}` });
    expect(gh.headOf()).toBe(body.commitSha);
    // every GitHub call used the ERP (write) App under the org tenant
    for (const c of vi.mocked(githubAppService.githubRequest).mock.calls) expect(c.slice(0, 2)).toEqual([tenant, "erp"]);

    const again = await post(s.id, manager, { runId: s.runId, files: s.files });
    expect(again.json()).toMatchObject({ outcome: "already_committed", commitSha: body.commitSha });

    const got = await app.inject({ method: "GET", url: `/api/${tenant}/modules/webdev/provisioned-sites/${s.id}`, headers: asUser(manager) });
    expect(got.statusCode).toBe(200);
    expect(got.json().scaffold).toMatchObject({ state: "committed", commitSha: body.commitSha, branch: "main", fileCount: 2, error: null });
  });

  it("refusals carry their token and status: 422 hash mismatch, 409 not pristine, 422 missing runId, 404 bad id", async () => {
    const s = await completeSite();
    const bad = [{ ...s.files[0] }, { ...s.files[1], sha256: "0".repeat(64) }];
    const r1 = await post(s.id, manager, { runId: s.runId, files: bad });
    expect(r1.statusCode).toBe(422);
    expect(r1.json()).toMatchObject({ error: "scaffold_hash_mismatch" });

    gh.pushHumanCommit({ "notes.md": "human" });
    const r2 = await post(s.id, manager, { runId: s.runId, files: s.files });
    expect(r2.statusCode).toBe(409);
    expect(r2.json()).toMatchObject({ error: "scaffold_repo_not_pristine" });
    expect(String(r2.json().reason)).toMatch(/parent/);

    const r3 = await post(s.id, manager, { files: s.files });
    expect(r3.statusCode).toBe(422);
    expect(r3.json()).toMatchObject({ error: "scaffold_manifest_invalid" });

    const r4 = await post("not-a-uuid", manager, { runId: s.runId, files: s.files });
    expect(r4.statusCode).toBe(404);
  });
});
