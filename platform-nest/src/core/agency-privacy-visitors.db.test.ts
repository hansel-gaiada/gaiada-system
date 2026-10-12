// M5-V3-h — G5 rights requests over consented website-visitor profiles, driven over HTTP (app.inject) against REAL
// Postgres and REAL Cerbos, with a FAKE collector (the ops API behind a fake fetch) and a FAKE WebDesk consent.status.
// Profiles are created the real way: V3-e's ingest over the fake collector. Every write runs as `platform_app_test`
// (NOSUPERUSER NOBYPASSRLS); `adminPool()` (superuser) only READS evidence.
//
// Acceptance (design 2026-10-12 §8 V3-h):
//   - erasing by the EMAIL of a lead with a linked profile deletes the profile, tombstones both ids and records the
//     forget counts in the ledger;
//   - a later ingest of that visitor's buffered events creates nothing;
//   - export returns the profile and its events;
//   - a grep finds no identifier (visitor id, consent id, email, phone) in approvals, events, the ledger or the logs;
// plus: the collector unreachable during erase (ERP side commits, ledger says `queued`, retried); a hash-only run
// (`id_not_held`); the property lock (503, nothing changed, approval still usable); and another company untouched.
//
// Needs DATABASE_URL_TEST (+ CERBOS_URL): the Linux gate. Skips without it.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { newId, withTenants } from "../db";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient } from "../testing/fixtures";
import type { InsightsSettings } from "../modules/search/insights-client";
import type { ConsentReader, ConsentStatusEntry } from "../modules/search/visitor-consent-client";
import {
  clearPendingForgetsForTests, idHash, ingestProperty, pendingForgetCount, withVisitorPropertyLock, type PropRef, type VisitorJobDeps,
} from "../modules/search/visitor-jobs";
import { setVisitorEraseDepsForTests } from "../modules/search/visitor-erase";
import { pseudonymHash } from "./agency-privacy.subject";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const S = { modules: ["search"] };
const INS: InsightsSettings = { baseUrl: "http://collector.test", readKey: "read-key-0123456789", forgetKey: "forget-key-0123456789", timeoutMs: 2000 };
const WEB_A = "a0000000-0000-4000-8000-0000000003a1";
const WEB_A2 = "a0000000-0000-4000-8000-0000000003a2";
const WEB_B = "b0000000-0000-4000-8000-0000000003b1";
const NOW = new Date();
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60000).toISOString();

// ── fake collector (the V3-e test's shape) ──────────────────────────────────────────────────────────────────────
interface BufRow { website: string; id: number; visitorId: string; consentId: string; kind: string; path: string; name: string | null; data: unknown; occurredAt: string }
class FakeCollector {
  rows: BufRow[] = [];
  seq = 5000;
  forgetDown = false;
  forgets: Array<{ website: string; visitorIds: string[]; consentIds: string[]; mode: string }> = [];
  reset() { this.rows = []; this.forgetDown = false; this.forgets = []; }
  add(website: string, visitorId: string, consentId: string, o: Partial<BufRow> = {}): number {
    const id = ++this.seq;
    this.rows.push({ website, id, visitorId, consentId, kind: "pageview", path: "/services/web/", name: null, data: null, occurredAt: minutesAgo(30), ...o });
    return id;
  }
  forgot(website: string, mode: string, id: string) {
    return this.forgets.some((f) => f.website === website && f.mode === mode && (f.visitorIds.includes(id) || f.consentIds.includes(id)));
  }
  fetchImpl = (async (input: string, init: RequestInit) => {
    const u = new URL(input);
    const auth = (init.headers as Record<string, string>).Authorization;
    if (u.pathname === "/ops/v1/events") {
      if (auth !== `Bearer ${INS.readKey}`) return json(401, {});
      const website = u.searchParams.get("website")!;
      const after = Number(u.searchParams.get("after") ?? 0);
      const limit = Number(u.searchParams.get("limit") ?? 1000);
      const list = this.rows.filter((r) => r.website === website && r.id > after).sort((a, b) => a.id - b.id).slice(0, limit);
      return json(200, {
        events: list.map((r) => ({
          id: r.id, visitorId: r.visitorId, consentId: r.consentId, receivedAt: r.occurredAt, occurredAt: r.occurredAt, kind: r.kind,
          path: r.path, name: r.name, data: r.data, device: "desktop", geo: { country: "ID", city: "Denpasar" }, network: null, company: null,
        })),
        next: list.length ? list[list.length - 1]!.id : after,
      });
    }
    if (u.pathname === "/ops/v1/forget") {
      if (auth !== `Bearer ${INS.forgetKey}`) return json(403, {});
      if (this.forgetDown) throw new TypeError("fetch failed");
      const b = JSON.parse(String(init.body)) as { website: string; visitorIds: string[]; consentIds: string[]; mode: string };
      this.forgets.push(b);
      const before = this.rows.length;
      this.rows = this.rows.filter((r) => !(r.website === b.website && (b.visitorIds.includes(r.visitorId) || b.consentIds.includes(r.consentId))));
      return json(200, { website: b.website, mode: b.mode, deleted: { events: before - this.rows.length }, tombstoned: { visitors: b.visitorIds.length, consents: b.consentIds.length } });
    }
    return json(404, {});
  }) as unknown as typeof fetch;
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// ── fake WebDesk consent.status ──────────────────────────────────────────────────────────────────────────────────
class FakeConsent implements ConsentReader {
  bySite = new Map<string, Map<string, ConsentStatusEntry>>();
  constructor(private readonly domains: Record<string, string>) {}
  reset() { this.bySite.clear(); }
  grant(site: string, consentId: string) {
    const m = this.bySite.get(site) ?? new Map<string, ConsentStatusEntry>();
    m.set(consentId, { consentId, analytics: true, marketing: false, action: "grant", noticeVersion: "3", recordedAt: new Date().toISOString() });
    this.bySite.set(site, m);
  }
  async resolveSiteSlug(_companyId: string, domain: string): Promise<string> { return this.domains[domain]!; }
  async statuses(_companyId: string, siteSlug: string, ids: readonly string[]): Promise<Map<string, ConsentStatusEntry>> {
    const site = this.bySite.get(siteSlug) ?? new Map<string, ConsentStatusEntry>();
    const out = new Map<string, ConsentStatusEntry>();
    for (const id of ids) { const e = site.get(id); if (e) out.set(id, { ...e }); }
    return out;
  }
}

describe.skipIf(!TEST_URL)("M5-V3-h — rights requests over consented visitor profiles (find / export / erase), fake collector", () => {
  let app: NestFastifyApplication;
  let co: string;
  let coB: string;
  let admin: string;
  let decider: string;
  let adminB: string;
  let deciderB: string;
  let propA: PropRef;
  let propA2: PropRef;
  let propB: PropRef;
  const coll = new FakeCollector();
  const consent = new FakeConsent({ "v3h-a.example": "site-a", "v3h-a2.example": "site-a2", "v3h-b.example": "site-b" });
  const ingestDeps = (): VisitorJobDeps => ({ insights: { settings: INS, fetchImpl: coll.fetchImpl }, consent, now: () => NOW });
  const logLines: string[] = [];

  const mkProp = async (tenant: string, domain: string, website: string): Promise<PropRef> => {
    const id = newId();
    const client = await createClient(tenant, `V3H client ${domain}`);
    await withTenants([tenant], (c) => c.query(
      `INSERT INTO search_properties (id, tenant_id, client_id, domain, site_url, umami_site_id) VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, tenant, client, domain, `https://${domain}`, website],
    ), S);
    return { tenantId: tenant, propertyId: id, domain, website };
  };

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    co = await createCompany("V3H Privacy A", ["search"]);
    coB = await createCompany("V3H Privacy B", ["search"]);
    const mk = async (email: string, role: string, tenant: string) => {
      const id = await createUser(email);
      await addMembership(tenant, id);
      await grantRole(id, await createRole(role), "company", tenant);
      return id;
    };
    admin = await mk("admin@v3h-privacy.test", "company_admin", co);
    decider = await mk("decider@v3h-privacy.test", "company_admin", co);
    adminB = await mk("admin-b@v3h-privacy.test", "company_admin", coB);
    deciderB = await mk("decider-b@v3h-privacy.test", "company_admin", coB);
    propA = await mkProp(co, "v3h-a.example", WEB_A);
    propA2 = await mkProp(co, "v3h-a2.example", WEB_A2);
    propB = await mkProp(coB, "v3h-b.example", WEB_B);
    app = await buildApp();
  }, 60000);

  afterAll(async () => {
    setVisitorEraseDepsForTests(null);
    vi.restoreAllMocks();
    await app.close();
    await teardownTestDb();
  });

  beforeEach(() => {
    coll.reset();
    consent.reset();
    clearPendingForgetsForTests();
    setVisitorEraseDepsForTests({ insights: { settings: INS, fetchImpl: coll.fetchImpl }, lockWaitMs: 1500, lockPollMs: 50 });
    const capture = (...a: unknown[]) => { logLines.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); };
    vi.spyOn(console, "log").mockImplementation(capture);
    vi.spyOn(console, "warn").mockImplementation(capture);
    vi.spyOn(console, "error").mockImplementation(capture);
  });

  // ── helpers ──────────────────────────────────────────────────────────────────────────────────────────────────
  let seq = 0;
  function person() {
    const n = ++seq;
    return {
      email: `rina.visitor${n}@v3h-subject.test`, phone: `+62 813 5000 ${String(1000 + n)}`, phoneDigits: `628135000${String(1000 + n)}`,
      visitorId: newId(), consentId: newId(),
    };
  }

  async function insertLead(tenant: string, f: { email?: string; phone?: string; consentId?: string | null }): Promise<string> {
    const id = newId();
    const vc: Record<string, unknown> = { analytics: true, marketing: false, version: "3", decided_at: "2026-10-12T09:00:00Z" };
    if (f.consentId) vc.consentId = f.consentId;
    await withTenants([tenant], (c) => c.query(
      `INSERT INTO agency_leads (id, tenant_id, org_name, contact_name, contact_email, contact_phone, source, status, stage, origin_site, visitor_consent)
       VALUES ($1, $2, 'Villa Rina', 'Rina', $3, $4, 'web', 'new', 'enquiry', 'test', $5::jsonb)`,
      [id, tenant, f.email ?? null, f.phone ?? null, JSON.stringify(vc)],
    ));
    return id;
  }

  /** A consented visitor with `n` ingested events, created by V3-e's real ingest. */
  async function seedProfile(p: PropRef, site: string, visitorId: string, consentId: string, n = 2): Promise<void> {
    consent.grant(site, consentId);
    for (let i = 0; i < n; i++) coll.add(p.website!, visitorId, consentId, { occurredAt: minutesAgo(60 - i) });
    const r = await ingestProperty(p, ingestDeps());
    expect(r.outcome).toBe("ok");
  }

  const profile = async (tenant: string, visitorId: string) =>
    (await adminPool().query(`SELECT id FROM search_visitor_profiles WHERE tenant_id = $1 AND visitor_id = $2`, [tenant, visitorId])).rows[0] ?? null;
  const eventCount = async (tenant: string, visitorId: string) =>
    (await adminPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM search_visitor_events e JOIN search_visitor_profiles p ON p.id = e.profile_id
        WHERE p.tenant_id = $1 AND p.visitor_id = $2`, [tenant, visitorId])).rows[0]!.n;
  // Sorted in JS (code-unit order, the same order `[...].sort()` gives the expected lists), not by a collation.
  const tombstones = async (tenant: string, ids: string[]) =>
    (await adminPool().query<{ property_id: string; kind: string; reason: string }>(
      `SELECT property_id::text AS property_id, kind, reason FROM search_visitor_tombstones
        WHERE tenant_id = $1 AND id_hash = ANY($2::bytea[])`,
      [tenant, ids.map((i) => idHash(i))])).rows
      .sort((a, b) => (a.property_id < b.property_id ? -1 : a.property_id > b.property_id ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
  const executedRow = async (approvalId: string) =>
    (await adminPool().query(`SELECT * FROM agency_dsr_requests WHERE approval_id = $1 AND phase = 'executed'`, [approvalId])).rows[0] as Record<string, unknown> | undefined;

  const call = (tenant: string, user: string, kind: string, payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: `/api/${tenant}/agency/privacy/${kind}`, headers: asUser(user), payload });
  const decide = (tenant: string, user: string, approvalId: string) =>
    app.inject({ method: "POST", url: `/api/${tenant}/automation-approvals/${approvalId}/decide`, headers: asUser(user), payload: { decision: "approved" } });
  async function fileAndDecide(tenant: string, requester: string, by: string, kind: string, ids: Record<string, unknown>) {
    const filed = await call(tenant, requester, kind, ids);
    expect(filed.statusCode, filed.body).toBe(202);
    const body = filed.json() as { approvalId: string; requestId: string };
    const d = await decide(tenant, by, body.approvalId);
    expect(d.statusCode, d.body).toBe(200);
    return body;
  }

  /** Every durable place an identifier must NOT land, plus every captured log line. */
  async function leakText(): Promise<string> {
    const q = async (sql: string) => (await adminPool().query<{ t: string }>(sql)).rows.map((r) => r.t).join("\n");
    return [
      await q(`SELECT tool_args::text || ' ' || coalesce(reason, '') AS t FROM automation_approvals`),
      await q(`SELECT payload::text AS t FROM outbox_events`),
      await q(`SELECT metadata::text AS t FROM activities`),
      await q(`SELECT row_to_json(d)::text AS t FROM agency_dsr_requests d`),
      await q(`SELECT coalesce(last_outcome, '') AS t FROM search_visitor_ingest_state`),
      ...logLines,
    ].join("\n").toLowerCase();
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════
  it("erase by the EMAIL of a lead with a linked profile: profile and events deleted, both ids tombstoned on every property, forget delivered and counted in the ledger; a later ingest creates nothing; another company untouched", async () => {
    const p = person();
    await seedProfile(propA, "site-a", p.visitorId, p.consentId, 2);
    // The same browser ids also exist in company B (another tenant's property): they must survive A's erase.
    await seedProfile(propB, "site-b", p.visitorId, p.consentId, 1);
    const lead = await insertLead(co, { email: p.email, phone: p.phone, consentId: p.consentId });
    expect(await profile(co, p.visitorId)).not.toBeNull();
    expect(await eventCount(co, p.visitorId)).toBe(2);

    const { approvalId } = await fileAndDecide(co, admin, decider, "erase", { email: p.email });
    const run = await call(co, admin, "erase", { email: p.email, approvalId });
    expect(run.statusCode, run.body).toBe(200);
    const out = run.json() as { counts: Record<string, unknown>; collector: string };
    expect(out.counts).toMatchObject({
      leadCount: 1, profileCount: 1, profileEventCount: 2, tombstoneCount: 4, // 2 ids x 2 properties of A
      collectorForget: "delivered", collectorForgetCalls: 2,
    });
    expect(out.collector).toMatch(/confirmed the erase/);

    // ERP: the profile and its events are gone; both ids are tombstoned 'erase' on BOTH of A's properties.
    expect(await profile(co, p.visitorId)).toBeNull();
    expect((await adminPool().query(`SELECT count(*)::int AS n FROM search_visitor_events WHERE tenant_id = $1 AND property_id = $2`, [co, propA.propertyId])).rows[0].n).toBe(0);
    expect(await tombstones(co, [p.visitorId, p.consentId])).toEqual([
      ...[propA.propertyId, propA2.propertyId].sort().flatMap((prop) => [
        { property_id: prop, kind: "consent", reason: "erase" }, { property_id: prop, kind: "visitor", reason: "erase" },
      ]),
    ]);
    // The lead: scrubbed, consent snapshot kept as evidence WITHOUT the consent id.
    const l = (await adminPool().query(`SELECT contact_email, visitor_consent FROM agency_leads WHERE id = $1`, [lead])).rows[0];
    expect(l.contact_email).toBeNull();
    expect(l.visitor_consent).toEqual({ analytics: true, marketing: false, version: "3", decided_at: "2026-10-12T09:00:00Z" });

    // Collector: forget mode "erase" with BOTH ids at both of A's websites, never at B's.
    for (const w of [WEB_A, WEB_A2]) {
      expect(coll.forgot(w, "erase", p.visitorId)).toBe(true);
      expect(coll.forgets.find((f) => f.website === w)).toMatchObject({ visitorIds: [p.visitorId], consentIds: [p.consentId], mode: "erase" });
    }
    expect(coll.forgets.some((f) => f.website === WEB_B)).toBe(false);

    // The ledger: counts and the collector outcome, hashes only.
    const row = (await executedRow(approvalId))!;
    expect(row).toMatchObject({
      kind: "erase", profile_count: 1, profile_event_count: 2, tombstone_count: 4, collector_forget: "delivered", collector_forget_calls: 2,
      visitor_id_hash: null, consent_id_hash: null,
    });
    expect(row.collector_deleted_events).toBe(out.counts.collectorDeletedEvents);
    expect(Number(row.collector_deleted_events)).toBeGreaterThanOrEqual(2);

    // A LATER INGEST of that visitor's buffered events (the browser kept sending; WebDesk still says granted) creates
    // nothing: the tombstones stop it, and ingest tells the collector again (erase).
    coll.forgets = [];
    coll.add(WEB_A, p.visitorId, p.consentId, { occurredAt: minutesAgo(5) });
    coll.add(WEB_A, p.visitorId, p.consentId, { kind: "event", name: "lead_form_start", path: "/contact/", occurredAt: minutesAgo(4) });
    const later = await ingestProperty(propA, ingestDeps());
    expect(later.outcome).toBe("ok");
    expect(later.profilesCreated).toBe(0);
    expect(later.eventsInserted).toBe(0);
    expect(later.skippedTombstoned).toBe(2);
    expect(await profile(co, p.visitorId)).toBeNull();
    expect(coll.forgot(WEB_A, "erase", p.visitorId)).toBe(true);

    // Company B: its profile, its events and its (absent) tombstones are untouched.
    expect(await profile(coB, p.visitorId)).not.toBeNull();
    expect(await eventCount(coB, p.visitorId)).toBe(1);
    expect(await tombstones(coB, [p.visitorId, p.consentId])).toEqual([]);

    // No identifier anywhere durable or in any log line.
    const text = await leakText();
    for (const id of [p.visitorId, p.consentId, p.email, p.phone, p.phoneDigits]) expect(text).not.toContain(id.toLowerCase());

    // A replay answers the stored counts, collector outcome included.
    const again = await call(co, admin, "erase", { email: p.email, approvalId });
    expect(again.json()).toMatchObject({ replayed: true, counts: { profileCount: 1, collectorForget: "delivered" } });
  });

  it("the collector is UNREACHABLE during erase: the ERP deletion and tombstones commit, the ledger says 'queued' (never delivered), the forget is retried; a restart that loses the queue still re-creates nothing", async () => {
    const p = person();
    await seedProfile(propA, "site-a", p.visitorId, p.consentId, 2);
    coll.add(WEB_A, p.visitorId, p.consentId, { occurredAt: minutesAgo(3) }); // buffered, not yet ingested

    // By visitor id alone this time (the id the privacy page shows the person).
    const { approvalId } = await fileAndDecide(co, admin, decider, "erase", { visitorId: p.visitorId });
    const filed = (await adminPool().query(`SELECT visitor_id_hash, email_hash FROM agency_dsr_requests WHERE approval_id = $1 AND phase = 'filed'`, [approvalId])).rows[0];
    expect(filed).toEqual({ visitor_id_hash: pseudonymHash(p.visitorId), email_hash: null });

    coll.forgetDown = true;
    const run = await call(co, admin, "erase", { visitorId: p.visitorId, approvalId });
    expect(run.statusCode, run.body).toBe(200);
    const out = run.json() as { counts: Record<string, unknown>; collector: string };
    expect(out.counts).toMatchObject({ profileCount: 1, profileEventCount: 2, collectorForget: "queued", collectorForgetCalls: 0 });
    expect(out.collector).toMatch(/NOT confirmed/);
    expect(await profile(co, p.visitorId)).toBeNull();
    // The consent id was found through the profile and tombstoned too.
    expect((await tombstones(co, [p.visitorId, p.consentId])).length).toBe(4);
    expect((await executedRow(approvalId))!).toMatchObject({ collector_forget: "queued", collector_forget_calls: 0, profile_count: 1 });
    expect(pendingForgetCount()).toBe(4); // both ids, queued for each of A's two websites

    // Back up: the next run on A2 flushes its queued erase.
    coll.forgetDown = false;
    await ingestProperty(propA2, ingestDeps());
    expect(coll.forgot(WEB_A2, "erase", p.visitorId)).toBe(true);
    expect(coll.forgot(WEB_A2, "erase", p.consentId)).toBe(true);

    // A process restart loses the memory queue before A's next run: the buffered event is still re-created as nothing,
    // and ingest itself tells the collector to erase (the backstop).
    clearPendingForgetsForTests();
    consent.grant("site-a", p.consentId); // WebDesk still says granted: only the tombstones stand in the way
    const later = await ingestProperty(propA, ingestDeps());
    expect(later.profilesCreated).toBe(0);
    expect(later.skippedTombstoned).toBeGreaterThanOrEqual(1);
    expect(await profile(co, p.visitorId)).toBeNull();
    expect(coll.forgot(WEB_A, "erase", p.visitorId)).toBe(true);

    const text = await leakText();
    for (const id of [p.visitorId, p.consentId]) expect(text).not.toContain(id);
  });

  it("export returns the profile and every event (by visitor id, and through a lead's consent id); find lists it without the ids; nothing is changed or stored", async () => {
    const p = person();
    await seedProfile(propA, "site-a", p.visitorId, p.consentId, 3);
    await insertLead(co, { email: p.email, consentId: p.consentId });

    const ex = await fileAndDecide(co, admin, decider, "export", { visitorId: p.visitorId });
    const r = await call(co, admin, "export", { visitorId: p.visitorId, approvalId: ex.approvalId });
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json() as { leads: unknown[]; visitorProfiles: Array<Record<string, unknown>>; counts: Record<string, number> };
    expect(body.leads).toEqual([]); // a visitor id never reaches a lead's contact data
    expect(body.counts).toMatchObject({ leadCount: 0, profileCount: 1, profileEventCount: 3 });
    expect(body.visitorProfiles).toHaveLength(1);
    const vp = body.visitorProfiles[0]!;
    expect(vp).toMatchObject({ visitorId: p.visitorId, consentId: p.consentId, propertyId: propA.propertyId, propertyDomain: "v3h-a.example", matchedBy: ["visitor_id"], pageviews: 3 });
    expect((vp.events as unknown[]).length).toBe(3);
    expect((vp.events as Array<Record<string, unknown>>)[0]).toMatchObject({ kind: "pageview", path: "/services/web/" });

    // Through the lead (email request): the same profile, matched by the lead's consent snapshot.
    const byEmail = await fileAndDecide(co, admin, decider, "export", { email: p.email });
    const r2 = (await call(co, admin, "export", { email: p.email, approvalId: byEmail.approvalId })).json() as { visitorProfiles: Array<Record<string, unknown>> };
    expect(r2.visitorProfiles.map((x) => x.matchedBy)).toEqual([["lead"]]);

    // find by consent id: counts, no ids.
    const f = await fileAndDecide(co, admin, decider, "find", { consentId: p.consentId });
    const fr = await call(co, admin, "find", { consentId: p.consentId, approvalId: f.approvalId });
    expect(fr.statusCode).toBe(200);
    const fb = fr.json() as { visitorProfiles: Array<Record<string, unknown>> };
    expect(fb.visitorProfiles).toEqual([expect.objectContaining({ matchedBy: ["consent_id"], eventCount: 3, pageviews: 3 })]);
    expect(JSON.stringify(fb)).not.toContain(p.visitorId);
    expect(JSON.stringify(fb)).not.toContain(p.consentId);

    // Reads changed nothing, and the export's personal data was never stored.
    expect(await eventCount(co, p.visitorId)).toBe(3);
    expect(await tombstones(co, [p.visitorId, p.consentId])).toEqual([]);
    const text = await leakText();
    for (const id of [p.visitorId, p.consentId, p.email]) expect(text).not.toContain(id.toLowerCase());
  });

  it("a hash-only run (approvalId alone, an id the ERP holds nowhere): tombstoned by hash, ledger says 'id_not_held'; ingest then blocks the buffered events and tells the collector", async () => {
    const p = person();
    consent.grant("site-a", p.consentId);
    coll.add(WEB_A, p.visitorId, p.consentId, { occurredAt: minutesAgo(2) }); // only at the collector, never ingested

    const { approvalId } = await fileAndDecide(co, admin, decider, "erase", { consentId: p.consentId });
    const run = await call(co, admin, "erase", { approvalId }); // run-by-approval: the subject comes from the ledger hash
    expect(run.statusCode, run.body).toBe(200);
    expect((run.json() as { counts: Record<string, unknown> }).counts).toMatchObject({ profileCount: 0, tombstoneCount: 2, collectorForget: "id_not_held", collectorForgetCalls: 0 });
    expect(await tombstones(co, [p.consentId])).toEqual([
      ...[propA.propertyId, propA2.propertyId].sort().map((prop) => ({ property_id: prop, kind: "consent", reason: "erase" })),
    ]);
    expect((await executedRow(approvalId))!).toMatchObject({ collector_forget: "id_not_held", consent_id_hash: pseudonymHash(p.consentId) });

    const later = await ingestProperty(propA, ingestDeps());
    expect(later.profilesCreated).toBe(0);
    expect(await profile(co, p.visitorId)).toBeNull();
    expect(coll.forgot(WEB_A, "erase", p.consentId)).toBe(true);
  });

  it("a visitor job holding a property lock: 503 visitor_store_busy, NOTHING changed, the approval still unused and runnable afterwards", async () => {
    const p = person();
    await seedProfile(propA, "site-a", p.visitorId, p.consentId, 1);
    const { approvalId } = await fileAndDecide(co, admin, decider, "erase", { visitorId: p.visitorId });

    const held = await withVisitorPropertyLock(propA2.propertyId, async () => {
      const r = await call(co, admin, "erase", { visitorId: p.visitorId, approvalId });
      expect(r.statusCode, r.body).toBe(503);
      expect(r.json()).toMatchObject({ reason: "visitor_store_busy" });
    });
    expect(held.acquired).toBe(true);
    expect(await profile(co, p.visitorId)).not.toBeNull();
    expect(await tombstones(co, [p.visitorId])).toEqual([]);
    expect(await executedRow(approvalId)).toBeUndefined();
    expect(coll.forgets).toEqual([]);

    const r = await call(co, admin, "erase", { visitorId: p.visitorId, approvalId });
    expect(r.statusCode, r.body).toBe(200);
    expect(await profile(co, p.visitorId)).toBeNull();
  });

  it("another company's request for the same ids touches only its own rows, and content binding covers the visitor keys", async () => {
    const p = person();
    await seedProfile(propA, "site-a", p.visitorId, p.consentId, 1);

    // B's erase of the same visitor id runs in B: A's profile and A's properties are untouched.
    const b = await fileAndDecide(coB, adminB, deciderB, "erase", { visitorId: p.visitorId });
    const runB = await call(coB, adminB, "erase", { visitorId: p.visitorId, approvalId: b.approvalId });
    expect(runB.statusCode, runB.body).toBe(200);
    expect(runB.json()).toMatchObject({ counts: { profileCount: 0 } });
    expect(await profile(co, p.visitorId)).not.toBeNull();
    expect(await tombstones(co, [p.visitorId])).toEqual([]);
    expect(coll.forgets.every((f) => f.website === WEB_B)).toBe(true);

    // A's approval for a visitor id does not run for another visitor id, nor with an added consent id.
    const a = await fileAndDecide(co, admin, decider, "erase", { visitorId: p.visitorId });
    for (const body of [{ visitorId: newId() }, { visitorId: p.visitorId, consentId: p.consentId }]) {
      const r = await call(co, admin, "erase", { ...body, approvalId: a.approvalId });
      expect(r.statusCode).toBe(400);
      expect(r.json()).toMatchObject({ reason: "privacy_request_mismatch" });
    }
    expect(await profile(co, p.visitorId)).not.toBeNull();
  });
});
