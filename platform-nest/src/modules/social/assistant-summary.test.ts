// SMM-35 — the assistant's "social summary" read against LIVE Postgres (RLS), same harness as
// content-brief.test.ts (SMM-26). A DEDICATED file, not appended to social.test.ts — this module's
// own recurring defect class #7: scope stubs locally, never share a module-level mock across a file
// whose `it()`s were not designed to run in this exact order.
//
// Cerbos is stubbed to always-allow (parity matrix is social.test.ts's job) — this file exercises what
// SMM-35's read half actually owns: the absent-vs-zero discipline (this ticket's own named risk — a
// summary that says "0" when it means "never observed") and provable cross-client isolation across TWO
// separate summary calls against the SAME running app.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { withTenants, newId } from "../../db";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createClient } from "../../testing/fixtures";
import { registerModule, resetModules } from "../registry";
import { socialModule } from "./index";

vi.mock("../../rbac/cerbos", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../rbac/cerbos")>();
  return { ...actual, check: vi.fn(async () => ({ allow: true as const })) };
});

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

const MODULES = { modules: ["social"] };

describe.skipIf(!TEST_URL)("social assistant summary (SMM-35)", () => {
  let app: NestFastifyApplication;
  let A: string;
  let uA: string;
  let clientA: string;
  let clientB: string;

  async function makeAccount(client: string, network = "instagram"): Promise<string> {
    const accId = newId();
    await withTenants([A], async (c) => {
      await c.query(
        `INSERT INTO social_publisher_orgs (id, tenant_id, client_id, postiz_org_id, api_key_ref, origin_site)
         VALUES ($1,$2,$3,$4,'env:KEY','central') ON CONFLICT (tenant_id, client_id) DO NOTHING`,
        [newId(), A, client, `org-${A}-${client}`],
      );
      const { rows } = await c.query<{ id: string }>(`SELECT id FROM social_publisher_orgs WHERE tenant_id=$1 AND client_id=$2`, [A, client]);
      await c.query(
        `INSERT INTO social_accounts (id, tenant_id, client_id, publisher_org_id, network, handle, status, quota, origin_site)
         VALUES ($1,$2,$3,$4,$5,$6,'connected','{}'::jsonb,'central')`,
        [accId, A, client, rows[0].id, network, `@h-${accId}`],
      );
    }, MODULES);
    return accId;
  }

  // `toolScope.networks` is what scopes an engagement's OWN accounts (see `assistant-summary.ts`'s
  // `loadScopedAccounts` header) — a client with two engagements must not have one see the other's
  // connected accounts/metrics/inbox. Every test below passes exactly the networks it seeded for
  // THIS engagement, never relying on the default (every network `false`).
  async function makeEngagement(client: string, name: string, networks: Record<string, boolean> = {}): Promise<string> {
    const res = await app.inject({
      method: "POST", url: `/api/${A}/modules/social/engagements`, headers: asUser(uA),
      payload: { clientId: client, name },
    });
    expect(res.statusCode).toBe(201);
    const id = res.json().id;
    if (Object.keys(networks).length > 0) {
      const patch = await app.inject({
        method: "PATCH", url: `/api/${A}/modules/social/engagements/${id}/scope`, headers: asUser(uA),
        payload: { toolScope: { networks } },
      });
      expect(patch.statusCode).toBe(200);
    }
    return id;
  }

  async function makePost(engagementId: string, status: string, title: string): Promise<string> {
    const id = newId();
    await withTenants([A], (c) => c.query(
      `INSERT INTO social_posts (id, tenant_id, engagement_id, title, source, status, origin_site)
       VALUES ($1,$2,$3,$4,'human',$5,'central')`,
      [id, A, engagementId, title, status],
    ), MODULES);
    return id;
  }

  async function insertMetricsDay(accountId: string, date: string, followers: number | null): Promise<void> {
    await withTenants([A], (c) => c.query(
      `INSERT INTO social_metrics_daily (id, tenant_id, account_id, date, followers, origin_site)
       VALUES ($1,$2,$3,$4,$5,'central')
       ON CONFLICT (account_id, date) DO UPDATE SET followers = EXCLUDED.followers`,
      [newId(), A, accountId, date, followers],
    ), MODULES);
  }

  async function makeInboxThread(accountId: string, network: string, status: string): Promise<void> {
    await withTenants([A], (c) => c.query(
      `INSERT INTO social_inbox_threads
         (id, tenant_id, account_id, network, kind, external_thread_id, status, origin_site)
       VALUES ($1,$2,$3,$4,'comment',$5,$6,'central')`,
      [newId(), A, accountId, network, `ext-${newId()}`, status],
    ), MODULES);
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";

    A = await createCompany("SMM35 Co", ["social"]);
    uA = await createUser("smm35@a.test");
    await addMembership(A, uA);
    clientA = await createClient(A, "Summary Brand A");
    clientB = await createClient(A, "Summary Brand B");

    resetModules();
    registerModule(socialModule);
    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  it("404s for an unknown engagement, without ever fabricating a summary", async () => {
    const res = await app.inject({
      method: "GET", url: `/api/${A}/modules/social/engagements/${newId()}/assistant-summary`, headers: asUser(uA),
    });
    expect(res.statusCode).toBe(404);
  });

  // (M1) THE MODULE-GUC REGRESSION (recurring defect class #1). Every read inside
  // `assistant-summary.ts` self-declares `declareSocialModuleScope` on its own transaction — there is
  // no controller-supplied `{modules:['social']}` this file can lean on. This test is the live proof:
  // it seeds REAL, non-zero rows (a post, a connected account, an open thread) and asserts the
  // endpoint reports them back. If any one `declareSocialModuleScope` call were dropped from
  // `assistant-summary.ts`, `app_module_allowed('social')` would be FALSE on that connection and the
  // corresponding read would silently come back empty/zero — this assertion is what would fail.
  it("(M1) MODULE-GUC REGRESSION: reports real, non-zero counts for seeded rows", async () => {
    const acc = await makeAccount(clientA, "linkedin");
    const eng = await makeEngagement(clientA, "Module GUC Eng", { linkedin: true });
    await makePost(eng, "idea", "Idea one");
    await makePost(eng, "published", "Published one");
    await makeInboxThread(acc, "linkedin", "open");

    const res = await app.inject({
      method: "GET", url: `/api/${A}/modules/social/engagements/${eng}/assistant-summary`, headers: asUser(uA),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.posts.total).toBe(2);
    expect(body.posts.byStatus).toEqual(
      expect.arrayContaining([{ status: "idea", count: 1 }, { status: "published", count: 1 }]),
    );
    expect(body.inbox.open).toBe(1);
    expect(body.inbox.oldestOpenSince).not.toBeNull();
  });

  // ── ABSENT ≠ ZERO — the ticket's own named risk, proven three ways ─────────────────────────────
  it("(A1) a connected account with NO metrics row ever pulled reports followers=null, everPulled=false — never 0", async () => {
    await makeAccount(clientA, "x");
    const eng = await makeEngagement(clientA, "Never Pulled Eng", { x: true });

    const res = await app.inject({
      method: "GET", url: `/api/${A}/modules/social/engagements/${eng}/assistant-summary`, headers: asUser(uA),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.metrics.accounts).toHaveLength(1);
    expect(body.metrics.accounts[0].followers).toBeNull();
    expect(body.metrics.accounts[0].asOfDate).toBeNull();
    expect(body.metrics.everPulled).toBe(false);
    expect(body.metrics.totalKnownFollowers).toBeNull(); // NOT 0 — no account has ever been read
  });

  it("(A2) a metrics row with a NULL followers reading still reports followers=null (pulled, but not that field)", async () => {
    const acc = await makeAccount(clientA, "youtube");
    const eng = await makeEngagement(clientA, "Null Reading Eng", { youtube: true });
    await insertMetricsDay(acc, new Date().toISOString().slice(0, 10), null);

    const res = await app.inject({
      method: "GET", url: `/api/${A}/modules/social/engagements/${eng}/assistant-summary`, headers: asUser(uA),
    });
    const body = res.json();
    expect(body.metrics.accounts[0].followers).toBeNull();
    // The pull DID happen (a row exists) even though this particular reading was null — distinct from
    // A1's "never pulled at all".
    expect(body.metrics.everPulled).toBe(true);
  });

  it("(A3) once a real follower reading exists, it is reported as a real number with its own asOfDate — and a genuine zero elsewhere stays a real 0", async () => {
    const acc = await makeAccount(clientA, "instagram");
    const eng = await makeEngagement(clientA, "Real Reading Eng", { instagram: true });
    const today = new Date().toISOString().slice(0, 10);
    await insertMetricsDay(acc, today, 4200);

    const res = await app.inject({
      method: "GET", url: `/api/${A}/modules/social/engagements/${eng}/assistant-summary`, headers: asUser(uA),
    });
    const body = res.json();
    expect(body.metrics.accounts[0].followers).toBe(4200);
    expect(body.metrics.accounts[0].asOfDate).toBe(today);
    expect(body.metrics.totalKnownFollowers).toBe(4200);
    // No posts were ever created for this engagement — a REAL zero (count of our own rows), not a
    // withheld number (file header's own carve-out).
    expect(body.posts.total).toBe(0);
    expect(body.inbox.open).toBe(0);
  });

  // ── THE CROSS-CLIENT LEAK TEST — mandatory per this ticket's own spec ────────────────────────────
  // Two engagements under DIFFERENT clients (same tenant), each with its own distinctive post, inbox
  // thread and follower reading. Proves the summary for engagement A never contains a single fact that
  // belongs to engagement B's client, and vice versa — the exact surface where one client's numbers
  // could otherwise reach another client's chat answer.
  it("CROSS-CLIENT LEAK TEST: two engagements' summaries never share a post, thread, or follower reading", async () => {
    const accA = await makeAccount(clientA, "facebook"); // a network unused by any earlier test's clientA fixtures — avoids this file's own cross-test pollution, not a leak in the code under test
    const accB = await makeAccount(clientB, "linkedin");
    const engA = await makeEngagement(clientA, "Leak Eng A", { facebook: true });
    const engB = await makeEngagement(clientB, "Leak Eng B", { linkedin: true });

    const postA = await makePost(engA, "idea", "CLIENT_A_MARKER post");
    const postB = await makePost(engB, "idea", "CLIENT_B_MARKER post");
    await makeInboxThread(accA, "linkedin", "open");
    await makeInboxThread(accB, "linkedin", "open");
    await makeInboxThread(accB, "linkedin", "open"); // B has TWO open threads, A has one — distinguishable counts
    const today = new Date().toISOString().slice(0, 10);
    await insertMetricsDay(accA, today, 111);
    await insertMetricsDay(accB, today, 999);

    const resA = await app.inject({
      method: "GET", url: `/api/${A}/modules/social/engagements/${engA}/assistant-summary`, headers: asUser(uA),
    });
    const resB = await app.inject({
      method: "GET", url: `/api/${A}/modules/social/engagements/${engB}/assistant-summary`, headers: asUser(uA),
    });
    expect(resA.statusCode).toBe(200);
    expect(resB.statusCode).toBe(200);
    const bodyA = resA.json();
    const bodyB = resB.json();

    // Post counts are engagement-scoped: A's total reflects only A's own post, never B's.
    expect(bodyA.posts.total).toBe(1);
    expect(bodyB.posts.total).toBe(1);

    // Inbox counts never cross: A sees exactly its own thread, B sees exactly its own two.
    expect(bodyA.inbox.open).toBe(1);
    expect(bodyB.inbox.open).toBe(2);

    // Account ids never cross into the other engagement's metrics list.
    const accountIdsA = bodyA.metrics.accounts.map((a: { accountId: string }) => a.accountId);
    const accountIdsB = bodyB.metrics.accounts.map((a: { accountId: string }) => a.accountId);
    expect(accountIdsA).toEqual([accA]);
    expect(accountIdsB).toEqual([accB]);
    expect(accountIdsA).not.toContain(accB);
    expect(accountIdsB).not.toContain(accA);

    // Follower readings never cross: A's own reading is 111 (never B's 999), and vice versa.
    expect(bodyA.metrics.accounts[0].followers).toBe(111);
    expect(bodyB.metrics.accounts[0].followers).toBe(999);
    expect(bodyA.metrics.totalKnownFollowers).toBe(111);
    expect(bodyB.metrics.totalKnownFollowers).toBe(999);

    void postA; void postB;
  });
});
