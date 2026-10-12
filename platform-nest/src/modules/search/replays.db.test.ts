// M5-V6-b — the recording routes against REAL Postgres and the real HTTP layer, with a FAKE collector behind a stubbed fetch. Needs
// DATABASE_URL_TEST: the Linux gate. NOT run on the dev laptop (owner order 2026-10-12: no local Docker); skipped without it.
//
// Acceptance (design 2026-10-12 §8 V6-b):
//   * denial with VALID ids and `from` (403, no collector call, no activity row) plus a positive control (200);
//   * authorize BEFORE validate; 403 and 404 are distinct; a recording of a visitor with no live profile is the same 404 as an unknown one;
//   * one activity row per opening, with no content (and no visitor or consent id);
//   * a withdrawn visitor's recording is not listed, not streamable, and is forgotten at the collector by the REAL sweep;
//   * a collector that cannot answer is a typed 503 in words, never an empty list;
//   * the list is metadata only; there is no download route.
// Authorization uses the recording Cerbos double (as visitors.db.test.ts does): what is asserted is WHICH kind/action each route asks for.
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
import type { InsightsSettings } from "./insights-client";
import type { ConsentReader, ConsentStatusEntry } from "./visitor-consent-client";
import { clearPendingForgetsForTests, sweepProperty, type PropRef } from "./visitor-jobs";

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
const WEBSITE = "44444444-4444-4444-8444-444444444444";
const SECRET = "EVENT-CONTENT-MUST-NOT-LEAK-IN-A-LIST";
const INS: InsightsSettings = { baseUrl: "http://collector.test", readKey: "read-key-0123456789", forgetKey: "forget-key-0123456789", timeoutMs: 2000 };
const ENV_KEYS = ["INSIGHTS_BASE_URL", "INSIGHTS_READ_KEY", "INSIGHTS_FORGET_KEY", "SEARCH_VISITORS_TIMEOUT_MS"] as const;
const realFetch = globalThis.fetch;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// ── fake collector (sessions, chunks, forget) ────────────────────────────────────────────────────────────────────
interface Rec { website: string; id: string; visitorId: string; consentId: string; chunks: number }
class FakeCollector {
  recs: Rec[] = [];
  down = false;
  status: number | null = null;
  requests: Array<{ path: string; params: Record<string, string>; auth: string }> = [];
  forgets: Array<{ website: string; visitorIds: string[]; consentIds: string[]; mode: string }> = [];
  reset() { this.recs = []; this.down = false; this.status = null; this.requests = []; this.forgets = []; }
  add(visitorId: string, consentId: string, chunks = 3, website = WEBSITE): string {
    const id = newId();
    this.recs.push({ website, id, visitorId, consentId, chunks });
    return id;
  }
  count(path: string) { return this.requests.filter((r) => r.path === path).length; }
  fetchImpl = (async (input: string, init: RequestInit) => {
    const u = new URL(input);
    const auth = (init.headers as Record<string, string>).Authorization;
    const params = Object.fromEntries(u.searchParams);
    this.requests.push({ path: u.pathname, params, auth });
    if (this.down) throw new TypeError("fetch failed");
    if (this.status !== null) return json(this.status, { error: "forced" });
    if (u.pathname === "/ops/v1/replay/sessions") {
      if (auth !== `Bearer ${INS.readKey}`) return json(401, { error: "unauthorized" });
      const rows = this.recs.filter((r) => r.website === params.website && r.visitorId === params.visitorId);
      return json(200, {
        website: params.website, visitorId: params.visitorId,
        sessions: rows.map((r) => ({
          id: r.id, consentId: r.consentId, startedAt: "2026-10-12T10:00:00Z", lastChunkAt: "2026-10-12T10:03:00Z", durationSeconds: 180,
          chunks: r.chunks, bytes: 999, pages: ["https://visitors.example/services/"],
        })),
      });
    }
    if (u.pathname === "/ops/v1/replay/chunks") {
      if (auth !== `Bearer ${INS.readKey}`) return json(401, { error: "unauthorized" });
      const r = this.recs.find((x) => x.website === params.website && x.id === params.recording);
      if (!r) return json(404, { error: "unknown-recording" });
      const after = Number(params.after ?? -1);
      const limit = Number(params.limit ?? 20);
      const seqs = Array.from({ length: r.chunks }, (_, i) => i).filter((s) => s > after);
      const page = seqs.slice(0, limit);
      return json(200, {
        website: r.website, recording: r.id, visitorId: r.visitorId, consentId: r.consentId,
        chunks: page.map((s) => ({ seq: s, receivedAt: "2026-10-12T10:00:00Z", bytes: 10, events: [{ type: 3, data: { note: SECRET, seq: s } }] })),
        next: page.length ? page[page.length - 1]! : after, more: seqs.length > limit,
      });
    }
    if (u.pathname === "/ops/v1/forget") {
      if (auth !== `Bearer ${INS.forgetKey}`) return json(403, { error: "forbidden" });
      const b = JSON.parse(String(init.body)) as { website: string; visitorIds: string[]; consentIds: string[]; mode: string };
      this.forgets.push(b);
      const before = this.recs.length;
      this.recs = this.recs.filter((r) => !(r.website === b.website && (b.visitorIds.includes(r.visitorId) || b.consentIds.includes(r.consentId))));
      return json(200, { website: b.website, mode: b.mode, deleted: { events: 0, recordings: before - this.recs.length }, tombstoned: { visitors: b.visitorIds.length, consents: b.consentIds.length } });
    }
    return json(404, { error: "not-found" });
  }) as unknown as typeof fetch;
}

/** WebDesk's consent.status: the consent ids in `withdrawn` answer analytics:false, every other id analytics:true. */
class FakeConsent implements ConsentReader {
  withdrawn = new Set<string>();
  async resolveSiteSlug(): Promise<string> { return "site-a"; }
  async statuses(_company: string, _site: string, ids: readonly string[]): Promise<Map<string, ConsentStatusEntry>> {
    const out = new Map<string, ConsentStatusEntry>();
    for (const id of ids) out.set(id, { consentId: id, analytics: !this.withdrawn.has(id), marketing: false, action: this.withdrawn.has(id) ? "withdraw" : "accept", noticeVersion: "3", recordedAt: new Date().toISOString() });
    return out;
  }
}

describe.skipIf(!TEST_URL)("M5-V6-b · session recording routes", () => {
  let app: NestFastifyApplication;
  let A: string;
  let B: string;
  let u: string;
  let propA: string;
  let propB: string;
  let propNoSite: string;
  const live = { visitor: "", consent: "" };
  const wd = { visitor: "", consent: "" };
  const other = { visitor: "", consent: "" };
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
  const coll = new FakeCollector();

  const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => adminPool().query(sql, params).then((r) => r.rows as T[]);
  const base = () => `/api/${A}/modules/search/properties/${propA}`;
  const listUrl = (visitor: string) => `${base()}/visitors/${visitor}/recordings`;
  const chunksUrl = (rec: string, from?: string) => `${base()}/recordings/${rec}/chunks${from === undefined ? "" : `?from=${from}`}`;
  const get = (url: string, user = u) => app.inject({ method: "GET", url, headers: asUser(user) });
  const openings = (rec: string) => q<{ actor_id: string; verb: string; target_entity_type: string; target_entity_id: string; metadata: Record<string, unknown> }>(
    `SELECT actor_id, verb, target_entity_type, target_entity_id, metadata FROM activities WHERE tenant_id = $1 AND target_entity_type = 'search_replay_recording' AND target_entity_id = $2`, [A, rec]);

  async function profile(tenant: string, prop: string, who: { visitor: string; consent: string }) {
    who.visitor = newId(); who.consent = newId();
    await q(
      `INSERT INTO search_visitor_profiles (id, tenant_id, property_id, visitor_id, consent_id, first_seen_at, last_seen_at, visits, pageviews, device, country, city,
                                            interests, score, score_parts)
       VALUES ($1,$2,$3,$4,$5,now(),now(),2,3,'desktop','ID','Denpasar','{}',10,$6)`,
      [newId(), tenant, prop, who.visitor, who.consent, JSON.stringify({ recency: 10, frequency: 0, depth: 0, intent: 0 })],
    );
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    registerModule(searchModule);
    await syncMetricDefinitions();
    A = await createCompany("V6b Co A", ["search"]);
    B = await createCompany("V6b Co B", ["search"]);
    u = await createUser("v6b-a@a.test");
    await addMembership(A, u);
    const clientA = await createClient(A, "V6b Client A");
    const clientB = await createClient(B, "V6b Client B");
    app = await buildApp();
    const mkProp = async (tenant: string, client: string, domain: string, site: string | null): Promise<string> => {
      const id = newId();
      await withTenants([tenant], (c) => c.query(
        `INSERT INTO search_properties (id, tenant_id, client_id, domain, site_url, verified_at, umami_site_id) VALUES ($1,$2,$3,$4,$5,now(),$6)`,
        [id, tenant, client, domain, `https://${domain}`, site]), S);
      return id;
    };
    propA = await mkProp(A, clientA, "v6b-a.example.com", WEBSITE);
    propNoSite = await mkProp(A, clientA, "v6b-nosite.example.com", null);
    propB = await mkProp(B, clientB, "v6b-b.example.com", WEBSITE); // the SAME collector website id: the profile check, not the website, is the wall
    await profile(A, propA, live);
    await profile(A, propA, wd);
    await profile(B, propB, other);
  }, 120000);

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  beforeEach(() => {
    calls.length = 0;
    denied.clear();
    coll.reset();
    clearPendingForgetsForTests();
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    process.env.INSIGHTS_BASE_URL = INS.baseUrl;
    process.env.INSIGHTS_READ_KEY = INS.readKey;
    process.env.INSIGHTS_FORGET_KEY = INS.forgetKey;
    // Only the collector is faked; any other request keeps the real fetch.
    vi.stubGlobal("fetch", ((input: string, init: RequestInit) => (String(input).startsWith(INS.baseUrl) ? coll.fetchImpl(input, init) : realFetch(input, init))) as unknown as typeof fetch);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  });

  // ── authorization ──────────────────────────────────────────────────────────────────────────────────────────────
  describe("authorization (view_replay; authorize before validate)", () => {
    it("positive control: both routes ask view_replay on the property kind, with module search and the tenant, and answer 200", async () => {
      const rec = coll.add(live.visitor, live.consent);
      for (const url of [listUrl(live.visitor), chunksUrl(rec), chunksUrl(rec, "1")]) {
        calls.length = 0;
        const res = await get(url);
        expect(res.statusCode, `${url}: ${res.body}`).toBe(200);
        expect(calls[0]).toMatchObject({ kind: "resource_search_property", action: "view_replay", id: propA, tenantId: A });
      }
    });
    it("denial with VALID ids and a valid `from` is 403 on both routes: no collector call, no activity row", async () => {
      const rec = coll.add(live.visitor, live.consent);
      denied.add("resource_search_property:view_replay");
      for (const url of [listUrl(live.visitor), chunksUrl(rec), chunksUrl(rec, "0"), chunksUrl(rec, "2")]) {
        const res = await get(url);
        expect(res.statusCode, url).toBe(403);
        expect(res.body).not.toContain(SECRET);
      }
      expect(coll.requests).toHaveLength(0);
      expect(await openings(rec)).toHaveLength(0);
    });
    it("read_visitors is NOT enough: a caller denied only view_replay never reaches a recording", async () => {
      const rec = coll.add(live.visitor, live.consent);
      denied.add("resource_search_property:view_replay"); // the double allows read_visitors; only the replay action is withheld
      expect((await get(chunksUrl(rec))).statusCode).toBe(403);
      expect(calls.every((c) => c.action === "view_replay")).toBe(true);
    });
    it("authorize comes BEFORE validate: a bad id or `from` from a denied caller is 403; from an allowed one it is 400 with a reason", async () => {
      denied.add("resource_search_property:view_replay");
      expect((await get(listUrl("not-a-uuid"))).statusCode).toBe(403);
      expect((await get(chunksUrl(newId(), "abc"))).statusCode).toBe(403);
      expect((await get(chunksUrl("nope"))).statusCode).toBe(403);
      denied.clear();
      expect((await get(listUrl("not-a-uuid"))).json()).toMatchObject({ reason: "visitor_id_invalid" });
      expect((await get(chunksUrl(newId(), "abc"))).json()).toMatchObject({ reason: "from_invalid" });
      expect((await get(chunksUrl(newId(), "-1"))).statusCode).toBe(400);
      expect((await get(chunksUrl("nope"))).json()).toMatchObject({ reason: "recording_id_invalid" });
    });
  });

  // ── 403 vs 404 ─────────────────────────────────────────────────────────────────────────────────────────────────
  describe("403 vs 404", () => {
    it("another company's property under my tenant path is 404 on both routes (and an unknown property too)", async () => {
      const rec = coll.add(other.visitor, other.consent);
      for (const prop of [propB, newId()]) {
        const l = await get(`/api/${A}/modules/search/properties/${prop}/visitors/${other.visitor}/recordings`);
        const c = await get(`/api/${A}/modules/search/properties/${prop}/recordings/${rec}/chunks`);
        expect([l.statusCode, c.statusCode]).toEqual([404, 404]);
        expect(c.body).not.toContain(SECRET);
      }
      expect(coll.requests).toHaveLength(0); // an invisible property never reaches the collector
    });
    it("an unknown visitor, another property's visitor and a visitor with no live profile are 404 on the list, with a reason", async () => {
      for (const v of [newId(), other.visitor]) {
        const res = await get(listUrl(v));
        expect(res.statusCode).toBe(404);
        expect(res.json()).toMatchObject({ reason: "visitor_not_found" });
      }
    });
    it("an unknown recording, another company's visitor's recording and an orphan recording are the SAME 404 on chunks (no oracle), and no content leaves", async () => {
      const orphan = coll.add(newId(), newId()); // a visitor the ERP has no profile for (never consented, erased, ...)
      const foreign = coll.add(other.visitor, other.consent); // the collector holds it under the shared website id; the ERP knows it only as B's
      const bodies: unknown[] = [];
      for (const rec of [newId(), orphan, foreign]) {
        const res = await get(chunksUrl(rec));
        expect(res.statusCode, rec).toBe(404);
        expect(res.body).not.toContain(SECRET);
        bodies.push(res.json());
      }
      expect(bodies[0]).toEqual(bodies[1]);
      expect(bodies[1]).toEqual(bodies[2]);
      expect(bodies[0]).toMatchObject({ reason: "recording_not_found" });
      expect(await openings(orphan)).toHaveLength(0);
      expect(await openings(foreign)).toHaveLength(0);
    });
    it("a recording whose consent id is not the profile's is not streamable either (the pair is the proof)", async () => {
      const rec = coll.add(live.visitor, newId());
      const res = await get(chunksUrl(rec));
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain(SECRET);
      expect(await openings(rec)).toHaveLength(0);
    });
  });

  // ── the list: metadata only ────────────────────────────────────────────────────────────────────────────────────
  describe("list", () => {
    it("is METADATA ONLY: recording id, times, length, pages, chunk count; no content, no consent id, no byte size", async () => {
      const rec = coll.add(live.visitor, live.consent, 7);
      const res = await get(listUrl(live.visitor));
      expect(res.statusCode).toBe(200);
      const body = res.json() as { propertyId: string; visitorId: string; recordings: Array<Record<string, unknown>> };
      expect(body).toMatchObject({ propertyId: propA, visitorId: live.visitor });
      expect(body.recordings).toEqual([{
        recordingId: rec, startedAt: "2026-10-12T10:00:00Z", lastChunkAt: "2026-10-12T10:03:00Z", durationSeconds: 180, pages: ["https://visitors.example/services/"], chunks: 7,
      }]);
      expect(res.body).not.toContain(SECRET);
      expect(res.body).not.toContain(live.consent);
      expect(res.body).not.toContain("events");
      expect(res.body).not.toContain("bytes");
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(await openings(rec)).toHaveLength(0); // a list is not an opening
      expect(coll.count("/ops/v1/replay/chunks")).toBe(0); // and never touches content
      expect(coll.requests[0]!.auth).toBe(`Bearer ${INS.readKey}`);
    });
    it("a visitor with a live profile and no recordings is an empty list, said as such (the collector answered)", async () => {
      const res = await get(listUrl(live.visitor));
      expect(res.statusCode).toBe(200);
      expect(res.json().recordings).toEqual([]);
    });
    it("a recording filed under a live visitor with ANOTHER consent id is hidden and forgotten by consent id (never by visitor id)", async () => {
      const mine = coll.add(live.visitor, live.consent);
      const strayConsent = newId();
      const stray = coll.add(live.visitor, strayConsent);
      const res = await get(listUrl(live.visitor));
      expect(res.json().recordings.map((r: { recordingId: string }) => r.recordingId)).toEqual([mine]);
      expect(coll.forgets).toHaveLength(1);
      expect(coll.forgets[0]).toMatchObject({ website: WEBSITE, visitorIds: [], consentIds: [strayConsent], mode: "withdraw" });
      expect(coll.recs.map((r) => r.id)).toEqual([mine]);
      expect(coll.recs.some((r) => r.id === stray)).toBe(false);
    });
  });

  // ── chunks and the activity row ────────────────────────────────────────────────────────────────────────────────
  describe("chunks", () => {
    it("pages the content (20 a page) with nextFrom; an opening writes ONE activity row, a later page none", async () => {
      const rec = coll.add(live.visitor, live.consent, 25);
      const first = await get(chunksUrl(rec));
      expect(first.statusCode, first.body).toBe(200);
      const p1 = first.json();
      expect(p1).toMatchObject({ propertyId: propA, recordingId: rec, from: 0, more: true, nextFrom: 20, opened: true });
      expect(p1.chunks.map((c: { seq: number }) => c.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i));
      expect(p1.chunks[0].events[0].data.note).toBe(SECRET); // the content is returned to an authorized viewer
      expect(first.headers["cache-control"]).toBe("no-store");
      expect(await openings(rec)).toHaveLength(1);

      const second = (await get(chunksUrl(rec, String(p1.nextFrom)))).json();
      expect(second).toMatchObject({ from: 20, more: false, nextFrom: null, opened: false });
      expect(second.chunks.map((c: { seq: number }) => c.seq)).toEqual([20, 21, 22, 23, 24]);
      expect(await openings(rec)).toHaveLength(1); // still one: paging is not another opening
    });
    it("the collector is asked for `after = from - 1`, so `from` is the first seq returned (no off-by-one, chunk 0 is not skipped)", async () => {
      const rec = coll.add(live.visitor, live.consent, 6);
      await get(chunksUrl(rec, "3"));
      await get(chunksUrl(rec, "0"));
      await get(chunksUrl(rec));
      const afters = coll.requests.filter((r) => r.path === "/ops/v1/replay/chunks").map((r) => r.params.after);
      expect(afters).toEqual(["2", "-1", "-1"]);
    });
    it("`from` absent and `from=0` are each an opening: one row each, and each row says who, which recording and which property, with no content", async () => {
      const rec = coll.add(live.visitor, live.consent, 2);
      await get(chunksUrl(rec));
      await get(chunksUrl(rec, "0"));
      const rows = await openings(rec);
      expect(rows).toHaveLength(2);
      for (const r of rows) {
        expect(r).toMatchObject({ actor_id: u, verb: "opened", target_entity_type: "search_replay_recording", target_entity_id: rec });
        expect(Object.keys(r.metadata).sort()).toEqual(["propertyId", "recordingId"]);
        expect(r.metadata).toMatchObject({ propertyId: propA, recordingId: rec });
        const text = JSON.stringify(r);
        expect(text).not.toContain(SECRET);
        expect(text).not.toContain(live.visitor);
        expect(text).not.toContain(live.consent);
        expect(text).not.toContain("events");
      }
    });
    it("a refused request (404, 503, 400) writes no activity row", async () => {
      const rec = coll.add(live.visitor, live.consent);
      coll.down = true;
      expect((await get(chunksUrl(rec))).statusCode).toBe(503);
      coll.down = false;
      expect((await get(chunksUrl(rec, "abc"))).statusCode).toBe(400);
      expect((await get(chunksUrl(newId()))).statusCode).toBe(404);
      expect(await openings(rec)).toHaveLength(0);
    });
    it("there is no download route, and no content-disposition on the stream", async () => {
      const rec = coll.add(live.visitor, live.consent);
      for (const url of [`${base()}/recordings/${rec}/download`, `${base()}/recordings/${rec}`, `${base()}/recordings/${rec}/chunks/download`, `${base()}/recordings`]) {
        expect((await get(url)).statusCode, url).toBe(404);
      }
      for (const method of ["POST", "PUT", "DELETE"] as const) {
        const res = await app.inject({ method, url: chunksUrl(rec), headers: asUser(u), payload: {} });
        expect(res.statusCode, method).toBe(404);
      }
      expect((await get(chunksUrl(rec))).headers["content-disposition"]).toBeUndefined();
    });
  });

  // ── withdrawn visitors ─────────────────────────────────────────────────────────────────────────────────────────
  describe("a withdrawn visitor's recording", () => {
    it("is forgotten at the collector by the real sweep, and is then neither listed nor streamable", async () => {
      const recWd = coll.add(wd.visitor, wd.consent, 4);
      const recLive = coll.add(live.visitor, live.consent, 4);
      expect((await get(listUrl(wd.visitor))).json().recordings).toHaveLength(1); // before the sweep the profile is still live

      const consent = new FakeConsent();
      consent.withdrawn.add(wd.consent);
      const prop: PropRef = { tenantId: A, propertyId: propA, domain: "v6b-a.example.com", website: WEBSITE };
      const r = await sweepProperty(prop, { insights: { settings: INS, fetchImpl: coll.fetchImpl }, consent, now: () => new Date(), sweepLockWaitMs: 20000 });
      expect(r).toMatchObject({ outcome: "ok", withdrawnProfiles: 1 });

      expect(coll.forgets.some((f) => f.visitorIds.includes(wd.visitor))).toBe(true);
      expect(coll.recs.map((x) => x.id)).toEqual([recLive]); // the withdrawn visitor's recording is gone from the collector; the live one stays
      const list = await get(listUrl(wd.visitor));
      expect(list.statusCode).toBe(404);
      expect(list.json()).toMatchObject({ reason: "visitor_not_found" });
      const stream = await get(chunksUrl(recWd));
      expect(stream.statusCode).toBe(404);
      expect(stream.body).not.toContain(SECRET);
      expect((await get(chunksUrl(recLive))).statusCode).toBe(200); // the live visitor is untouched
    });
    it("is not released even in the window before the sweep forgets it: a recording whose profile is gone streams nothing", async () => {
      const ghost = { visitor: newId(), consent: newId() };
      const rec = coll.add(ghost.visitor, ghost.consent); // the collector still holds it; the ERP has no profile (withdrawn / erased / purged)
      const res = await get(chunksUrl(rec));
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain(SECRET);
      expect((await get(listUrl(ghost.visitor))).statusCode).toBe(404);
      expect(await openings(rec)).toHaveLength(0);
    });
  });

  // ── the collector cannot answer: words, never an empty list ────────────────────────────────────────────────────
  describe("collector unavailable", () => {
    const expectWords = (res: { statusCode: number; json: () => Record<string, unknown>; body: string }, reason: string) => {
      expect(res.statusCode).toBe(503);
      const b = res.json();
      expect(b.reason).toBe(reason);
      expect(String(b.error).length).toBeGreaterThan(40);
      expect(b).not.toHaveProperty("recordings");
      expect(b).not.toHaveProperty("chunks");
      expect(res.body).not.toContain(INS.readKey);
      expect(res.body).not.toContain(INS.baseUrl);
    };
    it("unreachable: a typed 503 on both routes, in words", async () => {
      const rec = coll.add(live.visitor, live.consent);
      coll.down = true;
      const l = await get(listUrl(live.visitor));
      expectWords(l, "collector_unreachable");
      expect(l.json().error).toMatch(/not an empty list/);
      expectWords(await get(chunksUrl(rec)), "collector_unreachable");
    });
    it("a 5xx from the gate is the same 503; a refused key is its own typed 503", async () => {
      coll.status = 502;
      expectWords(await get(listUrl(live.visitor)), "collector_unreachable");
      coll.status = 403;
      expectWords(await get(listUrl(live.visitor)), "collector_rejected");
    });
    it("not configured (a key missing) is a typed 503, and the collector is never called", async () => {
      delete process.env.INSIGHTS_READ_KEY;
      expectWords(await get(listUrl(live.visitor)), "not_configured");
      expectWords(await get(chunksUrl(newId())), "not_configured");
      expect(coll.requests).toHaveLength(0);
    });
    it("a property with no collector website is a typed 503 (for a visitor that has a profile)", async () => {
      const lonely = { visitor: "", consent: "" };
      await profile(A, propNoSite, lonely);
      const res = await get(`/api/${A}/modules/search/properties/${propNoSite}/visitors/${lonely.visitor}/recordings`);
      expectWords(res, "no_website");
    });
  });
});
