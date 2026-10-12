// WSK-49c / WSK-D65 — a client editor's publish rebuilds staging automatically, WITHOUT the client ever holding
// `github_repo · deploy` and with no Cerbos change.
//
// Real: Postgres (RLS, the build ledger, the activities ledger, the site -> client link), Cerbos (all policies unmodified),
// the whole NestJS app (the client-mode BFF), WSK-66's real executor, the real GitHub chokepoint (`githubRequest` -> App JWT
// -> token exchange -> the dispatch, over real sockets to a local stub, the site-builds-dispatch.test.ts precedent) and the
// real ledger. Stub: GitHub's API and Zone B (the in-process FakeZoneB).
//
// What is proven: the build row is `rebuilding` with the client as `decided_by` and the dispatch is ONE call to the target
// that comes only from config; the dispatch ledger rows say `basis: client-publish` / `ruling: WSK-D65`; a link re-pointed
// between the execute and the dispatch sends NOTHING (typed `client_publish_unverified`); the staff path is still
// `authorizeDeploy` (a staff decider without deploy is still `deploy_denied`); and the authority cannot be forged, borrowed by
// a staff decider, or used for a rebuild. Denials send valid bodies, each beside a positive control.
import { generateKeyPairSync, randomUUID } from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { buildApp } from "../../main";
import { newId, withTenants } from "../../db";
import { resetModules } from "../registry";
import { resetCoreRollupProviders } from "../../rollups/engine";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient } from "../../testing/fixtures";
import { assemblePrincipal } from "../../rbac/principal";
import * as credentialStore from "../../core/github/credential-store";
import { resetGithubRuntimesForTest } from "../../core/github/github-app.service";
import { ClientPublishAuthority } from "../../core/github/workflow-dispatch";
import type { WebdeskControlRequest, WebdeskControlResponse } from "./webdesk-control-client";
import {
  fileWebdeskCommandApproval,
  preflightWebdeskApprovedCommand,
  setWebdeskApprovedCommandDepsForTests,
  webdeskCommandHashFor,
} from "./webdesk-approved-command";
import { startSiteRebuild } from "./site-builds.service";
import { webdeskZoneB } from "./webdesk-content.service";
import { FakeZoneB, GAIADA_SITE, GAIADA_SLUG, makeTestSigner, type FakeItem } from "./webdesk-content-testkit";

vi.mock("../../core/github/credential-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/github/credential-store")>();
  return { ...actual, loadAppCredentialOrThrow: vi.fn() };
});

const live = !!TEST_URL && !!process.env.CERBOS_URL;
const svcAuth = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svcAuth, "x-user-id": id });

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const REPO = "gaiadabali/gaiada-web-revamp";
const WORKFLOW = "webdesk-rebuild.yml";
const REF = "astro-site";
// A second configured site, so a mis-bound authority is refused by the binding check, not by "rebuild_not_configured".
const OTHER_SITE = "019fb652-c68b-7000-8000-00000000d65b";
const OTHER_REF = "other-site-ref";
const APP_ID = "4777424";
const INSTALLATION_ID = "157879245";

interface GhCall { method: string; path: string; body: Record<string, unknown> | null }
async function startGithub() {
  const g = { calls: [] as GhCall[], server: null as unknown as http.Server, port: 0 };
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
        return json(201, { token: "ghs_wsk49c_installation_token", expires_at: new Date(Date.now() + 3_600_000).toISOString(), permissions: { actions: "write" } });
      }
      if (req.method === "POST" && path === `/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`) { res.writeHead(204); res.end(); return; }
      json(404, { message: "stub: no such route" });
    });
  });
  await new Promise<void>((r) => g.server.listen(0, "127.0.0.1", r));
  g.port = (g.server.address() as AddressInfo).port;
  return g;
}
const dispatches = (g: { calls: GhCall[] }) => g.calls.filter((c) => c.method === "POST" && c.path.endsWith("/dispatches"));

describe.skipIf(!live)("WSK-49c / WSK-D65 · a client publish rebuilds staging, authorised by the executed publish itself", () => {
  let app: NestFastifyApplication;
  let gh: Awaited<ReturnType<typeof startGithub>>;
  let A: string;
  let cA1: string, cA2: string;
  let edA1: string, ed2A1: string, edA2: string;
  let staffAdmin: string, staffMember: string, staffEditor: string;
  let zb: FakeZoneB;
  const signer = makeTestSigner();
  const realFetch = global.fetch;
  let afterPublish: (() => Promise<void>) | null = null;

  const W = (client = cA1) => `/api/${A}/portal/clients/${client}/website`;
  const S = (client = cA1) => `${W(client)}/sites/${GAIADA_SLUG}/${GAIADA_SITE}`;
  const call = (method: "GET" | "POST", url: string, as: string, payload?: unknown) => app.inject({ method, url, headers: asUser(as), payload: payload as never });
  const principalOf = async (id: string) => (await assemblePrincipal(id, "high")) as NonNullable<Awaited<ReturnType<typeof assemblePrincipal>>>;
  const builds = async (approvalId: string) =>
    (await adminPool().query<{ state: string; failure_reason: string | null; decided_by: string | null; repo: string | null; ref: string | null; dispatched_at: Date | null; github_correlation_id: string | null }>(
      `SELECT state, failure_reason, decided_by, repo, ref, dispatched_at, github_correlation_id FROM webdev_site_builds WHERE approval_id = $1`, [approvalId],
    )).rows;
  const githubRows = async (approvalId: string) =>
    (await adminPool().query<{ actor_id: string; verb: string; metadata: Record<string, unknown> }>(
      `SELECT actor_id, verb, metadata FROM activities WHERE verb = 'github.deploy' AND metadata->>'approvalId' = $1 ORDER BY occurred_at, id`, [approvalId],
    )).rows;

  /** A live item whose draft (v2) changes only an editable field: a client may publish it. */
  function draft(slug: string): FakeItem {
    const it = zb.seedItem({ siteId: GAIADA_SITE, slug, collectionKey: "service", publishedVersion: 1, publishState: "published" });
    it.versions[0] = { ...it.versions[0], fields: { h1: "Head", slugLabel: "agency" }, seo: {}, blocks: [], contentHash: "a".repeat(64) };
    it.versions.push({ ...it.versions[0], version: 2, fields: { h1: "Client edit", slugLabel: "agency" }, contentHash: "b".repeat(64) });
    it.headVersion = 2;
    return it;
  }
  const file = async (who: string, items: FakeItem[]) => {
    const r = await call("POST", `${S()}/publish-requests`, who, { items: items.map((i) => ({ itemId: i.itemId, version: i.headVersion })) });
    expect(r.statusCode, r.body).toBe(202);
    return r.json().approvalId as string;
  };
  const approve = (who: string, id: string) => call("POST", `${W()}/publish-requests/${id}/approve`, who, {});
  const repoint = (client: string) =>
    withTenants([A], (c) => c.query(`UPDATE webdesk_site_clients SET client_id = $3 WHERE tenant_id = $1 AND tenant_slug = $2`, [A, GAIADA_SLUG, client]));

  beforeAll(async () => {
    gh = await startGithub();
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    A = await createCompany("WSK-D65 Co", ["webdev"]);
    cA1 = await createClient(A, "Bali Beach Resort");
    cA2 = await createClient(A, "Nusa Coffee");
    const clientRole = await createRole("client");
    const editorRole = await createRole("client_website_editor");
    const mkClient = async (email: string, client: string) => {
      const u = await createUser(email);
      await withTenants([A], (c) =>
        c.query(`INSERT INTO client_contacts (id, tenant_id, client_id, user_id, project_id, capability, status, origin_site) VALUES ($1, $2, $3, $4, NULL, 'signer', 'active', $5)`, [newId(), A, client, u, config.originSite]),
      );
      await grantRole(u, clientRole, "company", A);
      await grantRole(u, editorRole, "client", client);
      return u;
    };
    edA1 = await mkClient("ed-a1@d63.test", cA1);
    ed2A1 = await mkClient("ed2-a1@d63.test", cA1);
    edA2 = await mkClient("ed-a2@d63.test", cA2);
    const staff = async (email: string, role: string) => {
      const u = await createUser(email);
      await addMembership(A, u);
      await grantRole(u, await createRole(role), "company", A);
      return u;
    };
    staffAdmin = await staff("admin@d63.test", "company_admin");
    staffMember = await staff("member@d63.test", "member");
    staffEditor = await staff("editor@d63.test", "webdev_staff");
    zb = new FakeZoneB(A, A);
    zb.compositions.set("service", {
      ui: { label: "Services" },
      fields: [{ name: "h1", primitive: "text", ui: { clientEditable: true } }, { name: "slugLabel", primitive: "text" }],
    });
    config.githubOrgTenantId = A;
    config.githubApps.erp = { appId: APP_ID, installationId: INSTALLATION_ID };
    app = await buildApp();
  }, 120_000);

  beforeEach(async () => {
    zb.reset();
    signer.calls.length = 0;
    webdeskZoneB.clearSiteCache();
    afterPublish = null;
    await adminPool().query(`DELETE FROM automation_approvals WHERE origin = 'webdesk' AND tenant_id = $1`, [A]);
    await adminPool().query(`DELETE FROM webdesk_site_clients WHERE tenant_id = $1`, [A]);
    await withTenants([A], (c) =>
      c.query(`INSERT INTO webdesk_site_clients (id, tenant_id, tenant_slug, site_id, client_id, origin_site) VALUES ($1, $2, $3, $4, $5, $6)`, [newId(), A, GAIADA_SLUG, GAIADA_SITE, cA1, config.originSite]),
    );
    gh.calls.length = 0;
    config.webdeskRebuild.targetsJson = JSON.stringify([
      { tenantSlug: GAIADA_SLUG, siteId: GAIADA_SITE, repo: REPO, workflow: WORKFLOW, ref: REF, stagingUrl: "http://127.0.0.1:1" },
      { tenantSlug: GAIADA_SLUG, siteId: OTHER_SITE, repo: REPO, workflow: WORKFLOW, ref: OTHER_REF, stagingUrl: "http://127.0.0.1:1" },
    ]);
    config.webdeskRebuild.dispatchDeadlineMs = 30_000;
    config.githubOrgTenantId = A;
    resetGithubRuntimesForTest();
    vi.mocked(credentialStore.loadAppCredentialOrThrow).mockReset().mockResolvedValue({
      connectionId: "conn-d63", appId: APP_ID, installationId: INSTALLATION_ID, privateKeyPem: PEM,
    });
    global.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      return realFetch(url.startsWith("https://api.github.com") ? url.replace("https://api.github.com", `http://127.0.0.1:${gh.port}`) : url, init);
    }) as typeof fetch;
    // Zone B, with a hook that runs right AFTER the publish landed and BEFORE the executor records it and starts the rebuild.
    const base = zb.asClient();
    const client = {
      async send(req: WebdeskControlRequest): Promise<WebdeskControlResponse> {
        const r = await base.send(req);
        if (req.command === "content.publish" && afterPublish) await afterPublish();
        return r;
      },
      close() {},
    };
    setWebdeskApprovedCommandDepsForTests({ client: client as never, signer });
  });
  afterEach(() => {
    global.fetch = realFetch;
    setWebdeskApprovedCommandDepsForTests(null);
  });
  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
    gh?.server.closeAllConnections();
    await new Promise<void>((r) => gh?.server.close(() => r()));
  });

  it("a client SELF-PUBLISH of one item starts ONE rebuild: build row `rebuilding`, decided_by the client, the target straight from config", async () => {
    const it = draft("svc.d63-self");
    const r = await call("POST", `${S()}/items/${it.itemId}/publish`, edA1, {});
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ status: "approved", executionStatus: "executed", selfPublish: true });
    expect(it.publishedVersion).toBe(2);
    // WSK-359 (WSK-D65): the answer carries the rebuild as `{state, failureReason}` and NOTHING else of it (no build id, repo, ref or URL).
    expect(r.json().build).toEqual({ state: "rebuilding", failureReason: null });
    expect(r.body).not.toContain(REPO);
    expect(r.body).not.toContain(REF);
    expect(r.body).not.toContain("127.0.0.1");

    const sent = dispatches(gh);
    expect(sent).toHaveLength(1);
    expect(sent[0].path).toBe(`/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`);
    const approvalId = (await adminPool().query<{ id: string }>(`SELECT id FROM automation_approvals WHERE origin = 'webdesk' AND tenant_id = $1`, [A])).rows[0].id;
    expect(sent[0].body).toMatchObject({ ref: REF, inputs: { approval_id: approvalId, kind: "publish" } });
    const rows = await builds(approvalId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "rebuilding", failure_reason: null, decided_by: edA1, repo: REPO, ref: REF });
    expect(rows[0].dispatched_at).toBeInstanceOf(Date);
    expect(rows[0].github_correlation_id).toBeTruthy();
  });

  it("the dispatch is audited with the client as actor, `basis: client-publish` and the ruling WSK-D65 on every row of the attempt", async () => {
    const it = draft("svc.d63-audit");
    await call("POST", `${S()}/items/${it.itemId}/publish`, edA1, {});
    const approvalId = (await adminPool().query<{ id: string }>(`SELECT id FROM automation_approvals WHERE origin = 'webdesk' AND tenant_id = $1`, [A])).rows[0].id;
    const rows = await githubRows(approvalId);
    expect(rows.map((x) => x.metadata.outcome)).toEqual(["attempted", "succeeded"]);
    for (const row of rows) {
      expect(row.actor_id).toBe(edA1);
      expect(row.metadata).toMatchObject({ approvalId, basis: "client-publish", ruling: "WSK-D65", repo: REPO, ref: REF });
    }
  });

  it("a client-approved BATCH (another client editor decides) starts ONE rebuild decided by the approver; the requester's own approval is still denied and dispatches nothing", async () => {
    const batch = [draft("svc.d63-b1"), draft("svc.d63-b2")];
    const id = await file(edA1, batch);
    expect((await approve(edA1, id)).statusCode).toBe(403);
    expect(dispatches(gh)).toHaveLength(0);
    expect(await builds(id)).toHaveLength(0);
    const ok = await approve(ed2A1, id);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().build).toEqual({ state: "rebuilding", failureReason: null }); // the approve answer carries it too (control: the denied self-approval above carried none)
    expect(dispatches(gh)).toHaveLength(1);
    expect((await builds(id))[0]).toMatchObject({ state: "rebuilding", decided_by: ed2A1, repo: REPO, ref: REF });
    expect((await githubRows(id))[0].metadata).toMatchObject({ basis: "client-publish", ruling: "WSK-D65" });
  });

  it("once per approval: starting the rebuild again for the same approval finds the first row and dispatches nothing", async () => {
    const it = draft("svc.d63-once");
    await call("POST", `${S()}/items/${it.itemId}/publish`, edA1, {});
    const id = (await adminPool().query<{ id: string }>(`SELECT id FROM automation_approvals WHERE origin = 'webdesk' AND tenant_id = $1`, [A])).rows[0].id;
    const again = await startSiteRebuild({
      tenantId: A, tenantSlug: GAIADA_SLUG, siteId: GAIADA_SITE, approvalId: id, kind: "publish", publishedAt: null, decider: await principalOf(edA1),
      authority: ClientPublishAuthority.issue({ tenantId: A, approvalId: id, tenantSlug: GAIADA_SLUG, siteId: GAIADA_SITE, deciderId: edA1 }),
    });
    expect(again).toMatchObject({ deduplicated: true, state: "rebuilding" });
    expect(dispatches(gh)).toHaveLength(1);
  });

  it("a link re-pointed BETWEEN the publish and the dispatch sends nothing: the publish stands, the build row is `failed: client_publish_unverified` (control: the same flow un-moved dispatched above)", async () => {
    const it = draft("svc.d63-moved");
    afterPublish = async () => { await repoint(cA2); }; // the site now belongs to ANOTHER client, after WebDesk published and before the rebuild starts
    const r = await call("POST", `${S()}/items/${it.itemId}/publish`, edA1, {});
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ executionStatus: "executed" });
    expect(r.json().build).toEqual({ state: "failed", failureReason: "client_publish_unverified" }); // the typed reason, still no repo / ref / URL
    expect(it.publishedVersion).toBe(2);
    const id = (await adminPool().query<{ id: string }>(`SELECT id FROM automation_approvals WHERE origin = 'webdesk' AND tenant_id = $1`, [A])).rows[0].id;
    expect(gh.calls).toEqual([]); // not even the token exchange
    expect(await builds(id)).toEqual([expect.objectContaining({ state: "failed", failure_reason: "client_publish_unverified", decided_by: edA1, dispatched_at: null })]);
    expect(await githubRows(id)).toEqual([]);
  });

  it("WSK-359: a site with NO rebuild target answers `build: {state: failed, failureReason: rebuild_not_configured}`; the publish stands and nothing is dispatched", async () => {
    config.webdeskRebuild.targetsJson = "[]";
    const it = draft("svc.d63-notarget");
    const r = await call("POST", `${S()}/items/${it.itemId}/publish`, edA1, {});
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ executionStatus: "executed", build: { state: "failed", failureReason: "rebuild_not_configured" } });
    expect(Object.keys(r.json().build).sort()).toEqual(["failureReason", "state"]);
    expect(it.publishedVersion).toBe(2);
    expect(gh.calls).toEqual([]);
  });

  it("an UNLINKED site fails the same way (no link row at all)", async () => {
    const it = draft("svc.d63-unlinked");
    afterPublish = async () => { await adminPool().query(`DELETE FROM webdesk_site_clients WHERE tenant_id = $1`, [A]); };
    const r = await call("POST", `${S()}/items/${it.itemId}/publish`, edA1, {});
    expect(r.statusCode, r.body).toBe(200);
    const id = (await adminPool().query<{ id: string }>(`SELECT id FROM automation_approvals WHERE origin = 'webdesk' AND tenant_id = $1`, [A])).rows[0].id;
    expect(gh.calls).toEqual([]);
    expect((await builds(id))[0]).toMatchObject({ state: "failed", failure_reason: "client_publish_unverified" });
  });

  describe("the staff path is unchanged, and the authority cannot be forged, borrowed or used for a rebuild", () => {
    const rebuildFor = async (approvalId: string, decider: string, authority?: unknown) =>
      startSiteRebuild({
        tenantId: A, tenantSlug: GAIADA_SLUG, siteId: GAIADA_SITE, approvalId, kind: "publish", publishedAt: null, decider: await principalOf(decider),
        ...(authority !== undefined ? { authority: authority as ClientPublishAuthority } : {}),
      });
    const filedStaff = async () => {
      const it = draft(`svc.d63-staff-${randomUUID().slice(0, 6)}`);
      return (await fileWebdeskCommandApproval(await principalOf(staffAdmin), A, {
        command: "content.publish", tenantSlug: GAIADA_SLUG, siteId: GAIADA_SITE, args: { items: [{ itemId: it.itemId, version: 2 }] }, summary: { title: "staff publish" },
      })).approvalId;
    };

    it("a STAFF decider without `github_repo · deploy` is still `deploy_denied` with zero GitHub calls; control: company_admin dispatches", async () => {
      const denied = await rebuildFor(await filedStaff(), staffMember);
      expect(denied).toMatchObject({ state: "failed", failureReason: "deploy_denied" });
      expect(gh.calls).toEqual([]);
      const ok = await rebuildFor(await filedStaff(), staffAdmin);
      expect(ok).toMatchObject({ state: "rebuilding", failureReason: null });
      expect(dispatches(gh)).toHaveLength(1);
      // the staff dispatch is audited exactly as before: no basis, no ruling
      const rows = await githubRows((await adminPool().query<{ approval_id: string }>(`SELECT approval_id FROM webdev_site_builds WHERE state = 'rebuilding' ORDER BY requested_at DESC LIMIT 1`)).rows[0].approval_id);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.metadata).not.toHaveProperty("basis");
        expect(row.metadata).not.toHaveProperty("ruling");
      }
    });

    it("a JSON-shaped `authority` (what a request body could carry) is refused outright, with zero GitHub calls", async () => {
      const id = await filedStaff();
      const forged = { tenantId: A, approvalId: id, tenantSlug: GAIADA_SLUG, siteId: GAIADA_SITE, deciderId: staffAdmin };
      expect(await rebuildFor(id, staffAdmin, forged)).toMatchObject({ state: "failed", failureReason: "client_publish_unverified" });
      expect(gh.calls).toEqual([]);
    });

    it("an authority for an approval a CLIENT did not decide (a staff-filed, staff-decided publish) is refused, even issued for the staff decider", async () => {
      const id = await filedStaff();
      await adminPool().query(`UPDATE automation_approvals SET status = 'approved', execution_status = 'executed', decided_by = $2 WHERE id = $1`, [id, staffAdmin]);
      const auth = ClientPublishAuthority.issue({ tenantId: A, approvalId: id, tenantSlug: GAIADA_SLUG, siteId: GAIADA_SITE, deciderId: staffAdmin });
      expect(await rebuildFor(id, staffAdmin, auth)).toMatchObject({ state: "failed", failureReason: "client_publish_unverified" });
      expect(gh.calls).toEqual([]);
    });

    it("a STAFF member who decided a CLIENT-filed publish cannot borrow the authority (they hold no website grant for the client), a co-editor of the SAME client who did not decide it cannot use it, and neither can an editor of ANOTHER client", async () => {
      const it = draft("svc.d63-borrow");
      const id = await file(edA1, [it, draft("svc.d63-borrow2")]);
      // staff decide the client-filed batch through the staff inbox: executed, decided_by staff, row carries clientId
      expect((await call("POST", `/api/${A}/automation-approvals/${id}/decide`, staffAdmin, { decision: "approved" } as never)).statusCode).toBe(200);
      const staffAuth = ClientPublishAuthority.issue({ tenantId: A, approvalId: id, tenantSlug: GAIADA_SLUG, siteId: GAIADA_SITE, deciderId: staffAdmin });
      // the staff decide path dispatched through authorizeDeploy (company_admin may): that build exists; asking again is deduplicated...
      expect((await builds(id))[0].state).toBe("rebuilding");
      const before = dispatches(gh).length;
      await adminPool().query(`DELETE FROM webdev_site_builds WHERE approval_id = $1`, [id]);
      // ...but the borrowed client-publish authority itself is refused: staff holds no client_website_editor grant
      expect(await rebuildFor(id, staffAdmin, staffAuth)).toMatchObject({ state: "failed", failureReason: "client_publish_unverified" });
      expect(dispatches(gh).length).toBe(before);
      // a co-editor of the SAME client (cA1): holds the grant, but the row was decided by someone else
      const authCo = ClientPublishAuthority.issue({ tenantId: A, approvalId: id, tenantSlug: GAIADA_SLUG, siteId: GAIADA_SITE, deciderId: ed2A1 });
      await adminPool().query(`DELETE FROM webdev_site_builds WHERE approval_id = $1`, [id]);
      expect(await rebuildFor(id, ed2A1, authCo)).toMatchObject({ state: "failed", failureReason: "client_publish_unverified" });
      // an editor of ANOTHER client (cA2): no grant for cA1, and not the decider either
      const authOther = ClientPublishAuthority.issue({ tenantId: A, approvalId: id, tenantSlug: GAIADA_SLUG, siteId: GAIADA_SITE, deciderId: edA2 });
      await adminPool().query(`DELETE FROM webdev_site_builds WHERE approval_id = $1`, [id]);
      expect(await rebuildFor(id, edA2, authOther)).toMatchObject({ state: "failed", failureReason: "client_publish_unverified" });
      expect(dispatches(gh).length).toBe(before);
    });

    it("an authority binds to the site it names: a valid client-publish authority for gaiada.com cannot rebuild ANOTHER configured site; control: the right site dispatches", async () => {
      const it = draft("svc.d65-bind");
      expect((await call("POST", `${S()}/items/${it.itemId}/publish`, edA1, {})).statusCode).toBe(200);
      const id = (await adminPool().query<{ id: string }>(`SELECT id FROM automation_approvals WHERE origin = 'webdesk' AND tenant_id = $1`, [A])).rows[0].id;
      const auth = ClientPublishAuthority.issue({ tenantId: A, approvalId: id, tenantSlug: GAIADA_SLUG, siteId: GAIADA_SITE, deciderId: edA1 });
      await adminPool().query(`DELETE FROM webdev_site_builds WHERE approval_id = $1`, [id]);
      const before = dispatches(gh).length;
      const wrong = await startSiteRebuild({
        tenantId: A, tenantSlug: GAIADA_SLUG, siteId: OTHER_SITE, approvalId: id, kind: "publish", publishedAt: null, decider: await principalOf(edA1), authority: auth,
      });
      expect(wrong).toMatchObject({ state: "failed", failureReason: "client_publish_unverified" });
      expect(dispatches(gh).length).toBe(before);
      expect(dispatches(gh).some((c) => (c.body as { ref?: string } | null)?.ref === OTHER_REF)).toBe(false);
      await adminPool().query(`DELETE FROM webdev_site_builds WHERE approval_id = $1`, [id]);
      expect(await rebuildFor(id, edA1, auth)).toMatchObject({ state: "rebuilding", failureReason: null });
      expect(dispatches(gh).length).toBe(before + 1);
      expect(dispatches(gh).at(-1)!.body).toMatchObject({ ref: REF });
    });

    it("a client can NEVER reach content.rebuild: not by filing it, not by deciding it, and the portal approve route answers 404 for it", async () => {
      // filing: a client may file only a content.publish (valid shape for a staff filer: control)
      const staffFiled = await fileWebdeskCommandApproval(await principalOf(staffAdmin), A, {
        command: "content.rebuild", tenantSlug: GAIADA_SLUG, siteId: GAIADA_SITE, args: {}, summary: { title: "rebuild" },
      });
      await expect(
        fileWebdeskCommandApproval(await principalOf(edA1), A, {
          command: "content.rebuild", tenantSlug: GAIADA_SLUG, siteId: GAIADA_SITE, args: {}, summary: { title: "rebuild" }, client: { clientId: cA1 },
        }),
      ).rejects.toThrow(/may file only a content.publish/);
      // deciding: the preflight refuses a client decider for anything but a publish
      const toolArgs = { command: "content.rebuild", tenantSlug: GAIADA_SLUG, siteId: GAIADA_SITE, commandHash: webdeskCommandHashFor({ command: "content.rebuild", tenantSlug: GAIADA_SLUG, siteId: GAIADA_SITE }) };
      await expect(preflightWebdeskApprovedCommand(A, staffFiled.approvalId, toolArgs, staffAdmin, await principalOf(edA1), { clientId: cA1 })).rejects.toThrow(/may decide only a publish/);
      // the portal approve route: not this client's publish -> 404
      expect((await approve(edA1, staffFiled.approvalId)).statusCode).toBe(404);
      expect(gh.calls).toEqual([]);
    });
  });
});
