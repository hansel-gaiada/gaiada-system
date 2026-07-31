// ⚡ QA gate — bundled owed gate (SM-54/56/59/61), tracker §6au. This file is QA-authored, not
// SM-56's own — it attacks the collect edge at boundaries the shipped SM-56 suite (search-rank.test.ts)
// does not exercise: cross-TENANT forgery through the real HTTP route (the shipped suite proves the
// unit-level lookup is RLS-scoped but never drives the boundary over HTTP with a second tenant's real
// session), and — the one this file exists to answer — whether a paid task id can be "collected" under
// an ENGAGEMENT/PROPERTY/KEYWORD that never posted it, inside the SAME tenant. `findLedgerRowByVendorRef`
// is scoped to (tenant, provider, vendor_ref) only; nothing in `collectRankForTask` cross-checks the
// resolved ledger row's own `engagement_id`/`property_id` against the caller-supplied ones. If that gap
// is real, a same-tenant relay (or a compromised n8n credential) can attribute a fabricated rank snapshot
// to any property/keyword in the tenant merely by knowing (or replaying) another engagement's task id —
// and, if that other engagement's charge is `incurred`, silently reconciles someone else's orphaned spend
// as a side effect of a request that named a totally different engagement.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { newId, withTenants } from "../../db";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createClient } from "../../testing/fixtures";
import { registerModule, resetModules } from "../registry";
import { searchModule } from "./index";
import { resetCoreRollupProviders, syncMetricDefinitions } from "../../rollups/engine";
import { MockSearchProvider } from "./providers/mock-provider";
import { registerProvider, resetProviders } from "./providers/registry";
import { resetGlobalMonthToDateCache } from "./providers/ledger";
import type { TaskRef, SerpResult } from "./providers/types";

/** The shipped SM-56 suite sets `mock.delayMs = 40` on its SIMULTANEOUS-redelivery test expecting it to
 *  widen the collision window — but `MockSearchProvider.fetchSerpByTaskId` never calls `tick()` (by
 *  design, so a collect never advances `dispatchCount`), so `delayMs` has NO EFFECT on the collect path
 *  at all. This subclass actually delays `fetchSerpByTaskId` itself, which is what a real race probe
 *  needs — this is the SM-25b lesson ("a concurrent test that never collides proves nothing") applied to
 *  this file's own instrument, exactly as §6av found in the scheduler's stop()/lock test. */
class ActuallyDelayedCollectProvider extends MockSearchProvider {
  collectDelayMs = 0;
  async fetchSerpByTaskId(ref: TaskRef): Promise<SerpResult> {
    if (this.collectDelayMs > 0) await new Promise((r) => setTimeout(r, this.collectDelayMs));
    return super.fetchSerpByTaskId(ref);
  }
}

vi.mock("../../rbac/cerbos", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../rbac/cerbos")>();
  return { ...actual, check: vi.fn(async () => ({ allow: true as const })) };
});

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const SECRET = "qa-adversarial-sm56-secret";
const asRelay = (id: string) => ({ ...asUser(id), "x-gaiada-search-callback-secret": SECRET });

describe.skipIf(!TEST_URL)("⚡ QA adversarial — SM-56 collect-edge boundary (bundled gate, §6au)", () => {
  let app: NestFastifyApplication;
  let A: string, uA: string, clientA: string;
  let B: string, uB: string, clientB: string;
  let seq = 0;
  const uniqueDomain = () => `qa56-${Date.now()}-${seq++}.example.com`;
  const uniqueKeyword = (tag: string) => `qa56-${tag}-${Date.now()}-${seq++}`;

  async function makeProperty(tenant: string, user: string, client: string): Promise<string> {
    const res = await app.inject({
      method: "POST", url: `/api/${tenant}/modules/search/properties`, headers: asUser(user),
      payload: { clientId: client, domain: uniqueDomain(), siteUrl: "https://qa56.example.com" },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  async function makeEngagement(tenant: string, user: string, client: string, propertyId: string): Promise<string> {
    const res = await app.inject({
      method: "POST", url: `/api/${tenant}/modules/search/engagements`, headers: asUser(user),
      payload: {
        clientId: client, propertyId, name: `QA-56 engagement ${seq++}`,
        toolScope: { rank: { enabled: true } }, providerBudgetUsd: 100,
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  async function makeKeywordSet(tenant: string, user: string, engagementId: string): Promise<string> {
    const res = await app.inject({
      method: "POST", url: `/api/${tenant}/modules/search/keyword-sets`, headers: asUser(user),
      payload: { engagementId, name: `QA-56 set ${seq++}`, source: "research" },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  async function makeKeyword(tenant: string, user: string, setId: string, keyword: string): Promise<string> {
    const imp = await app.inject({
      method: "POST", url: `/api/${tenant}/modules/search/keyword-sets/${setId}/import`, headers: asUser(user),
      payload: { text: keyword },
    });
    expect(imp.statusCode).toBe(200);
    const list = await app.inject({
      method: "GET", url: `/api/${tenant}/modules/search/keyword-sets/${setId}/keywords`, headers: asUser(user),
    });
    const row = (list.json() as Array<{ id: string; keyword: string }>).find((k) => k.keyword === keyword);
    if (!row) throw new Error(`keyword ${keyword} not found after import`);
    return row.id;
  }

  /** A `posted` (or `incurred`) ledger row stamped with `vendor_ref = taskId`, exactly the shape the
   *  original `task_post` leaves behind — inserted directly, same as the shipped SM-56 suite's own
   *  `paidCall` helper, under whichever tenant/engagement/property the test wants to model as the
   *  ORIGINAL, genuine purchaser. */
  async function paidCall(
    tenant: string, eng: string, property: string, user: string, taskId: string,
    opts?: { status?: string; costUsd?: number },
  ): Promise<string> {
    const id = newId();
    await withTenants(
      [tenant],
      (c) => c.query(
        `INSERT INTO search_provider_calls
           (id, tenant_id, engagement_id, property_id, provider, endpoint, items, cost_usd, cache_hit,
            status, requested_by, simulated, vendor_ref)
         VALUES ($1,$2,$3,$4,'dataforseo','dataforseo.serp',1,$5,false,$6,$7,false,$8)`,
        [id, tenant, eng, property, opts?.costUsd ?? 0.0006, opts?.status ?? "posted", user, taskId],
      ),
      { modules: ["search"] },
    );
    return id;
  }

  async function snapshotsFor(tenant: string, property: string, kwId: string) {
    const r = await withTenants(
      [tenant],
      (c) => c.query<{ id: string; provider_call_id: string | null; property_id: string; keyword_id: string }>(
        `SELECT id, provider_call_id, property_id, keyword_id FROM search_rank_snapshots
          WHERE property_id = $1 AND keyword_id = $2`,
        [property, kwId],
      ),
      { modules: ["search"] },
    );
    return r.rows;
  }

  async function ledgerRow(tenant: string, id: string) {
    const r = await withTenants(
      [tenant],
      (c) => c.query<{ status: string; engagement_id: string; property_id: string }>(
        `SELECT status, engagement_id, property_id FROM search_provider_calls WHERE id = $1`,
        [id],
      ),
      { modules: ["search"] },
    );
    return r.rows[0];
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    registerModule(searchModule);
    await syncMetricDefinitions();

    A = await createCompany("QA56 Co A", ["search"]);
    uA = await createUser("qa56-a@a.test");
    await addMembership(A, uA);
    clientA = await createClient(A, "QA56 Client A");

    B = await createCompany("QA56 Co B", ["search"]);
    uB = await createUser("qa56-b@b.test");
    await addMembership(B, uB);
    clientB = await createClient(B, "QA56 Client B");

    app = await buildApp();
  });

  afterAll(async () => {
    resetProviders();
    config.search.providerMode = "live";
    await app?.close();
    await teardownTestDb();
  });

  beforeEach(() => {
    resetProviders();
    config.search.callbackSecret = SECRET;
    config.search.providerMode = "live";
    config.search.tenantMonthlyCapUsd = null;
    config.search.globalMonthlyCapUsd = 1_000_000;
    config.search.budgetWarnRatio = 0.8;
    resetGlobalMonthToDateCache();
  });

  afterEach(() => {
    resetProviders();
    config.search.providerMode = "live";
  });

  it("ATTACK — cross-TENANT: tenant B quoting tenant A's real task id over the HTTP route gets 404, not the platform-A data (RLS foreclosure driven over HTTP, not just the unit-level lookup)", async () => {
    const mock = new MockSearchProvider();
    registerProvider(mock);

    const propA = await makeProperty(A, uA, clientA);
    const engA = await makeEngagement(A, uA, clientA, propA);
    const setA = await makeKeywordSet(A, uA, engA);
    const kwA = await makeKeyword(A, uA, setA, uniqueKeyword("tenantA"));
    await paidCall(A, engA, propA, uA, "qa56-cross-tenant-task");

    const propB = await makeProperty(B, uB, clientB);
    const engB = await makeEngagement(B, uB, clientB, propB);
    const setB = await makeKeywordSet(B, uB, engB);
    const kwB = await makeKeyword(B, uB, setB, uniqueKeyword("tenantB"));

    // Tenant B's own credentials, tenant B's own resource ids, but the TASK ID belongs to tenant A.
    const res = await app.inject({
      method: "POST", url: `/api/${B}/modules/search/rank-pulls/callback`, headers: asRelay(uB),
      payload: { engagementId: engB, propertyId: propB, keywordId: kwB, taskId: "qa56-cross-tenant-task" },
    });

    expect(res.statusCode).toBe(404); // HELD — RLS forecloses at the connection, not merely filters
    expect(mock.collectCount).toBe(0); // no vendor call was ever attempted for tenant B's forged id
    expect(await snapshotsFor(B, propB, kwB)).toHaveLength(0);
    // And tenant A's own row is untouched.
    const rowsA = await withTenants([A], (c) => c.query(`SELECT status FROM search_provider_calls WHERE engagement_id = $1`, [engA]), { modules: ["search"] });
    expect(rowsA.rows[0].status).toBe("posted");
  });

  it("ATTACK — same-tenant, WRONG property/engagement: a task id paid under Engagement 1 / Property 1 is presented against Engagement 2 / Property 2's keyword. `findLedgerRowByVendorRef` scopes on (tenant, provider, vendor_ref) ONLY — does the collect edge cross-check the resolved row's own engagement/property before writing?", async () => {
    const mock = new MockSearchProvider();
    registerProvider(mock);

    // The GENUINE purchaser: Engagement 1 / Property 1 posted and paid for this task.
    const prop1 = await makeProperty(A, uA, clientA);
    const eng1 = await makeEngagement(A, uA, clientA, prop1);
    const set1 = await makeKeywordSet(A, uA, eng1);
    const kw1 = await makeKeyword(A, uA, set1, uniqueKeyword("genuine"));
    const ledgerId = await paidCall(A, eng1, prop1, uA, "qa56-wrong-scope-task");

    // A COMPLETELY UNRELATED engagement/property/keyword in the SAME tenant — never posted this task.
    const prop2 = await makeProperty(A, uA, clientA);
    const eng2 = await makeEngagement(A, uA, clientA, prop2);
    const set2 = await makeKeywordSet(A, uA, eng2);
    const kw2 = await makeKeyword(A, uA, set2, uniqueKeyword("unrelated"));

    const res = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/rank-pulls/callback`, headers: asRelay(uA),
      payload: { engagementId: eng2, propertyId: prop2, keywordId: kw2, taskId: "qa56-wrong-scope-task" },
    });

    const snapsWrong = await snapshotsFor(A, prop2, kw2);
    const snapsGenuine = await snapshotsFor(A, prop1, kw1);

    if (res.statusCode === 200 && snapsWrong.length > 0) {
      // BROKEN: the collect edge attributed a fabricated snapshot, under Engagement 2 / Property 2 /
      // Keyword 2, to a ledger row that Engagement 1 alone paid for — using data fetched under a task id
      // whose original vendor query was for Keyword 1's search, not Keyword 2's. `provider_call_id`
      // still points at Engagement 1's row, so a reader of Engagement 2's snapshots sees a row claiming
      // free, honest provenance that is in fact borrowed from a completely different client relationship.
      expect(snapsWrong[0].provider_call_id).toBe(ledgerId);
      throw new Error(
        `SM-56 DEFECT CONFIRMED: collect edge wrote a snapshot for engagement 2 / property ${prop2} / ` +
        `keyword ${kw2}, attributed via provider_call_id=${ledgerId} to Engagement 1's paid task — the ` +
        `resolved ledger row's own engagement_id/property_id (${(await ledgerRow(A, ledgerId)).engagement_id}/` +
        `${(await ledgerRow(A, ledgerId)).property_id}) was never cross-checked against the caller-supplied ` +
        `engagementId/propertyId. A same-tenant relay can attribute fabricated rank data to any property by ` +
        `replaying another engagement's task id.`,
      );
    }
    // HELD if this branch runs: either refused (4xx) or wrote nothing under the wrong scope.
    expect(snapsWrong).toHaveLength(0);
  });

  it("ATTACK — replay of an ALREADY-COMPLETED postback after the original charge was reconciled: a redelivery for a row that is already `completed` (not `incurred`) must stay a no-op `duplicate`, never re-advance or double-write", async () => {
    const mock = new MockSearchProvider();
    registerProvider(mock);
    const property = await makeProperty(A, uA, clientA);
    const eng = await makeEngagement(A, uA, clientA, property);
    const set = await makeKeywordSet(A, uA, eng);
    const kwId = await makeKeyword(A, uA, set, uniqueKeyword("post-complete-replay"));
    const ledgerId = await paidCall(A, eng, property, uA, "qa56-post-complete-task");

    // First delivery: genuinely collects and completes the row.
    const first = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/rank-pulls/callback`, headers: asRelay(uA),
      payload: { engagementId: eng, propertyId: property, keywordId: kwId, taskId: "qa56-post-complete-task" },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().status).toBe("collected");

    const rowAfterFirst = await ledgerRow(A, ledgerId);
    expect(rowAfterFirst.status).toBe("posted"); // it started `posted`, not `incurred` — no reconciliation to do

    // Simulate the vendor genuinely redelivering the SAME postback well after the fact (at-least-once
    // delivery has no time bound).
    const replay = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/rank-pulls/callback`, headers: asRelay(uA),
      payload: { engagementId: eng, propertyId: property, keywordId: kwId, taskId: "qa56-post-complete-task" },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().status).toBe("duplicate");
    expect(replay.json().reconciledIncurred).toBeFalsy();
    expect(await snapshotsFor(A, property, kwId)).toHaveLength(1); // still exactly one
    expect(mock.collectCount).toBe(1); // the replay never even reached the vendor
  });

  it("ATTACK (window genuinely forced) — a TRUE concurrent redelivery race, using a provider that actually delays fetchSerpByTaskId (the shipped suite's `mock.delayMs=40` does not, since fetchSerpByTaskId never calls tick()) — still exactly ONE snapshot", async () => {
    const mock = new ActuallyDelayedCollectProvider();
    mock.collectDelayMs = 120; // wide enough that both requests' pre-insert reads land before either write
    registerProvider(mock);
    const property = await makeProperty(A, uA, clientA);
    const eng = await makeEngagement(A, uA, clientA, property);
    const set = await makeKeywordSet(A, uA, eng);
    const kwId = await makeKeyword(A, uA, set, uniqueKeyword("forced-race"));
    await paidCall(A, eng, property, uA, "qa56-forced-race-task");

    const payload = { engagementId: eng, propertyId: property, keywordId: kwId, taskId: "qa56-forced-race-task" };
    const [a, b] = await Promise.all([
      app.inject({ method: "POST", url: `/api/${A}/modules/search/rank-pulls/callback`, headers: asRelay(uA), payload }),
      app.inject({ method: "POST", url: `/api/${A}/modules/search/rank-pulls/callback`, headers: asRelay(uA), payload }),
    ]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    const statuses = [a.json().status, b.json().status].sort();
    expect(statuses).toEqual(["collected", "duplicate"]); // HELD under a window genuinely forced open
    expect(await snapshotsFor(A, property, kwId)).toHaveLength(1);
  });
});
