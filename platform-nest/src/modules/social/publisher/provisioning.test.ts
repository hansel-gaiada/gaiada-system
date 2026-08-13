// SMM-05 — the golden cases (agentic bar criterion 7), end-to-end against live Postgres + Cerbos,
// driven through the REAL endpoints by real personas with all three walls in place. Skips silently
// without DATABASE_URL_TEST — check the skip count before believing a green run.
//
// The publisher itself is the in-memory mock (see mock-driver.ts): nothing here needs a live
// Postiz, which is the point — the engine is not deployed and a suite that required it would be a
// suite nobody could run.
//
// What each block proves, and why it earns a test rather than a comment:
//   (1) provisioning is idempotent, and 0105's two UNIQUEs are HONOURED rather than duplicated —
//       including the global one, whose violation the code can only learn about from the database.
//   (2) the connector registry mirrors state ABOUT a connection and never a token, with the
//       capability matrix and the quota rules the four OQ-1 research returns established.
//   (3) ⭐ THE CROSS-CLIENT REFUSAL. The ticket's headline risk: "a mapping bug publishes client A's
//       content to client B's account". 0105 enforces same-TENANT with composite FKs and says in
//       its own comment that the client-level check belongs at the dispatch choke-point. This is
//       that check, and it gets an adversarial test rather than trust.
//   (4) an unreachable publisher degrades VISIBLY — reads keep serving, writes refuse with a typed
//       code, and NOT ONE registry row is rewritten by an outage.
//   (5) authorization is a refusal, never an empty list.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../../config";
import { withTenants, newId } from "../../../db";
import { buildApp } from "../../../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../../../testing/fixtures";
import { registerModule, resetModules } from "../../registry";
import { socialModule } from "../index";
import { registerPublisher, resetPublishers } from "./registry";
import { createMockPublisher, newMockPublisherState, type MockPublisherState } from "./mock-driver";
import { assertDispatchChainForTenant } from "./provisioning";
import { SocialPublisherError, type IntegrationState } from "./types";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const MODULES: { modules: string[] } = { modules: ["social"] };

async function createClient(tenantId: string, name: string): Promise<string> {
  const id = newId();
  await withTenants([tenantId], (c) =>
    c.query(`INSERT INTO clients (id, tenant_id, name, origin_site) VALUES ($1,$2,$3,'central')`, [id, tenantId, name]),
  );
  return id;
}

// Upstream org ids are globally unique by 0105's own UNIQUE(postiz_org_id) — which is the point of
// the constraint — so every test that provisions one must mint a fresh ref, or test N+1 collides
// with test N's leftovers and fails for a reason that has nothing to do with what it is testing.
let orgSeq = 0;
const orgRef = (label: string): string => `org-${label}-${++orgSeq}`;

function integration(over: Partial<IntegrationState> & { id: string; network: string; handle: string }): IntegrationState {
  return { ...over };
}

describe.skipIf(!TEST_URL)("SMM-05 · publisher orgs + connector registry", () => {
  let app: NestFastifyApplication;
  let A: string;        // the agency tenant
  let manager: string;  // social_manager at A
  let staff: string;    // social_staff at A — may read the registry, may NOT connect
  // Fresh per test — see beforeEach. Every suite in this repo gets its own physical database, but
  // not its own ROW state between `it` blocks, and these tests each assert on "this client's whole
  // registry". Sharing two clients across them made half the suite depend on execution order.
  let clientOne: string;
  let clientTwo: string;
  let state: MockPublisherState;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    // The default alias's key, resolved server-side at call time. A real deployment sets
    // SOCIAL_POSTIZ_ORG_API_KEY; the suite must not mutate process.env (vitest workers share it).
    config.social.publisher.defaultOrgApiKey = "test-org-key";
    resetModules();
    registerModule(socialModule);

    A = await createCompany("Gaia Agency", ["social"]);
    manager = await createUser("smm05-manager@a.test");
    staff = await createUser("smm05-staff@a.test");
    await addMembership(A, manager);
    await addMembership(A, staff);
    const managerRole = await createRole("social_manager");
    const staffRole = await createRole("social_staff");
    await grantRole(manager, managerRole, "company", A);
    await grantRole(staff, staffRole, "company", A);

    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    resetPublishers();
    await teardownTestDb();
  });

  beforeEach(async () => {
    state = newMockPublisherState();
    resetPublishers();
    registerPublisher(createMockPublisher(state));
    clientOne = await createClient(A, "Brand One");
    clientTwo = await createClient(A, "Brand Two");
  });

  const post = (url: string, body: unknown, userId: string) =>
    app.inject({ method: "POST", url, headers: asUser(userId), payload: body as never });
  const get = (url: string, userId: string) =>
    app.inject({ method: "GET", url, headers: asUser(userId) });

  // ── (1) provisioning ──────────────────────────────────────────────────────────────────────────

  it("provisions a (tenant, client) -> org mapping and is IDEMPOTENT on a retry", async () => {
    const ref = orgRef("one");
    const payload = { clientId: clientOne, publisherOrgRef: ref };
    const first = await post(`/api/${A}/modules/social/publisher-orgs`, payload, manager);
    expect(first.statusCode).toBe(201);
    const created = first.json();
    expect(created).toMatchObject({ clientId: clientOne, publisherOrgRef: ref, driver: "postiz", created: true });
    // The ALIAS is echoed, never a key.
    expect(created.apiKeyRef).toBe("default");
    expect(JSON.stringify(created)).not.toContain("test-org-key");
    // And the probe ran: an org that answers is reported verified, honestly either way.
    expect(created.verification).toMatchObject({ ok: true });

    // An at-least-once caller cannot double-create (agentic bar criterion 3).
    const again = await post(`/api/${A}/modules/social/publisher-orgs`, payload, manager);
    expect(again.statusCode).toBe(201);
    expect(again.json()).toMatchObject({ publisherOrgId: created.publisherOrgId, created: false });

    const { rows } = await withTenants(
      [A], (c) => c.query(`SELECT count(*)::int AS n FROM social_publisher_orgs WHERE client_id = $1`, [clientOne]), MODULES,
    );
    expect(rows[0].n).toBe(1);
  });

  it("refuses to re-point a client at a DIFFERENT org — that is not a retry", async () => {
    await post(`/api/${A}/modules/social/publisher-orgs`, { clientId: clientOne, publisherOrgRef: orgRef("one") }, manager);
    const res = await post(`/api/${A}/modules/social/publisher-orgs`, { clientId: clientOne, publisherOrgRef: orgRef("other") }, manager);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("org_conflict");
  });

  it("refuses an org already mapped to another client — 0105's UNIQUE(postiz_org_id)", async () => {
    // The schema-level half of the wrong-account-publish defence: one org can NEVER serve two
    // clients. The code lets the constraint decide and translates it, because the constraint is
    // GLOBAL — it also covers rows in tenants this transaction's RLS scope cannot see.
    const shared = orgRef("shared");
    await post(`/api/${A}/modules/social/publisher-orgs`, { clientId: clientOne, publisherOrgRef: shared }, manager);
    const res = await post(`/api/${A}/modules/social/publisher-orgs`, { clientId: clientTwo, publisherOrgRef: shared }, manager);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("org_conflict");
    expect(res.json().error).toMatch(/one org can never serve two clients/);
  });

  // ── (2) connector-registry sync ───────────────────────────────────────────────────────────────

  it("mirrors integrations into the registry with resolved capabilities, and NEVER a token", async () => {
    const ref = orgRef("sync");
    const org = (await post(`/api/${A}/modules/social/publisher-orgs`, { clientId: clientOne, publisherOrgRef: ref }, manager)).json();
    state.integrations.set(ref, [
      integration({ id: "ig-1", network: "instagram", handle: "@brandone", displayName: "Brand One" }),
      integration({ id: "tt-1", network: "tiktok", handle: "@brandonetok" }),
      integration({ id: "li-1", network: "linkedin", handle: "brand-one", refreshNeeded: true }),
      integration({ id: "??-1", network: "myspace", handle: "@retro" }),
    ]);

    const res = await post(`/api/${A}/modules/social/publisher-orgs/${clientOne}/sync`, {}, manager);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.orgId).toBe(org.publisherOrgId);
    expect(body.accounts).toHaveLength(3);
    // A network 0105 does not model is NAMED, not silently dropped and never coerced — a coerced
    // network would mis-route a publish.
    expect(body.skipped).toEqual([{ network: "myspace", reason: "unmodelled_network" }]);

    const byNetwork = Object.fromEntries(body.accounts.map((a: { network: string }) => [a.network, a]));
    // §A4h: TikTok has no comment scope on its developer platform AT ALL.
    expect(byNetwork.tiktok.capabilities.comments).toBe(false);
    expect(byNetwork.tiktok.capabilities.unsupported.comments).toBe("network");
    // §A4e: LinkedIn has no DM API.
    expect(byNetwork.linkedin.capabilities.dm).toBe(false);
    expect(byNetwork.linkedin.capabilities.unsupported.dm).toBe("network");
    // A token that needs human re-consent is 'expiring' — the state that triggers the nudge.
    expect(byNetwork.linkedin.status).toBe("expiring");
    // The mock advertises quota_probe but holds no snapshot for these accounts: UNKNOWN, never a
    // fabricated cap (§A4f).
    expect(byNetwork.instagram.quotaSource).toBe("probe_unavailable");

    const { rows } = await withTenants(
      [A],
      (c) => c.query(`SELECT network, handle, status, quota, capabilities, postiz_integration_id AS "integrationId"
                        FROM social_accounts WHERE client_id = $1 ORDER BY network`, [clientOne]),
      MODULES,
    );
    expect(rows).toHaveLength(3);
    // The registry mirrors STATE ABOUT a connection. There is no token column and there must never
    // be one (D-5 custody split (c)) — this pins the whole written row, so a future field that
    // carried a credential would turn this red.
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain("test-org-key");
    expect(Object.keys(rows[0])).toEqual(["network", "handle", "status", "quota", "capabilities", "integrationId"]);
    expect(rows.find((r) => r.network === "instagram")!.quota).toEqual({});
  });

  it("reads a LIVE quota into the registry when the probe is available (§A4f)", async () => {
    const ref = orgRef("q");
    await post(`/api/${A}/modules/social/publisher-orgs`, { clientId: clientOne, publisherOrgRef: ref }, manager);
    state.integrations.set(ref, [integration({ id: "ig-9", network: "instagram", handle: "@q", networkAccountId: "17841" })]);
    // The account's OWN answer. Not 25, not 50, not 100-as-a-constant — whatever it reports.
    state.quota.set("ig-9", { igPosts24h: { used: 12, cap: 100 } });

    const body = (await post(`/api/${A}/modules/social/publisher-orgs/${clientOne}/sync`, {}, manager)).json();
    expect(body.accounts[0].quotaSource).toBe("live");
    const { rows } = await withTenants(
      [A], (c) => c.query(`SELECT quota FROM social_accounts WHERE client_id = $1`, [clientOne]), MODULES,
    );
    expect(rows[0].quota).toEqual({ igPosts24h: { used: 12, cap: 100 } });
  });

  it("is idempotent, survives an upstream rename, and marks vanished accounts disconnected", async () => {
    const ref = orgRef("r");
    await post(`/api/${A}/modules/social/publisher-orgs`, { clientId: clientOne, publisherOrgRef: ref }, manager);
    state.integrations.set(ref, [
      integration({ id: "ig-1", network: "instagram", handle: "@old" }),
      integration({ id: "fb-1", network: "facebook", handle: "brandpage" }),
    ]);
    const first = (await post(`/api/${A}/modules/social/publisher-orgs/${clientOne}/sync`, {}, manager)).json();
    const igId = first.accounts.find((a: { network: string }) => a.network === "instagram").accountId;

    // The client renames their handle upstream, and revokes Facebook.
    state.integrations.set(ref, [integration({ id: "ig-1", network: "instagram", handle: "@new" })]);
    const second = (await post(`/api/${A}/modules/social/publisher-orgs/${clientOne}/sync`, {}, manager)).json();

    // ONE row, not two: matching on the opaque integration id first is what keeps the account's
    // history and every variant FK pointing at it.
    expect(second.accounts).toHaveLength(1);
    expect(second.accounts[0].accountId).toBe(igId);
    expect(second.accounts[0].created).toBe(false);
    expect(second.disconnected).toHaveLength(1);
    const { rows } = await withTenants(
      [A], (c) => c.query(`SELECT network, handle, status FROM social_accounts WHERE client_id = $1 ORDER BY network`, [clientOne]), MODULES,
    );
    expect(rows).toEqual([
      { network: "facebook", handle: "brandpage", status: "disconnected" },
      { network: "instagram", handle: "@new", status: "connected" },
    ]);
  });

  it("refuses a sync for a client with no mapping, rather than syncing nothing", async () => {
    const res = await post(`/api/${A}/modules/social/publisher-orgs/${clientTwo}/sync`, {}, manager);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("org_not_provisioned");
  });

  // ── (3) ⭐ the cross-client FK-chain refusal at the dispatch choke-point ────────────────────────

  it("REFUSES a variant whose account belongs to a different client than its engagement", async () => {
    // The scenario is mundane, which is why it matters: one agency tenant, two clients, an operator
    // (or a tool call) with a mis-set accountId. Both accounts are perfectly visible to the same
    // principal and 0105's composite FKs are all satisfied — they enforce same-TENANT, and both
    // clients live in the same tenant. Only the client-level walk catches it.
    const refOne = orgRef("c1");
    const refTwo = orgRef("c2");
    await post(`/api/${A}/modules/social/publisher-orgs`, { clientId: clientOne, publisherOrgRef: refOne }, manager);
    await post(`/api/${A}/modules/social/publisher-orgs`, { clientId: clientTwo, publisherOrgRef: refTwo }, manager);
    state.integrations.set(refOne, [integration({ id: "ig-c1", network: "instagram", handle: "@one" })]);
    state.integrations.set(refTwo, [integration({ id: "ig-c2", network: "instagram", handle: "@two" })]);
    await post(`/api/${A}/modules/social/publisher-orgs/${clientOne}/sync`, {}, manager);
    const two = (await post(`/api/${A}/modules/social/publisher-orgs/${clientTwo}/sync`, {}, manager)).json();
    const clientTwoAccountId = two.accounts[0].accountId;

    // An engagement + post for client ONE...
    const engagementId = newId();
    const postId = newId();
    const goodVariantId = newId();
    const badVariantId = newId();
    const { rows: ownAccount } = await withTenants(
      [A], (c) => c.query<{ id: string }>(`SELECT id FROM social_accounts WHERE client_id = $1`, [clientOne]), MODULES,
    );
    await withTenants([A], async (c) => {
      await c.query(
        `INSERT INTO social_engagements (id, tenant_id, client_id, name, status, origin_site)
         VALUES ($1,$2,$3,'One engagement','active','central')`, [engagementId, A, clientOne]);
      await c.query(
        `INSERT INTO social_posts (id, tenant_id, engagement_id, title, origin_site)
         VALUES ($1,$2,$3,'A post','central')`, [postId, A, engagementId]);
      // ...targeting client TWO's account. Every composite FK is satisfied: same tenant throughout.
      await c.query(
        `INSERT INTO social_post_variants (id, tenant_id, post_id, account_id, body, origin_site)
         VALUES ($1,$2,$3,$4,'copy','central')`, [badVariantId, A, postId, clientTwoAccountId]);
      await c.query(
        `INSERT INTO social_post_variants (id, tenant_id, post_id, account_id, body, origin_site)
         VALUES ($1,$2,$3,$4,'copy','central')`, [goodVariantId, A, postId, ownAccount[0].id]);
    }, MODULES);

    // The correct chain resolves, and resolves to the RIGHT client + the org-scoped mapping.
    const ok = await assertDispatchChainForTenant(A, goodVariantId, manager);
    expect(ok).toMatchObject({ clientId: clientOne, network: "instagram", integrationId: "ig-c1" });
    expect(ok.org.postizOrgId).toBe(refOne);

    // The mismatched one refuses FAIL-CLOSED. Not a warning, not a best-effort publish to the
    // account that was named.
    await expect(assertDispatchChainForTenant(A, badVariantId, manager))
      .rejects.toMatchObject({ code: "cross_client_account" });

    // ...with an audit line (design §11: "a cross-client mismatch anywhere refuses fail-closed with
    // an audit line").
    const { rows: audit } = await withTenants([A], (c) => c.query<{ verb: string; metadata: Record<string, unknown> }>(
      `SELECT verb, metadata FROM activities
        WHERE target_entity_type = 'social_post_variant' AND target_entity_id = $1`, [badVariantId]));
    expect(audit).toHaveLength(1);
    expect(audit[0].verb).toBe("refused");
    expect(audit[0].metadata).toMatchObject({ reason: "cross_client_account", control: "dispatch_fk_chain" });
    // The audit line does NOT name the other client's account: a record about client One's content
    // must not carry client Two's identity.
    expect(JSON.stringify(audit[0].metadata)).not.toContain(clientTwoAccountId);
  });

  it("refuses a network disabled at the DEPLOYMENT level, whatever the engagement scope says", async () => {
    // Three of the five researched networks cannot publish publicly until an audit passes
    // (§A4g/§A4h) and X is metered — so the deployment flag outranks any per-engagement toggle.
    const ref = orgRef("tt");
    await post(`/api/${A}/modules/social/publisher-orgs`, { clientId: clientOne, publisherOrgRef: ref }, manager);
    state.integrations.set(ref, [integration({ id: "tt-x", network: "tiktok", handle: "@tok" })]);
    await post(`/api/${A}/modules/social/publisher-orgs/${clientOne}/sync`, {}, manager);
    const { rows: acct } = await withTenants(
      [A], (c) => c.query<{ id: string }>(`SELECT id FROM social_accounts WHERE client_id = $1`, [clientOne]), MODULES);

    const engagementId = newId(); const postId = newId(); const variantId = newId();
    await withTenants([A], async (c) => {
      await c.query(`INSERT INTO social_engagements (id, tenant_id, client_id, name, status, origin_site)
                     VALUES ($1,$2,$3,'e','active','central')`, [engagementId, A, clientOne]);
      await c.query(`INSERT INTO social_posts (id, tenant_id, engagement_id, title, origin_site)
                     VALUES ($1,$2,$3,'t','central')`, [postId, A, engagementId]);
      await c.query(`INSERT INTO social_post_variants (id, tenant_id, post_id, account_id, body, origin_site)
                     VALUES ($1,$2,$3,$4,'c','central')`, [variantId, A, postId, acct[0].id]);
    }, MODULES);

    expect(config.social.publisher.enabledNetworks).not.toContain("tiktok");
    await expect(assertDispatchChainForTenant(A, variantId, manager))
      .rejects.toMatchObject({ code: "network_disabled" });
  });

  it("refuses a variant with no valid chain without confirming what exists elsewhere", async () => {
    await expect(assertDispatchChainForTenant(A, newId(), manager))
      .rejects.toBeInstanceOf(SocialPublisherError);
  });

  // ── (4) publisher unreachable: degrade visibly, keep serving reads ────────────────────────────

  it("refuses a sync when the publisher is unreachable and rewrites NOT ONE row", async () => {
    const ref = orgRef("down");
    await post(`/api/${A}/modules/social/publisher-orgs`, { clientId: clientOne, publisherOrgRef: ref }, manager);
    state.integrations.set(ref, [integration({ id: "ig-1", network: "instagram", handle: "@brand" })]);
    await post(`/api/${A}/modules/social/publisher-orgs/${clientOne}/sync`, {}, manager);
    const before = await withTenants(
      [A], (c) => c.query(`SELECT id, status, health_checked_at FROM social_accounts WHERE client_id = $1`, [clientOne]), MODULES,
    );
    expect(before.rows[0].status).toBe("connected");

    // The tunnel goes down.
    state.failWith = new SocialPublisherError("publisher_unreachable", "wireguard peer handshake stale");
    const res = await post(`/api/${A}/modules/social/publisher-orgs/${clientOne}/sync`, {}, manager);
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe("publisher_unreachable");

    // THE POINT: an outage is never recorded as "every client account is disconnected". That would
    // put a false, alarming state in front of an operator and hide the real accounts behind it.
    const after = await withTenants(
      [A], (c) => c.query(`SELECT id, status, health_checked_at FROM social_accounts WHERE client_id = $1`, [clientOne]), MODULES,
    );
    expect(after.rows).toEqual(before.rows);
  });

  it("keeps serving every registry READ while the publisher is unreachable", async () => {
    const ref = orgRef("read");
    await post(`/api/${A}/modules/social/publisher-orgs`, { clientId: clientOne, publisherOrgRef: ref }, manager);
    state.integrations.set(ref, [integration({ id: "ig-1", network: "instagram", handle: "@brand" })]);
    await post(`/api/${A}/modules/social/publisher-orgs/${clientOne}/sync`, {}, manager);
    state.failWith = new SocialPublisherError("publisher_unreachable", "down");

    const list = await get(`/api/${A}/modules/social/accounts?clientId=${clientOne}`, manager);
    expect(list.statusCode).toBe(200);
    expect(list.json().accounts).toHaveLength(1);

    const status = await get(`/api/${A}/modules/social/publisher/status`, manager);
    expect(status.statusCode).toBe(200);
    // A read that answers WITHOUT calling the engine is what lets the console explain a degraded
    // feature instead of rendering an empty panel.
    expect(state.calls.filter((c) => c.op === "listIntegrations")).toHaveLength(1); // only the earlier sync
  });

  it("reports an unconfigured publisher honestly instead of pretending", async () => {
    resetPublishers();
    const status = (await get(`/api/${A}/modules/social/publisher/status`, manager)).json();
    expect(status).toMatchObject({ configured: false, driver: null, capabilities: [] });
    // The two findings that are otherwise invisible at runtime, stated on the status surface.
    expect(status.inboxSurface).toBe("none");
    expect(status.quotaProbe).toBe("unavailable");

    const res = await post(`/api/${A}/modules/social/publisher-orgs`, { clientId: clientTwo, publisherOrgRef: orgRef("none") }, manager);
    // The mapping is OUR data, so it is still recorded — but the verification says plainly that it
    // could not be checked. Never dressed up as verified.
    expect(res.statusCode).toBe(201);
    expect(res.json().verification).toEqual({ ok: false, reason: "publisher_not_configured" });
  });

  it("reports the engine's missing inbox surface on the status read (spike §8b)", async () => {
    const status = (await get(`/api/${A}/modules/social/publisher/status`, manager)).json();
    expect(status.configured).toBe(true);
    expect(status.inboxSurface).toBe("none");
  });

  // ── (5) authorization ─────────────────────────────────────────────────────────────────────────

  it("denies staff the connect action with a 403 — never an empty result", async () => {
    // The bug the client portal already shipped once: folding a denial into a bland empty answer.
    const res = await post(`/api/${A}/modules/social/publisher-orgs`, { clientId: clientTwo, publisherOrgRef: orgRef("staff") }, staff);
    expect(res.statusCode).toBe(403);
    const { rows } = await withTenants(
      [A], (c) => c.query(`SELECT count(*)::int AS n FROM social_publisher_orgs WHERE client_id = $1`, [clientTwo]), MODULES,
    );
    expect(rows[0].n).toBe(0);
  });

  it("lets staff READ the registry (the department's working surface)", async () => {
    const res = await get(`/api/${A}/modules/social/accounts`, staff);
    expect(res.statusCode).toBe(200);
  });

  it("refuses a malformed provisioning request with a token an agent can branch on", async () => {
    const res = await post(`/api/${A}/modules/social/publisher-orgs`, { clientId: clientOne }, manager);
    expect(res.statusCode).toBe(400);
    // The token goes in `message`, which HttpErrorFilter renames to `error` on the way out.
    expect(res.json().error).toBe("missing_publisher_org_ref");
  });
});
