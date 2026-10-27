// M6-P6o (WSK-D88) — the deploy secret's three routes and the REAL decide() route, over HTTP, isolated app (WebdevController +
// AutomationApprovalsController), with REAL Postgres and REAL Cerbos (every policy unmodified) and GitHub faked at the
// chokepoint (`githubRequest` -> core/github/git-data.testkit.ts). What only this layer can prove:
//   * the seal is `integration_connection · manage`: a member is refused with a VALID body (validation cannot pre-empt the
//     gate), a manager seals, and the answer never carries the value;
//   * the filing is the deploy grant's pair: a member is refused, a company_admin files ONE high `github` approval;
//   * the approval: the requester (a company_admin) may NOT approve their own request (`self_approval`, the row stays
//     pending); a manager is refused by the generic `decide`; a SECOND company_admin approves and the write runs in-band;
//     re-presenting the decided approval is a 404 and writes nothing;
//   * O-3 over HTTP: the decide answers 200 (the decision stands) with the write `failed`, and the console shows `pending`
//     with `github_permission_missing: organization_secrets`, never success.
// Denial tests send VALID requests and are paired with an allowed control on the identical request.
import { randomBytes } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { HttpErrorFilter } from "../../http-error.filter";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient } from "../../testing/fixtures";
import { newId } from "../../db";
import * as githubAppService from "../../core/github/github-app.service";
import { FakeGithub } from "../../core/github/git-data.testkit";
import { GITHUB_CREATE_REPO_WORKFLOW } from "../../core/github/repo-creation";
import { fileAutomationApproval } from "../../core/approval-filing";
import { AutomationApprovalsController } from "../../core/automation-approvals.controller";
import { createConnection } from "../../core/integrations.service";
import { findSecretValueLeaks } from "../../testing/secret-value-leaks";
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
const canary = (tag: string): string => `canary-p6oh-${tag}-${randomBytes(12).toString("hex")}`;

async function buildIsolatedApp(): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({ controllers: [WebdevController, AutomationApprovalsController] }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: false, abortOnError: false });
  app.useGlobalFilters(new HttpErrorFilter());
  await app.init();
  return app;
}

describe.skipIf(!TEST_URL)("M6-P6o · deploy secret routes + decide (HTTP, isolated app, real Cerbos)", () => {
  let app: NestFastifyApplication;
  let tenant: string;
  let admin1: string;
  let admin2: string;
  let manager: string;
  let member: string;
  let gh: FakeGithub;
  const planted: Record<string, string> = {};
  const bodies: string[] = [];
  const saved = { org: config.githubOrg, orgTenant: config.githubOrgTenantId, names: config.webdeskDeploySecretNames, key: config.integrationTokenKey };

  const credential = (tag: string): Record<string, unknown> => {
    const password = canary(`pw-${tag}`);
    planted[tag] = password;
    return {
      version: 1, environment: "staging", transport: "sftp", host: "sftp.example.invalid", port: 65002, user: `u_${tag}`, password,
      knownHosts: "[sftp.example.invalid]:65002 ssh-ed25519 AAAAplaceholder", remoteBase: "/home/u/domains/stg", docroot: "public_html",
      siteUrl: "https://stg.example.invalid",
    };
  };

  /** A provisioned, completed, scaffolded site with its own client and an UNSEALED client-owned ssh record. */
  async function site() {
    const slug = `p6oh-${newId().slice(-12)}`;
    const runId = newId();
    const db = adminPool();
    await db.query(`INSERT INTO pipeline_runs (id, tenant_id, status, origin_site) VALUES ($1, $2, 'delivery_active', 'main')`, [runId, tenant]);
    const filed = await fileAutomationApproval({
      tenantId: tenant, workflowId: GITHUB_CREATE_REPO_WORKFLOW, toolName: "github.createRepo",
      toolArgs: { name: slug, private: true }, impact: "high", origin: "github", requestedBy: admin1,
    });
    await db.query(`UPDATE automation_approvals SET status = 'approved' WHERE id = $1`, [filed.id]);
    const clientId = await createClient(tenant, `P6o HTTP client ${slug}`);
    const webdevSiteId = newId();
    await db.query(
      `INSERT INTO webdev_sites (id, tenant_id, domain, environment, kind, repo_url, adoption, origin, origin_site, client_id)
       VALUES ($1, $2, $3, 'staging', 'static', $4, 'mandated', 'provisioned', 'main', $5)`,
      [webdevSiteId, tenant, `${slug}.provisioned.invalid`, `https://github.com/${ORG}/${slug}`, clientId],
    );
    const snapshotId = newId();
    const contentHash = `sha256:${"f".repeat(64)}`;
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
      [id, tenant, runId, filed.id, slug, `https://github.com/${ORG}/${slug}`, admin1, webdevSiteId, snapshotId],
    );
    gh = new FakeGithub(ORG, slug);
    await gh.useOrgKeyPair();
    const base = gh.seedTemplate({ "README.md": "# template\n" });
    const lock = JSON.stringify({ blockLibraryVersion: "", contentHash, contractVersion: "1.0.0", snapshotId, vocabularyVersion: "1.1.0" }, null, 2) + "\n";
    const commit = gh.pushHumanCommit({ "CONTRACT.lock": lock });
    gh.addOrgSecret(GRANT);
    await db.query(
      `UPDATE webdev_provisioned_sites
          SET scaffold_state = 'committed', scaffold_manifest_sha256 = $2, scaffold_snapshot_id = $3, scaffold_branch = 'main',
              scaffold_base_sha = $4, scaffold_tree_sha = $5, scaffold_commit_sha = $5, scaffold_committed_at = now()
        WHERE id = $1`,
      [id, "d".repeat(64), snapshotId, base, commit],
    );
    const call = gh.caller();
    vi.mocked(githubAppService.githubRequest).mockImplementation(((_t: string, _r: string, _a: string, req: never) => call(req)) as never);
    const connectionId = (await createConnection(tenant, { ownerKind: "client", ownerId: clientId, provider: "ssh", externalAccount: `p6o-http ${slug}`, createdBy: admin1 })).id;
    return { id, slug, webdevSiteId, connectionId, name: siteDeploySecretName({ slug, environment: "staging", repositoryId: gh.repoId }) };
  }

  const inject = async (method: "GET" | "POST" | "PUT", url: string, user: string, payload?: unknown) => {
    const r = await app.inject({ method, url, headers: asUser(user), ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
    bodies.push(r.body);
    return r;
  };
  const base = () => `/api/${tenant}/modules/webdev`;
  const seal = (conn: string, user: string, payload: unknown) => inject("PUT", `${base()}/deploy-credentials/${conn}`, user, payload);
  const bind = (row: string, user: string, conn: string) =>
    inject("POST", `${base()}/sites/${row}/delivery-binding`, user, { hostKind: "shared-hosting", hostRef: "hostinger-1", access: "ssh", vaultRef: conn });
  const file = (row: string, user: string) => inject("POST", `${base()}/sites/${row}/deploy-secret`, user, {});
  const state = (row: string, user: string) => inject("GET", `${base()}/sites/${row}/deploy-secret`, user);
  const decide = (approvalId: string, user: string, decision = "approved") =>
    inject("POST", `/api/${tenant}/automation-approvals/${approvalId}/decide`, user, { decision });
  const row = async (id: string) => (await adminPool().query(`SELECT status, execution_status, decided_by FROM automation_approvals WHERE id = $1`, [id])).rows[0];

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    config.integrationTokenKey = randomBytes(32).toString("base64");
    tenant = await createCompany("P6o HTTP Co", ["webdev"]);
    const mk = async (email: string, role: string) => {
      const id = await createUser(email);
      await addMembership(tenant, id);
      await grantRole(id, await createRole(role), "company", tenant);
      return id;
    };
    admin1 = await mk("p6o-http-admin1@a.test", "company_admin");
    admin2 = await mk("p6o-http-admin2@a.test", "company_admin");
    manager = await mk("p6o-http-manager@a.test", "manager");
    member = await mk("p6o-http-member@a.test", "member");
    config.githubOrg = ORG;
    config.githubOrgTenantId = tenant;
    config.webdeskDeploySecretNames = "";
    app = await buildIsolatedApp();
  });
  afterAll(async () => {
    config.githubOrg = saved.org;
    config.githubOrgTenantId = saved.orgTenant;
    config.webdeskDeploySecretNames = saved.names;
    config.integrationTokenKey = saved.key;
    await app.close();
    await teardownTestDb();
  });
  // A block body on purpose: a function RETURNED from beforeEach is a cleanup hook.
  beforeEach(() => {
    vi.mocked(githubAppService.githubRequest).mockReset();
  });

  it("401 without a credential on all three routes", async () => {
    for (const [method, url] of [["PUT", `${base()}/deploy-credentials/${newId()}`], ["POST", `${base()}/sites/${newId()}/deploy-secret`], ["GET", `${base()}/sites/${newId()}/deploy-secret`]] as const) {
      expect((await app.inject({ method, url, payload: method === "GET" ? undefined : {} })).statusCode).toBe(401);
    }
  });

  it("SEAL: a member is 403 with a VALID body and nothing is stored; a manager seals; the answer never carries the value", async () => {
    const s = await site();
    const denied = await seal(s.connectionId, member, { credential: credential("member") });
    expect(denied.statusCode).toBe(403);
    expect((await adminPool().query(`SELECT access_token_enc FROM integration_connections WHERE id = $1`, [s.connectionId])).rows[0].access_token_enc).toBeNull();
    const ok = await seal(s.connectionId, manager, { credential: credential("manager") });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ connection: { id: s.connectionId, status: "linked", hasToken: true }, environment: "staging", transport: "sftp" });
    expect(ok.json().sealedVersion).toMatch(/^[0-9a-f]{64}$/);
    const bad = await seal(s.connectionId, manager, { credential: { ...credential("bad"), transport: "ftp" } });
    expect(bad.statusCode).toBe(422);
    expect(bad.json()).toMatchObject({ error: "deploy_credential_invalid" });
    expect((await seal("not-a-uuid", manager, { credential: credential("nf") })).statusCode).toBe(404);
  });

  it("FILE + DECIDE: member 403; admin1 files; admin1 cannot approve it (self_approval); a manager cannot decide; admin2 approves and the write runs in-band; re-presenting is 404", async () => {
    const s = await site();
    expect((await seal(s.connectionId, manager, { credential: credential("flow") })).statusCode).toBe(200);
    expect((await bind(s.webdevSiteId, manager, s.connectionId)).statusCode).toBe(200);

    expect((await file(s.webdevSiteId, member)).statusCode).toBe(403);
    const filed = await file(s.webdevSiteId, admin1);
    expect(filed.statusCode).toBe(201);
    const { approvalId } = filed.json<{ approvalId: string }>();
    expect((await state(s.webdevSiteId, manager)).json()).toMatchObject({ state: "awaiting_approval", approvalId });

    const self = await decide(approvalId, admin1);
    expect(self.statusCode).toBe(403);
    expect(self.json()).toMatchObject({ reason: "self_approval" });
    expect(await row(approvalId)).toMatchObject({ status: "pending" });
    const mgr = await decide(approvalId, manager);
    expect(mgr.statusCode).toBe(403);
    expect(await row(approvalId)).toMatchObject({ status: "pending" });
    expect(gh.calls.filter((c) => c.method === "PUT")).toHaveLength(0);

    const ok = await decide(approvalId, admin2);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      id: approvalId, status: "approved",
      deploySecret: { executionStatus: "executed", result: { secretName: s.name, written: "created", grant: { outcome: "granted" } } },
    });
    expect(await row(approvalId)).toMatchObject({ status: "approved", execution_status: "executed", decided_by: admin2 });
    const opened = JSON.parse(await gh.openOrgSecretValue(s.name));
    expect(opened.password).toBe(planted.flow);
    expect([...gh.orgSecrets.get(s.name)!.repos]).toEqual([gh.repoId]);
    expect((await state(s.webdevSiteId, manager)).json()).toMatchObject({ state: "written", secretName: s.name });

    const writes = gh.calls.filter((c) => c.method === "PUT" && /\/actions\/secrets\/[^/]+$/.test(c.path)).length;
    expect((await decide(approvalId, admin2)).statusCode).toBe(404);
    expect(gh.calls.filter((c) => c.method === "PUT" && /\/actions\/secrets\/[^/]+$/.test(c.path))).toHaveLength(writes);
  });

  it("O-3 over HTTP: the decision stands (200), the write fails typed, and the console shows PENDING with the reason, never success", async () => {
    const s = await site();
    await seal(s.connectionId, manager, { credential: credential("o3") });
    await bind(s.webdevSiteId, manager, s.connectionId);
    gh.orgSecretsPermission = false;
    const { approvalId } = (await file(s.webdevSiteId, admin1)).json<{ approvalId: string }>();
    const r = await decide(approvalId, admin2);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ deploySecret: { executionStatus: "failed", error: "github_permission_missing: organization_secrets" } });
    expect(gh.calls.filter((c) => c.method === "PUT")).toHaveLength(0);
    const st = await state(s.webdevSiteId, manager);
    expect(st.statusCode).toBe(200);
    expect(st.json()).toMatchObject({ state: "pending", reason: "github_permission_missing: organization_secrets", writtenAt: null });
  });

  it("no HTTP answer in this file carried a planted value (positive control: the scan sees one when it is there)", async () => {
    expect(Object.keys(planted).length).toBeGreaterThanOrEqual(5);
    expect(findSecretValueLeaks(bodies.map((text, i) => ({ where: `body#${i}`, text })), planted)).toEqual([]);
    const [k, v] = Object.entries(planted)[0];
    expect(findSecretValueLeaks([{ where: "control", text: JSON.stringify({ echoed: v }) }], { [k]: v })).toHaveLength(1);
  });
});
