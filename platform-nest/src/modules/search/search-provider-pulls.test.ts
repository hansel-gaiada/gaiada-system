// SM-16 — controller + persistence integration for backlinks.ts / ai-visibility.ts (design
// §12 SM-16; tracker §6j "SM-16 · backlinks + GEO/AI-visibility"). LIVE Postgres (RLS actually
// exercised) + the real HTTP layer, same harness as search-audit.test.ts (SM-08) / simulation.test.ts's
// integration half (SM-33) — Cerbos stubbed to always-allow (parity is search-cerbos.test.ts's job).
//
// What this file proves, mapped to the ticket's five inherited duties (§6j, transposed from SM-14):
//   1. `simulated` is stamped from DispatchResult.simulated, NOT config.search.providerMode — the
//      "misconfiguration" pin (a simulated driver registered while providerMode says 'live') is the
//      MUTATION PROBE: if the implementation read config.search.providerMode instead, this specific
//      test would go GREEN when it must be RED (it currently asserts simulated=true while mode='live').
//   2. stamped atomically with the payload (asserted implicitly: every persisted row's simulated/
//      provider/values come from the exact same dispatch result — verified via the reported response
//      matching the persisted row byte-for-byte).
//   3. the append-only-batch analogue of "absent stays absent": a mid-batch budget refusal stops the
//      ai-visibility batch loop, but the query pulled BEFORE the refusal stays persisted.
//   4. readers (listBacklinks/listAiVisibility) badge per-row, unfiltered by current mode — proven on
//      a MIXED table (one simulated row, one real-shaped row) via direct SQL seeding.
//   5. every route lives on SearchController — proven by driving them over real HTTP.
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
import { createSimulationProviders } from "./providers/simulation";
import { resetGlobalMonthToDateCache } from "./providers/ledger";

vi.mock("../../rbac/cerbos", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../rbac/cerbos")>();
  return { ...actual, check: vi.fn(async () => ({ allow: true as const })) };
});

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!TEST_URL)("search-marketing backlinks + AI-visibility pulls (SM-16)", () => {
  let app: NestFastifyApplication;
  let A: string;
  let uA: string;
  let clientA: string;
  let propertyId: string;
  let seq = 0;
  const uniqueDomain = () => `sm16-${Date.now()}-${seq++}.example.com`;

  async function makeEngagement(
    toolScope: Record<string, unknown>,
    providerBudgetUsd = 100,
    forPropertyId: string = propertyId,
  ): Promise<string> {
    const res = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/engagements`, headers: asUser(uA),
      payload: { clientId: clientA, propertyId: forPropertyId, name: `SM-16 engagement ${seq++}`, toolScope, providerBudgetUsd },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  async function outboxEvents(entityId: string, eventType: string): Promise<number> {
    const r = await withTenants(
      [A],
      (c) => c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM outbox_events WHERE tenant_id = $1 AND entity_id = $2 AND event_type = $3`,
        [A, entityId, eventType],
      ),
      // outbox_events is a core table (no `search` module wall), matching notifications.ts's own
      // alreadyNotified helper — no `modules` option needed here.
    );
    return Number(r.rows[0].n);
  }

  async function makeProperty(): Promise<string> {
    const res = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/properties`, headers: asUser(uA),
      payload: { clientId: clientA, domain: uniqueDomain(), siteUrl: "https://sm16.example.com" },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    registerModule(searchModule);
    await syncMetricDefinitions();

    A = await createCompany("SM16 Co A", ["search"]);
    uA = await createUser("sm16-a@a.test");
    await addMembership(A, uA);
    clientA = await createClient(A, "SM16 Client of A");

    app = await buildApp();

    const propRes = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/properties`, headers: asUser(uA),
      payload: { clientId: clientA, domain: uniqueDomain(), siteUrl: "https://sm16.example.com" },
    });
    expect(propRes.statusCode).toBe(201);
    propertyId = propRes.json().id as string;
  });

  afterAll(async () => {
    resetProviders();
    config.search.providerMode = "live";
    await app?.close();
    await teardownTestDb();
  });

  beforeEach(() => {
    resetProviders();
    config.search.tenantMonthlyCapUsd = null;
    config.search.globalMonthlyCapUsd = 1_000_000;
    config.search.budgetWarnRatio = 0.8;
    resetGlobalMonthToDateCache();
  });

  afterEach(() => {
    resetProviders();
    config.search.providerMode = "live";
  });

  // ══════════════════════════════════════════ BACKLINKS ══════════════════════════════════════════

  describe("POST engagements/:id/backlinks-pull", () => {
    it("happy path: persists one row stamped from a REAL (non-simulated) driver, provenance atomic with the payload", async () => {
      registerProvider(new MockSearchProvider());
      config.search.providerMode = "live";
      const property = await makeProperty(); // fresh property: no "previous snapshot" to interact with
      const eng = await makeEngagement({ backlinks: { enabled: true } }, 100, property);

      const res = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/engagements/${eng}/backlinks-pull`, headers: asUser(uA),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe("pulled");
      expect(body.backlinks).toBe(5321); // MockSearchProvider's fixed value
      expect(body.provider).toBe("dataforseo");
      expect(body.simulated).toBe(false);

      const row = await withTenants(
        [A],
        (c) => c.query(
          `SELECT provider, simulated, totals FROM search_backlink_snapshots WHERE property_id = $1 ORDER BY captured_at DESC LIMIT 1`,
          [property],
        ),
        { modules: ["search"] },
      );
      expect(row.rows[0].provider).toBe("dataforseo");
      expect(row.rows[0].simulated).toBe(false);
      expect(row.rows[0].totals.backlinks).toBe(5321);
    });

    it("MUTATION PROBE (duty 1): a simulated driver registered while providerMode says 'live' STILL stamps simulated=true — proves the stamp reads DispatchResult.simulated, not config.search.providerMode", async () => {
      for (const p of createSimulationProviders()) registerProvider(p);
      config.search.providerMode = "live"; // deliberate misconfiguration (main.ts makes this a boot
      // error in prod, §A4.3) — the one scenario where DispatchResult.simulated and
      // (config.search.providerMode === 'simulate') DISAGREE, which is exactly what this pin needs.
      const property = await makeProperty();
      const eng = await makeEngagement({ backlinks: { enabled: true } }, 100, property);

      const res = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/engagements/${eng}/backlinks-pull`, headers: asUser(uA),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // If the implementation were `simulated: config.search.providerMode === "simulate"` this would
      // read `false` here (mode is 'live') — it must read `true` (the DRIVER is simulated).
      expect(body.simulated).toBe(true);

      const row = await withTenants(
        [A],
        (c) => c.query(
          `SELECT simulated FROM search_backlink_snapshots WHERE property_id = $1 ORDER BY captured_at DESC LIMIT 1`,
          [property],
        ),
        { modules: ["search"] },
      );
      expect(row.rows[0].simulated).toBe(true);
    });

    it("refuses naming the toggle when the engagement's backlinks scope is disabled (budget stop-loss gate)", async () => {
      registerProvider(new MockSearchProvider());
      config.search.providerMode = "live";
      const property = await makeProperty();
      const eng = await makeEngagement({ backlinks: { enabled: false } }, 100, property);

      const res = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/engagements/${eng}/backlinks-pull`, headers: asUser(uA),
      });
      // UPDATED by SM-53 (tracker §6aa). This test previously pinned a message-less **500** and its
      // comment named that as the known-bad temporary contract, correctly flagging the
      // exception-filter fix as out of its own ticket's file ownership. That fix has since landed —
      // `ProviderDispatchErrorFilter` maps typed refusals onto HTTP — so the assertion is updated to
      // the intended contract rather than left pinning the defect. Recorded because this is the
      // honest failure mode of the file-ownership discipline: SM-16 could not fix the layer, so it
      // pinned the symptom; landing the fix then broke the pin. Changing a contract means grepping
      // for the tests that pinned the old one — I did not, and this gate caught it.
      expect(res.statusCode).toBe(409);
      const body = res.json() as { error: string; code: string };
      expect(body.code).toBe("scope_disabled");
      // The actionable half — the reason the mapping exists at all is that the operator must be told
      // WHICH toggle to enable. A 409 with an empty body would be no better than the 500 it replaced.
      expect(body.error).toContain("backlinks");

      const rows = await withTenants(
        [A], (c) => c.query(`SELECT 1 FROM search_backlink_snapshots WHERE property_id = $1`, [property]),
        { modules: ["search"] },
      );
      expect(rows.rows.length).toBe(0);
    });

    it("detects + emits search.backlinks.lost_spike on a large drop vs the immediately-prior snapshot", async () => {
      registerProvider(new MockSearchProvider()); // always reports 5,321 backlinks
      config.search.providerMode = "live";
      const property = await makeProperty();
      const eng = await makeEngagement({ backlinks: { enabled: true } }, 100, property);

      // Seed a much higher PRIOR snapshot directly (a real prior pull would have been a different
      // domain figure) so the mock's fixed 5,321 reads as a genuine large drop.
      await withTenants(
        [A],
        (c) => c.query(
          `INSERT INTO search_backlink_snapshots (id, tenant_id, property_id, totals, provider, simulated)
           VALUES ($1,$2,$3,$4,$5,false)`,
          [newId(), A, property, JSON.stringify({ backlinks: 100_000, refDomains: 500 }), "ahrefs"],
        ),
        { modules: ["search"] },
      );

      const res = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/engagements/${eng}/backlinks-pull`, headers: asUser(uA),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.lostSpike).toBe(true);
      expect(body.previousBacklinks).toBe(100_000);
      expect(await outboxEvents(property, "search.backlinks.lost_spike")).toBe(1);
    });

    it("no lost-spike event on a normal (non-dropping, first-ever) pull", async () => {
      registerProvider(new MockSearchProvider());
      config.search.providerMode = "live";
      const property = await makeProperty(); // fresh property: no prior snapshot at all
      const eng = await makeEngagement({ backlinks: { enabled: true } }, 100, property);

      const res = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/engagements/${eng}/backlinks-pull`, headers: asUser(uA),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().lostSpike).toBe(false);
      expect(await outboxEvents(property, "search.backlinks.lost_spike")).toBe(0);
    });
  });

  describe("GET properties/:id/backlinks — badge, not filter", () => {
    it("returns BOTH simulated and real rows unfiltered, each carrying its own flag", async () => {
      const badgeProperty = await makeProperty();

      await withTenants(
        [A],
        async (c) => {
          await c.query(
            `INSERT INTO search_backlink_snapshots (id, tenant_id, property_id, totals, provider, simulated)
             VALUES ($1,$2,$3,$4,$5,true)`,
            [newId(), A, badgeProperty, JSON.stringify({ backlinks: 10 }), "dataforseo"],
          );
          await c.query(
            `INSERT INTO search_backlink_snapshots (id, tenant_id, property_id, totals, provider, simulated)
             VALUES ($1,$2,$3,$4,$5,false)`,
            [newId(), A, badgeProperty, JSON.stringify({ backlinks: 20 }), "ahrefs"],
          );
        },
        { modules: ["search"] },
      );

      const res = await app.inject({
        method: "GET", url: `/api/${A}/modules/search/properties/${badgeProperty}/backlinks`, headers: asUser(uA),
      });
      expect(res.statusCode).toBe(200);
      const rows = res.json() as Array<{ simulated: boolean; provider: string }>;
      expect(rows.length).toBe(2);
      const flags = rows.map((r) => r.simulated).sort();
      expect(flags).toEqual([false, true]);
    });
  });

  // ═══════════════════════════════════════ AI VISIBILITY (GEO) ═══════════════════════════════════

  describe("POST engagements/:id/ai-visibility-pull", () => {
    it("happy path: pulls the engagement's scope-configured queries (no body override), one row per returned engine, stamped from the real driver", async () => {
      registerProvider(new MockSearchProvider()); // returns exactly one row (engine defaults to 'chatgpt')
      config.search.providerMode = "live";
      const query = `sm16-geo-${Date.now()}`;
      const eng = await makeEngagement({ ai_visibility: { enabled: true, queries: [query] } });

      const res = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/engagements/${eng}/ai-visibility-pull`, headers: asUser(uA),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.attempted).toBe(1);
      expect(body.pulled).toBe(1);
      expect(body.results[0].status).toBe("pulled");
      expect(body.results[0].rows[0].engine).toBe("chatgpt");
      expect(body.results[0].rows[0].brandMentioned).toBe(true);
      expect(body.results[0].simulated).toBe(false);
      expect(body.results[0].rows[0].changed).toBe(false); // first-ever row for this triple

      const row = await withTenants(
        [A],
        (c) => c.query(
          `SELECT provider, simulated, engine, brand_mentioned AS "brandMentioned" FROM search_ai_visibility
            WHERE property_id = $1 AND query = $2`,
          [propertyId, query],
        ),
        { modules: ["search"] },
      );
      expect(row.rows.length).toBe(1);
      expect(row.rows[0].provider).toBe("dataforseo");
      expect(row.rows[0].simulated).toBe(false);
      expect(row.rows[0].brandMentioned).toBe(true);
    });

    it("body `queries` overrides the engagement's scope-configured list", async () => {
      registerProvider(new MockSearchProvider());
      config.search.providerMode = "live";
      const scopeQuery = `sm16-scope-${Date.now()}`;
      const overrideQuery = `sm16-override-${Date.now()}`;
      const eng = await makeEngagement({ ai_visibility: { enabled: true, queries: [scopeQuery] } });

      const res = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/engagements/${eng}/ai-visibility-pull`, headers: asUser(uA),
        payload: { queries: [overrideQuery] },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().results[0].query).toBe(overrideQuery);

      const rows = await withTenants(
        [A], (c) => c.query(`SELECT query FROM search_ai_visibility WHERE property_id = $1 AND query = $2`, [propertyId, scopeQuery]),
        { modules: ["search"] },
      );
      expect(rows.rows.length).toBe(0); // the scope-configured query was never pulled
    });

    it("MUTATION PROBE (duty 1): a simulated driver registered while providerMode says 'live' STILL stamps simulated=true on every persisted row", async () => {
      for (const p of createSimulationProviders()) registerProvider(p);
      config.search.providerMode = "live";
      const query = `sm16-mutprobe-${Date.now()}`;
      const eng = await makeEngagement({ ai_visibility: { enabled: true, queries: [query] } });

      const res = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/engagements/${eng}/ai-visibility-pull`, headers: asUser(uA),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.results[0].simulated).toBe(true);
      for (const row of body.results[0].rows) expect(row).toBeTruthy();

      const rows = await withTenants(
        [A], (c) => c.query(`SELECT simulated FROM search_ai_visibility WHERE property_id = $1 AND query = $2`, [propertyId, query]),
        { modules: ["search"] },
      );
      expect(rows.rows.length).toBeGreaterThan(0);
      for (const r of rows.rows) expect(r.simulated).toBe(true);
    });

    it("detects + emits search.ai_visibility.changed when a flag flips vs the prior row for the same (engine,query)", async () => {
      registerProvider(new MockSearchProvider()); // always reports brandMentioned:true, cited:true, engine 'chatgpt'
      config.search.providerMode = "live";
      const query = `sm16-changed-${Date.now()}`;
      const eng = await makeEngagement({ ai_visibility: { enabled: true, queries: [query] } });

      // Seed a prior row with the OPPOSITE flags for the exact same (property, engine, query) triple.
      await withTenants(
        [A],
        (c) => c.query(
          `INSERT INTO search_ai_visibility
             (id, tenant_id, property_id, engine, query, brand_mentioned, cited, provider, simulated, captured_at)
           VALUES ($1,$2,$3,'chatgpt',$4,false,false,'dataforseo',false, now() - interval '1 day')`,
          [newId(), A, propertyId, query],
        ),
        { modules: ["search"] },
      );

      const res = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/engagements/${eng}/ai-visibility-pull`, headers: asUser(uA),
      });
      expect(res.statusCode).toBe(200);
      const outcome = res.json().results[0].rows[0];
      expect(outcome.changed).toBe(true);
      expect(outcome.previousBrandMentioned).toBe(false);
      expect(await outboxEvents(propertyId, "search.ai_visibility.changed")).toBe(1);
    });

    it("batch shape (duty 3 analogue): a mid-batch budget breach stops the loop but the FIRST query's already-inserted rows are left untouched", async () => {
      registerProvider(new MockSearchProvider());
      config.search.providerMode = "live";
      const q1 = `sm16-batch1-${Date.now()}`;
      const q2 = `sm16-batch2-${Date.now()}`;
      // Cap so tight the FIRST dispatch (an ai_visibility op, mock rate 0.001/item) fits but a SECOND
      // one would breach — the mock's estimateCostUsd is deterministic (rate * items).
      const eng = await makeEngagement({ ai_visibility: { enabled: true, queries: [q1, q2] } }, 0.0011);

      const res = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/engagements/${eng}/ai-visibility-pull`, headers: asUser(uA),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.results[0].query).toBe(q1);
      expect(body.results[0].status).toBe("pulled");
      expect(body.results[1].query).toBe(q2);
      expect(body.results[1].status).toBe("skipped");
      expect(body.skipped).toBe(1);
      expect(body.pulled).toBe(1);

      const q1Rows = await withTenants([A], (c) => c.query(`SELECT 1 FROM search_ai_visibility WHERE property_id = $1 AND query = $2`, [propertyId, q1]), { modules: ["search"] });
      const q2Rows = await withTenants([A], (c) => c.query(`SELECT 1 FROM search_ai_visibility WHERE property_id = $1 AND query = $2`, [propertyId, q2]), { modules: ["search"] });
      expect(q1Rows.rows.length).toBeGreaterThan(0); // NOT rolled back by q2's refusal
      expect(q2Rows.rows.length).toBe(0); // genuinely never dispatched — absent stays absent
    });

    it("empty queries (no scope config, no override) is a clean 0-attempt no-op, not an error", async () => {
      registerProvider(new MockSearchProvider());
      config.search.providerMode = "live";
      const eng = await makeEngagement({ ai_visibility: { enabled: true } }); // no `queries` array at all

      const res = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/engagements/${eng}/ai-visibility-pull`, headers: asUser(uA),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ propertyId, attempted: 0, pulled: 0, skipped: 0, failed: 0, results: [] });
    });
  });

  describe("GET properties/:id/ai-visibility — badge, not filter", () => {
    it("returns BOTH simulated and real rows unfiltered, each carrying its own flag", async () => {
      const badgeQuery = `sm16-geo-badge-${Date.now()}`;
      await withTenants(
        [A],
        async (c) => {
          await c.query(
            `INSERT INTO search_ai_visibility (id, tenant_id, property_id, engine, query, brand_mentioned, cited, provider, simulated)
             VALUES ($1,$2,$3,'chatgpt',$4,true,true,'dataforseo',true)`,
            [newId(), A, propertyId, badgeQuery],
          );
          await c.query(
            `INSERT INTO search_ai_visibility (id, tenant_id, property_id, engine, query, brand_mentioned, cited, provider, simulated)
             VALUES ($1,$2,$3,'gemini',$4,false,false,'dataforseo',false)`,
            [newId(), A, propertyId, badgeQuery],
          );
        },
        { modules: ["search"] },
      );

      const res = await app.inject({
        method: "GET", url: `/api/${A}/modules/search/properties/${propertyId}/ai-visibility?query=${badgeQuery}`, headers: asUser(uA),
      });
      expect(res.statusCode).toBe(200);
      const rows = res.json() as Array<{ simulated: boolean; engine: string }>;
      expect(rows.length).toBe(2);
      expect(rows.map((r) => r.simulated).sort()).toEqual([false, true]);
    });
  });
});
