// M5 V3-k (ERP half) — the ERP's REAL visitor jobs against a REAL insights-collector. PROTOTYPED until the orchestrator
// has run it on the Linux box and it passes there (then DEV-VERIFIED). Nothing here fakes the collector: events are POSTed to
// its public port (/lib/kestrel/v), read back and judged through its ops port (/ops/v1/events, Bearer read key), and the
// ERP reaches it through the SAME `insights-client` production uses (env: INSIGHTS_BASE_URL / INSIGHTS_READ_KEY /
// INSIGHTS_FORGET_KEY). The only fake is WebDesk's `consent.status` (a ConsentReader), because that is a different
// system: what it answers is the test's input (granted / forged-or-absent / withdrawn).
//
// SKIPPED unless ALL of these are set (normal CI sets none of the INSIGHTS_* ones, so it skips there):
//   INSIGHTS_E2E=1                      the switch (exactly "1")
//   INSIGHTS_E2E_COLLECT_URL            the collector's PUBLIC port, e.g. http://collector:8080  (trusts X-Real-IP)
//   INSIGHTS_BASE_URL                   the collector's OPS port,    e.g. http://collector:8081  (read by the ERP's real client)
//   INSIGHTS_READ_KEY                   the ops read key  (collector holds only its SHA-256 as OPS_READ_KEY_SHA256)
//   INSIGHTS_FORGET_KEY                 the ops forget key (OPS_FORGET_KEY_SHA256; a different key)
//   INSIGHTS_E2E_WEBSITE                a website uuid listed in the collector's INSIGHTS_WEBSITES
//   + the normal DB-test env: DATABASE_URL_TEST, DATABASE_URL, CERBOS_URL, REDIS_URL_TEST, REDIS_URL
// The collector must run with its DEFAULT CONSENT_EVENT_NAMES (section_view and cta_click are used), BUFFER_RETENTION_HOURS
// <= 72 and a vdb (Postgres) it can reach. Geo files are optional (a missing DB-IP file only leaves country/city empty; the
// test does not assert them). Nothing else is needed: no Umami (the aggregate channel is not used), REPLAY_ENABLED may be off.
//
// Sample (one network that holds Postgres, Cerbos, Redis and the collector; the repo is mounted read-only-ish at /src and
// `npm ci` has been run in platform-nest, or run it first in the same container):
//   docker run --rm --network gate-NET -v "$PWD":/src -w /src/platform-nest \
//     -e DATABASE_URL_TEST=postgres://postgres:postgres@pg:5432/postgres -e DATABASE_URL=postgres://postgres:postgres@pg:5432/postgres \
//     -e CERBOS_URL=http://cerbos:3592 -e REDIS_URL_TEST=redis://redis:6379/1 -e REDIS_URL=redis://redis:6379/1 \
//     -e INSIGHTS_E2E=1 -e INSIGHTS_E2E_COLLECT_URL=http://collector:8080 -e INSIGHTS_BASE_URL=http://collector:8081 \
//     -e INSIGHTS_READ_KEY=e2e-read-key-0123456789 -e INSIGHTS_FORGET_KEY=e2e-forget-key-0123456789 \
//     -e INSIGHTS_E2E_WEBSITE=11111111-2222-4333-8444-555555555555 \
//     node:22-bookworm bash -c 'npm ci && npx vitest run src/modules/search/visitor-collector.e2e.db.test.ts'
//   (the collector side of that example: INSIGHTS_WEBSITES=11111111-2222-4333-8444-555555555555,
//    OPS_READ_KEY_SHA256=$(printf %s e2e-read-key-0123456789 | sha256sum | cut -d' ' -f1), OPS_FORGET_KEY_SHA256 likewise.)
//
// What it costs: the collector's ops read never returns a row younger than 15 s, so each case that ingests waits 17 s after
// posting (cases 1, 2 and 4); the whole file is about 1.5 minutes. Every case allows 120 s.
//
// The cases run in order and case 3 continues from case 1's visitor (A), so run the file whole, not one case at a time.
// Every run uses fresh random uuids for every visitor and consent id, a fresh company, property and domain, so reruns
// against the same collector do not collide. The ingest of a NEW property starts at cursor 0 and reads the collector's whole
// buffer for that website: rows left there by anything else (other runs, other tests) have no consent in this test's fake
// WebDesk, so they are treated as absent and FORGOTTEN at the collector. Point this at a test collector, not at one whose
// buffer matters.
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { buildApp } from "../../main";
import { newId, withTenants } from "../../db";
import { resetModules } from "../registry";
import { resetCoreRollupProviders } from "../../rollups/engine";
import { adminPool, initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { addMembership, createClient, createCompany, createRole, createUser, grantRole } from "../../testing/fixtures";
import { forgetAtCollector } from "./insights-client";
import type { ConsentReader, ConsentStatusEntry } from "./visitor-consent-client";
import {
  clearPendingForgetsForTests, idHash, runVisitorIngest, runVisitorSweep,
  type IngestPropertyResult, type SweepPropertyResult, type VisitorJobDeps, type VisitorRunResult,
} from "./visitor-jobs";
import { setVisitorEraseDepsForTests } from "./visitor-erase";

const E = process.env;
const ENABLED = E.INSIGHTS_E2E === "1"
  && !!E.INSIGHTS_E2E_COLLECT_URL && !!E.INSIGHTS_BASE_URL && !!E.INSIGHTS_READ_KEY && !!E.INSIGHTS_FORGET_KEY
  && !!E.INSIGHTS_E2E_WEBSITE && !!TEST_URL;

const COLLECT_URL = (E.INSIGHTS_E2E_COLLECT_URL ?? "").trim().replace(/\/+$/, "");
const OPS_URL = (E.INSIGHTS_BASE_URL ?? "").trim().replace(/\/+$/, "");
const READ_KEY = (E.INSIGHTS_READ_KEY ?? "").trim();
const WEBSITE = (E.INSIGHTS_E2E_WEBSITE ?? "").trim().toLowerCase();

const S = { modules: ["search"] };
const CASE_TIMEOUT = 120_000;
/** The ops read never returns a row younger than 15 s (collector ReadLag); wait a little longer than that. */
const SETTLE_MS = 17_000;
// The collector drops headless and bot user agents silently; X-Real-IP is what port 8080 trusts (a public GB address).
const REAL_IP = "81.2.69.142";
const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

// ── the one fake: WebDesk's consent.status (latest record per consent id; an id with no record is absent) ─────────────
class FakeConsent implements ConsentReader {
  private readonly latest = new Map<string, ConsentStatusEntry>();
  constructor(private readonly domain: string, private readonly siteSlug: string) {}
  record(consentId: string, analytics: boolean, action: "grant" | "update"): void {
    this.latest.set(consentId, { consentId, analytics, marketing: false, action, noticeVersion: "3", recordedAt: new Date().toISOString() });
  }
  async resolveSiteSlug(_companyId: string, domain: string): Promise<string> {
    if (domain !== this.domain) throw new Error(`unexpected domain ${domain}`);
    return this.siteSlug;
  }
  async statuses(_companyId: string, siteSlug: string, ids: readonly string[]): Promise<Map<string, ConsentStatusEntry>> {
    const out = new Map<string, ConsentStatusEntry>();
    if (siteSlug !== this.siteSlug) return out;
    for (const id of ids) { const e = this.latest.get(id); if (e) out.set(id, { ...e }); }
    return out;
  }
}

// ── the real collector, by plain HTTP (never through the ERP's own client, so the proof is not circular) ─────────────
interface Visitor { visitorId: string; consentId: string }
const freshVisitor = (): Visitor => ({ visitorId: randomUUID(), consentId: randomUUID() });

/** POST /lib/kestrel/v. Returns the HTTP status (204 stored, 410 forgotten) and the body text. */
async function postV(v: Visitor, events?: unknown[]): Promise<{ status: number; body: string }> {
  const now = Date.now();
  const batch = events ?? [
    { t: now, kind: "pageview", path: "/services/web/" },
    { t: now + 1, kind: "event", name: "section_view", path: "/services/web/", data: { section_id: "pricing.plans" } },
    { t: now + 2, kind: "event", name: "cta_click", path: "/services/web/", data: { link_location: "hero" } },
  ];
  const res = await fetch(`${COLLECT_URL}/lib/kestrel/v`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", "User-Agent": CHROME_UA, "X-Real-IP": REAL_IP },
    body: JSON.stringify({ website: WEBSITE, visitorId: v.visitorId, consentId: v.consentId, events: batch }),
    signal: AbortSignal.timeout(15_000),
  });
  return { status: res.status, body: await res.text() };
}

interface OpsEvent { id: number; visitorId: string; consentId: string; kind: string; path: string | null; name: string | null }

/** Every event the collector will show the ERP for this website (rows older than 15 s), paged by id. */
async function opsEvents(): Promise<OpsEvent[]> {
  const out: OpsEvent[] = [];
  let after = 0;
  for (let page = 0; page < 100; page++) {
    const res = await fetch(`${OPS_URL}/ops/v1/events?website=${WEBSITE}&after=${after}&limit=1000`, {
      headers: { Authorization: `Bearer ${READ_KEY}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status !== 200) throw new Error(`ops read answered HTTP ${res.status}`);
    const body = (await res.json()) as { events: OpsEvent[]; next: number };
    out.push(...body.events);
    if (body.events.length === 0 || body.next <= after) break;
    after = body.next;
  }
  return out;
}
const opsEventsOf = async (v: Visitor) => (await opsEvents()).filter((e) => e.visitorId === v.visitorId || e.consentId === v.consentId);

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe.skipIf(!ENABLED)("M5 V3-k · ERP visitor jobs against a REAL insights-collector", () => {
  let app: NestFastifyApplication;
  let tenant: string;
  let propertyId: string;
  let admin: string;
  let decider: string;
  const rand = randomUUID().slice(0, 8);
  const domain = `v3k-${rand}.example`;
  const consent = new FakeConsent(domain, `site-v3k-${rand}`);

  // Visitors of the four cases, kept so later cases and the cleanup can see them.
  const A = freshVisitor();
  const B = freshVisitor();
  const C = freshVisitor();
  let aIngested = false;

  // What the ERP is told: the REAL insights client (env), the fake consent, only this test's company.
  const deps = (): VisitorJobDeps => ({ consent, tenantIds: [tenant], sweepLockWaitMs: 30_000 });
  const only = <T extends IngestPropertyResult | SweepPropertyResult>(run: VisitorRunResult): T => {
    expect(run.notConfigured, "the INSIGHTS_* env must configure the real client").toBe(false);
    expect(run.properties).toBe(1);
    expect(run.failed).toBe(0);
    return run.results[0] as T;
  };

  // ── ERP evidence (superuser pool: reads only) ──────────────────────────────────────────────────────────────────
  const profileOf = async (v: Visitor) =>
    (await adminPool().query<Record<string, unknown>>(
      `SELECT * FROM search_visitor_profiles WHERE tenant_id = $1 AND visitor_id = $2`, [tenant, v.visitorId])).rows[0] ?? null;
  const profileEvents = async (v: Visitor) =>
    (await adminPool().query<{ kind: string; name: string | null; path: string | null; data: unknown }>(
      `SELECT e.kind, e.name, e.path, e.data FROM search_visitor_events e JOIN search_visitor_profiles p ON p.id = e.profile_id
        WHERE p.tenant_id = $1 AND p.visitor_id = $2 ORDER BY e.collector_event_id`, [tenant, v.visitorId])).rows;
  const eventsOfPropertyCount = async () =>
    (await adminPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM search_visitor_events WHERE tenant_id = $1 AND property_id = $2`, [tenant, propertyId])).rows[0]!.n;
  const tombstones = async (id: string) =>
    (await adminPool().query<{ kind: string; reason: string }>(
      `SELECT kind, reason FROM search_visitor_tombstones WHERE tenant_id = $1 AND property_id = $2 AND id_hash = $3 ORDER BY kind`,
      [tenant, propertyId, idHash(id)])).rows;
  const cursor = async () =>
    Number((await adminPool().query<{ c: string }>(`SELECT cursor::text AS c FROM search_visitor_ingest_state WHERE property_id = $1`, [propertyId])).rows[0]?.c ?? 0);

  // ── the V3-h rights-request route (copied from agency-privacy-visitors.db.test.ts) ─────────────────────────────
  const call = (user: string, kind: string, payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: `/api/${tenant}/agency/privacy/${kind}`, headers: asUser(user), payload });
  const decide = (user: string, approvalId: string) =>
    app.inject({ method: "POST", url: `/api/${tenant}/automation-approvals/${approvalId}/decide`, headers: asUser(user), payload: { decision: "approved" } });
  async function fileAndDecide(kind: string, ids: Record<string, unknown>): Promise<{ approvalId: string; requestId: string }> {
    const filed = await call(admin, kind, ids);
    expect(filed.statusCode, filed.body).toBe(202);
    const body = filed.json() as { approvalId: string; requestId: string };
    const d = await decide(decider, body.approvalId);
    expect(d.statusCode, d.body).toBe(200);
    return body;
  }
  async function insertLead(f: { email: string; consentId: string }): Promise<string> {
    const id = newId();
    const vc = { analytics: true, marketing: false, version: "3", decided_at: "2026-10-12T09:00:00Z", consentId: f.consentId };
    await withTenants([tenant], (c) => c.query(
      `INSERT INTO agency_leads (id, tenant_id, org_name, contact_name, contact_email, source, status, stage, origin_site, visitor_consent)
       VALUES ($1, $2, 'Villa E2E', 'Rina E2E', $3, 'web', 'new', 'enquiry', 'test', $4::jsonb)`,
      [id, tenant, f.email, JSON.stringify(vc)],
    ));
    return id;
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    clearPendingForgetsForTests();
    tenant = await createCompany(`M5V3K E2E ${rand}`, ["search"]);
    const mk = async (email: string) => {
      const id = await createUser(email);
      await addMembership(tenant, id);
      await grantRole(id, await createRole("company_admin"), "company", tenant);
      return id;
    };
    admin = await mk(`admin-${rand}@v3k-e2e.test`);
    decider = await mk(`decider-${rand}@v3k-e2e.test`);
    propertyId = newId();
    const client = await createClient(tenant, `V3K client ${rand}`);
    await withTenants([tenant], async (c) => {
      await c.query(
        `INSERT INTO search_properties (id, tenant_id, client_id, domain, site_url, umami_site_id) VALUES ($1,$2,$3,$4,$5,$6)`,
        [propertyId, tenant, client, domain, `https://${domain}`, WEBSITE],
      );
      // one interest rule, so a profile's interests are not the empty (and uninformative) `{}`
      await c.query(
        `INSERT INTO search_interest_rules (id, tenant_id, property_id, match, pattern, facet, tag, weight) VALUES ($1,$2,$3,'path_prefix','/services/web','service','web',5)`,
        [newId(), tenant, propertyId],
      );
    }, S);
    // V3-h's erase path: the REAL collector (env settings), a short lock wait. No `insights` override = insightsSettings().
    setVisitorEraseDepsForTests({ lockWaitMs: 5000, lockPollMs: 50 });
    app = await buildApp();
  }, 90_000);

  afterAll(async () => {
    // Hygiene: whatever happened above, leave none of this run's visitors in the collector (idempotent; a failure here is not a verdict).
    try {
      await forgetAtCollector(WEBSITE, {
        visitorIds: [A.visitorId, B.visitorId, C.visitorId], consentIds: [A.consentId, B.consentId, C.consentId],
      }, "withdraw");
    } catch { /* the collector may be down; the verdict is in the cases */ }
    setVisitorEraseDepsForTests(null);
    if (app) await app.close();
    await teardownTestDb();
  }, 60_000);

  // ── 1 ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  it("1. a CONSENTED visitor: the real collector's events become an ERP profile with its events, interests and score; the collector keeps its buffer", async () => {
    consent.record(A.consentId, true, "grant");
    const posted = await postV(A);
    expect(posted.status, posted.body).toBe(204);
    await sleep(SETTLE_MS);
    // positive control on the collector: the three events are really buffered and visible to the ERP's read key
    const before = await opsEventsOf(A);
    expect(before.map((e) => e.name ?? e.kind).sort()).toEqual(["cta_click", "pageview", "section_view"]);

    const r = only<IngestPropertyResult>(await runVisitorIngest(deps()));
    expect(r.outcome).toBe("ok");
    expect(r.profilesCreated).toBeGreaterThanOrEqual(1);
    expect(r.eventsInserted).toBeGreaterThanOrEqual(3);

    const p = (await profileOf(A))!;
    expect(p, "A must have a profile").not.toBeNull();
    expect(p.consent_id).toBe(A.consentId);
    expect(p.device).toBe("desktop");
    expect(p.visits).toBe(1);
    expect(p.pageviews).toBe(1);
    const parts = p.score_parts as Record<string, number>;
    expect(Number(p.score)).toBe(parts.recency + parts.frequency + parts.depth + parts.intent);
    expect(parts).toEqual({ recency: 25, frequency: 0, depth: 5, intent: 10 }); // fresh visit; one /services/web rule; one cta_click
    expect(p.interests).toEqual({ service: [{ tag: "web", score: 5 }] });
    const evs = await profileEvents(A);
    expect(evs.map((e) => e.name ?? e.kind).sort()).toEqual(["cta_click", "pageview", "section_view"]);
    expect(evs.find((e) => e.name === "section_view")!.data).toEqual({ section_id: "pricing.plans" });
    expect(evs.find((e) => e.name === "cta_click")!.data).toEqual({ link_location: "hero" });
    expect(await cursor()).toBeGreaterThan(0);
    expect(await tombstones(A.visitorId)).toEqual([]);

    // a consented visitor is NOT forgotten: the collector still holds A's rows (the 72 h buffer)
    expect((await opsEventsOf(A)).length).toBe(3);
    aIngested = true;
  }, CASE_TIMEOUT);

  // ── 2 ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  it("2. a FORGED / ABSENT consent id: no profile, an ERP tombstone, and the collector forgot the visitor (ops read empty, /v answers 410)", async () => {
    // B's consent id is not in WebDesk's log (the fake answers nothing for it): the browser claimed a consent it cannot prove.
    const posted = await postV(B);
    expect(posted.status, posted.body).toBe(204);
    await sleep(SETTLE_MS);
    expect((await opsEventsOf(B)).length, "positive control: B's events are buffered before the ingest").toBe(3);

    const r = only<IngestPropertyResult>(await runVisitorIngest(deps()));
    expect(r.outcome).toBe("ok");
    expect(r.skippedNoConsent).toBeGreaterThanOrEqual(3);
    expect(r.forgetCalls).toBeGreaterThanOrEqual(1);

    // ERP: nothing ingested for B, and the visitor id is tombstoned (V3-d hash contract).
    expect(await profileOf(B)).toBeNull();
    expect((await profileEvents(B)).length).toBe(0);
    expect(await tombstones(B.visitorId)).toEqual([{ kind: "visitor", reason: "withdraw" }]);
    // The earlier consented visitor is untouched by B's handling.
    expect(await profileOf(A)).not.toBeNull();

    // Collector: B's rows are gone from the real ops read, and its pair is refused with 410.
    expect(await opsEventsOf(B)).toEqual([]);
    const again = await postV(B);
    expect(again.status, again.body).toBe(410);
    expect(again.body).toContain("visitor-forgotten");
    // the consent id alone is tombstoned too (a fresh visitor id on B's forged consent id is refused)
    const viaConsent = await postV({ visitorId: randomUUID(), consentId: B.consentId });
    expect(viaConsent.status, viaConsent.body).toBe(410);
  }, CASE_TIMEOUT);

  // ── 3 ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  it("3. WITHDRAWAL: A's latest record flips to `update analytics:false`; the sweep deletes the profile and events, tombstones, and the collector forgets A; a later ingest creates nothing", async () => {
    expect(aIngested, "case 1 must have ingested A (run the file whole)").toBe(true);
    expect(await profileOf(A)).not.toBeNull();
    expect((await opsEventsOf(A)).length).toBe(3);

    consent.record(A.consentId, false, "update"); // the LATEST record is a withdrawal (never read from `action`: analytics is what counts)
    const s = only<SweepPropertyResult>(await runVisitorSweep(deps()));
    expect(s.outcome).toBe("ok");
    expect(s.withdrawnProfiles).toBe(1);
    expect(s.forgetOutcome, "the forget must be delivered, not queued").toBeNull();
    expect(s.forgetCalls).toBeGreaterThanOrEqual(1);

    // ERP: profile and (cascaded) events gone, visitor id tombstoned.
    expect(await profileOf(A)).toBeNull();
    expect((await profileEvents(A)).length).toBe(0);
    expect(await eventsOfPropertyCount()).toBe(0);
    expect(await tombstones(A.visitorId)).toEqual([{ kind: "visitor", reason: "withdraw" }]);

    // Collector: A's events gone from the real ops read; the pair is refused.
    expect(await opsEventsOf(A)).toEqual([]);
    const again = await postV(A);
    expect(again.status, again.body).toBe(410);

    // A later ingest creates nothing — with WebDesk still saying withdrawn, and (the stale-answer case) even if it said granted again:
    // the tombstone, not the consent log, is what stands in the way.
    const later = only<IngestPropertyResult>(await runVisitorIngest(deps()));
    expect(later.profilesCreated).toBe(0);
    expect(later.eventsInserted).toBe(0);
    consent.record(A.consentId, true, "grant");
    const stale = only<IngestPropertyResult>(await runVisitorIngest(deps()));
    expect(stale.profilesCreated).toBe(0);
    expect(stale.eventsInserted).toBe(0);
    expect(await profileOf(A)).toBeNull();
    expect(await opsEventsOf(A)).toEqual([]);
  }, CASE_TIMEOUT);

  // ── 4 ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  it("4. ERASE BY EMAIL (V3-h): a consented, ingested visitor linked to a lead; the approved erase deletes the profile, tombstones both ids (erase), the ledger says delivered with counts, the collector refuses the pair, and a later ingest creates nothing", async () => {
    const email = `rina.${rand}@v3k-subject.test`;
    consent.record(C.consentId, true, "grant");
    const posted = await postV(C);
    expect(posted.status, posted.body).toBe(204);
    await sleep(SETTLE_MS);
    const ing = only<IngestPropertyResult>(await runVisitorIngest(deps()));
    expect(ing.outcome).toBe("ok");
    expect(await profileOf(C), "C must be ingested before the erase").not.toBeNull();
    expect((await profileEvents(C)).length).toBe(3);
    expect((await opsEventsOf(C)).length).toBe(3);
    const lead = await insertLead({ email, consentId: C.consentId });

    const { approvalId } = await fileAndDecide("erase", { email });
    const run = await call(admin, "erase", { email, approvalId });
    expect(run.statusCode, run.body).toBe(200);
    const out = run.json() as { counts: Record<string, unknown>; collector: string };
    expect(out.counts).toMatchObject({
      leadCount: 1, profileCount: 1, profileEventCount: 3, tombstoneCount: 2, // visitor id + consent id, one property
      collectorForget: "delivered", collectorForgetCalls: 1,
    });
    expect(Number(out.counts.collectorDeletedEvents)).toBeGreaterThanOrEqual(3);
    expect(out.collector).toMatch(/confirmed the erase/);

    // ERP: profile and events gone; both ids tombstoned with reason 'erase'; the lead scrubbed, its snapshot kept without the consent id.
    expect(await profileOf(C)).toBeNull();
    expect((await profileEvents(C)).length).toBe(0);
    expect(await tombstones(C.visitorId)).toEqual([{ kind: "visitor", reason: "erase" }]);
    expect(await tombstones(C.consentId)).toEqual([{ kind: "consent", reason: "erase" }]);
    const l = (await adminPool().query(`SELECT contact_email, visitor_consent FROM agency_leads WHERE id = $1`, [lead])).rows[0];
    expect(l.contact_email).toBeNull();
    expect(l.visitor_consent).toEqual({ analytics: true, marketing: false, version: "3", decided_at: "2026-10-12T09:00:00Z" });
    // The ledger row: forget delivered, with counts, hashes only.
    const row = (await adminPool().query(`SELECT * FROM agency_dsr_requests WHERE approval_id = $1 AND phase = 'executed'`, [approvalId])).rows[0] as Record<string, unknown>;
    expect(row).toMatchObject({ kind: "erase", profile_count: 1, profile_event_count: 3, tombstone_count: 2, collector_forget: "delivered", collector_forget_calls: 1 });
    expect(Number(row.collector_deleted_events)).toBeGreaterThanOrEqual(3);

    // Collector: C's rows gone from the real ops read; the pair, the visitor id alone and the consent id alone are all refused.
    expect(await opsEventsOf(C)).toEqual([]);
    const pair = await postV(C);
    expect(pair.status, pair.body).toBe(410);
    expect((await postV({ visitorId: C.visitorId, consentId: randomUUID() })).status).toBe(410);
    expect((await postV({ visitorId: randomUUID(), consentId: C.consentId })).status).toBe(410);

    // A later ingest (WebDesk still says granted; the browser kept sending and was refused) creates nothing.
    const later = only<IngestPropertyResult>(await runVisitorIngest(deps()));
    expect(later.profilesCreated).toBe(0);
    expect(later.eventsInserted).toBe(0);
    expect(await profileOf(C)).toBeNull();
    expect(await opsEventsOf(C)).toEqual([]);
  }, CASE_TIMEOUT);
});
