// M6-P6h — rebuild and promote read the REGISTRY; a production promote behind a HIGH approval. End to end, with everything
// real except the far sides.
//
// Real: Postgres (RLS, the migrated ledger incl. 202610132320's widened kind CHECK, the provisioned site and its registry
// rows), Cerbos (resource_webdev_provisioned_site.yaml `promote`, resource_github_repo.yaml `deploy`, the approvals policy:
// all unmodified), the whole NestJS app driven through `POST …/control/sites/:siteId/promote` and
// `POST …/automation-approvals/:id/decide`, the REAL GitHub chokepoint (`githubRequest` → App JWT → installation token →
// the dispatch, over real HTTP sockets), the real ledger and the real poller.
// Stubs (the WSK-60 suite's seams): GitHub's API (a local HTTP server `global.fetch` is pointed at), WebDesk's Zone B (the
// in-process fake of webdesk-content-testkit.ts, for the filing wall), and the site's stamp (an injected `fetchImpl`, so the
// URL the poller asks for is asserted, and it must be the PRODUCTION one).
//
// Needs DATABASE_URL_TEST + CERBOS_URL (skips otherwise). Denial tests send VALID requests and are paired with an allowed
// control on the identical request.
import { generateKeyPairSync, randomUUID } from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { buildApp } from "../../main";
import { newId } from "../../db";
import { resetModules } from "../registry";
import { resetCoreRollupProviders } from "../../rollups/engine";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../../testing/fixtures";
import { assemblePrincipal, type Principal } from "../../rbac/principal";
import * as credentialStore from "../../core/github/credential-store";
import { resetGithubRuntimesForTest } from "../../core/github/github-app.service";
import { setWebdeskApprovedCommandDepsForTests } from "./webdesk-approved-command";
import { webdeskZoneB } from "./webdesk-content.service";
import { FakeZoneB, GAIADA_SITE, GAIADA_SLUG, makeTestSigner } from "./webdesk-content-testkit";
import { siteDeploySecretName } from "./deploy-grant";
import { getBuildStatus, pollSiteBuild, startSitePromote, startSiteRebuild } from "./site-builds.service";

vi.mock("../../core/github/credential-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/github/credential-store")>();
  return { ...actual, loadAppCredentialOrThrow: vi.fn() };
});

const live = !!TEST_URL && !!process.env.CERBOS_URL;

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

const ORG = "acme-org";
// The provisioned slug = the repo name = the WebDesk tenant slug (M6-P4c). The fake Zone B's tenant is `gaiada`.
const SLUG = GAIADA_SLUG;
const REPO = `${ORG}/${SLUG}`;
const REPO_ID = 987654321;
const STAGING_DOMAIN = "stg.p6h-promote.example";
const PRODUCTION_DOMAIN = "www.p6h-promote.example";
const APP_ID = "4777424";
const INSTALLATION_ID = "157879245";
const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const secretFor = (env: "staging" | "production") => siteDeploySecretName({ slug: SLUG, environment: env, repositoryId: REPO_ID });

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// Stub GitHub API
// ══════════════════════════════════════════════════════════════════════════════════════════════════

interface GhCall { method: string; path: string; body: Record<string, unknown> | null }
interface Github { server: http.Server; port: number; calls: GhCall[] }
const dispatches = (g: Github) => g.calls.filter((c) => c.method === "POST" && c.path.endsWith("/dispatches"));

async function startGithub(): Promise<Github> {
  const g = { calls: [] } as unknown as Github;
  g.server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const path = req.url ?? "";
      g.calls.push({ method: req.method ?? "", path, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : null });
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json", "x-ratelimit-remaining": "4999", "x-ratelimit-limit": "5000" });
        res.end(JSON.stringify(body));
      };
      if (req.method === "POST" && path === `/app/installations/${INSTALLATION_ID}/access_tokens`) {
        return json(201, { token: "ghs_p6h_installation_token", expires_at: new Date(Date.now() + 3_600_000).toISOString(), permissions: { actions: "write" } });
      }
      if (req.method === "POST" && path === `/repos/${REPO}/actions/workflows/site.yml/dispatches`) {
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method === "GET" && path === `/repos/${REPO}`) return json(200, { full_name: REPO });
      json(404, { message: "stub: no such route" });
    });
  });
  await new Promise<void>((r) => g.server.listen(0, "127.0.0.1", r));
  g.port = (g.server.address() as AddressInfo).port;
  return g;
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// Suite
// ══════════════════════════════════════════════════════════════════════════════════════════════════

describe.skipIf(!live)("M6-P6h — registry targets, and a production promote behind a HIGH approval", () => {
  let app: NestFastifyApplication;
  let gh: Github;
  let zb: FakeZoneB;
  const signer = makeTestSigner();
  let R: string; // the root company: the GitHub org tenant in the "decider without deploy" case
  let A: string; // the company that owns the site (a child of R)
  let B: string;
  let adminA: string; // files
  let adminA2: string; // decides (maker ≠ checker)
  let editorA: string;
  let memberA: string;
  let provisionedId: string;
  let stagingRowId: string;
  let productionRowId: string;
  const P: Record<string, Principal> = {};
  const realFetch = global.fetch;

  async function principal(userId: string): Promise<Principal> {
    if (!P[userId]) {
      const p = await assemblePrincipal(userId, "high");
      if (!p) throw new Error(`could not assemble ${userId}`);
      P[userId] = p;
    }
    return P[userId];
  }

  const promoteUrl = (siteId = GAIADA_SITE) => `/api/${A}/modules/webdev/control/sites/${siteId}/promote`;
  const file = (as: string, body: unknown = { tenantSlug: SLUG }) =>
    app.inject({ method: "POST", url: promoteUrl(), headers: asUser(as), payload: body as never });
  const decide = (id: string, as: string, decision: "approved" | "rejected" = "approved") =>
    app.inject({ method: "POST", url: `/api/${A}/automation-approvals/${id}/decide`, headers: asUser(as), payload: { decision } });

  async function approval(id: string) {
    const { rows } = await adminPool().query<{
      status: string; execution_status: string | null; execution_error: string | null; tool_args: Record<string, unknown>;
      origin: string; workflow_id: string; tool_name: string; impact: string; requested_by: string;
    }>(`SELECT status, execution_status, execution_error, tool_args, origin, workflow_id, tool_name, impact, requested_by FROM automation_approvals WHERE id = $1`, [id]);
    return rows[0];
  }
  async function ledger(approvalId: string) {
    const { rows } = await adminPool().query<{
      id: string; kind: string; state: string; failure_reason: string | null; repo: string | null; ref: string | null;
      staging_url: string | null; dispatched_at: Date | null; verified_at: Date | null; decided_by: string | null; site_id: string; tenant_slug: string;
    }>(`SELECT * FROM webdev_site_builds WHERE approval_id = $1`, [approvalId]);
    return rows;
  }
  /** The M6-P4g grant as P4g would record it, with the given per-site secret names granted. */
  async function setGrant(names: string[], state: "granted" | "pending" | "revoked" = "granted") {
    await adminPool().query(
      `UPDATE webdev_provisioned_sites
          SET deploy_grant_state = $2, deploy_grant_secret_names = $3::text[], deploy_grant_snapshot_id = contract_snapshot_id,
              deploy_grant_repository_id = $4, deploy_grant_head_sha = $5, deploy_grant_requested_by = $6,
              deploy_grant_site_secret_name = $7, deploy_grant_pending_names = '{}'::text[],
              deploy_grant_granted_at = CASE WHEN $2 = 'granted' THEN now() ELSE deploy_grant_granted_at END,
              deploy_grant_revoked_at = CASE WHEN $2 = 'revoked' THEN now() ELSE NULL END,
              deploy_grant_revoke_reason = CASE WHEN $2 = 'revoked' THEN 'p6h test revoke' ELSE NULL END,
              deploy_grant_updated_at = now()
        WHERE id = $1`,
      [provisionedId, state, names, REPO_ID, "d".repeat(40), adminA, secretFor("staging")],
    );
  }
  const fullGrant = () => setGrant(["WEBDESK_DEPLOY_GRANT", secretFor("staging"), secretFor("production")]);

  /** A fake stamp server for `pollSiteBuild`: records every URL asked for, answers `bodyFor(url)`. */
  function stampFetch(bodyFor: (url: string) => unknown) {
    const asked: string[] = [];
    const impl = (async (input: string | URL | Request) => {
      const url = String(input);
      asked.push(url);
      const body = bodyFor(url);
      return body === null
        ? new Response("not found", { status: 404 })
        : new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    return { impl, asked };
  }
  const templateStamp = (approvalId: string | null, environment: "staging" | "production") => ({
    source: "webdesk", buildId: "4242-1-0123456789ab", pulledAt: new Date(Date.now() + 60_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    maxUpdatedAt: null, itemCount: null, sourceSha256: null, builtAt: new Date().toISOString(), commit: "e".repeat(40),
    kind: "static", environment, trigger: "workflow_dispatch", runId: 4242, runAttempt: 1, ...(approvalId ? { approvalId } : {}),
  });

  beforeAll(async () => {
    gh = await startGithub();
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    R = await createCompany("P6h root", ["webdev"]);
    A = await createCompany("P6h Co A", ["webdev"], R);
    B = await createCompany("P6h Co B", ["webdev"]);
    const mk = async (co: string, email: string, role: string) => {
      const id = await createUser(email);
      await addMembership(co, id);
      await grantRole(id, await createRole(role), "company", co);
      return id;
    };
    adminA = await mk(A, "p6h-admin-a@ex.test", "company_admin");
    adminA2 = await mk(A, "p6h-admin-a2@ex.test", "company_admin");
    editorA = await mk(A, "p6h-editor-a@ex.test", "webdev_staff");
    memberA = await mk(A, "p6h-member-a@ex.test", "member");
    zb = new FakeZoneB(A, B);

    // The provisioned site, as M6-P4c/P4b2/P6g leave it: complete, scaffolded on `main`, a staging row with a claimed domain
    // and a production row created from it. The grant is set per test.
    const db = adminPool();
    stagingRowId = newId();
    await db.query(
      `INSERT INTO webdev_sites (id, tenant_id, domain, environment, kind, repo_url, adoption, origin, origin_site)
       VALUES ($1, $2, $3, 'staging', 'static', $4, 'mandated', 'provisioned', 'main')`,
      [stagingRowId, A, STAGING_DOMAIN, `https://github.com/${REPO}`],
    );
    productionRowId = newId();
    await db.query(
      `INSERT INTO webdev_sites (id, tenant_id, domain, environment, kind, repo_url, adoption, origin, origin_site, promoted_from_site_id)
       VALUES ($1, $2, $3, 'production', 'static', $4, 'mandated', 'provisioned', 'main', $5)`,
      [productionRowId, A, PRODUCTION_DOMAIN, `https://github.com/${REPO}`, stagingRowId],
    );
    const snapshotId = newId();
    await db.query(
      `INSERT INTO webdev_contract_snapshots (id, tenant_id, webdesk_tenant_slug, contract_version, vocabulary_version, content_hash, artifacts, origin_site)
       VALUES ($1, $2, $3, '1.0.0', '1.1.0', $4, '{}'::jsonb, 'main')`,
      [snapshotId, A, SLUG, `sha256:${"a".repeat(64)}`],
    );
    provisionedId = newId();
    await db.query(
      `INSERT INTO webdev_provisioned_sites
         (id, tenant_id, provider, provider_ref, slug, framework, status, repo_url, requested_by, origin_site,
          completion_state, webdev_site_id, webdesk_tenant_slug, contract_snapshot_id, completion_updated_at)
       VALUES ($1, $2, 'erp_repo', $3, $4, 'astro', 'live', $5, $6, 'main', 'complete', $7, $4, $8, now())`,
      [provisionedId, A, randomUUID(), SLUG, `https://github.com/${REPO}`, adminA, stagingRowId, snapshotId],
    );
    await db.query(
      `UPDATE webdev_provisioned_sites
          SET scaffold_state = 'committed', scaffold_manifest_sha256 = $2, scaffold_snapshot_id = $3, scaffold_branch = 'main',
              scaffold_base_sha = $4, scaffold_tree_sha = $5, scaffold_commit_sha = $5, scaffold_committed_at = now()
        WHERE id = $1`,
      [provisionedId, "c".repeat(64), snapshotId, "b".repeat(40), "f".repeat(40)],
    );
    config.githubApps.erp = { appId: APP_ID, installationId: INSTALLATION_ID };
    app = await buildApp();
  }, 120_000);

  beforeEach(async () => {
    // Isolation: no build left in flight, no open promote request, the full grant, and no env override.
    await adminPool().query(`UPDATE webdev_site_builds SET state = 'failed', failure_reason = 'dispatch_unconfirmed' WHERE state = 'rebuilding'`);
    await adminPool().query(`UPDATE automation_approvals SET deleted_at = now() WHERE tenant_id = $1 AND workflow_id = 'site.promote' AND deleted_at IS NULL`, [A]);
    await adminPool().query(`UPDATE webdev_sites SET kind = 'static', domain = $2 WHERE id = $1`, [stagingRowId, STAGING_DOMAIN]);
    await adminPool().query(`UPDATE webdev_sites SET deleted_at = NULL WHERE id = $1`, [productionRowId]);
    await fullGrant();
    gh.calls.length = 0;
    zb.reset();
    signer.calls.length = 0;
    webdeskZoneB.clearSiteCache();
    config.webdeskRebuild.targetsJson = "";
    config.webdeskRebuild.dispatchDeadlineMs = 30_000;
    config.webdeskRebuild.pollWindowMs = 20 * 60_000;
    config.githubOrgTenantId = A;
    resetGithubRuntimesForTest();
    vi.mocked(credentialStore.loadAppCredentialOrThrow).mockReset().mockResolvedValue({
      connectionId: "conn-p6h", appId: APP_ID, installationId: INSTALLATION_ID, privateKeyPem: PEM,
    });
    global.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      return realFetch(url.startsWith("https://api.github.com") ? url.replace("https://api.github.com", `http://127.0.0.1:${gh.port}`) : url, init);
    }) as typeof fetch;
    setWebdeskApprovedCommandDepsForTests({ client: zb.asClient(), signer });
  });

  afterEach(() => {
    global.fetch = realFetch;
    setWebdeskApprovedCommandDepsForTests(null);
  });

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
    if (gh?.server) {
      gh.server.closeAllConnections();
      await new Promise<void>((r) => gh.server.close(() => r()));
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe("filing: POST control/sites/:siteId/promote files ONE HIGH approval and dispatches nothing", () => {
    it("202 {approvalId}; origin webdesk, site.promote, HIGH; the row names the site and the production URL; no rebuild key; nothing sent anywhere", async () => {
      const r = await file(adminA);
      expect(r.statusCode).toBe(202);
      expect(Object.keys(r.json())).toEqual(["approvalId"]);
      const { approvalId } = r.json<{ approvalId: string }>();
      const a = await approval(approvalId);
      expect(a).toMatchObject({ status: "pending", origin: "webdesk", workflow_id: "site.promote", tool_name: "webdesk.site.promote", impact: "high", requested_by: adminA });
      const { summary, commandHash, ...args } = a.tool_args;
      expect(args).toEqual({ command: "site.promote", tenantSlug: SLUG, siteId: GAIADA_SITE });
      expect(commandHash).toMatch(/^[0-9a-f]{64}$/);
      expect(a.tool_args).not.toHaveProperty("rebuild");
      expect((summary as { title: string }).title).toContain(`https://${PRODUCTION_DOMAIN}`);
      expect(dispatches(gh)).toHaveLength(0);
      expect(await ledger(approvalId)).toHaveLength(0);
      expect(zb.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    });

    it("de-dup: filing again returns the SAME pending request with alreadyPending:true", async () => {
      const first = (await file(adminA)).json<{ approvalId: string }>().approvalId;
      const dup = await file(adminA2);
      expect(dup.statusCode).toBe(202);
      expect(dup.json()).toEqual({ approvalId: first, alreadyPending: true });
    });

    it("🔴 a member and a webdev editor are 403 (the promote gate is FIRST: valid and invalid bodies both 403); ✅ control: company_admin files", async () => {
      for (const who of [memberA, editorA]) {
        expect((await file(who)).statusCode).toBe(403);
        expect((await file(who, { nonsense: true })).statusCode).toBe(403);
      }
      expect((await file(adminA)).statusCode).toBe(202);
    });

    it("a body other than {tenantSlug} is a typed 400 and files nothing", async () => {
      for (const body of [{ tenantSlug: SLUG, environment: "production" }, {}, { tenantSlug: 7 }]) {
        const r = await file(adminA, body);
        expect(r.statusCode, JSON.stringify(body)).toBe(400);
      }
    });

    it("🔴 no production registry row → 409 promote-not-ready (production_not_registered), nothing filed; ✅ control once the row is back", async () => {
      await adminPool().query(`UPDATE webdev_sites SET deleted_at = now() WHERE id = $1`, [productionRowId]);
      const r = await file(adminA);
      expect(r.statusCode).toBe(409);
      expect(r.json()).toMatchObject({ reason: "production_not_registered" });
      expect(r.json().type).toMatch(/\/promote-not-ready$/);
      await adminPool().query(`UPDATE webdev_sites SET deleted_at = NULL WHERE id = $1`, [productionRowId]);
      expect((await file(adminA)).statusCode).toBe(202);
    });

    it("🔴 no granted PRODUCTION secret (the staging one is not enough) → 409 production_secret_not_granted, nothing filed", async () => {
      await setGrant(["WEBDESK_DEPLOY_GRANT", secretFor("staging")]);
      const r = await file(adminA);
      expect(r.statusCode).toBe(409);
      expect(r.json()).toMatchObject({ reason: "production_secret_not_granted" });
      const n = await adminPool().query(`SELECT count(*)::int AS n FROM automation_approvals WHERE tenant_id = $1 AND workflow_id = 'site.promote' AND deleted_at IS NULL`, [A]);
      expect(n.rows[0].n).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe("deciding: maker ≠ checker, and a decider must hold github_repo · deploy", () => {
    it("🔴 the requester cannot approve their own promote: 403, row pending, ZERO dispatches; ✅ control: another admin → executed", async () => {
      const id = (await file(adminA)).json<{ approvalId: string }>().approvalId;
      const self = await decide(id, adminA);
      expect(self.statusCode).toBe(403);
      expect(self.body).toContain("a production promote may not be approved by the principal who requested it");
      expect(await approval(id)).toMatchObject({ status: "pending" });
      expect(dispatches(gh)).toHaveLength(0);
      expect((await decide(id, adminA2)).statusCode).toBe(200);
      expect(dispatches(gh)).toHaveLength(1);
    });

    it("🔴 a decider WITHOUT github_repo · deploy (the GitHub org is the root company, where they hold no role): 403, pending, no dispatch; ✅ control: the same decider once the org tenant is their own company", async () => {
      const id = (await file(adminA)).json<{ approvalId: string }>().approvalId;
      config.githubOrgTenantId = R;
      const denied = await decide(id, adminA2);
      expect(denied.statusCode).toBe(403);
      expect(denied.body).toContain("github_repo deploy was refused");
      expect(await approval(id)).toMatchObject({ status: "pending" });
      expect(dispatches(gh)).toHaveLength(0);
      config.githubOrgTenantId = A;
      expect((await decide(id, adminA2)).statusCode).toBe(200);
      expect(dispatches(gh)).toHaveLength(1);
    });

    it("a member cannot decide at all (the generic decide gate), and nothing is dispatched", async () => {
      const id = (await file(adminA)).json<{ approvalId: string }>().approvalId;
      expect((await decide(id, memberA)).statusCode).toBe(403);
      expect(dispatches(gh)).toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe("executing: ONE production dispatch, ONE ledger row per approval, live only through the production stamp", () => {
    it("approve → one site.yml dispatch (kind=promote, environment=production, the approval id) on the default branch → one promote row; re-presenting is 404 and runs nothing", async () => {
      const id = (await file(adminA)).json<{ approvalId: string }>().approvalId;
      const r = await decide(id, adminA2);
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({
        webdesk: { command: "site.promote", executionStatus: "executed", environment: "production", build: { state: "rebuilding", failureReason: null } },
      });
      const sent = dispatches(gh);
      expect(sent).toHaveLength(1);
      expect(sent[0].path).toBe(`/repos/${REPO}/actions/workflows/site.yml/dispatches`);
      expect(sent[0].body).toEqual({ ref: "main", inputs: { approval_id: id, kind: "promote", environment: "production" } });

      const rows = await ledger(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        kind: "promote", state: "rebuilding", failure_reason: null, repo: REPO, ref: "main", decided_by: adminA2,
        staging_url: `https://${PRODUCTION_DOMAIN}`, site_id: GAIADA_SITE, tenant_slug: SLUG, verified_at: null,
      });
      expect(rows[0].dispatched_at).toBeInstanceOf(Date);
      expect(await approval(id)).toMatchObject({ status: "approved", execution_status: "executed", execution_error: null });

      // Re-presenting the decided approval: decide()'s 404, and NOTHING runs again.
      expect((await decide(id, adminA2)).statusCode).toBe(404);
      expect(dispatches(gh)).toHaveLength(1);
      // A duplicated in-process call finds the row and dispatches nothing either (the ledger's UNIQUE (tenant_id, approval_id)).
      const again = await startSitePromote({ tenantId: A, tenantSlug: SLUG, siteId: GAIADA_SITE, approvalId: id, decider: await principal(adminA2) });
      expect(again).toMatchObject({ deduplicated: true, state: "rebuilding" });
      expect(dispatches(gh)).toHaveLength(1);
      expect(await ledger(id)).toHaveLength(1);

      // The promote is NOT on the editor's staging wire.
      const status = await getBuildStatus(A, SLUG, GAIADA_SITE);
      expect(status.build?.approvalId ?? null).not.toBe(id);
    });

    it("`live` only through a stamp read from the PRODUCTION URL that names this approval: a staging build, another approval, and a 404 all leave it rebuilding", async () => {
      const id = (await file(adminA)).json<{ approvalId: string }>().approvalId;
      expect((await decide(id, adminA2)).statusCode).toBe(200);
      const buildId = (await ledger(id))[0].id;

      // 1. the production URL still serves a STAGING build's stamp naming this approval (a mis-deploy): not proof.
      let s = stampFetch(() => templateStamp(id, "staging"));
      expect(await pollSiteBuild(A, buildId, { fetchImpl: s.impl })).toBe("rebuilding");
      expect(s.asked[0]).toMatch(new RegExp(`^https://${PRODUCTION_DOMAIN.replace(/\./g, "\\.")}/webdesk-build\\.json\\?t=`));
      // 2. a production build of ANOTHER approval: not proof (a promote has no "later dispatch").
      s = stampFetch(() => templateStamp(randomUUID(), "production"));
      expect(await pollSiteBuild(A, buildId, { fetchImpl: s.impl })).toBe("rebuilding");
      // 3. unreadable: not proof.
      s = stampFetch(() => null);
      expect(await pollSiteBuild(A, buildId, { fetchImpl: s.impl })).toBe("rebuilding");
      expect((await ledger(id))[0].state).toBe("rebuilding");
      // 4. the production build that names THIS approval: live.
      s = stampFetch((url) => (url.startsWith(`https://${PRODUCTION_DOMAIN}/`) ? templateStamp(id, "production") : null));
      expect(await pollSiteBuild(A, buildId, { fetchImpl: s.impl })).toBe("live");
      const settled = (await ledger(id))[0];
      expect(settled.state).toBe("live");
      expect(settled.verified_at).toBeInstanceOf(Date);
    });

    it("the poll window closing without proof turns a promote `unverified`, never live", async () => {
      const id = (await file(adminA)).json<{ approvalId: string }>().approvalId;
      expect((await decide(id, adminA2)).statusCode).toBe(200);
      const buildId = (await ledger(id))[0].id;
      const s = stampFetch(() => templateStamp(null, "production")); // a push-built production stamp
      expect(await pollSiteBuild(A, buildId, { fetchImpl: s.impl, now: new Date(Date.now() + 21 * 60_000) })).toBe("unverified");
      expect((await ledger(id))[0]).toMatchObject({ state: "unverified", verified_at: null });
    });

    it("🔴 the production grant revoked between filing and deciding → executed as FAILED `webdesk_promote_failed: production_secret_not_granted`, ONE failed row, ZERO dispatches", async () => {
      const id = (await file(adminA)).json<{ approvalId: string }>().approvalId;
      await setGrant(["WEBDESK_DEPLOY_GRANT", secretFor("staging")]);
      const r = await decide(id, adminA2);
      expect(r.statusCode).toBe(200); // the decision stands; the outcome is data
      expect(r.json()).toMatchObject({ webdesk: { command: "site.promote", executionStatus: "failed", error: "webdesk_promote_failed: production_secret_not_granted" } });
      expect(dispatches(gh)).toHaveLength(0);
      expect(gh.calls).toHaveLength(0);
      const rows = await ledger(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: "promote", state: "failed", failure_reason: "production_secret_not_granted", dispatched_at: null });
      expect(await approval(id)).toMatchObject({ execution_status: "failed", execution_error: "webdesk_promote_failed: production_secret_not_granted" });
    });

    it("🔴 a second promote while one is in flight: refused at filing (409 promote-in-flight) and, if it gets that far, at execution (failed, no dispatch)", async () => {
      const first = (await file(adminA)).json<{ approvalId: string }>().approvalId;
      expect((await decide(first, adminA2)).statusCode).toBe(200);
      expect(dispatches(gh)).toHaveLength(1);

      const refused = await file(adminA);
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ reason: "promote_in_flight" });
      expect(refused.json().type).toMatch(/\/promote-in-flight$/);

      // Filed before the first went in flight (simulated: the first is reset to rebuilding after this one is filed).
      await adminPool().query(`UPDATE webdev_site_builds SET state = 'failed', failure_reason = 'dispatch_unconfirmed' WHERE approval_id = $1`, [first]);
      const second = (await file(adminA)).json<{ approvalId: string }>().approvalId;
      await adminPool().query(`UPDATE webdev_site_builds SET state = 'rebuilding', failure_reason = NULL WHERE approval_id = $1`, [first]);
      const r = await decide(second, adminA2);
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ webdesk: { executionStatus: "failed", error: "webdesk_promote_failed: promote_in_flight" } });
      expect(dispatches(gh)).toHaveLength(1);
      expect((await ledger(second))[0]).toMatchObject({ kind: "promote", state: "failed", failure_reason: "promote_in_flight" });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe("the staging rebuild reads the registry too (no WEBDESK_REBUILD_TARGETS entry)", () => {
    it("a static site: site.yml on the default branch, inputs carry environment=staging, the stamp base is the staging origin", async () => {
      const approvalId = randomUUID();
      const r = await startSiteRebuild({
        tenantId: A, tenantSlug: SLUG, siteId: GAIADA_SITE, approvalId, kind: "rebuild", publishedAt: null, decider: await principal(adminA2),
      });
      expect(r).toMatchObject({ state: "rebuilding", failureReason: null, deduplicated: false });
      const sent = dispatches(gh);
      expect(sent).toHaveLength(1);
      expect(sent[0].path).toBe(`/repos/${REPO}/actions/workflows/site.yml/dispatches`);
      expect(sent[0].body).toEqual({ ref: "main", inputs: { approval_id: approvalId, kind: "rebuild", environment: "staging" } });
      expect((await ledger(approvalId))[0]).toMatchObject({ kind: "rebuild", repo: REPO, ref: "main", staging_url: `https://${STAGING_DOMAIN}` });

      // The template stamp naming this approval proves it (the publish-proof rule's rebuild half).
      const s = stampFetch(() => templateStamp(approvalId, "staging"));
      expect(await pollSiteBuild(A, (await ledger(approvalId))[0].id, { fetchImpl: s.impl })).toBe("live");
      expect(s.asked[0]).toMatch(new RegExp(`^https://${STAGING_DOMAIN.replace(/\./g, "\\.")}/webdesk-build\\.json`));
    });

    it("a run GitHub dropped is settled by the LATER dispatch's stamp (laterDispatch), never by an earlier one", async () => {
      const first = randomUUID();
      const second = randomUUID();
      const decider = await principal(adminA2);
      await startSiteRebuild({ tenantId: A, tenantSlug: SLUG, siteId: GAIADA_SITE, approvalId: first, kind: "rebuild", publishedAt: null, decider });
      await startSiteRebuild({ tenantId: A, tenantSlug: SLUG, siteId: GAIADA_SITE, approvalId: second, kind: "rebuild", publishedAt: null, decider });
      const firstRow = (await ledger(first))[0];
      const secondRow = (await ledger(second))[0];
      // The served build is the SECOND dispatch's: it settles the first (dropped) one…
      const s = stampFetch(() => templateStamp(second, "staging"));
      expect(await pollSiteBuild(A, firstRow.id, { fetchImpl: s.impl })).toBe("live");
      expect(await pollSiteBuild(A, secondRow.id, { fetchImpl: s.impl })).toBe("live");
      // …and a stamp of the FIRST never settles the second.
      const third = randomUUID();
      await startSiteRebuild({ tenantId: A, tenantSlug: SLUG, siteId: GAIADA_SITE, approvalId: third, kind: "rebuild", publishedAt: null, decider });
      const old = stampFetch(() => templateStamp(first, "staging"));
      expect(await pollSiteBuild(A, (await ledger(third))[0].id, { fetchImpl: old.impl })).toBe("rebuilding");
    });

    it("a wp site has nothing to rebuild: notApplicable, NO ledger row, NO dispatch", async () => {
      await adminPool().query(`UPDATE webdev_sites SET kind = 'wp' WHERE id = $1`, [stagingRowId]);
      const approvalId = randomUUID();
      const r = await startSiteRebuild({
        tenantId: A, tenantSlug: SLUG, siteId: GAIADA_SITE, approvalId, kind: "publish", publishedAt: new Date().toISOString(), decider: await principal(adminA2),
      });
      expect(r).toMatchObject({ notApplicable: true, buildId: null, failureReason: "rebuild_not_applicable" });
      expect(await ledger(approvalId)).toHaveLength(0);
      expect(gh.calls).toHaveLength(0);
    });

    it("the staging grant missing → a failed row `deploy_not_granted`, no dispatch", async () => {
      await setGrant(["WEBDESK_DEPLOY_GRANT"], "pending");
      const approvalId = randomUUID();
      const r = await startSiteRebuild({
        tenantId: A, tenantSlug: SLUG, siteId: GAIADA_SITE, approvalId, kind: "rebuild", publishedAt: null, decider: await principal(adminA2),
      });
      expect(r).toMatchObject({ state: "failed", failureReason: "deploy_not_granted" });
      expect(gh.calls).toHaveLength(0);
    });

    it("another company's tenant cannot resolve this company's provisioned site (RLS): rebuild_not_configured", async () => {
      const r = await startSiteRebuild({
        tenantId: B, tenantSlug: SLUG, siteId: GAIADA_SITE, approvalId: randomUUID(), kind: "rebuild", publishedAt: null, decider: await principal(adminA2),
      });
      expect(r).toMatchObject({ state: "failed", failureReason: "rebuild_not_configured" });
      expect(gh.calls).toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe("the console reads each environment (GET provisioned-sites/:id → builds)", () => {
    it("staging and production: the URL, whether a build could start (and the typed reason if not), the newest build", async () => {
      const id = (await file(adminA)).json<{ approvalId: string }>().approvalId;
      expect((await decide(id, adminA2)).statusCode).toBe(200);
      await setGrant(["WEBDESK_DEPLOY_GRANT", secretFor("staging")]);
      const r = await app.inject({ method: "GET", url: `/api/${A}/modules/webdev/provisioned-sites/${provisionedId}`, headers: asUser(adminA) });
      expect(r.statusCode).toBe(200);
      const builds = r.json().builds as { environments: Array<Record<string, unknown>> };
      expect(builds.environments.map((e) => e.environment)).toEqual(["staging", "production"]);
      expect(builds.environments[0]).toMatchObject({ siteUrl: `https://${STAGING_DOMAIN}`, target: { ready: true, reason: null } });
      expect(builds.environments[1]).toMatchObject({
        siteUrl: `https://${PRODUCTION_DOMAIN}`,
        target: { ready: false, reason: "production_secret_not_granted" },
        latest: { approvalId: id, kind: "promote", state: "rebuilding", failureReason: null },
      });
    });
  });
});
