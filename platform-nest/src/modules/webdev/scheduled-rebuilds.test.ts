// WSK-61 — a scheduled publish going live rebuilds staging under the schedule's OWN approval, end to end.
//
// Real: Postgres (RLS, the migrated ledger and firings table), Cerbos (resource_webdesk_content_item.yaml
// `schedule`, resource_github_repo.yaml `deploy`, resource_webdev_zoneb_event.yaml `record`, all
// unmodified), the NestJS app (`decide`, `zoneb-events`), the REAL GitHub chokepoint over real sockets,
// the WSK-60 ledger and the stamp poller. Stubs: GitHub's API and the staging site (local HTTP servers,
// the site-builds-dispatch.test.ts harness), and Zone B (a fake control client that answers the schedule
// write and `item.get` from a table the test controls). Needs DATABASE_URL_TEST + CERBOS_URL.
//
// The event is a HINT: every test that fires one also proves the dispatch decision came from the
// company's own approval rows and a fresh `item.get`, never from the event's contents.
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { buildApp } from "../../main";
import { resetModules } from "../registry";
import { resetCoreRollupProviders } from "../../rollups/engine";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../../testing/fixtures";
import { assemblePrincipal, type Principal } from "../../rbac/principal";
import { withGlobal, withTenants } from "../../db";
import * as credentialStore from "../../core/github/credential-store";
import { resetGithubRuntimesForTest } from "../../core/github/github-app.service";
import type { WebdeskControlClient, WebdeskControlRequest, WebdeskControlResponse } from "./webdesk-control-client";
import {
  fileWebdeskCommandApproval,
  setWebdeskApprovedCommandDepsForTests,
  webdeskCommandHashFor,
  type EditorialAssertionSigner,
} from "./webdesk-approved-command";
import { getBuildStatus, sweepSiteBuilds } from "./site-builds.service";
import { scheduleSettleIdleForTests, setScheduleIndexNowNotifierForTests, settleScheduledRebuilds, sweepScheduledRebuilds } from "./scheduled-rebuilds.service";

vi.mock("../../core/github/credential-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/github/credential-store")>();
  return { ...actual, loadAppCredentialOrThrow: vi.fn() };
});

const live = !!TEST_URL && !!process.env.CERBOS_URL;

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

const TENANT_SLUG = "gaiada";
const REPO = "gaiadabali/gaiada-web-revamp";
const WORKFLOW = "webdesk-rebuild.yml";
const REF = "astro-site";
const APP_ID = "4777424";
const INSTALLATION_ID = "157879245";
const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

// ── Stub GitHub API (token exchange + dispatch; the WSK-60 harness, trimmed) ─────────────────────────
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
      const p = req.url ?? "";
      g.calls.push({ method: req.method ?? "", path: p, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : null });
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json", "x-ratelimit-remaining": "4999", "x-ratelimit-limit": "5000" });
        res.end(JSON.stringify(body));
      };
      if (req.method === "POST" && p === `/app/installations/${INSTALLATION_ID}/access_tokens`) {
        return json(201, { token: "ghs_wsk61_installation_token", expires_at: new Date(Date.now() + 3_600_000).toISOString(), permissions: { actions: "write" } });
      }
      if (req.method === "POST" && p === `/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`) {
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method === "GET" && p === `/repos/${REPO}`) return json(200, { full_name: REPO });
      json(404, { message: "stub: no such route" });
    });
  });
  await new Promise<void>((r) => g.server.listen(0, "127.0.0.1", r));
  g.port = (g.server.address() as AddressInfo).port;
  return g;
}

// ── Stub staging site (the stamp) ────────────────────────────────────────────────────────────────────
interface Staging { server: http.Server; port: number; body: unknown }
async function startStaging(): Promise<Staging> {
  const s = { body: { source: "git" } } as unknown as Staging;
  s.server = http.createServer((req, res) => {
    if (!(req.url ?? "").startsWith("/webdesk-build.json")) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(s.body));
  });
  await new Promise<void>((r) => s.server.listen(0, "127.0.0.1", r));
  s.port = (s.server.address() as AddressInfo).port;
  return s;
}

// ── Fake Zone B: the schedule write succeeds; item.get answers from `zb.items` ───────────────────────
type ItemState = Record<string, unknown> | 404 | 500;
const zb = { items: new Map<string, ItemState>(), calls: [] as WebdeskControlRequest[] };
const reads = () => zb.calls.filter((c) => c.command === "item.get");
const testSigner: EditorialAssertionSigner = { configured: true, sign: () => "a.b.c" };
const fakeClient = {
  async send(req: WebdeskControlRequest): Promise<WebdeskControlResponse> {
    zb.calls.push(req);
    if (req.command === "item.get") {
      const st = zb.items.get(String(req.params?.itemId));
      if (st === undefined || st === 404) {
        return { status: 404, contentType: "application/problem+json", json: { type: "https://webdesk.gaiada.online/errors/item-not-found" }, bodyText: "" };
      }
      if (st === 500) return { status: 500, contentType: "application/problem+json", json: { type: "https://webdesk.gaiada.online/errors/boom" }, bodyText: "" };
      return { status: 200, contentType: "application/json", json: { item: { itemId: req.params?.itemId, ...st }, version: {}, live: null }, bodyText: "" };
    }
    const items = ((req.body?.items as Array<{ itemId: string; version: number }>) ?? []);
    const key = req.command === "content.publish" ? "published" : "scheduled";
    return { status: 200, contentType: "application/json", json: { [key]: items.map((it) => ({ itemId: it.itemId, version: it.version })), replayed: false }, bodyText: "" };
  },
  close() {},
} as unknown as WebdeskControlClient;

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
/** Live at `v` by TIME (a plain scheduled publish whose publish_at passed; the tick has not run yet). */
const liveByTime = (v: number) => ({ publishState: "scheduled", publishedVersion: v, publishAt: ago(60_000), unpublishAt: null, deletedAt: null });
const published = (v: number) => ({ publishState: "published", publishedVersion: v, publishAt: null, unpublishAt: null, deletedAt: null });
const unpublished = () => ({ publishState: "unpublished", publishedVersion: null, publishAt: null, unpublishAt: null, deletedAt: null });
const deleted = (v: number) => ({ ...published(v), deletedAt: ago(5_000) });

describe.skipIf(!live)("WSK-61 — a scheduled publish going live dispatches ONE staging rebuild under its own approval", () => {
  let app: NestFastifyApplication;
  let gh: Github;
  let staging: Staging;
  let T: string;
  let U: string;
  let adminA: string;
  let adminB: string;
  let adminC: string;
  let editor: string;
  let SITE: string;
  const P: Record<string, Principal> = {};
  const realFetch = global.fetch;

  const target = (siteId: string) => ({ tenantSlug: TENANT_SLUG, siteId, repo: REPO, workflow: WORKFLOW, ref: REF, stagingUrl: `http://127.0.0.1:${staging.port}` });

  async function principal(userId: string): Promise<Principal> {
    if (!P[userId]) {
      const p = await assemblePrincipal(userId, "high");
      if (!p) throw new Error(`could not assemble ${userId}`);
      P[userId] = p;
    }
    return P[userId];
  }

  const decide = (id: string, as: string, decision: "approved" | "rejected" = "approved") =>
    app.inject({ method: "POST", url: `/api/${T}/automation-approvals/${id}/decide`, headers: asUser(as), payload: { decision } });

  /** File a content.schedule as the editor; decide it (approved unless told otherwise). */
  async function schedule(
    items: Array<{ itemId: string; version: number }>,
    at: { publishAt?: string | null; unpublishAt?: string | null },
    opts: { decider?: string; decision?: "approved" | "rejected" | null; siteId?: string } = {},
  ): Promise<string> {
    const { approvalId } = await fileWebdeskCommandApproval(await principal(editor), T, {
      command: "content.schedule",
      tenantSlug: TENANT_SLUG,
      siteId: opts.siteId ?? SITE,
      args: { items, publishAt: at.publishAt ?? null, unpublishAt: at.unpublishAt ?? null },
      summary: { title: "wsk61 schedule" },
    });
    if (opts.decision !== null) {
      const r = await decide(approvalId, opts.decider ?? adminB, opts.decision ?? "approved");
      expect(r.statusCode).toBe(200);
      if ((opts.decision ?? "approved") === "approved") {
        expect(r.json()).toMatchObject({ webdesk: { command: "content.schedule", executionStatus: "executed" } });
      }
    }
    zb.calls.length = 0; // the schedule write itself is not what these tests count
    return approvalId;
  }

  const fire = (data: Record<string, unknown>, opts: { eventId?: string; as?: string; tenant?: string } = {}) =>
    app.inject({
      method: "POST",
      url: `/api/${opts.tenant ?? T}/modules/webdev/zoneb-events`,
      headers: asUser(opts.as ?? adminA),
      payload: { eventId: opts.eventId ?? randomUUID(), kind: "schedule.fired", tenantId: opts.tenant ?? T, originSite: "webdesk", occurredAt: new Date().toISOString(), data },
    });
  const firedData = (items: Array<{ itemId: string; version: number | null }>, over: Record<string, unknown> = {}) => ({
    tenantSlug: TENANT_SLUG,
    siteId: SITE,
    transition: "publish",
    approvalId: null,
    items: items.map((i) => ({ ...i, effectiveAt: ago(60_000) })),
    ...over,
  });

  async function builds(approvalId: string) {
    const { rows } = await adminPool().query<{ id: string; kind: string; state: string; failure_reason: string | null; decided_by: string | null; dispatched_at: Date | null; published_at: Date | null }>(
      `SELECT id, kind, state, failure_reason, decided_by, dispatched_at, published_at FROM webdev_site_builds WHERE approval_id = $1`,
      [approvalId],
    );
    return rows;
  }
  async function firings(approvalId: string) {
    const { rows } = await adminPool().query<{ transition: string; outcome: string; build_id: string | null; detail: string | null; site_id: string | null }>(
      `SELECT transition, outcome, build_id, detail, site_id FROM webdev_schedule_firings WHERE approval_id = $1 ORDER BY transition`,
      [approvalId],
    );
    return rows;
  }
  async function stale(siteId: string): Promise<boolean> {
    return (await getBuildStatus(T, TENANT_SLUG, siteId)).stagingStale;
  }

  beforeAll(async () => {
    gh = await startGithub();
    staging = await startStaging();
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    T = await createCompany("WSK-61 Co", ["webdev"]);
    U = await createCompany("WSK-61 Other Co", ["webdev"]);
    const mk = async (email: string, role: string) => {
      const id = await createUser(email);
      await addMembership(T, id);
      await grantRole(id, await createRole(role), "company", T);
      return id;
    };
    adminA = await mk("wsk61-admin-a@ex.test", "company_admin");
    adminB = await mk("wsk61-admin-b@ex.test", "company_admin");
    adminC = await mk("wsk61-admin-c@ex.test", "company_admin");
    editor = await mk("wsk61-editor@ex.test", "webdev_staff");
    config.githubOrgTenantId = T;
    config.githubApps.erp = { appId: APP_ID, installationId: INSTALLATION_ID };
    app = await buildApp();
  }, 120_000);

  beforeEach(async () => {
    // Isolation: every test gets a fresh site, and nothing an earlier test left due is swept again.
    await adminPool().query(`UPDATE automation_approvals SET deleted_at = now() WHERE workflow_id = 'content.schedule' AND deleted_at IS NULL`);
    await adminPool().query(`UPDATE webdev_site_builds SET state = 'failed', failure_reason = 'dispatch_unconfirmed' WHERE state = 'rebuilding'`);
    SITE = randomUUID();
    gh.calls.length = 0;
    staging.body = { source: "git" };
    zb.items.clear();
    zb.calls.length = 0;
    config.webdeskRebuild.targetsJson = JSON.stringify([target(SITE)]);
    config.webdeskRebuild.dispatchDeadlineMs = 30_000;
    config.webdeskRebuild.pollWindowMs = 20 * 60_000;
    config.webdeskRebuild.pollIntervalMs = 1;
    config.webdeskSchedule.supersedeGraceMs = 15 * 60_000;
    config.githubOrgTenantId = T;
    resetGithubRuntimesForTest();
    vi.mocked(credentialStore.loadAppCredentialOrThrow).mockReset().mockResolvedValue({
      connectionId: "conn-wsk61", appId: APP_ID, installationId: INSTALLATION_ID, privateKeyPem: PEM,
    });
    global.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      return realFetch(url.startsWith("https://api.github.com") ? url.replace("https://api.github.com", `http://127.0.0.1:${gh.port}`) : url, init);
    }) as typeof fetch;
    setWebdeskApprovedCommandDepsForTests({ client: fakeClient, signer: testSigner });
  });

  afterEach(async () => {
    await scheduleSettleIdleForTests(T);
    global.fetch = realFetch;
    setWebdeskApprovedCommandDepsForTests(null);
    setScheduleIndexNowNotifierForTests(null);
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
  describe("the event path: one dispatch, as the decider, under the schedule's approval; a replay sends nothing", () => {
    it("schedule.fired → re-read both items → ONE dispatch (approval id, kind publish, no published_at) → build row + firing row", async () => {
      const a = randomUUID(), b = randomUUID();
      const id = await schedule([{ itemId: a, version: 2 }, { itemId: b, version: 3 }], { publishAt: ago(60_000) });
      expect(dispatches(gh)).toHaveLength(0); // the schedule itself never rebuilds (WSK-66)
      zb.items.set(a, liveByTime(2));
      zb.items.set(b, published(3)); // the tick already flipped this one: both read as live

      const eventId = randomUUID();
      const r = await fire(firedData([{ itemId: a, version: 2 }, { itemId: b, version: 3 }]), { eventId });
      expect(r.statusCode).toBe(201);
      expect(r.json()).toMatchObject({ inserted: true });
      await scheduleSettleIdleForTests(T);

      expect(reads().map((c) => c.params?.itemId).sort()).toEqual([a, b].sort());
      const sent = dispatches(gh);
      expect(sent).toHaveLength(1);
      expect(sent[0].body).toEqual({ ref: REF, inputs: { approval_id: id, kind: "publish" } });
      const rows = await builds(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: "publish", state: "rebuilding", failure_reason: null, decided_by: adminB, published_at: null });
      expect(await firings(id)).toEqual([{ transition: "publish", outcome: "build_recorded", build_id: rows[0].id, detail: "items_live=2/2;build=rebuilding", site_id: SITE }]);

      // The SAME event again (an at-least-once producer): 200, nothing recorded, nothing dispatched.
      zb.calls.length = 0;
      const again = await fire(firedData([{ itemId: a, version: 2 }, { itemId: b, version: 3 }]), { eventId });
      expect(again.statusCode).toBe(200);
      expect(again.json()).toMatchObject({ inserted: false });
      await scheduleSettleIdleForTests(T);
      // A NEW event for the same schedule and a sweep: the settled schedule is not even read again.
      expect((await fire(firedData([{ itemId: a, version: 2 }]))).statusCode).toBe(201);
      await scheduleSettleIdleForTests(T);
      await sweepScheduledRebuilds();
      expect(reads()).toHaveLength(0);
      expect(dispatches(gh)).toHaveLength(1);
      expect(await builds(id)).toHaveLength(1);
    });

    it("the event's answer does not wait on, or change with, the settle: an unreadable Zone B still answers 201", async () => {
      const a = randomUUID();
      const id = await schedule([{ itemId: a, version: 1 }], { publishAt: ago(60_000) });
      zb.items.set(a, 500);
      const r = await fire(firedData([{ itemId: a, version: 1 }]));
      expect(r.statusCode).toBe(201);
      await scheduleSettleIdleForTests(T);
      expect(dispatches(gh)).toHaveLength(0);
      expect(await firings(id)).toEqual([]); // not settled: the next tick reads again
      zb.items.set(a, liveByTime(1));
      await sweepScheduledRebuilds();
      expect(dispatches(gh)).toHaveLength(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe("the sweep is the primary path; racing the event still yields ONE dispatch", () => {
    it("no event at all → the sweep dispatches", async () => {
      const a = randomUUID();
      const id = await schedule([{ itemId: a, version: 4 }], { publishAt: ago(60_000) });
      zb.items.set(a, liveByTime(4));
      const r = await sweepScheduledRebuilds();
      expect(r).toMatchObject({ dispatched: 1 });
      expect(dispatches(gh)).toHaveLength(1);
      expect((await builds(id))[0]).toMatchObject({ state: "rebuilding", decided_by: adminB });
    });

    it("event + two sweeps at once → one build row, one dispatch", async () => {
      const a = randomUUID();
      const id = await schedule([{ itemId: a, version: 1 }], { publishAt: ago(60_000) });
      zb.items.set(a, liveByTime(1));
      await Promise.all([fire(firedData([{ itemId: a, version: 1 }])), sweepScheduledRebuilds(), settleScheduledRebuilds(T)]);
      await scheduleSettleIdleForTests(T);
      expect(dispatches(gh)).toHaveLength(1);
      expect(await builds(id)).toHaveLength(1);
      expect(await firings(id)).toHaveLength(1);
    });

    it("not yet due (publishAt in the future) → nothing read, nothing dispatched", async () => {
      const a = randomUUID();
      await schedule([{ itemId: a, version: 1 }], { publishAt: new Date(Date.now() + 3_600_000).toISOString() });
      zb.items.set(a, published(1));
      await fire(firedData([{ itemId: a, version: 1 }]));
      await scheduleSettleIdleForTests(T);
      await sweepScheduledRebuilds();
      expect(reads()).toHaveLength(0);
      expect(dispatches(gh)).toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe("only the company's own APPROVED-and-EXECUTED schedules can rebuild", () => {
    it("🔴 rejected, still pending, or withdrawn (deleted) → never dispatched, even with every item live and an event naming it", async () => {
      const a = randomUUID();
      const rejected = await schedule([{ itemId: a, version: 1 }], { publishAt: ago(60_000) }, { decision: "rejected" });
      const pending = await schedule([{ itemId: a, version: 1 }], { publishAt: ago(60_000) }, { decision: null });
      const withdrawn = await schedule([{ itemId: a, version: 1 }], { publishAt: ago(60_000) });
      await adminPool().query(`UPDATE automation_approvals SET deleted_at = now() WHERE id = $1`, [withdrawn]);
      zb.items.set(a, liveByTime(1));
      for (const approvalId of [rejected, pending, withdrawn]) {
        await fire(firedData([{ itemId: a, version: 1 }], { approvalId }));
      }
      await scheduleSettleIdleForTests(T);
      await sweepScheduledRebuilds();
      expect(reads()).toHaveLength(0);
      expect(dispatches(gh)).toHaveLength(0);
      for (const id of [rejected, pending, withdrawn]) expect(await builds(id)).toHaveLength(0);
      // ✅ control: the same items, approved → dispatched.
      const ok = await schedule([{ itemId: a, version: 1 }], { publishAt: ago(60_000) });
      await sweepScheduledRebuilds();
      expect(await builds(ok)).toHaveLength(1);
    });

    it("🔴 a forged event naming ANOTHER company's due schedule (its site, its approval id) does nothing to it", async () => {
      const a = randomUUID();
      const mine = await schedule([{ itemId: a, version: 1 }], { publishAt: new Date(Date.now() + 3_600_000).toISOString() });
      // U's due, executed schedule (inserted raw: U has no users here), its args re-hashed so they are VALID.
      const theirs = randomUUID();
      const theirSite = randomUUID();
      const src = (await adminPool().query<{ tool_args: Record<string, unknown> }>(`SELECT tool_args FROM automation_approvals WHERE id = $1`, [mine])).rows[0].tool_args;
      const args: Record<string, unknown> = { ...src, siteId: theirSite, publishAt: ago(60_000), rebuild: { target: "staging", approvalId: theirs } };
      args.commandHash = webdeskCommandHashFor(args);
      await adminPool().query(
        `INSERT INTO automation_approvals (id, tenant_id, workflow_id, tool_name, tool_args, impact, reason, requested_by, origin, origin_site, status, execution_status, decided_at)
         SELECT $1, $2, workflow_id, tool_name, $3::jsonb, impact, reason, requested_by, origin, origin_site, 'approved', 'executed', now()
           FROM automation_approvals WHERE id = $4`,
        [theirs, U, JSON.stringify(args), mine],
      );
      zb.items.set(a, liveByTime(1));
      const r = await fire(firedData([{ itemId: a, version: 1 }], { siteId: theirSite, approvalId: theirs }));
      expect(r.statusCode).toBe(201); // recorded as a fact on T; it is noise
      await scheduleSettleIdleForTests(T);
      expect(reads()).toHaveLength(0);
      expect(dispatches(gh)).toHaveLength(0);
      expect(await builds(theirs)).toHaveLength(0);
      // And T's admin cannot post on U's route at all.
      expect((await fire(firedData([{ itemId: a, version: 1 }]), { tenant: U })).statusCode).toBe(403);
      // ✅ control: the row IS settle-able in its own company (it reads the item and records a build:
      // failed, since no target names that site and nobody decided it in U).
      await settleScheduledRebuilds(U);
      expect(reads()).toHaveLength(1);
      expect((await builds(theirs))[0]).toMatchObject({ state: "failed" });
      expect(dispatches(gh)).toHaveLength(0);
    });

    it("🔴 stored args edited after the decision (site swapped) → `refused`, nothing read, nothing dispatched", async () => {
      const a = randomUUID();
      const id = await schedule([{ itemId: a, version: 1 }], { publishAt: ago(60_000) });
      const other = randomUUID();
      config.webdeskRebuild.targetsJson = JSON.stringify([target(SITE), target(other)]);
      await adminPool().query(`UPDATE automation_approvals SET tool_args = jsonb_set(tool_args, '{siteId}', to_jsonb($2::text)) WHERE id = $1`, [id, other]);
      zb.items.set(a, liveByTime(1));
      await sweepScheduledRebuilds();
      expect(reads()).toHaveLength(0);
      expect(dispatches(gh)).toHaveLength(0);
      expect(await firings(id)).toEqual([{ transition: "publish", outcome: "refused", build_id: null, detail: "args_tampered", site_id: null }]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe("partial batches wait; after the grace window: some live dispatches, none live is superseded", () => {
    it("one item live, one still at its old version (a swap the tick has not run) → waits; the swap lands → dispatches", async () => {
      const a = randomUUID(), b = randomUUID();
      const id = await schedule([{ itemId: a, version: 2 }, { itemId: b, version: 5 }], { publishAt: ago(60_000) });
      zb.items.set(a, liveByTime(2));
      zb.items.set(b, published(4));
      expect(await settleScheduledRebuilds(T)).toMatchObject({ waiting: 1, dispatched: 0 });
      expect(dispatches(gh)).toHaveLength(0);
      expect(await firings(id)).toEqual([]);
      zb.items.set(b, published(5));
      await fire(firedData([{ itemId: b, version: 5 }], { approvalId: id }));
      await scheduleSettleIdleForTests(T);
      expect(dispatches(gh)).toHaveLength(1);
    });

    it("after the grace: one of two live → dispatches, detail items_live=1/2", async () => {
      config.webdeskSchedule.supersedeGraceMs = 1_000;
      const a = randomUUID(), b = randomUUID();
      const id = await schedule([{ itemId: a, version: 2 }, { itemId: b, version: 2 }], { publishAt: ago(60_000) });
      zb.items.set(a, liveByTime(2));
      zb.items.set(b, deleted(2));
      await sweepScheduledRebuilds();
      expect(dispatches(gh)).toHaveLength(1);
      expect((await firings(id))[0]).toMatchObject({ outcome: "build_recorded", detail: "items_live=1/2;build=rebuilding" });
    });

    it("after the grace: none live → `superseded`, terminal for the sweep; an event NAMING the approval re-checks it and a late swap still rebuilds", async () => {
      config.webdeskSchedule.supersedeGraceMs = 1_000;
      const a = randomUUID();
      const id = await schedule([{ itemId: a, version: 7 }], { publishAt: ago(60_000) });
      zb.items.set(a, published(6)); // the swap has not happened
      await sweepScheduledRebuilds();
      expect(await firings(id)).toEqual([{ transition: "publish", outcome: "superseded", build_id: null, detail: "items_live=0/1", site_id: SITE }]);
      zb.calls.length = 0;
      await sweepScheduledRebuilds();
      expect(reads()).toHaveLength(0); // settled: the sweep never reads it again
      // An event that does NOT name it re-checks nothing.
      zb.items.set(a, published(7));
      await fire(firedData([{ itemId: a, version: 7 }]));
      await scheduleSettleIdleForTests(T);
      expect(reads()).toHaveLength(0);
      // The tick's swap event names the approval: re-read, now live → ONE dispatch, the firing upgraded.
      await fire(firedData([{ itemId: a, version: 7 }], { approvalId: id }));
      await scheduleSettleIdleForTests(T);
      expect(dispatches(gh)).toHaveLength(1);
      const rows = await builds(id);
      expect(await firings(id)).toEqual([{ transition: "publish", outcome: "build_recorded", build_id: rows[0].id, detail: "items_live=1/1;build=rebuilding", site_id: SITE }]);
      // …and a forged re-check of a superseded schedule whose items are NOT live dispatches nothing.
      const b = randomUUID();
      const id2 = await schedule([{ itemId: b, version: 1 }], { publishAt: ago(60_000) });
      zb.items.set(b, unpublished());
      await sweepScheduledRebuilds();
      await fire(firedData([{ itemId: b, version: 1 }], { approvalId: id2 }));
      await scheduleSettleIdleForTests(T);
      expect(dispatches(gh)).toHaveLength(1);
      expect((await firings(id2))[0].outcome).toBe("superseded");
    });

    it("an effective instant older than the sweep window → `expired` without a read", async () => {
      const a = randomUUID();
      const id = await schedule([{ itemId: a, version: 1 }], { publishAt: ago(8 * 24 * 3_600_000) });
      zb.items.set(a, published(1));
      await sweepScheduledRebuilds();
      expect(reads()).toHaveLength(0);
      expect(dispatches(gh)).toHaveLength(0);
      expect((await firings(id))[0]).toMatchObject({ outcome: "expired", detail: "outside_sweep_window" });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe("the decider: re-checked at dispatch time, a failure is typed and terminal", () => {
    it("🔴 a decider who lost the deploy right → build `failed: deploy_denied`, zero dispatches, never retried; ✅ control with rights → dispatched", async () => {
      const a = randomUUID();
      const id = await schedule([{ itemId: a, version: 1 }], { publishAt: ago(60_000) }, { decider: adminC });
      await withGlobal((c) => c.query(`DELETE FROM user_roles WHERE user_id = $1`, [adminC]));
      zb.items.set(a, liveByTime(1));
      expect(await sweepScheduledRebuilds()).toMatchObject({ failedBuilds: 1, dispatched: 0 });
      expect(dispatches(gh)).toHaveLength(0);
      expect((await builds(id))[0]).toMatchObject({ state: "failed", failure_reason: "deploy_denied", decided_by: adminC });
      expect((await firings(id))[0]).toMatchObject({ outcome: "build_recorded", detail: "items_live=1/1;build=failed" });
      await sweepScheduledRebuilds();
      expect(await builds(id)).toHaveLength(1);
      // control: adminB still holds the right.
      const ok = await schedule([{ itemId: a, version: 1 }], { publishAt: ago(60_000) });
      await sweepScheduledRebuilds();
      expect((await builds(ok))[0]).toMatchObject({ state: "rebuilding" });
      expect(dispatches(gh)).toHaveLength(1);
    });

    it("🔴 a decider who is no longer active → build `failed: decider_inactive`, nothing sent to GitHub at all", async () => {
      const decider = await createUser("wsk61-leaver@ex.test");
      await addMembership(T, decider);
      await grantRole(decider, await createRole("company_admin"), "company", T);
      const a = randomUUID();
      const id = await schedule([{ itemId: a, version: 1 }], { publishAt: ago(60_000) }, { decider });
      await withGlobal((c) => c.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [decider]));
      zb.items.set(a, liveByTime(1));
      await sweepScheduledRebuilds();
      expect(gh.calls).toHaveLength(0);
      expect((await builds(id))[0]).toMatchObject({ state: "failed", failure_reason: "decider_inactive", decided_by: decider });
      expect(await getBuildStatus(T, TENANT_SLUG, SITE)).toMatchObject({ build: { approvalId: id, state: "failed" } });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe("a scheduled takedown marks staging stale ONCE; a later rebuild clears it and nothing re-marks it", () => {
    it("down → stale_marked; rebuild verified live → cleared; replayed and new events + sweeps leave it cleared", async () => {
      const a = randomUUID(), b = randomUUID();
      const id = await schedule([{ itemId: a, version: 3 }, { itemId: b, version: 1 }], { unpublishAt: ago(60_000) });
      zb.items.set(a, unpublished());
      zb.items.set(b, { ...published(1), unpublishAt: ago(60_000) }); // down by time, the tick not run yet
      const ev = firedData([{ itemId: a, version: null }, { itemId: b, version: null }], { transition: "unpublish" });
      const eventId = randomUUID();
      expect((await fire(ev, { eventId })).statusCode).toBe(201);
      await scheduleSettleIdleForTests(T);
      expect(await stale(SITE)).toBe(true);
      expect(await firings(id)).toEqual([{ transition: "unpublish", outcome: "stale_marked", build_id: null, detail: "items_down=2/2", site_id: SITE }]);
      expect(dispatches(gh)).toHaveLength(0); // a takedown rebuilds nothing by itself

      // The editor's rebuild, verified live, clears the mark (WSK-60's rule).
      const req = await app.inject({ method: "POST", url: `/api/${T}/modules/webdev/content/sites/${TENANT_SLUG}/${SITE}/rebuild-requests`, headers: asUser(editor), payload: {} });
      const rebuildId = (req.json() as { approvalId: string }).approvalId;
      expect((await decide(rebuildId, adminB)).statusCode).toBe(200);
      const dispatchedAt = (await builds(rebuildId))[0].dispatched_at as Date;
      staging.body = { source: "webdesk", pulledAt: new Date(dispatchedAt.getTime() + 60_000).toISOString(), maxUpdatedAt: null, itemCount: 1, sourceSha256: "x" };
      await sweepSiteBuilds();
      expect(await stale(SITE)).toBe(false);

      // Nothing marks it again: the replayed event, a fresh event, a sweep.
      await fire(ev, { eventId });
      await fire(ev);
      await scheduleSettleIdleForTests(T);
      await sweepScheduledRebuilds();
      expect(await stale(SITE)).toBe(false);
      expect(await firings(id)).toHaveLength(1);
    });

    it("every item still live after the grace (the takedown was moved) → `superseded`, no mark", async () => {
      config.webdeskSchedule.supersedeGraceMs = 1_000;
      const a = randomUUID();
      const id = await schedule([{ itemId: a, version: 2 }], { unpublishAt: ago(60_000) });
      zb.items.set(a, published(2));
      await sweepScheduledRebuilds();
      expect(await stale(SITE)).toBe(false);
      expect((await firings(id))[0]).toMatchObject({ transition: "unpublish", outcome: "superseded", detail: "items_down=0/1" });
    });

    it("publish AND takedown on one schedule settle independently, BY TIME: one rebuild, then one mark", async () => {
      const a = randomUUID();
      const unpublishAt = new Date(Date.now() + 4_000).toISOString();
      const id = await schedule([{ itemId: a, version: 1 }], { publishAt: ago(120_000), unpublishAt });
      // Zone B's own row for it: live by time now, gone by time at unpublishAt (no tick needed for either).
      zb.items.set(a, { ...liveByTime(1), unpublishAt });
      await sweepScheduledRebuilds();
      expect(dispatches(gh)).toHaveLength(1);
      expect(await stale(SITE)).toBe(false);
      expect(await firings(id)).toHaveLength(1); // the takedown is not due yet
      await new Promise((r) => setTimeout(r, 4_500));
      await sweepScheduledRebuilds();
      expect((await firings(id)).map((f) => [f.transition, f.outcome])).toEqual([["publish", "build_recorded"], ["unpublish", "stale_marked"]]);
      expect(await stale(SITE)).toBe(true);
      expect(dispatches(gh)).toHaveLength(1);
    }, 30_000);
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe("M5-P5a2: a settled schedule pings IndexNow (best-effort, at-least-once, only the items in the wanted state)", () => {
    const notifier = () => vi.fn(async (_tenantId: string, _a: unknown) => "queued");

    it("a publish that settles calls the notifier ONCE with (publish, the approval id, only the at-version items); the rebuild is unaffected", async () => {
      const a = randomUUID(), b = randomUUID();
      const id = await schedule([{ itemId: a, version: 2 }, { itemId: b, version: 5 }], { publishAt: ago(60_000) });
      config.webdeskSchedule.supersedeGraceMs = 1_000;
      zb.items.set(a, liveByTime(2));
      zb.items.set(b, published(4)); // still at its old version: not pinged
      const n = notifier();
      setScheduleIndexNowNotifierForTests(n);
      expect(await settleScheduledRebuilds(T)).toMatchObject({ dispatched: 1 });
      expect(n).toHaveBeenCalledTimes(1);
      expect(n.mock.calls[0]).toEqual([T, { tenantSlug: TENANT_SLUG, siteId: SITE, transition: "publish", ref: id, items: [{ itemId: a, version: 2 }] }]);
      expect(dispatches(gh)).toHaveLength(1);
    });

    it("a takedown calls it with (unpublish, the approval id, only the items that are down)", async () => {
      const a = randomUUID(), b = randomUUID();
      const id = await schedule([{ itemId: a, version: 3 }, { itemId: b, version: 1 }], { unpublishAt: ago(60_000) });
      config.webdeskSchedule.supersedeGraceMs = 1_000;
      zb.items.set(a, unpublished());
      zb.items.set(b, published(1)); // the takedown was moved for this one: still live
      const n = notifier();
      setScheduleIndexNowNotifierForTests(n);
      expect(await settleScheduledRebuilds(T)).toMatchObject({ staleMarked: 1 });
      expect(n).toHaveBeenCalledTimes(1);
      expect(n.mock.calls[0]).toEqual([T, { tenantSlug: TENANT_SLUG, siteId: SITE, transition: "unpublish", ref: id, items: [{ itemId: a, version: 3 }] }]);
    });

    it("a superseded settle (nothing live / nothing down), a waiting one and a settled schedule never call it", async () => {
      const n = notifier();
      setScheduleIndexNowNotifierForTests(n);
      config.webdeskSchedule.supersedeGraceMs = 1_000;
      const a = randomUUID(), c = randomUUID();
      await schedule([{ itemId: a, version: 2 }], { publishAt: ago(60_000) });
      zb.items.set(a, unpublished());
      expect(await settleScheduledRebuilds(T)).toMatchObject({ superseded: 1 });
      await schedule([{ itemId: c, version: 2 }], { unpublishAt: ago(60_000) });
      zb.items.set(c, published(2));
      expect(await settleScheduledRebuilds(T)).toMatchObject({ superseded: 1 });
      expect(n).not.toHaveBeenCalled();
      // waiting: Zone B unreadable
      config.webdeskSchedule.supersedeGraceMs = 15 * 60_000;
      const d = randomUUID();
      await schedule([{ itemId: d, version: 1 }], { publishAt: ago(60_000) });
      zb.items.set(d, 500);
      expect(await settleScheduledRebuilds(T)).toMatchObject({ waiting: 1 });
      expect(n).not.toHaveBeenCalled();
    });

    it("a settled schedule is pinged once (ref = the approval id) and a later sweep does not even read it again", async () => {
      const a = randomUUID(), b = randomUUID();
      const id = await schedule([{ itemId: a, version: 2 }, { itemId: b, version: 5 }], { publishAt: ago(60_000) });
      zb.items.set(a, liveByTime(2));
      zb.items.set(b, published(5));
      const n = notifier();
      setScheduleIndexNowNotifierForTests(n);
      await settleScheduledRebuilds(T);
      await sweepScheduledRebuilds(); // settled by the first: not even read again
      expect(n).toHaveBeenCalledTimes(1);
      expect((n.mock.calls[0][1] as { ref: string }).ref).toBe(id);
    });

    it("a notifier that THROWS (or rejects) leaves the settle outcome, counters, rebuild and firing rows exactly as without it", async () => {
      const run = async (broken: boolean) => {
        const a = randomUUID(), b = randomUUID();
        const pub = await schedule([{ itemId: a, version: 2 }], { publishAt: ago(60_000) });
        zb.items.set(a, liveByTime(2));
        const down = await schedule([{ itemId: b, version: 1 }], { unpublishAt: ago(60_000) });
        zb.items.set(b, unpublished());
        setScheduleIndexNowNotifierForTests(broken ? async () => { throw new Error("indexnow exploded"); } : notifier());
        const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
        try {
          const r = await settleScheduledRebuilds(T);
          const logged = warn.mock.calls.map((c) => String(c[0]));
          return { r, builds: (await builds(pub)).map((x) => x.state), pub: await firings(pub), down: await firings(down), logged };
        } finally {
          warn.mockRestore();
        }
      };
      const ok = await run(false);
      await adminPool().query(`UPDATE automation_approvals SET deleted_at = now() WHERE workflow_id = 'content.schedule' AND deleted_at IS NULL`);
      gh.calls.length = 0;
      const bad = await run(true);
      expect(bad.r).toEqual(ok.r);
      expect(bad.r).toMatchObject({ dispatched: 1, staleMarked: 1, waiting: 0 });
      expect(bad.builds).toEqual(ok.builds);
      expect(bad.pub.map((f) => f.outcome)).toEqual(ok.pub.map((f) => f.outcome));
      expect(bad.down.map((f) => f.outcome)).toEqual(["stale_marked"]);
      expect(dispatches(gh)).toHaveLength(1);
      expect(bad.logged.filter((m) => m.includes("IndexNow") && m.includes("ping failed"))).toHaveLength(2);
      expect(bad.logged.join("\n")).not.toContain("exploded"); // the error NAME only, never its message
    });
  });
  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe("the third wall: webdev_schedule_firings reads ZERO rows without tenant + webdev scope", () => {
    it("superuser sees the row; no GUC → 0; tenant without the webdev scope → 0; tenant + scope → 1", async () => {
      const a = randomUUID();
      const id = await schedule([{ itemId: a, version: 1 }], { publishAt: ago(60_000) });
      zb.items.set(a, liveByTime(1));
      await sweepScheduledRebuilds();
      const q = `SELECT count(*)::int AS n FROM webdev_schedule_firings WHERE approval_id = $1`;
      expect((await adminPool().query<{ n: number }>(q, [id])).rows[0].n).toBe(1);
      expect((await withGlobal((c) => c.query<{ n: number }>(q, [id]))).rows[0].n).toBe(0);
      expect((await withTenants([T], (c) => c.query<{ n: number }>(q, [id]))).rows[0].n).toBe(0);
      expect((await withTenants([U], (c) => c.query<{ n: number }>(q, [id]), { modules: ["webdev"] })).rows[0].n).toBe(0);
      expect((await withTenants([T], (c) => c.query<{ n: number }>(q, [id]), { modules: ["webdev"] })).rows[0].n).toBe(1);
      // And a write without scope is refused, not silently dropped.
      await expect(
        withTenants([T], (c) =>
          c.query(
            `INSERT INTO webdev_schedule_firings (tenant_id, approval_id, tenant_slug, site_id, transition, outcome, effective_at) VALUES ($1, $2, 'x', $3, 'publish', 'superseded', now())`,
            [T, randomUUID(), SITE],
          ),
        ),
      ).rejects.toThrow(/row-level security/);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe("migration 202610110441: the kind CHECK keeps every kind and admits schedule.fired", () => {
    const KINDS = ["form.received", "deploy.done", "promote.done", "rollback.done", "contract.published", "alert.raised", "schedule.fired"];
    const sql = readFileSync(path.join(__dirname, "../../../migrations/202610110441_webdev_schedule_firings.sql"), "utf8");
    const doBlock = sql.slice(sql.indexOf("DO $$"), sql.indexOf("END $$;") + "END $$;".length);
    const kindDef = async (c: { query: (q: string) => Promise<{ rows: Array<{ d: string }> }> }) =>
      (await c.query(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = 'webdev_zoneb_event_log'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%form.received%'`)).rows[0].d;

    it("the migrated CHECK names all seven kinds, and rejects an unknown one", async () => {
      const d = await kindDef(adminPool());
      for (const k of KINDS) expect(d).toContain(`'${k}'`);
      await expect(
        adminPool().query(
          `INSERT INTO webdev_zoneb_event_log (tenant_id, event_id, kind, payload, origin_site) VALUES ($1, $2, 'schedule.exploded', '{}', 'webdesk')`,
          [T, randomUUID()],
        ),
      ).rejects.toThrow(/check constraint/);
    });

    it("re-run against a CHECK carrying an extra kind → that kind SURVIVES (catalog union, never a retyped list)", async () => {
      const c = await adminPool().connect();
      try {
        await c.query("BEGIN");
        const d = await kindDef(c);
        const name = (await c.query<{ n: string }>(`SELECT conname AS n FROM pg_constraint WHERE conrelid = 'webdev_zoneb_event_log'::regclass AND pg_get_constraintdef(oid) = $1`, [d])).rows[0].n;
        // The earlier tests in this file recorded schedule.fired facts; a pre-WSK-61 CHECK cannot be re-added over
        // them. Removed inside this transaction only (rolled back below).
        await c.query(`DELETE FROM webdev_zoneb_event_log WHERE kind = 'schedule.fired'`);
        await c.query(`ALTER TABLE webdev_zoneb_event_log DROP CONSTRAINT ${name}`);
        await c.query(`ALTER TABLE webdev_zoneb_event_log ADD CONSTRAINT ${name} CHECK (kind IN (${[...KINDS.slice(0, 6), "x.added.elsewhere"].map((k) => `'${k}'`).join(", ")}))`);
        await c.query(doBlock);
        const after = await kindDef(c);
        for (const k of [...KINDS, "x.added.elsewhere"]) expect(after).toContain(`'${k}'`);
      } finally {
        await c.query("ROLLBACK");
        c.release();
      }
    });

    it("🔴 drift negative control: a live CHECK that LOST a kind the code relies on → the migration refuses", async () => {
      const c = await adminPool().connect();
      try {
        await c.query("BEGIN");
        const d = await kindDef(c);
        const name = (await c.query<{ n: string }>(`SELECT conname AS n FROM pg_constraint WHERE conrelid = 'webdev_zoneb_event_log'::regclass AND pg_get_constraintdef(oid) = $1`, [d])).rows[0].n;
        // The earlier tests in this file recorded schedule.fired facts; a pre-WSK-61 CHECK cannot be re-added over
        // them. Removed inside this transaction only (rolled back below).
        await c.query(`DELETE FROM webdev_zoneb_event_log WHERE kind = 'schedule.fired'`);
        await c.query(`ALTER TABLE webdev_zoneb_event_log DROP CONSTRAINT ${name}`);
        await c.query(`ALTER TABLE webdev_zoneb_event_log ADD CONSTRAINT ${name} CHECK (kind IN ('form.received', 'deploy.done', 'promote.done', 'rollback.done', 'contract.published'))`);
        await expect(c.query(doBlock)).rejects.toThrow(/no longer admits alert\.raised/);
      } finally {
        await c.query("ROLLBACK");
        c.release();
      }
    });
  });
});
