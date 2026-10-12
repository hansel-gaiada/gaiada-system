// M5-V3-g — the consented-visitor routes against REAL Postgres and the real HTTP layer. Needs DATABASE_URL_TEST: the Linux gate. NOT run on
// the dev laptop (owner order 2026-10-12: no local Docker); skipped without it.
//
// Acceptance (design 2026-10-12 §8 V3-g): staff 403 with VALID bodies and queries, manager 200; the lead id only for a principal who may read
// that lead; 403 and 404 distinct; not-configured / disabled / unreachable answer in words; rows keep server order.
// Authorization uses the recording Cerbos double (as conversions.db.test.ts does), so what is asserted is WHICH kind/action each route asks
// for ("staff" = a double that denies read_visitors / update; the real policy is V3-f's and has its own tests).
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { newId, withTenants } from "../../db";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createClient } from "../../testing/fixtures";
import { registerModule, resetModules } from "../registry";
import { resetCoreRollupProviders, syncMetricDefinitions } from "../../rollups/engine";
import { searchModule } from "./index";
import { buildVisitorStatus } from "./visitors.service";

const calls: Array<{ kind: string; action: string; id?: string; tenantId?: string }> = [];
/** "<kind>:<action>" pairs the double denies. */
const denied = new Set<string>();
vi.mock("../../rbac/cerbos", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../rbac/cerbos")>();
  return {
    ...actual,
    check: vi.fn(async (_p: never, resource: { kind: string; id?: string; tenantId?: string }, action: string) => {
      calls.push({ kind: resource.kind, action, id: resource.id, tenantId: resource.tenantId });
      return denied.has(`${resource.kind}:${action}`) ? { allow: false as const, reason: "test-forced-deny" } : { allow: true as const };
    }),
  };
});

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const S = { modules: ["search"] };
const WEBSITE = "33333333-3333-4333-8333-333333333333";
const ENV_KEYS = ["INSIGHTS_BASE_URL", "INSIGHTS_READ_KEY", "INSIGHTS_FORGET_KEY", "SEARCH_VISITORS_ENABLED", "SEARCH_VISITORS_TIMEOUT_MS"] as const;

describe.skipIf(!TEST_URL)("M5-V3-g · consented visitor routes", () => {
  let app: NestFastifyApplication;
  let A: string;
  let B: string;
  let u: string;
  let propA: string;
  let propB: string;
  let propNoSite: string;
  const v: Record<string, { visitor: string; consent: string }> = {};
  let leadOpen: string;
  let leadOnly: string;
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => adminPool().query(sql, params).then((r) => r.rows as T[]);
  const base = (t = "A") => `/api/${t === "A" ? A : B}/modules/search/properties/${t === "A" ? propA : propB}/visitors`;
  const get = (url: string, user = u) => app.inject({ method: "GET", url, headers: asUser(user) });

  async function profile(tenant: string, prop: string, key: string, over: { score: number; last: string; interests?: unknown; visits?: number }) {
    const id = newId(); const visitor = newId(); const consent = newId();
    await q(
      `INSERT INTO search_visitor_profiles (id, tenant_id, property_id, visitor_id, consent_id, first_seen_at, last_seen_at, visits, pageviews, device, country, city,
                                            interests, score, score_parts)
       VALUES ($1,$2,$3,$4,$5,$6,$6,$7,3,'desktop','ID','Denpasar',$8,$9,$10)`,
      [id, tenant, prop, visitor, consent, over.last, over.visits ?? 2, JSON.stringify(over.interests ?? {}), over.score,
        JSON.stringify({ recency: 25, frequency: 5, depth: 0, intent: 0 })],
    );
    v[key] = { visitor, consent };
    return id;
  }
  async function events(profileId: string, tenant: string, prop: string, n: number) {
    for (let i = 1; i <= n; i++) {
      await q(
        `INSERT INTO search_visitor_events (id, tenant_id, property_id, profile_id, collector_event_id, occurred_at, kind, path, name, data)
         VALUES ($1,$2,$3,$4,$5,$6,'pageview',$7,NULL,NULL)`,
        [newId(), tenant, prop, profileId, i, new Date(Date.now() - i * 60000).toISOString(), `/p/${i}`],
      );
    }
  }
  async function lead(consentId: string): Promise<string> {
    const id = newId();
    await withTenants([A], (c) => c.query(
      `INSERT INTO agency_leads (id, tenant_id, org_name, contact_name, source, status, stage, owner_id, origin_site, visitor_consent)
       VALUES ($1,$2,$3,$4,'web','in_review','enquiry',$5,'test',$6)`,
      [id, A, `V3g Org ${id.slice(0, 4)}`, "Prospect", u, JSON.stringify({ analytics: true, marketing: false, consentId })],
    ));
    return id;
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    registerModule(searchModule);
    await syncMetricDefinitions();
    A = await createCompany("V3g Co A", ["search"]);
    B = await createCompany("V3g Co B", ["search"]);
    u = await createUser("v3g-a@a.test");
    await addMembership(A, u);
    const clientA = await createClient(A, "V3g Client A");
    const clientB = await createClient(B, "V3g Client B");
    app = await buildApp();
    const mkProp = async (tenant: string, client: string, domain: string, site: string | null): Promise<string> => {
      const id = newId();
      await withTenants([tenant], (c) => c.query(
        `INSERT INTO search_properties (id, tenant_id, client_id, domain, site_url, verified_at, umami_site_id) VALUES ($1,$2,$3,$4,$5,now(),$6)`,
        [id, tenant, client, domain, `https://${domain}`, site]), S);
      return id;
    };
    propA = await mkProp(A, clientA, "v3g-a.example.com", WEBSITE);
    propNoSite = await mkProp(A, clientA, "v3g-nosite.example.com", null);
    propB = await mkProp(B, clientB, "v3g-b.example.com", WEBSITE);

    // Three visitors on A (scores 80, 40, 40 with distinct last-seen), one on B. Server order by score: hi, mid-newer, mid-older.
    const hi = await profile(A, propA, "hi", { score: 80, last: "2026-10-12T10:00:00Z", interests: { industry: [{ tag: "dental", score: 9 }], service: [{ tag: "web-design", score: 5 }] } });
    await profile(A, propA, "midNew", { score: 40, last: "2026-10-11T10:00:00Z", interests: { service: [{ tag: "seo", score: 4 }] } });
    await profile(A, propA, "midOld", { score: 40, last: "2026-10-01T10:00:00Z" });
    await profile(B, propB, "other", { score: 99, last: "2026-10-12T10:00:00Z" });
    await events(hi, A, propA, 205);
    leadOpen = await lead(v.hi.consent);
    leadOnly = await lead(v.midNew.consent);
  }, 120000);

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  beforeEach(() => {
    calls.length = 0;
    denied.clear();
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  });

  // ── authorization: staff 403 with VALID requests, manager 200; the action asked is the one the design names ────────
  describe("authorization (authorize before validate)", () => {
    const validRules = { rules: [{ match: "path_prefix", pattern: "/services/", facet: "service", tag: "web-design", weight: 3 }] };
    it("reads ask read_visitors on the property kind, with module search and the tenant", async () => {
      for (const path of ["", `/${v.hi.visitor}`, "/status", "/interest-rules", "/filter/0/score"]) {
        calls.length = 0;
        const res = await get(`${base()}${path}`);
        expect(res.statusCode, `${path}: ${res.body}`).toBe(200);
        expect(calls[0]).toMatchObject({ kind: "resource_search_property", action: "read_visitors", id: propA, tenantId: A });
      }
    });
    it("staff (read_visitors denied) get 403 on every read, with valid queries and ids", async () => {
      denied.add("resource_search_property:read_visitors");
      for (const path of ["", "?minScore=10&order=recent", `/${v.hi.visitor}`, "/status", "/interest-rules", "/filter/0/score"]) {
        const res = await get(`${base()}${path}`);
        expect(res.statusCode, path).toBe(403);
      }
    });
    it("a denied write is 403 with a VALID body (never 400), and changes nothing; PUT and POST both ask update", async () => {
      denied.add("resource_search_property:update");
      for (const method of ["PUT", "POST"] as const) {
        const res = await app.inject({ method, url: `${base()}/interest-rules`, headers: asUser(u), payload: validRules });
        expect(res.statusCode, method).toBe(403);
      }
      expect(await q(`SELECT 1 FROM search_interest_rules WHERE property_id = $1`, [propA])).toHaveLength(0);
    });
    it("authorize comes BEFORE validate: an invalid body from a denied caller is still 403; from an allowed one it is 400", async () => {
      denied.add("resource_search_property:update");
      const denied403 = await app.inject({ method: "PUT", url: `${base()}/interest-rules`, headers: asUser(u), payload: { rules: "nope" } });
      expect(denied403.statusCode).toBe(403);
      denied.clear();
      const bad400 = await app.inject({ method: "PUT", url: `${base()}/interest-rules`, headers: asUser(u), payload: { rules: "nope" } });
      expect(bad400.statusCode).toBe(400);
      expect(bad400.json()).toMatchObject({ reason: "rules_invalid" });
      denied.add("resource_search_property:read_visitors");
      expect((await get(`${base()}?minScore=999`)).statusCode).toBe(403);
      denied.clear();
      expect((await get(`${base()}?minScore=999`)).json()).toMatchObject({ reason: "min_score_invalid" });
    });
  });

  // ── 403 and 404 are distinct ────────────────────────────────────────────────────────────────────────────────────
  describe("403 vs 404", () => {
    it("another company's property under my tenant path is 404 (and the same id under its own tenant works)", async () => {
      const res = await get(`/api/${A}/modules/search/properties/${propB}/visitors`);
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("property not found"); // http-error.filter renders every HttpException as { error }
    });
    it("an unknown visitor on my property is 404 with its own reason; another property's visitor is 404 too", async () => {
      const unknown = await get(`${base()}/${newId()}`);
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json()).toMatchObject({ reason: "visitor_not_found" });
      const crossProperty = await get(`${base()}/${v.other.visitor}`);
      expect(crossProperty.statusCode).toBe(404);
    });
    it("a malformed id is 400, after authorization", async () => {
      expect((await get(`${base()}/not-a-uuid`)).statusCode).toBe(400);
      denied.add("resource_search_property:read_visitors");
      expect((await get(`${base()}/not-a-uuid`)).statusCode).toBe(403);
    });
    it("every route 404s an unknown property for an allowed caller", async () => {
      const nope = `/api/${A}/modules/search/properties/${newId()}/visitors`;
      for (const path of ["", "/status", "/interest-rules", "/filter/0/score", `/${newId()}`]) expect((await get(`${nope}${path}`)).statusCode, path).toBe(404);
      const put = await app.inject({ method: "PUT", url: `${nope}/interest-rules`, headers: asUser(u), payload: { rules: [] } });
      expect(put.statusCode).toBe(404);
    });
  });

  // ── list ────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("list", () => {
    it("keeps server order (score desc, then newest) and never leaks another company's visitor", async () => {
      const res = await get(base());
      const ids = (res.json().visitors as Array<{ visitorId: string }>).map((x) => x.visitorId);
      expect(ids).toEqual([v.hi.visitor, v.midNew.visitor, v.midOld.visitor]);
      expect(ids).not.toContain(v.other.visitor);
      const recent = await get(`${base()}?order=recent`);
      expect((recent.json().visitors as Array<{ visitorId: string }>).map((x) => x.visitorId)).toEqual([v.hi.visitor, v.midNew.visitor, v.midOld.visitor]);
    });
    it("pages by cursor with no gap or repeat across equal scores", async () => {
      const one = (await get(`${base()}?limit=1`)).json();
      const two = (await get(`${base()}?limit=1&cursor=${one.nextCursor}`)).json();
      const three = (await get(`${base()}?limit=1&cursor=${two.nextCursor}`)).json();
      expect([one, two, three].map((p) => p.visitors[0].visitorId)).toEqual([v.hi.visitor, v.midNew.visitor, v.midOld.visitor]);
      expect(three.nextCursor).toBeNull();
    });
    it("filters: minScore, facet and tag, hasLead, seenFrom; the path twin answers the same", async () => {
      const ids = async (qs: string) => ((await get(`${base()}${qs}`)).json().visitors as Array<{ visitorId: string }>).map((x) => x.visitorId);
      expect(await ids("?minScore=50")).toEqual([v.hi.visitor]);
      expect(await ids("?facet=industry&tag=dental")).toEqual([v.hi.visitor]);
      expect(await ids("?tag=seo")).toEqual([v.midNew.visitor]);
      expect(await ids("?facet=service")).toEqual([v.hi.visitor, v.midNew.visitor]);
      expect(await ids("?hasLead=true")).toEqual([v.hi.visitor, v.midNew.visitor]);
      expect(await ids("?hasLead=false")).toEqual([v.midOld.visitor]);
      expect(await ids("?seenFrom=2026-10-10")).toEqual([v.hi.visitor, v.midNew.visitor]);
      const twin = (await get(`${base()}/filter/50/score`)).json();
      expect(twin.visitors.map((x: { visitorId: string }) => x.visitorId)).toEqual([v.hi.visitor]);
    });
  });

  // ── the lead link ───────────────────────────────────────────────────────────────────────────────────────────────
  describe("the lead link", () => {
    it("detail returns the lead id only for a principal who may read that agency_lead, and probes read on the agency_lead kind", async () => {
      const res = await get(`${base()}/${v.hi.visitor}`);
      expect(res.json().visitor.lead).toEqual({ state: "readable", id: leadOpen });
      expect(calls.some((c) => c.kind === "agency_lead" && c.action === "read" && c.id === leadOpen && c.tenantId === A)).toBe(true);
    });
    it("list rows say only linked or none: never a lead id, and agency_lead is never probed", async () => {
      calls.length = 0;
      const res = await get(base());
      const list = res.json().visitors as Array<{ visitorId: string; lead: unknown }>;
      expect(list.find((x) => x.visitorId === v.hi.visitor)!.lead).toEqual({ state: "linked" });
      expect(list.find((x) => x.visitorId === v.midNew.visitor)!.lead).toEqual({ state: "linked" });
      expect(list.find((x) => x.visitorId === v.midOld.visitor)!.lead).toEqual({ state: "none" });
      expect(res.body).not.toContain(leadOpen);
      expect(res.body).not.toContain(leadOnly);
      expect(calls.filter((c) => c.kind === "agency_lead")).toHaveLength(0);
    });
    it("a reader of visitors who may NOT read leads gets words on detail, and the lead id appears nowhere", async () => {
      denied.add("agency_lead:read");
      const res = await get(`${base()}/${v.hi.visitor}`);
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain(leadOpen);
      expect(res.body).toContain("a lead you cannot open");
      expect(res.json().visitor.lead).toEqual({ state: "restricted", message: "a lead you cannot open" });
      const list = await get(base());
      expect(list.statusCode).toBe(200);
      expect(list.body).not.toContain(leadOpen);
    });
    it("a lead of another company never links", async () => {
      // A lead in B carrying A's consent id must not surface in A.
      const stray = newId();
      await withTenants([B], (c) => c.query(
        `INSERT INTO agency_leads (id, tenant_id, org_name, contact_name, source, status, stage, owner_id, origin_site, visitor_consent)
         VALUES ($1,$2,'Stray','x','web','in_review','enquiry',$4,'test',$3)`,
        [stray, B, JSON.stringify({ consentId: v.midOld.consent }), u],
      ));
      const res = await get(`${base()}/${v.midOld.visitor}`);
      expect(res.json().visitor.lead).toEqual({ state: "none" });
      expect(res.body).not.toContain(stray);
    });
  });

  // ── detail ──────────────────────────────────────────────────────────────────────────────────────────────────────
  it("detail: summary, the latest 200 events (newest first, truncation said), interests and score parts with their maxima", async () => {
    const d = (await get(`${base()}/${v.hi.visitor}`)).json().visitor;
    expect(d).toMatchObject({ visitorId: v.hi.visitor, score: 80, visits: 2, country: "ID", city: "Denpasar", eventsTruncated: true });
    expect(d.events).toHaveLength(200);
    const times = d.events.map((e: { occurredAt: string }) => Date.parse(e.occurredAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(d.interests.industry[0].tag).toBe("dental");
    expect(d.scoreParts).toEqual({ recency: 25, frequency: 5, depth: 0, intent: 0 });
    expect(d.scoreMax).toEqual({ recency: 25, frequency: 15, depth: 30, intent: 30 });
  });

  // ── interest rules ──────────────────────────────────────────────────────────────────────────────────────────────
  describe("interest rules", () => {
    const r1 = { match: "path_prefix", pattern: "/services/web/", facet: "service", tag: "web-design", weight: 5 };
    const r2 = { match: "section_prefix", pattern: "dental.", facet: "industry", tag: "dental", weight: 7 };
    it("PUT replaces the whole set (a rule left out is removed, a weight change is an update); POST is the same handler for the hub; GET reads back", async () => {
      expect((await get(`${base()}/interest-rules`)).json()).toMatchObject({ rules: [], note: expect.stringContaining("No rules") });
      const put = await app.inject({ method: "PUT", url: `${base()}/interest-rules`, headers: asUser(u), payload: { rules: [r1, r2] } });
      expect(put.statusCode, put.body).toBe(200);
      expect(put.json().rules).toHaveLength(2);
      const post = await app.inject({ method: "POST", url: `${base()}/interest-rules`, headers: asUser(u), payload: { rules: [{ ...r1, weight: 9 }] } });
      expect(post.statusCode, post.body).toBe(200);
      expect(post.json()).toMatchObject({ removed: 1 });
      const back = (await get(`${base()}/interest-rules`)).json().rules;
      expect(back).toMatchObject([{ ...r1, weight: 9 }]);
      expect(back[0].id).toBe(put.json().rules.find((x: { pattern: string }) => x.pattern === r1.pattern).id); // updated in place, not re-created
      const act = await q(`SELECT 1 FROM activities WHERE tenant_id = $1 AND target_entity_type = 'search_interest_rules'`, [A]);
      expect(act.length).toBeGreaterThanOrEqual(2);
      await app.inject({ method: "PUT", url: `${base()}/interest-rules`, headers: asUser(u), payload: { rules: [] } });
      expect((await get(`${base()}/interest-rules`)).json().rules).toEqual([]);
    });
    it("a write addressed to another company's property is 404 and changes nothing there", async () => {
      const res = await app.inject({ method: "PUT", url: `/api/${A}/modules/search/properties/${propB}/visitors/interest-rules`, headers: asUser(u), payload: { rules: [r2] } });
      expect(res.statusCode).toBe(404);
      expect(await q(`SELECT 1 FROM search_interest_rules WHERE property_id = $1`, [propB])).toHaveLength(0);
    });
  });

  // ── status: three non-ok states in words, never an empty list ───────────────────────────────────────────────────
  describe("status", () => {
    const keys = () => {
      process.env.INSIGHTS_BASE_URL = "http://127.0.0.1:9";
      process.env.INSIGHTS_READ_KEY = "rk";
      process.env.INSIGHTS_FORGET_KEY = "fk";
      process.env.SEARCH_VISITORS_TIMEOUT_MS = "1500";
    };
    it("not configured: says so in words", async () => {
      const s = (await get(`${base()}/status`)).json();
      expect(s).toMatchObject({ state: "not_configured", configured: false, bots: null });
      expect(s.message).toMatch(/not set up/i);
    });
    it("disabled: configured but SEARCH_VISITORS_ENABLED is not 1", async () => {
      keys();
      const s = (await get(`${base()}/status`)).json();
      expect(s).toMatchObject({ state: "disabled", configured: true, enabled: false, bots: null });
      expect(s.message).toMatch(/switched off/i);
    });
    it("unreachable: enabled and configured but the collector does not answer", async () => {
      keys();
      process.env.SEARCH_VISITORS_ENABLED = "1";
      const s = (await get(`${base()}/status`)).json();
      expect(s).toMatchObject({ state: "unreachable", configured: true, enabled: true, bots: null });
      expect(s.message).toMatch(/could not be reached/i);
    });
    it("a property with no collector website says so; the last ok ingest is shown whatever the state", async () => {
      keys();
      process.env.SEARCH_VISITORS_ENABLED = "1";
      await q(`INSERT INTO search_visitor_ingest_state (tenant_id, property_id, last_run_at, last_ok_at, last_outcome) VALUES ($1,$2,now(),now(),'ok')
               ON CONFLICT (property_id) DO NOTHING`, [A, propNoSite]);
      const res = await get(`/api/${A}/modules/search/properties/${propNoSite}/visitors/status`);
      expect(res.json()).toMatchObject({ state: "no_website", lastOutcome: "ok" });
      expect(res.json().lastOkIngestAt).toEqual(expect.any(String));
    });
    it("ok: bot counts for the last 30 days from the collector (fake transport)", async () => {
      keys();
      process.env.SEARCH_VISITORS_ENABLED = "1";
      const fetchImpl = (async () => new Response(JSON.stringify({ website: WEBSITE, from: "a", to: "b", days: [{ day: "2026-10-12", reason: "ua", count: 6 }] }))) as unknown as typeof fetch;
      const s = await buildVisitorStatus(A, propA, { insights: { fetchImpl } });
      expect(s).toMatchObject({ state: "ok", configured: true, enabled: true, bots: { total: 6, byReason: { ua: 6 }, days: 30 } });
      const rejected = (async () => new Response("{}", { status: 403 })) as unknown as typeof fetch;
      expect(await buildVisitorStatus(A, propA, { insights: { fetchImpl: rejected } })).toMatchObject({ state: "rejected" });
    });
  });
});
