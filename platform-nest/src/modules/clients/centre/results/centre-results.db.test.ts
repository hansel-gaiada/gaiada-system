// PV6-02 — Services & results, real-DB proofs: the five builders against seeded rows, the composer's three outcomes
// (offered / not offered / unavailable), the module wall, the `simulated` filter, and both HTTP routes (staff and
// portal, including the client-wide predicate and the staff/portal parity). Needs DATABASE_URL_TEST + a live Cerbos
// (skips silently otherwise: check the skip count before believing a green run).
//
// Every seeded date is relative to NOW (the test's clock, handed to the composer as `now`), so the windows
// (30 days for social/ads/analytics/website, 28 for search) never drift from the data. Rows are seeded with the admin
// pool (RLS bypass) so the module tables can be filled without enabling anything; the READS under test go through the
// app role and the real module wall.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../../../config";
import { buildApp } from "../../../../main";
import { newId, withTenants } from "../../../../db";
import { resetModules } from "../../../registry";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../../../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient, createProject } from "../../../../testing/fixtures";
import { composeBusinessResults, RESULTS_BUILDERS } from "./compose";
import { makeAnalyticsBuilder } from "./analytics";
import type { BusinessResults, Kpi, ResultsBuilder, ServiceCard } from "./types";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

const NOW = new Date();
const DAY = 86_400_000;
/** ISO date n days before NOW (UTC). */
const d = (n: number): string => new Date(NOW.getTime() - n * DAY).toISOString().slice(0, 10);
/** A timestamp n days before NOW, at noon UTC. */
const ts = (n: number): string => `${d(n)}T12:00:00Z`;
/** An instant `n` whole days (plus a 6 hour margin, so a clock a few seconds later still floors to n) after NOW. */
const ahead = (n: number): string => new Date(NOW.getTime() + n * DAY + 6 * 3_600_000).toISOString();

/** The real builders, with Umami pinned off so the run does not depend on the host's environment. */
const BUILDERS: ResultsBuilder[] = RESULTS_BUILDERS.map((b) => (b.service === "analytics" ? makeAnalyticsBuilder(() => null) : b));
const compose = (tenant: string, client: string, deps = {}) => composeBusinessResults(tenant, client, { now: NOW, builders: BUILDERS, ...deps });

const cardsOf = (r: BusinessResults, service: string): ServiceCard[] => r.services.filter((s) => s.service === service);
const kpiOf = (card: ServiceCard, key: string): Kpi => {
  const k = card.kpis.find((x) => x.key === key);
  if (!k) throw new Error(`no KPI ${key} on ${card.service}: ${card.kpis.map((x) => x.key).join(",")}`);
  return k;
};

describe.skipIf(!TEST_URL)("Client Centre · Services & results (PV6-02)", () => {
  let app: NestFastifyApplication;
  let T: string;          // company with every service module enabled
  let T2: string;         // company with clients + search + webdev only (no social, no monitoring)
  let T3: string;         // company with NO clients module (the staff route is 404)
  let clientA: string;    // the client with data in every service
  let clientB: string;    // another client of T, with data of its own (the leak counterparty)
  let clientC: string;    // a client with an engagement but no metrics (unknown, never 0), and a WebDesk link
  let client2: string;    // a client of T2 with social + search + website + monitor rows
  let staffAdmin: string;
  let staffViewer: string;
  let outsider: string;
  let wideSigner: string;    // client A, client-wide signer
  let wideViewer: string;    // client A, client-wide viewer
  let scoped: string;        // client A, PROJECT-scoped signer
  let legacy: string;        // client L via clients.portal_user_id
  let contactB: string;      // client B
  let clientL: string;
  let projectA: string;
  let admin: ReturnType<typeof adminPool>;
  const ids: Record<string, string> = {};

  async function sql(q: string, p: unknown[] = []) {
    return admin.query(q, p);
  }

  async function seedSocial(tenant: string, client: string, opts: { metrics: boolean; handle: string }) {
    const org = newId();
    await sql(`INSERT INTO social_publisher_orgs (id, tenant_id, client_id, postiz_org_id, api_key_ref, origin_site) VALUES ($1,$2,$3,$4,'env:K','central')`, [org, tenant, client, `org-${client}`]);
    const acct = async (network: string, handle: string, status = "connected") => {
      const id = newId();
      await sql(`INSERT INTO social_accounts (id, tenant_id, client_id, publisher_org_id, network, handle, status, origin_site) VALUES ($1,$2,$3,$4,$5,$6,$7,'central')`, [id, tenant, client, org, network, handle, status]);
      return id;
    };
    const a1 = await acct("instagram", opts.handle);
    const a2 = await acct("linkedin", `${opts.handle}-li`);
    await acct("tiktok", `${opts.handle}-broken`, "error"); // an errored account is an internal matter: never listed
    const eng = newId();
    await sql(`INSERT INTO social_engagements (id, tenant_id, client_id, name, status, origin_site) VALUES ($1,$2,$3,'Growth','active','central')`, [eng, tenant, client]);
    if (opts.metrics) {
      await sql(`INSERT INTO social_kpi_targets (tenant_id, engagement_id, metric_key, target_value) VALUES ($1,$2,'followers_total',1000),($1,$2,'reach_month',5000)`, [tenant, eng]);
      const m = (acc: string, day: string, f: number | null, imp: number | null, reach: number | null, eng_: number | null, clicks: number | null) =>
        sql(`INSERT INTO social_metrics_daily (tenant_id, account_id, date, followers, impressions, reach, engagements, link_clicks) VALUES ($1,$2,$3::date,$4,$5,$6,$7,$8)`, [tenant, acc, day, f, imp, reach, eng_, clicks]);
      await m(a1, d(5), 500, 1000, 400, 50, 20);
      await m(a1, d(2), 520, null, 100, null, null);
      await m(a2, d(3), 200, null, null, null, null);
      await m(a1, d(40), 450, null, 300, null, null); // the previous window
      const post = async (day: string) => {
        const p = newId();
        await sql(`INSERT INTO social_posts (id, tenant_id, engagement_id, title, source, status, origin_site) VALUES ($1,$2,$3,'seeded','native_import','published','central')`, [p, tenant, eng]);
        await sql(`INSERT INTO social_post_variants (tenant_id, post_id, account_id, status, native_import, published_at, origin_site) VALUES ($1,$2,$3,'published',true,$4::timestamptz,'central')`, [tenant, p, a1, `${day}T10:00:00Z`]);
      };
      await post(d(4));
      await post(d(6));
      await post(d(40));
    }
    return eng;
  }

  async function seedSearch(tenant: string, client: string, domain: string, opts: { umami?: boolean; engagement?: boolean } = {}) {
    const prop = newId();
    await sql(`INSERT INTO search_properties (id, tenant_id, client_id, domain, site_url, umami_site_id, origin_site) VALUES ($1,$2,$3,$4,$5,$6,'central')`,
      [prop, tenant, client, domain, `https://${domain}`, opts.umami ? newId() : null]);
    const eng = newId();
    if (opts.engagement !== false) {
      await sql(`INSERT INTO search_engagements (id, tenant_id, client_id, property_id, name, status, origin_site) VALUES ($1,$2,$3,$4,'SEO programme','active','central')`, [eng, tenant, client, prop]);
    }
    return { prop, eng };
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    admin = adminPool();

    T = await createCompany("Results Co", ["clients", "social", "search", "webdev", "monitoring"]);
    T2 = await createCompany("Results Partial Co", ["clients", "search", "webdev"]);
    T3 = await createCompany("Results No Clients Co", ["social"]);

    staffAdmin = await createUser("results-admin@a.test");
    staffViewer = await createUser("results-viewer@a.test");
    outsider = await createUser("results-outsider@b.test");
    wideSigner = await createUser("results-wide-signer@acme.test");
    wideViewer = await createUser("results-wide-viewer@acme.test");
    scoped = await createUser("results-scoped@acme.test");
    legacy = await createUser("results-legacy@acme.test");
    contactB = await createUser("results-rival@rival.test");
    const ownerUser = await createUser("results-owner@a.test");
    for (const u of [staffAdmin, staffViewer, wideSigner, wideViewer, scoped, legacy, contactB, ownerUser]) await addMembership(T, u);
    await addMembership(T3, outsider);
    await grantRole(staffAdmin, await createRole("company_admin"), "company", T);
    await grantRole(staffViewer, await createRole("viewer"), "company", T);
    await grantRole(outsider, await createRole("company_admin"), "company", T3);
    const clientRole = await createRole("client");
    for (const u of [wideSigner, wideViewer, scoped, legacy, contactB]) await grantRole(u, clientRole, "company", T);

    clientA = await createClient(T, "Acme Inc");
    clientB = await createClient(T, "Rival Ltd");
    clientC = await createClient(T, "Quiet Co");
    clientL = await createClient(T, "Legacy Co", legacy);
    client2 = await createClient(T2, "Partial Client");
    projectA = await createProject(T, "Acme site", ownerUser);
    await withTenants([T], (c) => c.query(`UPDATE projects SET client_id = $2 WHERE id = $1`, [projectA, clientA]));
    const contact = (client: string, user: string, cap: "signer" | "viewer", project: string | null) =>
      withTenants([T], (c) => c.query(
        `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, project_id, capability, status, activated_at, origin_site) VALUES ($1,$2,$3,$4,$5,$6,'active',now(),'central')`,
        [newId(), T, client, user, project, cap]));
    await contact(clientA, wideSigner, "signer", null);
    await contact(clientA, wideViewer, "viewer", null);
    await contact(clientA, scoped, "signer", projectA);
    await contact(clientB, contactB, "signer", null);

    // ── client A: every service ───────────────────────────────────────────────────────────────────────────────
    ids.socialEngA = await seedSocial(T, clientA, { metrics: true, handle: "@acme" });
    const sa = await seedSearch(T, clientA, "a.example", { umami: true });
    ids.propA = sa.prop; ids.searchEngA = sa.eng;
    await sql(`INSERT INTO search_kpi_targets (tenant_id, engagement_id, metric_key, target_value) VALUES ($1,$2,'top10_keywords',5),($1,$2,'ai_citations',10)`, [T, sa.eng]);
    const set = newId();
    await sql(`INSERT INTO search_keyword_sets (id, tenant_id, engagement_id, name, origin_site) VALUES ($1,$2,$3,'tracked','central')`, [set, T, sa.eng]);
    const kw: string[] = [];
    for (const k of ["alpha", "beta", "gamma", "delta"]) {
      const id = newId();
      kw.push(id);
      await sql(`INSERT INTO search_keywords (id, tenant_id, set_id, keyword, locale, is_tracked, origin_site) VALUES ($1,$2,$3,$4,'en-US',true,'central')`, [id, T, set, k]);
    }
    const rank = (k: string, day: number, pos: number | null, simulated = false) =>
      sql(`INSERT INTO search_rank_snapshots (tenant_id, property_id, keyword_id, engine, device, captured_at, position, simulated) VALUES ($1,$2,$3,'google','desktop',$4::timestamptz,$5,$6)`, [T, sa.prop, k, ts(day), pos, simulated]);
    await rank(kw[0], 1, 3); await rank(kw[1], 1, 8); await rank(kw[2], 1, 15);
    await rank(kw[0], 40, 12); await rank(kw[1], 40, 7); // as the current window began: 1 keyword in the top 10
    await rank(kw[3], 1, 1, true);                       // SIMULATED: must change nothing
    const gsc = (day: number, q: string, clicks: number, impr: number, pos: number, simulated = false) =>
      sql(`INSERT INTO search_gsc_performance (tenant_id, property_id, date, query, page, clicks, impressions, position, row_hash, simulated) VALUES ($1,$2,$3::date,$4,'/p',$5,$6,$7,$8,$9)`, [T, sa.prop, d(day), q, clicks, impr, pos, newId(), simulated]);
    await gsc(10, "q1", 10, 100, 4); await gsc(9, "q2", 20, 300, 8);
    await gsc(35, "q1", 5, 50, 10);                       // previous 28-day window
    await gsc(8, "q-sim", 9999, 99999, 1, true);          // SIMULATED
    const ai = (day: number, cited: boolean, simulated = false) =>
      sql(`INSERT INTO search_ai_visibility (tenant_id, property_id, captured_at, engine, query, cited, simulated) VALUES ($1,$2,$3::timestamptz,'chatgpt','q',$4,$5)`, [T, sa.prop, ts(day), cited, simulated]);
    await ai(5, true); await ai(6, true); await ai(7, false); await ai(4, true, true);
    // paid search
    const camp = async (name: string, status: string) => {
      const id = newId();
      await sql(`INSERT INTO search_campaigns (id, tenant_id, engagement_id, name, status, platform, budget_minor, currency) VALUES ($1,$2,$3,$4,$5,'google_ads',777700,'USD')`, [id, T, sa.eng, name, status]);
      return id;
    };
    const live = await camp("Brand campaign", "live");
    const paused = await camp("Old campaign", "paused");
    const adm = (campaign: string, day: number, clicks: number, conv: number, value: number, simulated = false) =>
      sql(`INSERT INTO search_campaign_metrics_daily (tenant_id, campaign_id, date, impressions, clicks, cost_minor, currency, conversions, conv_value_minor, simulated) VALUES ($1,$2,$3::date,1000,$4,99999,'USD',$5,$6,$7)`, [T, campaign, d(day), clicks, conv, value, simulated]);
    await adm(live, 3, 100, 4, 150000); await adm(live, 2, 50, 1, 50000);
    await adm(live, 1, 7777, 77, 7777700, true);          // SIMULATED
    await adm(paused, 3, 5555, 55, 5555500);              // a paused campaign is not part of the live card
    // analytics: GA4 rows (real + simulated), and a second property bound only to Umami
    const ga = (day: number, channel: string, sessions: number, engaged: number, conv: number, simulated = false) =>
      sql(`INSERT INTO search_ga4_metrics (tenant_id, property_id, date, channel_group, sessions, engaged_sessions, conversions, simulated) VALUES ($1,$2,$3::date,$4,$5,$6,$7,$8)`, [T, sa.prop, d(day), channel, sessions, engaged, conv, simulated]);
    await ga(5, "Organic Search", 100, 60, 3); await ga(4, "Direct", 50, 30, 1); await ga(35, "Organic Search", 80, 40, 2);
    await ga(3, "Direct", 5000, 5000, 500, true);         // SIMULATED
    ids.propU = (await seedSearch(T, clientA, "umami-only.example", { umami: true, engagement: false })).prop;
    // website: a registered site with two probes, one open incident; plus probes that must not count
    await sql(`INSERT INTO webdev_sites (tenant_id, domain, client_id, origin_site) VALUES ($1,'a.example',$2,'site')`, [T, clientA]);
    const mon = async (client: string, name: string, kind: string, target: string, status: string, cert: number | null, dom: number | null) => {
      const id = newId();
      await sql(`INSERT INTO monitors (id, tenant_id, client_id, name, kind, target, status, severity, interval_sec, cert_expires_at, domain_expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,'ticket',60,$8,$9)`,
        [id, T, client, name, kind, target, status, cert === null ? null : ahead(cert), dom === null ? null : ahead(dom)]);
      return id;
    };
    const m1 = await mon(clientA, "web", "http", "https://www.a.example/", "up", 40, 100);
    const m2 = await mon(clientA, "tls", "tls", "a.example:443", "up", 20, null);
    await mon(clientA, "other site", "http", "https://elsewhere.example/", "down", 1, 1); // not this site
    await mon(clientB, "rival", "http", "https://a.example/", "down", 2, 2);              // another client's monitor
    for (const st of ["up", "up", "up", "down"]) {
      await sql(`INSERT INTO monitor_results (tenant_id, client_id, monitor_id, status, checked_at) VALUES ($1,$2,$3,$4,now() - interval '1 hour')`, [T, clientA, m1, st]);
    }
    await sql(`INSERT INTO monitor_incidents (tenant_id, client_id, monitor_id, opened_at) VALUES ($1,$2,$3,now() - interval '2 hour')`, [T, clientA, m1]);
    await sql(`INSERT INTO monitor_incidents (tenant_id, client_id, monitor_id, opened_at, closed_at) VALUES ($1,$2,$3,now() - interval '5 day', now() - interval '4 day')`, [T, clientA, m2]);

    // ── client B: its own data, which must never appear on A ──────────────────────────────────────────────────
    await seedSocial(T, clientB, { metrics: true, handle: "@rival-brand" });
    await seedSearch(T, clientB, "rival-only.example");
    await sql(`INSERT INTO webdev_sites (tenant_id, domain, client_id, origin_site) VALUES ($1,'rival-site.example',$2,'site')`, [T, clientB]);

    // ── client C: an engagement and accounts but NO pulled metrics; and a WebDesk-linked site ────────────────
    await seedSocial(T, clientC, { metrics: false, handle: "@quiet" });
    await sql(`INSERT INTO webdesk_site_clients (tenant_id, tenant_slug, site_id, client_id, origin_site) VALUES ($1,'tenantslug',$2,$3,'site')`, [T, newId(), clientC]);

    // ── T2: social data exists but the company has not enabled `social`; website without monitoring ───────────
    await seedSocial(T2, client2, { metrics: true, handle: "@partial" });
    await seedSearch(T2, client2, "partial.example");
    await sql(`INSERT INTO webdev_sites (tenant_id, domain, client_id, origin_site) VALUES ($1,'partial.example',$2,'site')`, [T2, client2]);
    const pm = newId();
    await sql(`INSERT INTO monitors (id, tenant_id, client_id, name, kind, target, status, severity, interval_sec) VALUES ($1,$2,$3,'w','http','https://partial.example/','up','ticket',60)`, [pm, T2, client2]);

    app = await buildApp();
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  // ═══════════════════════════════════════════════ the builders: correct numbers, null for unknown ═══════════
  describe("builders against seeded rows", () => {
    let r: BusinessResults;
    beforeAll(async () => { r = await compose(T, clientA); });

    it("returns every offered service for the client, nothing unavailable", () => {
      expect(r.visible).toBe(true);
      expect(r.clientId).toBe(clientA);
      expect(r.unavailable).toEqual([]);
      expect([...new Set(r.services.map((s) => s.service))]).toEqual(["social", "search", "search_ads", "analytics", "website"]);
      for (const s of r.services) expect(s.clientVisible).toBe(true);
    });

    it("social: one card, connected accounts only, figures through the report snapshot, previous and target filled", () => {
      const [card] = cardsOf(r, "social");
      expect(card).toMatchObject({ areaId: "mk_social", status: "active", title: "Social media" });
      expect(card.items.map((i) => i.label)).toEqual(["@acme", "@acme-li"]);          // the errored account is not listed
      const followers = kpiOf(card, "social.followers");
      expect(followers).toMatchObject({ value: 720, previous: 450, target: 1000, unit: "count" }); // 520 + 200; previous window 450
      expect(followers.period).toEqual({ from: d(29), to: d(0) });
      expect(kpiOf(card, "social.reach")).toMatchObject({ value: 500, previous: 300, target: 5000 });
      expect(kpiOf(card, "social.engagements")).toMatchObject({ value: 50, previous: null, target: null });
      expect(kpiOf(card, "social.link_clicks")).toMatchObject({ value: 20, previous: null });
      expect(kpiOf(card, "social.posts_published")).toMatchObject({ value: 2, previous: 1 });
    });

    it("social: an engagement with no pulled metrics reports null, never 0; posts published is a real 0", async () => {
      const q = await compose(T, clientC);
      const [card] = cardsOf(q, "social");
      for (const k of ["social.followers", "social.reach", "social.engagements", "social.link_clicks"]) {
        expect(kpiOf(card, k).value, k).toBeNull();
        expect(kpiOf(card, k).previous, k).toBeNull();
      }
      expect(kpiOf(card, "social.posts_published")).toMatchObject({ value: 0, previous: 0 });
    });

    it("search: top 10, GSC clicks/impressions/position and AI citations, with previous and targets; simulated rows excluded", () => {
      const [card] = cardsOf(r, "search");
      expect(card).toMatchObject({ areaId: "se", status: "active", title: "SEO" });
      expect(card.items).toEqual([{ label: "a.example", detail: null }]);
      expect(kpiOf(card, "search.top10_keywords")).toMatchObject({ value: 2, previous: 1, target: 5 }); // the simulated #1 is not counted
      expect(kpiOf(card, "search.organic_clicks")).toMatchObject({ value: 30, previous: 5, target: null });
      expect(kpiOf(card, "search.impressions")).toMatchObject({ value: 400, previous: 50 });
      expect(kpiOf(card, "search.avg_position")).toMatchObject({ value: 7, previous: 10, unit: "position" }); // (4*100 + 8*300) / 400
      expect(kpiOf(card, "search.ai_citations")).toMatchObject({ value: 2, previous: null, target: 10 });
      expect(kpiOf(card, "search.organic_clicks").period).toEqual({ from: d(27), to: d(0) });
    });

    it("search: a property with no tracked ranking, no Search Console rows and no AI snapshots is all null", async () => {
      const bare = await createClient(T, "Bare Search Co");
      await seedSearch(T, bare, "bare.example");
      const [card] = cardsOf(await compose(T, bare), "search");
      for (const k of card.kpis) { expect(k.value, k.key).toBeNull(); expect(k.previous, k.key).toBeNull(); }
    });

    it("paid search: only the live campaign, summed over the window; conversion value in major units of its one currency", () => {
      const [card] = cardsOf(r, "search_ads");
      expect(card).toMatchObject({ areaId: "mk_paid", title: "Paid search", status: "active" });
      expect(card.items).toEqual([{ label: "Brand campaign", detail: "Google Ads" }]);
      expect(kpiOf(card, "search_ads.clicks")).toMatchObject({ value: 150, previous: null });
      expect(kpiOf(card, "search_ads.conversions")).toMatchObject({ value: 5, previous: null });
      const value = kpiOf(card, "search_ads.conversion_value");
      expect(value).toMatchObject({ value: 2000, previous: null });
      expect(value.label).toBe("Conversion value (USD)");
    });

    it("paid search carries NO money field: the key set is pinned, and no cost, spend or budget figure appears anywhere", () => {
      const [card] = cardsOf(r, "search_ads");
      expect(Object.keys(card).sort()).toEqual(["areaId", "clientVisible", "items", "kpis", "service", "since", "status", "title"]);
      expect(card.kpis.map((k) => k.key)).toEqual(["search_ads.clicks", "search_ads.conversions", "search_ads.conversion_value"]);
      for (const k of card.kpis) expect(Object.keys(k).sort()).toEqual(["asOf", "key", "label", "period", "previous", "target", "unit", "value"]);
      const wire = JSON.stringify(card).toLowerCase();
      for (const word of ["cost", "spend", "budget", "bid", "cpa", "99999", "777700"]) expect(wire, word).not.toContain(word);
    });

    it("paid search: absent for a client with no live campaign", async () => {
      expect(cardsOf(await compose(T, clientB), "search_ads")).toEqual([]);
    });

    it("analytics: GA4 sums for the bound property; the Umami-only property is skipped when Umami is not configured", () => {
      const cards = cardsOf(r, "analytics");
      expect(cards).toHaveLength(1);                     // umami-only.example has nothing true to say without Umami
      const [card] = cards;
      expect(card.areaId).toBe("mk_analytics");
      expect(card.items[0].label).toBe("a.example");
      expect(kpiOf(card, "analytics.sessions")).toMatchObject({ value: 150, previous: 80 });
      expect(kpiOf(card, "analytics.engaged_sessions")).toMatchObject({ value: 90, previous: 40 });
      expect(kpiOf(card, "analytics.conversions")).toMatchObject({ value: 4, previous: 2 });
    });

    it("analytics: with Umami configured the Umami-only property reports its visits, and a suppressed cell is null, never 0", async () => {
      const umami = async (siteId: string, w: { from: string }) => (w.from === d(29) ? 42 : null);
      const res = await compose(T, clientA, { builders: RESULTS_BUILDERS.map((b) => (b.service === "analytics" ? makeAnalyticsBuilder(() => umami) : b)) });
      const cards = cardsOf(res, "analytics");
      expect(cards).toHaveLength(2);
      const u = cards.find((c) => c.items[0].label === "umami-only.example")!;
      expect(kpiOf(u, "analytics.sessions")).toMatchObject({ value: 42, previous: null });
      expect(kpiOf(u, "analytics.engaged_sessions").value).toBeNull();
      expect(kpiOf(u, "analytics.conversions").value).toBeNull();
      // the GA4-backed property did not call Umami for its sessions: GA4 wins
      expect(kpiOf(cards.find((c) => c.items[0].label === "a.example")!, "analytics.sessions").value).toBe(150);
    });

    it("website: the registered site, probes matched by host, uptime on the monitoring console's own SQL, expiry days, open incidents", () => {
      const [card] = cardsOf(r, "website");
      expect(card).toMatchObject({ areaId: "mk_web", title: "Website", status: "active" });
      expect(card.items).toEqual([{ label: "a.example", detail: "Online" }]);
      expect(kpiOf(card, "website.uptime_30d")).toMatchObject({ value: 75, unit: "percent", previous: null }); // 3 up of 4 checks
      expect(kpiOf(card, "website.open_incidents").value).toBe(1);                                              // the closed one is not counted
      expect(kpiOf(card, "website.cert_days").value).toBe(20);                                                  // the nearer of the two probes
      expect(kpiOf(card, "website.domain_days").value).toBe(100);
    });

    it("website: a WebDesk-linked site is listed with every probe figure null (the ERP holds no domain for it)", async () => {
      const [card] = cardsOf(await compose(T, clientC), "website");
      expect(card.title).toBe("Website content");
      expect(card.items).toEqual([{ label: "Managed website", detail: null }]);
      for (const k of card.kpis) expect(k.value, k.key).toBeNull();
    });

    it("a client never sees another client's rows, in any service", () => {
      const wire = JSON.stringify(r);
      for (const other of ["rival-only.example", "rival-site.example", "@rival-brand", "elsewhere.example"]) expect(wire, other).not.toContain(other);
    });
  });

  // ═══════════════════════════════════════════════ offered / not offered / unavailable ═══════════════════════
  describe("module enablement and failure", () => {
    it("a module the company has not enabled is absent, and unavailable stays empty", async () => {
      const r = await compose(T2, client2);
      expect(cardsOf(r, "social")).toEqual([]);          // social data exists, the company does not offer social
      expect(r.unavailable).toEqual([]);
      expect(cardsOf(r, "search")).toHaveLength(1);
      expect(cardsOf(r, "website")).toHaveLength(1);
    });

    it("website without the monitoring module: the card is there, every probe figure is null", async () => {
      const [card] = cardsOf(await compose(T2, client2), "website");
      expect(card.items).toEqual([{ label: "partial.example", detail: null }]);
      for (const k of card.kpis) expect(k.value, k.key).toBeNull();
    });

    it("a builder that throws is listed in unavailable and the other services still return", async () => {
      const boom: ResultsBuilder = { service: "search", requires: ["search"], async build() { throw new Error("relation does not exist"); } };
      const r = await compose(T, clientA, { builders: BUILDERS.map((b) => (b.service === "search" ? boom : b)) });
      expect(r.unavailable).toEqual(["search"]);
      expect(cardsOf(r, "search")).toEqual([]);
      expect([...new Set(r.services.map((s) => s.service))]).toEqual(["social", "search_ads", "analytics", "website"]);
      expect(JSON.stringify(r)).not.toContain("relation does not exist"); // the error text is logged, never returned
    });

    it("every builder runs under its module scope: with the scope removed the module wall returns zero rows", async () => {
      const unscoped = await compose(T, clientA, { read: (t: string, _modules: string[], fn: Parameters<typeof withTenants>[1]) => withTenants([t], fn) });
      expect(unscoped.services).toEqual([]);   // social, search, ads, analytics, website: every one of them lost its rows
      expect(unscoped.unavailable).toEqual([]);
      // and the scoped run of the SAME data is not empty, so the emptiness above is the wall and not the seed
      expect((await compose(T, clientA)).services.length).toBeGreaterThan(0);
    });

    it("a builder that declares the wrong module reads nothing (the wall is per module, not per request)", async () => {
      const wrong = await compose(T, clientA, { read: (t: string, _m: string[], fn: Parameters<typeof withTenants>[1]) => withTenants([t], fn, { modules: ["hr"] }) });
      expect(wrong.services).toEqual([]);
    });
  });

  // ═══════════════════════════════════════════════ staff route ═══════════════════════════════════════════════
  describe("GET /api/:t/clients/:clientId/centre/results (staff)", () => {
    const url = (t: string, c: string) => `/api/${t}/clients/${c}/centre/results`;

    it("a staff reader with `client` read gets the payload", async () => {
      const res = await app.inject({ method: "GET", url: url(T, clientA), headers: asUser(staffViewer) });
      expect(res.statusCode).toBe(200);
      const body = res.json() as BusinessResults;
      expect(body.visible).toBe(true);
      expect(body.services.length).toBeGreaterThan(0);
    });

    it("authorization runs before the client is looked at: an outsider is 403 even for a client that does not exist", async () => {
      expect((await app.inject({ method: "GET", url: url(T, clientA), headers: asUser(outsider) })).statusCode).toBe(403);
      expect((await app.inject({ method: "GET", url: url(T, newId()), headers: asUser(outsider) })).statusCode).toBe(403);
    });

    it("an unknown or malformed client id is 404 for an authorized reader", async () => {
      expect((await app.inject({ method: "GET", url: url(T, newId()), headers: asUser(staffAdmin) })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: url(T, "not-a-uuid"), headers: asUser(staffAdmin) })).statusCode).toBe(404);
    });

    it("another company's client id is 404 (the tenant wall)", async () => {
      expect((await app.inject({ method: "GET", url: url(T, client2), headers: asUser(staffAdmin) })).statusCode).toBe(404);
    });

    it("404s when the tenant has not enabled the clients module", async () => {
      expect((await app.inject({ method: "GET", url: url(T3, clientA), headers: asUser(outsider) })).statusCode).toBe(404);
    });

    it("an unauthenticated call is refused", async () => {
      expect([401, 403]).toContain((await app.inject({ method: "GET", url: url(T, clientA) })).statusCode);
    });
  });

  // ═══════════════════════════════════════════════ portal route ══════════════════════════════════════════════
  describe("GET /api/:t/portal/centre/:clientId/results (portal)", () => {
    const url = (t: string, c: string) => `/api/${t}/portal/centre/${c}/results`;
    const strip = (b: BusinessResults) => ({ ...b, generatedAt: "x" });

    it("a client-wide contact (signer or viewer) sees the cards", async () => {
      for (const u of [wideSigner, wideViewer]) {
        const res = await app.inject({ method: "GET", url: url(T, clientA), headers: asUser(u) });
        expect(res.statusCode).toBe(200);
        const body = res.json() as BusinessResults;
        expect(body.visible).toBe(true);
        expect(body.services.map((s) => s.service)).toContain("social");
      }
    });

    it("a project-scoped contact of the SAME client is in scope but not client-wide: 200 with visible:false and no services", async () => {
      const res = await app.inject({ method: "GET", url: url(T, clientA), headers: asUser(scoped) });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ clientId: clientA, visible: false, services: [], unavailable: [] });
    });

    it("a contact of another client gets 404 for this client, never 403 and never visible:false", async () => {
      const res = await app.inject({ method: "GET", url: url(T, clientA), headers: asUser(contactB) });
      expect(res.statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: url(T, newId()), headers: asUser(wideSigner) })).statusCode).toBe(404);
    });

    it("the legacy whole-client portal user is client-wide for their client", async () => {
      const res = await app.inject({ method: "GET", url: url(T, clientL), headers: asUser(legacy) });
      expect(res.statusCode).toBe(200);
      expect((res.json() as BusinessResults).visible).toBe(true);
    });

    it("staff (not a portal client at all) is refused", async () => {
      expect((await app.inject({ method: "GET", url: url(T, clientA), headers: asUser(staffAdmin) })).statusCode).toBe(403);
    });

    it("staff and portal payloads for the same client are equal (the parity test)", async () => {
      const staff = (await app.inject({ method: "GET", url: `/api/${T}/clients/${clientA}/centre/results`, headers: asUser(staffAdmin) })).json() as BusinessResults;
      const portal = (await app.inject({ method: "GET", url: url(T, clientA), headers: asUser(wideSigner) })).json() as BusinessResults;
      expect(portal.services.length).toBeGreaterThan(0);
      expect(strip(portal)).toEqual(strip(staff));
      // and both equal what the composer builds directly, so neither route adds or drops anything
      const direct = await composeBusinessResults(T, clientA);
      expect(strip(JSON.parse(JSON.stringify(direct)))).toEqual(strip(staff));
    });
  });
});
