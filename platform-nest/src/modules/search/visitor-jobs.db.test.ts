// M5-V3-e — the visitor jobs against LIVE Postgres, with FAKES for both remotes (the collector's ops API behind a
// fake fetch, WebDesk's consent.status behind a fake ConsentReader). Needs DATABASE_URL_TEST (platform-nest/CLAUDE.md;
// skipped without it: NOT run on the dev laptop, runs on the Linux gate). initTestDb() repoints the app at a
// NOSUPERUSER NOBYPASSRLS role, so every read and write below is subject to FORCE RLS.
//
// Acceptance (design §8 V3-e): an absent consent id, or one whose LATEST record is `update analytics:false`, is never
// ingested and is forgotten; a sweep run while that visitor's pre-withdrawal events are being ingested leaves no
// profile (lock + tombstone); ingest re-checks the tombstones inside its writing transaction; a repeated batch changes
// nothing; the purge deletes only expired profiles; score parts sum to the score and no rules means no interests (as
// stored); a cross-tenant read returns nothing; a collector or WebDesk outage records a typed failure and writes
// nothing partial, in the direction stated in visitor-jobs.ts. (Flag/interval/no-timer cases: visitor-jobs.test.ts.)
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { newId, withTenants } from "../../db";
import { adminPool, initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createClient } from "../../testing/fixtures";
import type { InsightsSettings } from "./insights-client";
import { ConsentStatusError, type ConsentReader, type ConsentStatusEntry } from "./visitor-consent-client";
import {
  clearPendingForgetsForTests, idHash, ingestProperty, pendingForgetCount, purgeTenant, runVisitorIngest, runVisitorSweep,
  sweepProperty, withVisitorPropertyLock, type PropRef, type VisitorJobDeps,
} from "./visitor-jobs";

const S = { modules: ["search"] };
const NOW = new Date("2026-10-12T12:00:00Z");
const INS: InsightsSettings = { baseUrl: "http://collector.test", readKey: "read-key-0123456789", forgetKey: "forget-key-0123456789", timeoutMs: 2000 };
const WEB_A = "a0000000-0000-4000-8000-00000000000a";
const WEB_C = "c0000000-0000-4000-8000-00000000000c";
const DOMAIN_A = "visitors-a.example";
const DOMAIN_C = "visitors-c.example";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const uuid = () => newId();
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60000).toISOString();

// ── fake collector (ops API) ─────────────────────────────────────────────────────────────────────────────────────
interface BufRow { website: string; id: number; visitorId: string; consentId: string; kind: string; path: string; name: string | null; data: unknown; occurredAt: string }
class FakeCollector {
  rows: BufRow[] = [];
  seq = 100;
  down = false;
  forgetDown = false;
  ignoreAfter = false;
  forgets: Array<{ website: string; visitorIds: string[]; consentIds: string[]; mode: string }> = [];
  onForget: (() => Promise<void>) | null = null;
  reset() { this.rows = []; this.down = false; this.forgetDown = false; this.ignoreAfter = false; this.forgets = []; this.onForget = null; }
  add(website: string, visitorId: string, consentId: string, o: Partial<BufRow> = {}): number {
    const id = ++this.seq;
    this.rows.push({ website, id, visitorId, consentId, kind: "pageview", path: "/services/web/", name: null, data: null, occurredAt: minutesAgo(60), ...o });
    return id;
  }
  forgotVisitor(v: string) { return this.forgets.some((f) => f.visitorIds.includes(v)); }
  forgotConsent(c: string) { return this.forgets.some((f) => f.consentIds.includes(c)); }
  fetchImpl = (async (input: string, init: RequestInit) => {
    const u = new URL(input);
    const auth = (init.headers as Record<string, string>).Authorization;
    if (this.down) throw new TypeError("fetch failed");
    if (u.pathname === "/ops/v1/events") {
      if (auth !== `Bearer ${INS.readKey}`) return json(401, { error: "unauthorized" });
      const website = u.searchParams.get("website")!;
      const after = Number(u.searchParams.get("after") ?? 0);
      const limit = Number(u.searchParams.get("limit") ?? 1000);
      const list = this.rows.filter((r) => r.website === website && (this.ignoreAfter || r.id > after)).sort((a, b) => a.id - b.id).slice(0, limit);
      return json(200, {
        events: list.map((r) => ({
          id: r.id, visitorId: r.visitorId, consentId: r.consentId, receivedAt: r.occurredAt, occurredAt: r.occurredAt, kind: r.kind,
          path: r.path, name: r.name, data: r.data, device: "desktop", geo: { country: "ID", city: "Denpasar" }, network: { asn: 7713, name: "Telkom" }, company: null,
        })),
        next: list.length ? list[list.length - 1]!.id : after,
      });
    }
    if (u.pathname === "/ops/v1/forget") {
      if (auth !== `Bearer ${INS.forgetKey}`) return json(403, { error: "forbidden" });
      if (this.onForget) await this.onForget();
      if (this.forgetDown) throw new TypeError("fetch failed");
      const b = JSON.parse(String(init.body)) as { website: string; visitorIds: string[]; consentIds: string[]; mode: string };
      this.forgets.push(b);
      const before = this.rows.length;
      this.rows = this.rows.filter((r) => !(r.website === b.website && (b.visitorIds.includes(r.visitorId) || b.consentIds.includes(r.consentId))));
      return json(200, { website: b.website, mode: b.mode, deleted: { events: before - this.rows.length }, tombstoned: { visitors: b.visitorIds.length, consents: b.consentIds.length } });
    }
    return json(404, { error: "not-found" });
  }) as unknown as typeof fetch;
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// ── fake WebDesk consent.status (per site; the latest record per id) ───────────────────────────────────────────
class FakeConsent implements ConsentReader {
  bySite = new Map<string, Map<string, ConsentStatusEntry>>();
  down = false;
  calls = 0;
  gate: Promise<void> | null = null;
  onCall: (() => void) | null = null;
  constructor(private readonly domains: Record<string, string>) {}
  reset() { this.bySite.clear(); this.down = false; this.calls = 0; this.gate = null; this.onCall = null; }
  record(site: string, consentId: string, analytics: boolean, action: string) {
    const m = this.bySite.get(site) ?? new Map<string, ConsentStatusEntry>();
    m.set(consentId, { consentId, analytics, marketing: false, action, noticeVersion: "3", recordedAt: new Date().toISOString() });
    this.bySite.set(site, m);
  }
  async resolveSiteSlug(_companyId: string, domain: string): Promise<string> {
    if (this.down) throw new ConsentStatusError("unreachable", "WebDesk control channel failed");
    const slug = this.domains[domain];
    if (!slug) throw new ConsentStatusError("site_unresolved", "no site");
    return slug;
  }
  async statuses(_companyId: string, siteSlug: string, ids: readonly string[]): Promise<Map<string, ConsentStatusEntry>> {
    this.calls++;
    if (this.down) throw new ConsentStatusError("unreachable", "WebDesk control channel failed");
    // The answer is taken NOW (what WebDesk says at this instant); the gate then holds the caller, so a test can
    // change the log (a withdrawal) while the ERP is still working with this answer.
    const site = this.bySite.get(siteSlug) ?? new Map<string, ConsentStatusEntry>();
    const out = new Map<string, ConsentStatusEntry>();
    for (const id of ids) { const e = site.get(id); if (e) out.set(id, { ...e }); }
    this.onCall?.();
    if (this.gate) await this.gate;
    return out;
  }
}

describe.skipIf(!TEST_URL)("M5-V3-e · visitor jobs (ingest, sweep, purge) with fake remotes", () => {
  let A: string;
  let C: string;
  let propA: PropRef;
  let propC: PropRef;
  const coll = new FakeCollector();
  const consent = new FakeConsent({ [DOMAIN_A]: "site-a", [DOMAIN_C]: "site-c" });
  const deps = (o: Partial<VisitorJobDeps> = {}): VisitorJobDeps => ({
    insights: { settings: INS, fetchImpl: coll.fetchImpl }, consent, now: () => NOW, sweepLockWaitMs: 20000, tenantIds: [A, C], ...o,
  });

  const mkProp = async (tenant: string, client: string, domain: string, website: string): Promise<PropRef> => {
    const id = newId();
    await withTenants([tenant], (c) => c.query(
      `INSERT INTO search_properties (id, tenant_id, client_id, domain, site_url, umami_site_id) VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, tenant, client, domain, `https://${domain}`, website],
    ), S);
    return { tenantId: tenant, propertyId: id, domain, website };
  };
  const rows = async <T,>(tenant: string, sql: string, args: unknown[] = [], scoped = true): Promise<T[]> =>
    (await withTenants([tenant], (c) => c.query(sql, args), scoped ? S : undefined)).rows as T[];
  const profiles = (p: PropRef) => rows<Record<string, unknown>>(p.tenantId,
    `SELECT * FROM search_visitor_profiles WHERE property_id = $1 ORDER BY visitor_id`, [p.propertyId]);
  const profileOf = async (p: PropRef, visitor: string) => (await rows<Record<string, unknown>>(p.tenantId,
    `SELECT * FROM search_visitor_profiles WHERE property_id = $1 AND visitor_id = $2`, [p.propertyId, visitor]))[0] ?? null;
  const events = (p: PropRef) => rows<{ collector_event_id: string; profile_id: string }>(p.tenantId,
    `SELECT collector_event_id::text, profile_id FROM search_visitor_events WHERE property_id = $1 ORDER BY collector_event_id`, [p.propertyId]);
  const tombstoned = async (p: PropRef, kind: "visitor" | "consent", id: string) => (await rows<{ n: string }>(p.tenantId,
    `SELECT count(*)::text AS n FROM search_visitor_tombstones WHERE property_id = $1 AND kind = $2 AND id_hash = $3`,
    [p.propertyId, kind, idHash(id)]))[0]!.n === "1";
  const state = async (p: PropRef) => (await rows<{ cursor: string; last_ok_at: Date | null; last_outcome: string | null }>(p.tenantId,
    `SELECT cursor::text, last_ok_at, last_outcome FROM search_visitor_ingest_state WHERE property_id = $1`, [p.propertyId]))[0] ?? null;

  beforeAll(async () => {
    await initTestDb();
    A = await createCompany("M5V3E Co A", ["search"]);
    C = await createCompany("M5V3E Co C", ["search"]);
    propA = await mkProp(A, await createClient(A, "M5V3E Client A"), DOMAIN_A, WEB_A);
    propC = await mkProp(C, await createClient(C, "M5V3E Client C"), DOMAIN_C, WEB_C);
  });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => {
    coll.reset();
    consent.reset();
    clearPendingForgetsForTests();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const t of [A, C]) {
      await withTenants([t], async (c) => {
        await c.query(`DELETE FROM search_visitor_profiles WHERE tenant_id = $1`, [t]);
        await c.query(`DELETE FROM search_visitor_tombstones WHERE tenant_id = $1`, [t]);
        await c.query(`DELETE FROM search_visitor_ingest_state WHERE tenant_id = $1`, [t]);
        await c.query(`DELETE FROM search_interest_rules WHERE tenant_id = $1`, [t]);
      }, S);
    }
  });

  it("positive control: a consented visitor becomes a profile with its events; the cursor advances; score parts sum to the score", async () => {
    const v = uuid(); const k = uuid();
    consent.record("site-a", k, true, "grant");
    coll.add(WEB_A, v, k, { occurredAt: minutesAgo(120) });
    coll.add(WEB_A, v, k, { kind: "event", name: "lead_form_start", path: "/contact/", data: { form_id: "contact", email: "x@y.z" }, occurredAt: minutesAgo(110) });
    const last = coll.add(WEB_A, v, k, { occurredAt: minutesAgo(10) });
    const r = await ingestProperty(propA, deps());
    expect(r.outcome).toBe("ok");
    expect(r.profilesCreated).toBe(1);
    expect(r.eventsInserted).toBe(3);
    const p = (await profileOf(propA, v))!;
    expect(p).not.toBeNull();
    expect(p.consent_id).toBe(k);
    expect(p.visits).toBe(2);       // a 100-minute gap splits the visits
    expect(p.pageviews).toBe(2);
    expect(p.country).toBe("ID");
    expect(p.network).toEqual({ kind: "network", asn: 7713, name: "Telkom" });
    const parts = p.score_parts as Record<string, number>;
    expect(Number(p.score)).toBe(parts.recency + parts.frequency + parts.depth + parts.intent);
    expect(parts).toEqual({ recency: 25, frequency: 5, depth: 0, intent: 15 });
    expect(p.interests).toEqual({}); // no rules => no interests, never a guess
    expect((await state(propA))!.cursor).toBe(String(last));
    const evs = await rows<{ data: unknown }>(A, `SELECT data FROM search_visitor_events WHERE property_id = $1 AND kind = 'event'`, [propA.propertyId]);
    expect(evs[0]!.data).toEqual({ form_id: "contact" }); // only the allow-listed key survives
    expect(coll.forgets).toEqual([]);
  });

  it("with interest rules, the stored interests and depth follow them", async () => {
    await withTenants([A], (c) => c.query(
      `INSERT INTO search_interest_rules (id, tenant_id, property_id, match, pattern, facet, tag, weight) VALUES ($1,$2,$3,'path_prefix','/services/web','service','web',5)`,
      [newId(), A, propA.propertyId]), S);
    const v = uuid(); const k = uuid();
    consent.record("site-a", k, true, "grant");
    coll.add(WEB_A, v, k, { path: "/services/web/" });
    coll.add(WEB_A, v, k, { path: "/services/web/shop/" });
    expect((await ingestProperty(propA, deps())).outcome).toBe("ok");
    const p = (await profileOf(propA, v))!;
    expect(p.interests).toEqual({ service: [{ tag: "web", score: 10 }] });
    expect((p.score_parts as Record<string, number>).depth).toBe(10);
  });

  it("a consent id with NO record is never ingested and is forgotten (visitor and consent id)", async () => {
    const v = uuid(); const forged = uuid();
    coll.add(WEB_A, v, forged);
    const r = await ingestProperty(propA, deps());
    expect(r.outcome).toBe("ok");
    expect(await profiles(propA)).toEqual([]);
    expect(await events(propA)).toEqual([]);
    expect(coll.forgotVisitor(v)).toBe(true);
    expect(coll.forgotConsent(forged)).toBe(true);
    expect(coll.rows).toEqual([]);
    expect(await tombstoned(propA, "visitor", v)).toBe(true);
  });

  it("a consent id whose LATEST record is `update analytics:false` is never ingested, is forgotten, and an existing profile goes", async () => {
    const v = uuid(); const k = uuid();
    consent.record("site-a", k, true, "grant");
    coll.add(WEB_A, v, k);
    expect((await ingestProperty(propA, deps())).profilesCreated).toBe(1);
    // the visitor turns analytics off: the site records action "update" with analytics:false (not "withdraw")
    consent.record("site-a", k, false, "update");
    coll.add(WEB_A, v, k, { path: "/after-withdrawal/" });
    const r = await ingestProperty(propA, deps());
    expect(r.outcome).toBe("ok");
    expect(r.withdrawnProfiles).toBe(1);
    expect(await profileOf(propA, v)).toBeNull();
    expect(await events(propA)).toEqual([]); // cascaded
    expect(await tombstoned(propA, "visitor", v)).toBe(true);
    expect(coll.forgotVisitor(v)).toBe(true);
    expect(coll.forgotConsent(k)).toBe(false); // a known consent id is not tombstoned at the collector on a plain withdrawal
  });

  it("THE RACE: a sweep started while ingest writes the visitor's pre-withdrawal events leaves no profile", async () => {
    const v = uuid(); const k = uuid();
    consent.record("site-a", k, true, "grant");
    coll.add(WEB_A, v, k, { occurredAt: minutesAgo(30) });
    coll.add(WEB_A, v, k, { occurredAt: minutesAgo(29) });
    let release!: () => void;
    consent.gate = new Promise<void>((r) => { release = r; });
    const entered = new Promise<void>((r) => { consent.onCall = r; });
    const ingestRun = ingestProperty(propA, deps());
    await entered;                      // ingest holds the property lock and has WebDesk's pre-withdrawal answer
    consent.gate = null; consent.onCall = null;
    consent.record("site-a", k, false, "withdraw");  // the visitor withdraws NOW
    const sweepRun = sweepProperty(propA, deps());
    await sleep(500);                   // the sweep is waiting on the lock, not running
    expect(consent.calls).toBe(1);
    release();
    const [ing, sw] = await Promise.all([ingestRun, sweepRun]);
    expect(ing.outcome).toBe("ok");
    expect(ing.profilesCreated).toBe(1);   // ingest did commit the pre-withdrawal profile...
    expect(sw.outcome).toBe("ok");
    expect(sw.withdrawnProfiles).toBe(1);  // ...and the sweep, which ran right after it, removed it
    expect(await profiles(propA)).toEqual([]);
    expect(await events(propA)).toEqual([]);
    expect(await tombstoned(propA, "visitor", v)).toBe(true);
    expect(coll.forgotVisitor(v)).toBe(true);
    // a late pre-withdrawal event of the same visitor arriving afterwards brings nothing back
    coll.add(WEB_A, v, k, { occurredAt: minutesAgo(28) });
    consent.record("site-a", k, true, "update"); // even if the same consent id were re-granted, the visitor stays tombstoned
    const again = await ingestProperty(propA, deps());
    expect(again.outcome).toBe("ok");
    expect(again.skippedTombstoned).toBe(1);
    expect(await profiles(propA)).toEqual([]);
  });

  it("ingest RE-CHECKS the tombstones inside its writing transaction: a withdrawal landing between its checks and its commit wins", async () => {
    const v = uuid(); const k = uuid();      // consented visitor
    const w = uuid(); const kw = uuid();     // a withdrawn visitor on the same page, so ingest calls forget between A and B
    consent.record("site-a", k, true, "grant");
    consent.record("site-a", kw, false, "update");
    coll.add(WEB_A, v, k);
    coll.add(WEB_A, w, kw);
    // while the forget is in flight (after transaction A, before transaction B), another writer tombstones v
    // WITHOUT taking the lock (e.g. a rights request): transaction B must see it and skip v.
    coll.onForget = async () => {
      coll.onForget = null;
      await withTenants([A], (c) => c.query(
        `INSERT INTO search_visitor_tombstones (tenant_id, property_id, kind, id_hash, reason) VALUES ($1,$2,'visitor',$3,'erase')`,
        [A, propA.propertyId, idHash(v)]), S);
    };
    const r = await ingestProperty(propA, deps());
    expect(r.outcome).toBe("ok");
    expect(r.skippedTombstoned).toBe(1);
    expect(await profiles(propA)).toEqual([]);
    expect(coll.forgotVisitor(w)).toBe(true);
  });

  it("a repeated batch changes nothing (same events re-served, and a cursor reset)", async () => {
    const v1 = uuid(); const v2 = uuid(); const k1 = uuid(); const k2 = uuid();
    consent.record("site-a", k1, true, "grant");
    consent.record("site-a", k2, true, "grant");
    coll.add(WEB_A, v1, k1, { occurredAt: minutesAgo(50) });
    coll.add(WEB_A, v1, k1, { kind: "event", name: "cta_click", occurredAt: minutesAgo(49) });
    coll.add(WEB_A, v2, k2, { occurredAt: minutesAgo(20) });
    expect((await ingestProperty(propA, deps())).outcome).toBe("ok");
    const p1 = await profiles(propA);
    const e1 = await events(propA);
    coll.ignoreAfter = true; // the collector serves the same page again
    const again = await ingestProperty(propA, deps({ now: () => new Date(NOW.getTime() + 3600000) }));
    expect(again.outcome).toBe("ok");
    expect(again.eventsInserted).toBe(0);
    expect(again.profilesCreated).toBe(0);
    await withTenants([A], (c) => c.query(`UPDATE search_visitor_ingest_state SET cursor = 0 WHERE property_id = $1`, [propA.propertyId]), S);
    coll.ignoreAfter = false;
    expect((await ingestProperty(propA, deps())).eventsInserted).toBe(0);
    expect(await profiles(propA)).toEqual(p1); // every column, updated_at included
    expect(await events(propA)).toEqual(e1);
  });

  it("pages through the buffer by cursor", async () => {
    const k = uuid();
    consent.record("site-a", k, true, "grant");
    let last = 0;
    for (let i = 0; i < 5; i++) last = coll.add(WEB_A, uuid(), k, { occurredAt: minutesAgo(40 - i) });
    // one consent id with five visitor ids: each visitor gets its own profile
    const r = await ingestProperty(propA, deps({ pageLimit: 2 }));
    expect(r.outcome).toBe("ok");
    expect(r.pages).toBe(3);
    expect((await profiles(propA)).length).toBe(5);
    expect((await state(propA))!.cursor).toBe(String(last));
  });

  it("the sweep deletes withdrawn and absent consents' profiles, tombstones them, forgets them, and keeps the consented", async () => {
    const keep = uuid(); const kKeep = uuid();
    const gone = uuid(); const kGone = uuid();
    const vanished = uuid(); const kVanished = uuid();
    for (const kk of [kKeep, kGone, kVanished]) consent.record("site-a", kk, true, "grant");
    coll.add(WEB_A, keep, kKeep); coll.add(WEB_A, gone, kGone); coll.add(WEB_A, vanished, kVanished);
    expect((await ingestProperty(propA, deps())).profilesCreated).toBe(3);
    consent.record("site-a", kGone, false, "update");
    consent.bySite.get("site-a")!.delete(kVanished); // no record any more: no proof
    const run = await runVisitorSweep(deps());
    expect(run.failed).toBe(0);
    const left = (await profiles(propA)).map((p) => p.visitor_id);
    expect(left).toEqual([keep]);
    expect(await tombstoned(propA, "visitor", gone)).toBe(true);
    expect(await tombstoned(propA, "visitor", vanished)).toBe(true);
    expect(await tombstoned(propA, "visitor", keep)).toBe(false);
    expect(coll.forgotVisitor(gone) && coll.forgotVisitor(vanished)).toBe(true);
    expect(coll.forgotVisitor(keep)).toBe(false);
  });

  it("the sweep removes a profile a tombstone already covers (a writer that tombstoned without deleting)", async () => {
    const v = uuid(); const k = uuid();
    consent.record("site-a", k, true, "grant");
    coll.add(WEB_A, v, k);
    await ingestProperty(propA, deps());
    await withTenants([A], (c) => c.query(
      `INSERT INTO search_visitor_tombstones (tenant_id, property_id, kind, id_hash, reason) VALUES ($1,$2,'consent',$3,'erase')`,
      [A, propA.propertyId, idHash(k)]), S);
    const r = await sweepProperty(propA, deps());
    expect(r.tombstonedProfiles).toBe(1);
    expect(await profiles(propA)).toEqual([]);
  });

  it("WebDesk down: ingest writes NOTHING (no profile, no tombstone, no forget, cursor unmoved) and records a typed failure", async () => {
    const v = uuid(); const k = uuid();
    consent.record("site-a", k, true, "grant");
    coll.add(WEB_A, v, k);
    consent.down = true;
    const r = await ingestProperty(propA, deps());
    expect(r.outcome).toBe("consent_unreachable");
    expect(await profiles(propA)).toEqual([]);
    expect(await tombstoned(propA, "visitor", v)).toBe(false); // an outage is not a withdrawal
    expect(coll.forgets).toEqual([]);
    expect(coll.rows.length).toBe(1);                          // the buffer waits
    const st = (await state(propA))!;
    expect(st.cursor).toBe("0");
    expect(st.last_ok_at).toBeNull();
    expect(st.last_outcome).toBe("ingest: WebDesk consent.status is unreachable");
  });

  it("WebDesk down: the sweep keeps what it cannot check (no mass deletion) and records the failure", async () => {
    const v = uuid(); const k = uuid();
    consent.record("site-a", k, true, "grant");
    coll.add(WEB_A, v, k);
    await ingestProperty(propA, deps());
    consent.down = true;
    const r = await sweepProperty(propA, deps());
    expect(r.outcome).toBe("consent_unreachable");
    expect((await profiles(propA)).length).toBe(1);
    expect((await state(propA))!.last_outcome).toBe("sweep: WebDesk consent.status is unreachable");
  });

  it("collector down: ingest records a typed failure and writes nothing", async () => {
    coll.add(WEB_A, uuid(), uuid());
    coll.down = true;
    const r = await ingestProperty(propA, deps());
    expect(r.outcome).toBe("collector_unreachable");
    expect(await profiles(propA)).toEqual([]);
    expect(consent.calls).toBe(0);
    expect((await state(propA))!.last_outcome).toBe("ingest: the insights collector is unreachable");
  });

  it("forget fails mid-page: the ERP withdrawal is committed, the consented rest of the page is NOT, the cursor stays; the retry completes it", async () => {
    const ok = uuid(); const kOk = uuid();
    const bad = uuid(); const kBad = uuid();
    consent.record("site-a", kOk, true, "grant");
    consent.record("site-a", kBad, false, "update");
    coll.add(WEB_A, ok, kOk);
    coll.add(WEB_A, bad, kBad);
    coll.forgetDown = true;
    const r = await ingestProperty(propA, deps());
    expect(r.outcome).toBe("collector_unreachable");
    expect(await tombstoned(propA, "visitor", bad)).toBe(true); // the ERP side never waits on the collector
    expect(await profiles(propA)).toEqual([]);                   // nothing partial: the consented row waits too
    expect((await state(propA))!.cursor).toBe("0");
    expect(pendingForgetCount()).toBeGreaterThan(0);
    coll.forgetDown = false;
    const again = await ingestProperty(propA, deps());
    expect(again.outcome).toBe("ok");
    expect((await profiles(propA)).map((p) => p.visitor_id)).toEqual([ok]);
    expect(coll.forgotVisitor(bad)).toBe(true);
    expect(pendingForgetCount()).toBe(0);
  });

  it("collector down during the sweep: the profile is deleted anyway; the forget is queued and delivered next time", async () => {
    const v = uuid(); const k = uuid();
    consent.record("site-a", k, true, "grant");
    coll.add(WEB_A, v, k);
    await ingestProperty(propA, deps());
    consent.record("site-a", k, false, "withdraw");
    coll.down = true;
    const r = await sweepProperty(propA, deps());
    expect(r.withdrawnProfiles).toBe(1);
    expect(r.forgetOutcome).toBe("collector_unreachable");
    expect(await profiles(propA)).toEqual([]);
    expect(pendingForgetCount()).toBe(1);
    coll.down = false;
    await sweepProperty(propA, deps());
    expect(coll.forgotVisitor(v)).toBe(true);
    expect(pendingForgetCount()).toBe(0);
  });

  it("a busy property: ingest skips (busy), the sweep waits and gives up after its wait, recording `busy`", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const holder = withVisitorPropertyLock(propA.propertyId, () => held);
    await sleep(100);
    expect((await ingestProperty(propA, deps())).outcome).toBe("busy");
    const v = uuid(); const k = uuid();
    consent.record("site-a", k, true, "grant");
    await withTenants([A], (c) => c.query(
      `INSERT INTO search_visitor_profiles (id, tenant_id, property_id, visitor_id, consent_id, first_seen_at, last_seen_at) VALUES ($1,$2,$3,$4,$5,now(),now())`,
      [newId(), A, propA.propertyId, v, k]), S);
    expect((await sweepProperty(propA, deps({ sweepLockWaitMs: 300 }))).outcome).toBe("busy");
    release();
    expect((await holder).acquired).toBe(true);
    expect((await ingestProperty(propA, deps())).outcome).toBe("ok");
  });

  it("cross-tenant: another company, or no module scope, reads nothing; another site's consent id is 'absent' there", async () => {
    const v = uuid(); const k = uuid();
    consent.record("site-a", k, true, "grant");
    coll.add(WEB_A, v, k);
    await ingestProperty(propA, deps());
    expect((await profiles(propA)).length).toBe(1);
    expect(await rows(C, `SELECT * FROM search_visitor_profiles`)).toEqual([]);
    expect(await rows(C, `SELECT * FROM search_visitor_events`)).toEqual([]);
    expect(await rows(A, `SELECT * FROM search_visitor_profiles`, [], false)).toEqual([]); // no module scope: zero rows
    // company C's buffer carries A's (valid, granted) consent id: WebDesk answers for C's site only, so it is absent
    const vc = uuid();
    coll.add(WEB_C, vc, k);
    const r = await ingestProperty(propC, deps());
    expect(r.outcome).toBe("ok");
    expect(await profiles(propC)).toEqual([]);
    expect(coll.forgets.some((f) => f.website === WEB_C && f.visitorIds.includes(vc))).toBe(true);
    expect((await profiles(propA)).length).toBe(1); // A untouched
  });

  it("runVisitorIngest without collector settings does nothing at all", async () => {
    coll.add(WEB_A, uuid(), uuid());
    const r = await runVisitorIngest(deps({ insights: { settings: null, fetchImpl: coll.fetchImpl } }));
    expect(r.notConfigured).toBe(true);
    expect(r.properties).toBe(0);
    expect(consent.calls).toBe(0);
  });

  it("the sweep still runs for a company whose search module was switched off", async () => {
    const v = uuid(); const k = uuid();
    consent.record("site-a", k, true, "grant");
    coll.add(WEB_A, v, k);
    await ingestProperty(propA, deps());
    consent.record("site-a", k, false, "withdraw");
    await adminPool().query(`UPDATE companies SET enabled_modules = '{}' WHERE id = $1`, [A]);
    try {
      const run = await runVisitorSweep(deps());
      expect(run.properties).toBeGreaterThanOrEqual(1);
      expect(await profiles(propA)).toEqual([]);
    } finally {
      await adminPool().query(`UPDATE companies SET enabled_modules = '{search}' WHERE id = $1`, [A]);
    }
  });

  it("the purge deletes ONLY profiles last seen more than 14 months ago, and only old tombstones", async () => {
    const mk = (lastSeen: string) => withTenants([A], async (c) => {
      const id = newId();
      await c.query(
        `INSERT INTO search_visitor_profiles (id, tenant_id, property_id, visitor_id, consent_id, first_seen_at, last_seen_at) VALUES ($1,$2,$3,$4,$5,$6,$6)`,
        [id, A, propA.propertyId, uuid(), uuid(), lastSeen]);
      await c.query(
        `INSERT INTO search_visitor_events (id, tenant_id, property_id, profile_id, collector_event_id, occurred_at, kind, path) VALUES ($1,$2,$3,$4,$5,$6,'pageview','/a/')`,
        [newId(), A, propA.propertyId, id, Math.floor(Math.random() * 1e12), lastSeen]);
      return id;
    }, S);
    const expired = await mk("2025-08-01T00:00:00Z");   // > 14 months before NOW
    const edge = await mk("2025-08-13T00:00:00Z");      // just under 14 months
    const recent = await mk("2026-10-01T00:00:00Z");
    const tomb = (createdAt: string) => withTenants([A], (c) => c.query(
      `INSERT INTO search_visitor_tombstones (tenant_id, property_id, kind, id_hash, reason, created_at) VALUES ($1,$2,'visitor',$3,'withdraw',$4)`,
      [A, propA.propertyId, idHash(uuid()), createdAt]), S);
    await tomb("2025-07-01T00:00:00Z");
    await tomb("2026-01-01T00:00:00Z");
    const r = await purgeTenant(A, NOW);
    expect(r).toEqual({ profilesDeleted: 1, tombstonesDeleted: 1 });
    const ids = (await profiles(propA)).map((p) => p.id).sort();
    expect(ids).toEqual([edge, recent].sort());
    expect(ids).not.toContain(expired);
    expect((await rows<{ profile_id: string }>(A, `SELECT profile_id FROM search_visitor_events WHERE property_id = $1`, [propA.propertyId]))
      .map((e) => e.profile_id).sort()).toEqual([edge, recent].sort()); // the expired profile's events cascaded
    expect((await rows(A, `SELECT 1 FROM search_visitor_tombstones WHERE property_id = $1`, [propA.propertyId])).length).toBe(1);
  });
});
