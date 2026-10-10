// WSK-60 — publish → rebuild → staging, end to end, with everything real except the two far sides.
//
// Real: Postgres (RLS, the migrated ledger), Cerbos (resource_webdesk_content_item.yaml,
// resource_github_repo.yaml `deploy`, resource_automation_approval.yaml — all unmodified), the whole
// NestJS app driven through `POST /api/:t/automation-approvals/:id/decide`, the REAL GitHub chokepoint
// (`githubRequest` → App JWT → installation-token exchange → the dispatch call, over real HTTP sockets),
// the real ledger (`withGithubLedger`), the real stamp reader and the real sweeper.
// Stubs: GitHub's API (a local HTTP server that `global.fetch` is pointed at: the chokepoint's host is
// fixed, so the test rewrites `https://api.github.com` to it, which is the github-app.service.test.ts
// precedent), WebDesk's Zone B (a fake control client: the WS4/mTLS half is WSK-66's own suite), and
// the staging site (a local HTTP server serving /webdesk-build.json). The vault is mocked to hand out a
// freshly generated RSA key; the PEM never leaves the process.
//
// Needs DATABASE_URL_TEST + CERBOS_URL (skips otherwise).
//
// Done-when map (design §12 WSK-60):
//   1 → "done-when 1"      2 → "done-when 2" (the workflow's `concurrency` is asserted in the SITE repo's
//   test, where the file lives)      3 → "done-when 3"      5 → "done-when 5"
// Denial tests send VALID bodies and are paired with an allowed control on the identical body.
import { generateKeyPairSync, randomUUID } from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { buildApp } from "../../main";
import { resetModules } from "../registry";
import { resetCoreRollupProviders } from "../../rollups/engine";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../../testing/fixtures";
import { assemblePrincipal, type Principal } from "../../rbac/principal";
import { withTenants } from "../../db";
import * as credentialStore from "../../core/github/credential-store";
import { resetGithubRuntimesForTest } from "../../core/github/github-app.service";
import { GithubNotConfiguredError } from "../../core/github/errors";
import type { WebdeskControlClient, WebdeskControlRequest, WebdeskControlResponse } from "./webdesk-control-client";
import {
  fileWebdeskCommandApproval,
  setWebdeskApprovedCommandDepsForTests,
  type EditorialAssertionSigner,
  type WebdeskApprovedCommand,
} from "./webdesk-approved-command";
import {
  BUILD_KEYS,
  BUILD_STATUS_KEYS,
  getBuildStatus,
  noteStagingStale,
  startSiteRebuild,
  sweepSiteBuilds,
} from "./site-builds.service";

vi.mock("../../core/github/credential-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/github/credential-store")>();
  return { ...actual, loadAppCredentialOrThrow: vi.fn() };
});

const live = !!TEST_URL && !!process.env.CERBOS_URL;

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

const TENANT_SLUG = "gaiada";
const SITE_ID = "0b6f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4";
const OTHER_SITE_ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const REPO = "gaiadabali/gaiada-web-revamp";
const WORKFLOW = "webdesk-rebuild.yml";
const REF = "astro-site";
const APP_ID = "4777424";
const INSTALLATION_ID = "157879245";
const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// Stub GitHub API
// ══════════════════════════════════════════════════════════════════════════════════════════════════

interface GhCall { method: string; path: string; body: Record<string, unknown> | null; authorization: string | undefined }
interface Github {
  server: http.Server;
  port: number;
  calls: GhCall[];
  dispatch: "204" | "404" | "403-permission" | "422" | "500" | "slow";
  repoVisible: boolean;
  tokenExchange: "ok" | "404" | "401";
  slowMs: number;
}
const dispatches = (g: Github) => g.calls.filter((c) => c.method === "POST" && c.path.endsWith("/dispatches"));

async function startGithub(): Promise<Github> {
  const g = { calls: [], dispatch: "204", repoVisible: true, tokenExchange: "ok", slowMs: 0 } as unknown as Github;
  g.server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const path = req.url ?? "";
      g.calls.push({ method: req.method ?? "", path, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : null, authorization: req.headers.authorization });
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json", "x-ratelimit-remaining": "4999", "x-ratelimit-limit": "5000" });
        res.end(JSON.stringify(body));
      };
      if (req.method === "POST" && path === `/app/installations/${INSTALLATION_ID}/access_tokens`) {
        if (g.tokenExchange === "404") return json(404, { message: "Not Found" });
        if (g.tokenExchange === "401") return json(401, { message: "Bad credentials" });
        return json(201, { token: "ghs_wsk60_installation_token", expires_at: new Date(Date.now() + 3_600_000).toISOString(), permissions: { actions: "write" } });
      }
      if (req.method === "POST" && path === `/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`) {
        switch (g.dispatch) {
          case "204": res.writeHead(204); res.end(); return;
          case "404": return json(404, { message: "Not Found" });
          case "403-permission": return json(403, { message: "Resource not accessible by integration" });
          case "422": return json(422, { message: "Workflow does not have 'workflow_dispatch' trigger" });
          case "500": return json(500, { message: "boom" });
          case "slow":
            setTimeout(() => { res.writeHead(204); res.end(); }, g.slowMs);
            return;
        }
      }
      if (req.method === "GET" && path === `/repos/${REPO}`) {
        return g.repoVisible ? json(200, { full_name: REPO }) : json(404, { message: "Not Found" });
      }
      json(404, { message: "stub: no such route" });
    });
  });
  await new Promise<void>((r) => g.server.listen(0, "127.0.0.1", r));
  g.port = (g.server.address() as AddressInfo).port;
  return g;
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// Stub staging site (the stamp)
// ══════════════════════════════════════════════════════════════════════════════════════════════════

interface Staging { server: http.Server; port: number; body: unknown; status: number; hits: number }
async function startStaging(): Promise<Staging> {
  const s = { body: { source: "git" }, status: 200, hits: 0 } as unknown as Staging;
  s.server = http.createServer((req, res) => {
    s.hits++;
    if (!(req.url ?? "").startsWith("/webdesk-build.json")) { res.writeHead(404); res.end(); return; }
    res.writeHead(s.status, { "content-type": "application/json" });
    res.end(JSON.stringify(s.body));
  });
  await new Promise<void>((r) => s.server.listen(0, "127.0.0.1", r));
  s.port = (s.server.address() as AddressInfo).port;
  return s;
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// Fake Zone B (the WS4/mTLS half is WSK-66's own suite)
// ══════════════════════════════════════════════════════════════════════════════════════════════════

const testSigner: EditorialAssertionSigner = { configured: true, sign: () => "a.b.c" };
let zoneBCalls: WebdeskControlRequest[] = [];
let zoneBPublishedAt = new Date().toISOString();
const fakeClient = {
  async send(req: WebdeskControlRequest): Promise<WebdeskControlResponse> {
    zoneBCalls.push(req);
    const items = ((req.body?.items as Array<{ itemId: string; version: number }>) ?? []);
    const key = req.command === "content.publish" ? "published" : "scheduled";
    return {
      status: 200,
      contentType: "application/json",
      json: { [key]: items.map((it) => ({ itemId: it.itemId, version: it.version, publishedAt: zoneBPublishedAt })), replayed: false },
      bodyText: "",
    };
  },
  close() {},
} as unknown as WebdeskControlClient;

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// Suite
// ══════════════════════════════════════════════════════════════════════════════════════════════════

describe.skipIf(!live)("WSK-60 — publish approval → one workflow dispatch → stamp-verified staging", () => {
  let app: NestFastifyApplication;
  let gh: Github;
  let staging: Staging;
  let T: string;
  let adminA: string;
  let adminB: string;
  let editor: string;
  let member: string;
  const P: Record<string, Principal> = {};
  const realFetch = global.fetch;
  let targetsJson = "";

  const target = (siteId: string) => ({
    tenantSlug: TENANT_SLUG, siteId, repo: REPO, workflow: WORKFLOW, ref: REF, stagingUrl: `http://127.0.0.1:${staging.port}`,
  });

  async function principal(userId: string): Promise<Principal> {
    if (!P[userId]) {
      const p = await assemblePrincipal(userId, "high");
      if (!p) throw new Error(`could not assemble ${userId}`);
      P[userId] = p;
    }
    return P[userId];
  }

  async function file(as: string, command: WebdeskApprovedCommand, args: Record<string, unknown>, siteId = SITE_ID): Promise<string> {
    const { approvalId } = await fileWebdeskCommandApproval(await principal(as), T, {
      command, tenantSlug: TENANT_SLUG, siteId, args, summary: { title: `${command} wsk60 test` },
    });
    return approvalId;
  }
  const publishOne = (as = editor, siteId = SITE_ID) => file(as, "content.publish", { items: [{ itemId: randomUUID(), version: 2 }] }, siteId);

  async function row(id: string) {
    const { rows } = await adminPool().query<{
      status: string; execution_status: string; execution_error: string | null; execution_result: { text?: string } | null; tool_args: Record<string, unknown>;
    }>(`SELECT status, execution_status, execution_error, execution_result, tool_args FROM automation_approvals WHERE id = $1`, [id]);
    return rows[0];
  }
  async function build(approvalId: string) {
    const { rows } = await adminPool().query<{
      id: string; kind: string; state: string; failure_reason: string | null; dispatched_at: Date | null; published_at: Date | null;
      verified_at: Date | null; github_correlation_id: string | null; repo: string | null; ref: string | null; decided_by: string | null;
      staging_url: string | null; poll_count: number;
    }>(`SELECT * FROM webdev_site_builds WHERE approval_id = $1`, [approvalId]);
    return rows;
  }
  const decide = (id: string, as: string, decision: "approved" | "rejected" = "approved") =>
    app.inject({ method: "POST", url: `/api/${T}/automation-approvals/${id}/decide`, headers: asUser(as), payload: { decision } });
  const status = (as: string, siteId = SITE_ID, slug = TENANT_SLUG) =>
    app.inject({ method: "GET", url: `/api/${T}/modules/webdev/content/sites/${slug}/${siteId}/build-status`, headers: asUser(as) });
  const requestRebuild = (as: string, siteId = SITE_ID) =>
    app.inject({ method: "POST", url: `/api/${T}/modules/webdev/content/sites/${TENANT_SLUG}/${siteId}/rebuild-requests`, headers: asUser(as), payload: {} });

  beforeAll(async () => {
    gh = await startGithub();
    staging = await startStaging();
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    T = await createCompany("WSK-60 Co", ["webdev"]);
    const mk = async (email: string, role: string) => {
      const id = await createUser(email);
      await addMembership(T, id);
      await grantRole(id, await createRole(role), "company", T);
      return id;
    };
    adminA = await mk("wsk60-admin-a@ex.test", "company_admin");
    adminB = await mk("wsk60-admin-b@ex.test", "company_admin");
    editor = await mk("wsk60-editor@ex.test", "webdev_staff");
    member = await mk("wsk60-member@ex.test", "member");
    // The GitHub org tenant IS this company (the fast path of resolveGithubOrgTenant).
    config.githubOrgTenantId = T;
    config.githubApps.erp = { appId: APP_ID, installationId: INSTALLATION_ID };
    app = await buildApp();
  }, 120_000);

  beforeEach(async () => {
    // Isolation: a build left `rebuilding` by an earlier test would be polled by this test's sweeps.
    await adminPool().query(
      `UPDATE webdev_site_builds SET state = 'failed', failure_reason = 'dispatch_unconfirmed' WHERE state = 'rebuilding'`,
    );
    gh.calls.length = 0;
    gh.dispatch = "204";
    gh.repoVisible = true;
    gh.tokenExchange = "ok";
    gh.slowMs = 0;
    staging.body = { source: "git" };
    staging.status = 200;
    staging.hits = 0;
    zoneBCalls = [];
    zoneBPublishedAt = new Date().toISOString();
    targetsJson = JSON.stringify([target(SITE_ID), target(OTHER_SITE_ID)]);
    config.webdeskRebuild.targetsJson = targetsJson;
    config.webdeskRebuild.dispatchDeadlineMs = 30_000;
    config.webdeskRebuild.pollWindowMs = 20 * 60_000;
    config.webdeskRebuild.pollIntervalMs = 30_000;
    config.githubOrgTenantId = T;
    resetGithubRuntimesForTest();
    vi.mocked(credentialStore.loadAppCredentialOrThrow).mockReset().mockResolvedValue({
      connectionId: "conn-wsk60", appId: APP_ID, installationId: INSTALLATION_ID, privateKeyPem: PEM,
    });
    // The chokepoint's host is fixed (api.github.com); point it at the stub. Real sockets, real headers.
    global.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      return realFetch(url.startsWith("https://api.github.com") ? url.replace("https://api.github.com", `http://127.0.0.1:${gh.port}`) : url, init);
    }) as typeof fetch;
    setWebdeskApprovedCommandDepsForTests({ client: fakeClient, signer: testSigner });
  });

  afterEach(() => {
    global.fetch = realFetch;
    setWebdeskApprovedCommandDepsForTests(null);
  });

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
    for (const s of [gh?.server, staging?.server]) {
      if (!s) continue;
      s.closeAllConnections();
      await new Promise<void>((r) => s.close(() => r()));
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe("done-when 1 — a publish approved in the ERP dispatches exactly ONE workflow run, the approval id in the ledger", () => {
    it("approve → Zone B publish → one POST …/dispatches (App-authenticated) → a build row carrying the approval id and the ledger correlation id", async () => {
      const id = await publishOne();
      const r = await decide(id, adminB);
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ webdesk: { command: "content.publish", executionStatus: "executed", build: { state: "rebuilding", failureReason: null } } });
      expect(zoneBCalls).toHaveLength(1);

      // Exactly one dispatch, to the right repo/workflow/ref, with the approval id as an input.
      const sent = dispatches(gh);
      expect(sent).toHaveLength(1);
      expect(sent[0].path).toBe(`/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`);
      expect(sent[0].authorization).toBe("Bearer ghs_wsk60_installation_token"); // the installation token, minted by the App JWT
      expect(sent[0].body).toEqual({
        ref: REF,
        inputs: { approval_id: id, kind: "publish", published_at: zoneBPublishedAt },
      });
      expect(gh.calls.filter((c) => c.path.endsWith("/access_tokens"))).toHaveLength(1);

      // The ledger row.
      const rows = await build(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: "publish", state: "rebuilding", failure_reason: null, repo: REPO, ref: REF, decided_by: adminB, verified_at: null });
      expect(rows[0].dispatched_at).toBeInstanceOf(Date);
      expect(rows[0].published_at?.toISOString()).toBe(zoneBPublishedAt);
      expect(rows[0].staging_url).toBe(`http://127.0.0.1:${staging.port}`);

      // GitHub's own activity ledger (GH-04): attempted + succeeded, both carrying the approval id, joined
      // by the correlation id that the build row stored.
      const acts = await adminPool().query<{ id: string; metadata: Record<string, unknown> }>(
        `SELECT id, metadata FROM activities WHERE verb = 'github.deploy' AND metadata->>'approvalId' = $1 ORDER BY occurred_at, id`,
        [id],
      );
      expect(acts.rows.map((a) => a.metadata.outcome).sort()).toEqual(["attempted", "succeeded"]);
      const attempted = acts.rows.find((a) => a.metadata.outcome === "attempted");
      expect(attempted?.id).toBe(rows[0].github_correlation_id);
      expect(acts.rows.find((a) => a.metadata.outcome === "succeeded")?.metadata.correlationId).toBe(attempted?.id);
      expect(attempted?.metadata).toMatchObject({ repo: REPO, ref: REF, approvalId: id });

      // The approval row still says what WSK-66 said.
      expect(await row(id)).toMatchObject({ status: "approved", execution_status: "executed", execution_error: null });
      expect(JSON.parse((await row(id)).execution_result?.text ?? "{}")).toMatchObject({ rebuild: { target: "staging", approvalId: id } });
    });

    it("at-most-once per approval: a second decide is refused, and a duplicated hook call finds the first row and sends NOTHING", async () => {
      const id = await publishOne();
      expect((await decide(id, adminB)).statusCode).toBe(200);
      expect((await decide(id, adminB)).statusCode).toBe(404);
      expect(dispatches(gh)).toHaveLength(1);

      const again = await startSiteRebuild({
        tenantId: T, tenantSlug: TENANT_SLUG, siteId: SITE_ID, approvalId: id, kind: "publish", publishedAt: null, decider: await principal(adminB),
      });
      expect(again).toMatchObject({ deduplicated: true, state: "rebuilding" });
      expect(dispatches(gh)).toHaveLength(1);
      expect(await build(id)).toHaveLength(1);
    });

    it("a REJECTED publish and an approved SCHEDULE dispatch nothing (nothing public changed)", async () => {
      const rejected = await publishOne();
      expect((await decide(rejected, adminB, "rejected")).statusCode).toBe(200);
      const sched = await file(editor, "content.schedule", { items: [{ itemId: randomUUID(), version: 1 }], publishAt: "2099-11-01T00:00:00.000Z" });
      const r = await decide(sched, adminB);
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ webdesk: { command: "content.schedule", executionStatus: "executed" } });
      expect(gh.calls).toHaveLength(0);
      expect(await build(rejected)).toHaveLength(0);
      expect(await build(sched)).toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe("done-when 2 — two publishes 20 s apart: the second dispatch is recorded too", () => {
    it("two approved publishes 20 s apart → two dispatches, two ledger rows, each its own approval id (coalescing is GitHub's `concurrency`, asserted in the site repo)", async () => {
      const first = await publishOne();
      expect((await decide(first, adminB)).statusCode).toBe(200);
      await new Promise((r) => setTimeout(r, 20_000));
      zoneBPublishedAt = new Date().toISOString();
      const second = await publishOne();
      expect((await decide(second, adminB)).statusCode).toBe(200);

      const sent = dispatches(gh);
      expect(sent).toHaveLength(2);
      expect(sent.map((s) => (s.body?.inputs as { approval_id: string }).approval_id)).toEqual([first, second]);
      const rows = await adminPool().query<{ approval_id: string; dispatched_at: Date; state: string }>(
        `SELECT approval_id, dispatched_at, state FROM webdev_site_builds WHERE approval_id = ANY($1::uuid[]) ORDER BY dispatched_at`,
        [[first, second]],
      );
      expect(rows.rows.map((r) => r.approval_id)).toEqual([first, second]);
      expect(rows.rows.every((r) => r.state === "rebuilding")).toBe(true);
      const gap = rows.rows[1].dispatched_at.getTime() - rows.rows[0].dispatched_at.getTime();
      expect(gap).toBeGreaterThanOrEqual(19_000);
    }, 60_000);
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe("a rebuild that cannot start NEVER fails the publish, and is never shown as anything but failed", () => {
    // [label, arrange, expected reason, dispatches expected]
    type Case = [string, () => void, string, number];
    const cases: Case[] = [
      ["the App is NOT installed on the repo (dispatch 404, repo unreadable)", () => { gh.dispatch = "404"; gh.repoVisible = false; }, "github_app_not_installed", 1],
      ["the installation is gone (token exchange 404)", () => { gh.tokenExchange = "404"; }, "github_app_not_installed", 0],
      ["the App credential is wrong (token exchange 401)", () => { gh.tokenExchange = "401"; }, "github_not_configured", 0],
      ["the App is installed but lacks actions:write (403 'not accessible by integration')", () => { gh.dispatch = "403-permission"; }, "github_app_permission_missing", 1],
      ["the repo is visible but the workflow/ref is missing (dispatch 404, repo 200)", () => { gh.dispatch = "404"; gh.repoVisible = true; }, "workflow_not_found", 1],
      ["the workflow has no workflow_dispatch trigger (422)", () => { gh.dispatch = "422"; }, "workflow_not_dispatchable", 1],
      ["GitHub answers 500", () => { gh.dispatch = "500"; }, "github_dispatch_failed", 1],
      ["no App credential is sealed", () => { vi.mocked(credentialStore.loadAppCredentialOrThrow).mockRejectedValue(new GithubNotConfiguredError("erp", "credential_not_sealed")); }, "github_not_configured", 0],
      ["no rebuild target is configured for the site", () => { config.webdeskRebuild.targetsJson = ""; }, "rebuild_not_configured", 0],
      ["the GitHub org tenant is unresolvable", () => { config.githubOrgTenantId = ""; }, "github_org_unavailable", 0],
    ];
    it.each(cases)("%s → publish executed, build failed: %s", async (_label, arrange, reason, expectedDispatches) => {
      arrange();
      const id = await publishOne();
      const started = Date.now();
      const r = await decide(id, adminB);
      expect(r.statusCode).toBe(200);
      // The publish stands…
      expect(r.json()).toMatchObject({ webdesk: { executionStatus: "executed", build: { state: "failed", failureReason: reason } } });
      expect(await row(id)).toMatchObject({ status: "approved", execution_status: "executed", execution_error: null });
      expect(zoneBCalls).toHaveLength(1);
      // …and the ledger names why, in the editor's own terms.
      const rows = await build(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ state: "failed", failure_reason: reason, verified_at: null });
      expect(dispatches(gh)).toHaveLength(expectedDispatches);
      const s = await status(editor);
      expect(s.statusCode).toBe(200);
      expect(s.json()).toMatchObject({ build: { approvalId: id, kind: "publish", state: "failed", verifiedAt: null } });
      // The permission refusal must not have sat through the rate-limit queue's 60 s backoff.
      expect(Date.now() - started).toBeLessThan(15_000);
    }, 30_000);

    it("the dispatch outlives its deadline → failed `dispatch_unconfirmed` (it MAY have started a run: the ledger says so, it does not guess)", async () => {
      gh.dispatch = "slow";
      gh.slowMs = 1_500;
      config.webdeskRebuild.dispatchDeadlineMs = 300;
      const id = await publishOne();
      const r = await decide(id, adminB);
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ webdesk: { executionStatus: "executed", build: { state: "failed", failureReason: "dispatch_unconfirmed" } } });
      expect((await build(id))[0]).toMatchObject({ state: "failed", failure_reason: "dispatch_unconfirmed" });
      await new Promise((r2) => setTimeout(r2, 1_800)); // let the late stub answer drain before the next test
    });

    it("🔴 a decider without `github_repo · deploy` (a plain member) → deploy_denied, ZERO GitHub calls; ✅ control: the same call as company_admin dispatches", async () => {
      const id = await publishOne();
      const denied = await startSiteRebuild({
        tenantId: T, tenantSlug: TENANT_SLUG, siteId: SITE_ID, approvalId: id, kind: "publish", publishedAt: null, decider: await principal(member),
      });
      expect(denied).toMatchObject({ state: "failed", failureReason: "deploy_denied" });
      expect(gh.calls).toHaveLength(0);

      const id2 = await publishOne();
      const ok = await startSiteRebuild({
        tenantId: T, tenantSlug: TENANT_SLUG, siteId: SITE_ID, approvalId: id2, kind: "publish", publishedAt: null, decider: await principal(adminB),
      });
      expect(ok).toMatchObject({ state: "rebuilding", failureReason: null });
      expect(dispatches(gh)).toHaveLength(1);
    });

    it("🔴 the D14 rule needs a non-empty approval id: an empty one is refused before any call", async () => {
      const denied = await startSiteRebuild({
        tenantId: T, tenantSlug: TENANT_SLUG, siteId: SITE_ID, approvalId: "", kind: "publish", publishedAt: null, decider: await principal(adminB),
      }).catch((e: unknown) => e);
      // An empty approval id cannot even claim a ledger row (approval_id is a uuid): it fails closed, never dispatches.
      expect(gh.calls).toHaveLength(0);
      expect(denied).toMatchObject({ state: "failed" });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe("done-when 3 — the stamp poll: live ONLY when maxUpdatedAt ≥ publishedAt; an unchanged stamp stays rebuilding, then unverified", () => {
    async function dispatched(): Promise<{ id: string; publishedAt: Date }> {
      const id = await publishOne();
      expect((await decide(id, adminB)).statusCode).toBe(200);
      const b = (await build(id))[0];
      expect(b.state).toBe("rebuilding");
      return { id, publishedAt: b.published_at as Date };
    }
    const stampOf = (maxUpdatedAt: Date, pulledAt = new Date()) => ({
      source: "webdesk", pulledAt: pulledAt.toISOString(), maxUpdatedAt: maxUpdatedAt.toISOString(), itemCount: 330, sourceSha256: "x".repeat(64),
    });

    it("negative control: the OLD stamp (maxUpdatedAt before publishedAt) keeps the build `rebuilding` across sweeps — never live", async () => {
      const { id, publishedAt } = await dispatched();
      staging.body = stampOf(new Date(publishedAt.getTime() - 3_600_000));
      config.webdeskRebuild.pollIntervalMs = 1; // every sweep is due
      for (let i = 0; i < 3; i++) {
        await sweepSiteBuilds();
        expect((await build(id))[0]).toMatchObject({ state: "rebuilding", verified_at: null });
      }
      expect((await build(id))[0].poll_count).toBeGreaterThanOrEqual(3);
      expect(((await status(editor)).json() as { build: { state: string } }).build.state).toBe("rebuilding");
    });

    it("the same build goes LIVE the first sweep after the stamp reaches publishedAt; build-status reports live with verifiedAt", async () => {
      const { id, publishedAt } = await dispatched();
      config.webdeskRebuild.pollIntervalMs = 1;
      staging.body = stampOf(new Date(publishedAt.getTime() - 1)); // one millisecond short
      await sweepSiteBuilds();
      expect((await build(id))[0].state).toBe("rebuilding");
      staging.body = stampOf(publishedAt); // exactly equal
      const r = await sweepSiteBuilds();
      expect(r.live).toBeGreaterThanOrEqual(1);
      const b = (await build(id))[0];
      expect(b.state).toBe("live");
      expect(b.verified_at).toBeInstanceOf(Date);
      const s = (await status(editor)).json() as { build: Record<string, unknown> };
      expect(s.build).toMatchObject({ approvalId: id, kind: "publish", state: "live" });
      expect(typeof s.build.verifiedAt).toBe("string");
      // A settled build is not polled again.
      const hits = staging.hits;
      await sweepSiteBuilds();
      expect(staging.hits).toBe(hits);
    });

    it("the git build's stamp, an unreachable site and a 404 prove nothing: still rebuilding", async () => {
      const { id } = await dispatched();
      config.webdeskRebuild.pollIntervalMs = 1;
      staging.body = { source: "git" };
      await sweepSiteBuilds();
      staging.status = 404;
      await sweepSiteBuilds();
      staging.status = 200;
      staging.body = "not an object";
      await sweepSiteBuilds();
      expect((await build(id))[0].state).toBe("rebuilding");
    });

    it("negative control, run to its natural timeout: an unchanged stamp stays `rebuilding` until the window closes, then `unverified` (never live)", async () => {
      const { id, publishedAt } = await dispatched();
      staging.body = stampOf(new Date(publishedAt.getTime() - 3_600_000));
      config.webdeskRebuild.pollIntervalMs = 100;
      config.webdeskRebuild.pollWindowMs = 1_500;
      const dispatchedAt = (await build(id))[0].dispatched_at as Date;
      const seen = new Set<string>();
      const deadline = Date.now() + 10_000;
      let final = "rebuilding";
      while (Date.now() < deadline) {
        await sweepSiteBuilds();
        final = (await build(id))[0].state;
        seen.add(final);
        if (final !== "rebuilding") break;
        await new Promise((r) => setTimeout(r, 150));
      }
      expect(final).toBe("unverified");
      expect([...seen]).toEqual(["rebuilding", "unverified"]); // it WAS rebuilding first, and was never live
      expect(Date.now() - dispatchedAt.getTime()).toBeGreaterThanOrEqual(1_500);
      const b = (await build(id))[0];
      expect(b.verified_at).toBeNull();
      expect(((await status(editor)).json() as { build: { state: string; verifiedAt: unknown } }).build).toMatchObject({ state: "unverified", verifiedAt: null });
    }, 30_000);

    it("a stamp that proves the build wins over an expired window (the window closes only an UNPROVEN build)", async () => {
      const { id, publishedAt } = await dispatched();
      config.webdeskRebuild.pollIntervalMs = 1;
      staging.body = stampOf(publishedAt);
      await sweepSiteBuilds({ now: new Date(Date.now() + 3 * 3_600_000) });
      expect((await build(id))[0].state).toBe("live");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe("content.rebuild — the editor's 'Request rebuild' after an unpublish", () => {
    it("POST rebuild-requests → 202 {approvalId} (exactly that key); a second request returns the SAME open approval", async () => {
      const r = await requestRebuild(editor);
      expect(r.statusCode).toBe(202);
      const body = r.json() as Record<string, unknown>;
      expect(Object.keys(body)).toEqual(["approvalId"]);
      expect(typeof body.approvalId).toBe("string");
      const filed = await row(body.approvalId as string);
      expect(filed).toMatchObject({ status: "pending", execution_status: "not_applicable" });
      expect(filed.tool_args).toMatchObject({ command: "content.rebuild", tenantSlug: TENANT_SLUG, siteId: SITE_ID, rebuild: { target: "staging", approvalId: body.approvalId } });
      expect((await requestRebuild(editor)).json()).toEqual({ approvalId: body.approvalId });
      // A different site gets its own.
      expect(((await requestRebuild(editor, OTHER_SITE_ID)).json() as { approvalId: string }).approvalId).not.toBe(body.approvalId);
      expect(gh.calls).toHaveLength(0); // filing dispatches nothing
    });

    it("🔴 a plain member cannot file one (403); ✅ control: the editor can, on the identical request", async () => {
      expect((await requestRebuild(member)).statusCode).toBe(403);
      expect((await requestRebuild(editor)).statusCode).toBe(202);
    });

    it("no staging target for the site → 503 at FILING (an approval that could only fail is not filed)", async () => {
      config.webdeskRebuild.targetsJson = "";
      const r = await requestRebuild(editor);
      expect(r.statusCode).toBe(503);
      expect(JSON.stringify(r.json())).toContain("webdesk_not_configured");
    });

    it("approve → ONE dispatch carrying kind=rebuild and the approval id, no published_at; the build is kind `rebuild`", async () => {
      const id = ((await requestRebuild(editor)).json() as { approvalId: string }).approvalId;
      const r = await decide(id, adminB);
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ webdesk: { command: "content.rebuild", executionStatus: "executed", build: { state: "rebuilding" } } });
      expect(zoneBCalls).toHaveLength(0); // nothing goes to Zone B
      const sent = dispatches(gh);
      expect(sent).toHaveLength(1);
      expect(sent[0].body).toEqual({ ref: REF, inputs: { approval_id: id, kind: "rebuild" } });
      expect(await row(id)).toMatchObject({ status: "approved", execution_status: "executed", execution_error: null });
      const s = (await status(editor)).json() as { build: Record<string, unknown> };
      expect(s.build).toMatchObject({ approvalId: id, kind: "rebuild", state: "rebuilding", publishedAt: null });
    });

    it("the requester may decide their own rebuild (no maker-checker arm: it changes no WebDesk content), still through company_admin's generic decide gate", async () => {
      const id = ((await requestRebuild(adminA)).json() as { approvalId: string }).approvalId;
      expect((await decide(id, adminA)).statusCode).toBe(200);
      expect(dispatches(gh)).toHaveLength(1);
    });

    it("🔴 a decider who is not company_admin is refused by the generic decide gate: row pending, zero dispatches; ✅ control: company_admin", async () => {
      const id = ((await requestRebuild(editor)).json() as { approvalId: string }).approvalId;
      expect((await decide(id, member)).statusCode).toBe(403);
      expect((await decide(id, editor)).statusCode).toBe(403);
      expect((await row(id)).status).toBe("pending");
      expect(gh.calls).toHaveLength(0);
      expect((await decide(id, adminB)).statusCode).toBe(200);
      expect(dispatches(gh)).toHaveLength(1);
    });

    it("App not installed → the approval is `failed` with `webdesk_rebuild_failed: github_app_not_installed`, the build is failed, nothing pretends", async () => {
      gh.dispatch = "404";
      gh.repoVisible = false;
      const id = ((await requestRebuild(editor)).json() as { approvalId: string }).approvalId;
      const r = await decide(id, adminB);
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ status: "approved", webdesk: { command: "content.rebuild", executionStatus: "failed", error: "webdesk_rebuild_failed: github_app_not_installed" } });
      expect(await row(id)).toMatchObject({ execution_status: "failed", execution_error: "webdesk_rebuild_failed: github_app_not_installed" });
      expect((await build(id))[0]).toMatchObject({ kind: "rebuild", state: "failed", failure_reason: "github_app_not_installed" });
      expect(((await status(editor)).json() as { build: { state: string } }).build.state).toBe("failed");
    });

    it("the target removed between filing and approving → 503 at decide's preflight, the row stays PENDING and nothing is sent", async () => {
      const id = ((await requestRebuild(editor)).json() as { approvalId: string }).approvalId;
      config.webdeskRebuild.targetsJson = "";
      expect((await decide(id, adminB)).statusCode).toBe(503);
      expect((await row(id)).status).toBe("pending");
      expect(gh.calls).toHaveLength(0);
    });

    it("🔴 tool_args edited after filing (the site swapped for another configured site) → failed `webdesk_args_tampered`, zero dispatches", async () => {
      const id = ((await requestRebuild(editor)).json() as { approvalId: string }).approvalId;
      await adminPool().query(`UPDATE automation_approvals SET tool_args = jsonb_set(tool_args, '{siteId}', to_jsonb($2::text)) WHERE id = $1`, [id, OTHER_SITE_ID]);
      const r = await decide(id, adminB);
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ webdesk: { executionStatus: "failed" } });
      expect((await row(id)).execution_error).toMatch(/^webdesk_args_tampered: /);
      expect(gh.calls).toHaveLength(0);
      expect(await build(id)).toHaveLength(0);
    });

    it("a rebuild is proven by pulledAt ≥ dispatchedAt (an unpublish moves no maxUpdatedAt): an older pull stays rebuilding, a newer one goes live", async () => {
      const id = ((await requestRebuild(editor)).json() as { approvalId: string }).approvalId;
      expect((await decide(id, adminB)).statusCode).toBe(200);
      const dispatchedAt = (await build(id))[0].dispatched_at as Date;
      config.webdeskRebuild.pollIntervalMs = 1;
      staging.body = { source: "webdesk", pulledAt: new Date(dispatchedAt.getTime() - 60_000).toISOString(), maxUpdatedAt: new Date().toISOString(), itemCount: 3, sourceSha256: "x" };
      await sweepSiteBuilds();
      expect((await build(id))[0].state).toBe("rebuilding"); // a newer maxUpdatedAt does NOT rescue a rebuild
      staging.body = { source: "webdesk", pulledAt: new Date(dispatchedAt.getTime() + 60_000).toISOString(), maxUpdatedAt: null, itemCount: 3, sourceSha256: "x" };
      await sweepSiteBuilds();
      expect((await build(id))[0].state).toBe("live");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe("stagingStale — content taken down stays on staging until a later rebuild is verified", () => {
    it("noteStagingStale sets it; a rebuild dispatched AFTER it and verified live clears it; one dispatched BEFORE does not", async () => {
      const site = randomUUID();
      config.webdeskRebuild.targetsJson = JSON.stringify([target(site)]);
      config.webdeskRebuild.pollIntervalMs = 1;
      expect(await getBuildStatus(T, TENANT_SLUG, site)).toEqual({ build: null, stagingStale: false });

      // A build dispatched before the takedown…
      const before = await publishOne(editor, site);
      expect((await decide(before, adminB)).statusCode).toBe(200);
      await new Promise((r) => setTimeout(r, 30));
      await noteStagingStale(T, site);
      await noteStagingStale(T, site); // idempotent
      expect((await getBuildStatus(T, TENANT_SLUG, site)).stagingStale).toBe(true);
      staging.body = { source: "webdesk", pulledAt: new Date(Date.now() + 1e6).toISOString(), maxUpdatedAt: new Date(Date.now() + 1e6).toISOString(), itemCount: 1, sourceSha256: "x" };
      await sweepSiteBuilds();
      expect((await build(before))[0].state).toBe("live");
      expect((await getBuildStatus(T, TENANT_SLUG, site)).stagingStale).toBe(true); // …does not clear it

      // …and a rebuild requested after the takedown does.
      const rb = ((await requestRebuild(editor, site)).json() as { approvalId: string }).approvalId;
      expect((await decide(rb, adminB)).statusCode).toBe(200);
      await sweepSiteBuilds();
      expect((await build(rb))[0].state).toBe("live");
      expect(await getBuildStatus(T, TENANT_SLUG, site)).toMatchObject({ stagingStale: false, build: { kind: "rebuild", state: "live" } });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe("done-when 5 — build-status and rebuild-requests match the editor's wire shapes EXACTLY", () => {
    it("no build yet → exactly { build: null, stagingStale: false }", async () => {
      const r = await status(editor, randomUUID());
      expect(r.statusCode).toBe(200);
      const body = r.json() as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual([...BUILD_STATUS_KEYS].sort());
      expect(body).toEqual({ build: null, stagingStale: false });
    });

    it("a build → exactly the seven keys the editor parses, with the editor's types, and nothing else", async () => {
      const id = await publishOne();
      expect((await decide(id, adminB)).statusCode).toBe(200);
      const body = (await status(editor)).json() as { build: Record<string, unknown>; stagingStale: unknown };
      expect(Object.keys(body).sort()).toEqual([...BUILD_STATUS_KEYS].sort());
      expect(Object.keys(body.build).sort()).toEqual([...BUILD_KEYS].sort());
      // platform-ui/src/lib/webdeskContent.ts parseBuildStatus, restated.
      expect(typeof body.stagingStale).toBe("boolean");
      const b = body.build as { approvalId: unknown; kind: unknown; requestedAt: unknown; publishedAt: unknown; state: unknown; stagingUrl: unknown; verifiedAt: unknown };
      expect(b.approvalId).toBe(id);
      expect(["publish", "rebuild"]).toContain(b.kind);
      expect(["rebuilding", "live", "unverified", "failed"]).toContain(b.state);
      expect(Number.isFinite(Date.parse(String(b.requestedAt)))).toBe(true);
      expect(Number.isFinite(Date.parse(String(b.publishedAt)))).toBe(true);
      expect(b.stagingUrl).toBe(`http://127.0.0.1:${staging.port}`);
      expect(b.verifiedAt).toBeNull();
    });

    it("the three reasons a caller sees nothing: unauthenticated 401, a member 403, a malformed siteId 400 (after authz), another tenant's slug → build null", async () => {
      const url = `/api/${T}/modules/webdev/content/sites/${TENANT_SLUG}/${SITE_ID}/build-status`;
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
      expect((await status(member)).statusCode).toBe(403);
      expect((await status(editor)).statusCode).toBe(200);
      expect((await status(editor, "not-a-uuid")).statusCode).toBe(400);
      const id = await publishOne();
      await decide(id, adminB);
      expect(((await status(editor, SITE_ID, "some-other-tenant")).json() as { build: unknown }).build).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe("the third wall + the ledger's own CHECKs", () => {
    it("🔴 a connection that does not declare the webdev module sees ZERO rows and cannot insert; ✅ control: with the module scope it sees them", async () => {
      const id = await publishOne();
      await decide(id, adminB);
      const superCount = await adminPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM webdev_site_builds WHERE tenant_id = $1`, [T]);
      expect(Number(superCount.rows[0].n)).toBeGreaterThan(0);

      const noModule = await withTenants([T], (c) => c.query(`SELECT id FROM webdev_site_builds`));
      expect(noModule.rows).toHaveLength(0);
      await expect(
        withTenants([T], (c) =>
          c.query(`INSERT INTO webdev_site_builds (tenant_id, tenant_slug, site_id, kind) VALUES ($1, 'x', $2, 'publish')`, [T, randomUUID()]),
        ),
      ).rejects.toThrow(/row-level security/);

      const withModule = await withTenants([T], (c) => c.query(`SELECT id FROM webdev_site_builds`), { modules: ["webdev"] });
      expect(withModule.rows.length).toBe(Number(superCount.rows[0].n));

      const other = await createCompany("WSK-60 Other Co", ["webdev"]);
      const foreign = await withTenants([other], (c) => c.query(`SELECT id FROM webdev_site_builds`), { modules: ["webdev"] });
      expect(foreign.rows).toHaveLength(0);
      const marks = await withTenants([T], (c) => c.query(`SELECT 1 FROM webdev_site_staging_marks`));
      expect(marks.rows).toHaveLength(0);
    });

    it("the CHECKs: live needs verified_at; failed needs a reason (and a typed one); a reason needs failed; one build per approval", async () => {
      const base = (extra: string, vals: unknown[]) =>
        adminPool().query(
          `INSERT INTO webdev_site_builds (tenant_id, tenant_slug, site_id, kind, ${extra.split("|")[0]}) VALUES ($1, 'x', $2, 'publish', ${extra.split("|")[1]})`,
          [T, randomUUID(), ...vals],
        );
      await expect(base("state, dispatched_at|'live', now()", [])).rejects.toThrow(/wsb_live_is_verified/);
      await expect(base("state|'failed'", [])).rejects.toThrow(/wsb_failed_has_reason/);
      await expect(base("state, failure_reason|'failed', 'Not A Token!'", [])).rejects.toThrow(/wsb_failure_reason_token/);
      await expect(base("state, failure_reason|'rebuilding', 'github_dispatch_failed'", [])).rejects.toThrow(/wsb_failed_has_reason/);
      await expect(base("state|'unverified'", [])).rejects.toThrow(/wsb_dispatched_for_poll_outcomes/);
      const approval = randomUUID();
      const ins = () =>
        adminPool().query(`INSERT INTO webdev_site_builds (tenant_id, tenant_slug, site_id, kind, approval_id) VALUES ($1, 'x', $2, 'publish', $3)`, [T, randomUUID(), approval]);
      await ins();
      await expect(ins()).rejects.toThrow(/ux_wsb_tenant_approval/);
    });
  });
});
