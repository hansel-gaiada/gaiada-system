// DW-6n n3, n4 and n5 (docs/FRONTEND-BFF-CONTRACT.md §40.5.3 and §40.5.6): the SEO department's readers, called DIRECTLY with
// a ReaderCtx against live Postgres + RLS + the `search` module wall. Zone Asia/Makassar (UTC+8): window Sep 1 .. Sep 30 2026
// is [2026-08-31T16:00:00Z, 2026-09-30T16:00:00Z). Scope is C(u): clients with a live project in S(u), never internal.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { config } from "../../../../config";
import { newId, withTenants } from "../../../../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../../../../testing/setup";
import { createClient, createCompany, createProject } from "../../../../testing/fixtures";
import { rebuildOrgUnitClosure } from "../../../../core/org-unit-closure";
import type { ReaderCtx } from "../types";
import { adBudgetsOnPace, clientReportsOnTime, clientsRankingGrowth } from "./search";

const SEARCH = { modules: ["search"] };

describe.skipIf(!TEST_URL)("DW-6n n3 / n4 / n5 SEO readers (live PG + RLS + search wall)", () => {
  let co: string;
  let other: string;
  let off: string; // a tenant without the search module: no search rows at all
  let savedTz: string;
  const tree = {
    id: "d-corp", kind: "company", name: "Corp",
    children: [
      { id: "d-seo", kind: "department", name: "SEO", children: [{ id: "dv-tech", kind: "division", name: "Technical", children: [] }] },
      { id: "d-web", kind: "department", name: "Web", children: [] },
      { id: "d-empty", kind: "department", name: "Empty", children: [] },
    ],
  };
  const ctx = (over: Partial<ReaderCtx> = {}): ReaderCtx => ({
    tenantId: co, unitId: "d-seo", periodKind: "month", start: "2026-09-01", end: "2026-09-30", asOf: "2026-09-20", ...over,
  });

  type Client = { id: string; property: string; engagement: string };
  /** A client, optionally with a live project in `dept`, a search property and a search engagement. */
  async function mkClient(tenant: string, name: string, dept: string | null, opts: { internal?: boolean } = {}): Promise<Client> {
    const id = await createClient(tenant, name);
    if (dept) {
      const project = await createProject(tenant, `${name} project`, undefined, id);
      await withTenants([tenant], (c) => c.query(`UPDATE projects SET department_id = $2 WHERE id = $1`, [project, dept]));
    }
    if (opts.internal) await withTenants([tenant], (c) => c.query(`UPDATE clients SET is_internal = true WHERE id = $1`, [id]));
    const property = newId();
    const engagement = newId();
    await withTenants([tenant], async (c) => {
      await c.query(`INSERT INTO search_properties (id, tenant_id, client_id, domain, site_url) VALUES ($1,$2,$3,$4,$5)`, [property, tenant, id, `${property}.test`, `https://${property}.test`]);
      await c.query(`INSERT INTO search_engagements (id, tenant_id, client_id, property_id, name) VALUES ($1,$2,$3,$4,'eng')`, [engagement, tenant, id, property]);
    }, SEARCH);
    return { id, property, engagement };
  }

  // ── n3 helpers ──
  async function keyword(tenant: string, cl: Client): Promise<string> {
    const set = newId();
    const kw = newId();
    await withTenants([tenant], async (c) => {
      await c.query(`INSERT INTO search_keyword_sets (id, tenant_id, engagement_id, name) VALUES ($1,$2,$3,'set')`, [set, tenant, cl.engagement]);
      await c.query(`INSERT INTO search_keywords (id, tenant_id, set_id, keyword) VALUES ($1,$2,$3,$4)`, [kw, tenant, set, `kw-${kw}`]);
    }, SEARCH);
    return kw;
  }
  async function snap(tenant: string, cl: Client, kw: string, at: string, position: number | null, o: { engine?: string; device?: string; simulated?: boolean } = {}) {
    await withTenants([tenant], (c) =>
      c.query(
        `INSERT INTO search_rank_snapshots (id, tenant_id, property_id, keyword_id, engine, device, captured_at, position, simulated, origin_site)
         VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz,$8,$9,$10)`,
        [newId(), tenant, cl.property, kw, o.engine ?? "google", o.device ?? "desktop", at, position, o.simulated ?? false, config.originSite],
      ), SEARCH);
  }

  // ── n4 helper ──
  async function report(tenant: string, cl: Client, period: string | null, deliveredAt: string | null, deleted = false) {
    await withTenants([tenant], (c) =>
      c.query(
        `INSERT INTO search_reports (id, tenant_id, engagement_id, period, kind, status, delivered_at, origin_site, deleted_at)
         VALUES ($1,$2,$3,$4,'monthly',$5,$6::timestamptz,$7,$8::timestamptz)`,
        [newId(), tenant, cl.engagement, period, deliveredAt ? "delivered" : "draft", deliveredAt, config.originSite, deleted ? "2026-09-02T00:00:00Z" : null],
      ), SEARCH);
  }

  // ── n5 helper ──
  async function campaign(tenant: string, cl: Client, o: {
    budget: number | null; currency?: string; status?: string; deleted?: boolean;
    rows: { date: string; cost: number; currency?: string; simulated?: boolean }[];
  }) {
    const id = newId();
    await withTenants([tenant], async (c) => {
      await c.query(
        `INSERT INTO search_campaigns (id, tenant_id, engagement_id, name, status, budget_minor, currency, origin_site, deleted_at)
         VALUES ($1,$2,$3,'camp',$4,$5,$6,$7,$8::timestamptz)`,
        [id, tenant, cl.engagement, o.status ?? "live", o.budget, o.currency ?? "IDR", config.originSite, o.deleted ? "2026-09-02T00:00:00Z" : null],
      );
      for (const r of o.rows) {
        await c.query(
          `INSERT INTO search_campaign_metrics_daily (id, tenant_id, campaign_id, date, cost_minor, currency, simulated, origin_site)
           VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8)`,
          [newId(), tenant, id, r.date, r.cost, r.currency ?? o.currency ?? "IDR", r.simulated ?? false, config.originSite],
        );
      }
    }, SEARCH);
  }

  beforeAll(async () => {
    await initTestDb();
    savedTz = config.reportsTz;
    config.reportsTz = "Asia/Makassar";
    co = await createCompany("DW-6n d Co", ["search"]);
    other = await createCompany("DW-6n d Other", ["search"]);
    off = await createCompany("DW-6n d Off", []);
    await withTenants([co], (c) => rebuildOrgUnitClosure(c, co, tree));

    // clients: in S(u) directly (A, D, E, F), in a child unit (B), and never counted (outside unit, internal, no project)
    const A = await mkClient(co, "A", "d-seo");
    const B = await mkClient(co, "B", "dv-tech");
    const D = await mkClient(co, "D", "d-seo");
    const E = await mkClient(co, "E", "d-seo");
    const F = await mkClient(co, "F", "d-seo");
    const Cweb = await mkClient(co, "Cweb", "d-web");
    const Int = await mkClient(co, "Internal", "d-seo", { internal: true });
    const NoProj = await mkClient(co, "NoProj", null);
    const O = await mkClient(other, "Other", "d-seo");

    // ═══ n3 ═══
    // A: end-instant snapshot (pos 20) is NOT in the window; the last one before it is pos 5; start is Aug 20 pos 10 -> grew.
    // A's mobile keyword was found at the start and lost at the end: not counted. A simulated snapshot is ignored.
    const kA = await keyword(co, A);
    await snap(co, A, kA, "2026-08-20T00:00:00Z", 10);
    await snap(co, A, kA, "2026-09-15T00:00:00Z", 5);
    await snap(co, A, kA, "2026-09-20T00:00:00Z", 1, { simulated: true });
    await snap(co, A, kA, "2026-09-30T16:00:00Z", 20);
    await snap(co, A, kA, "2026-08-20T00:00:00Z", 3, { device: "mobile" });
    await snap(co, A, kA, "2026-09-15T00:00:00Z", null, { device: "mobile" });
    // B (child unit): a snapshot at exactly the first instant IS the start (pos 9, not Aug 20's 5); end pos 7 -> grew.
    const kB = await keyword(co, B);
    await snap(co, B, kB, "2026-08-20T00:00:00Z", 5);
    await snap(co, B, kB, "2026-08-31T16:00:00Z", 9);
    await snap(co, B, kB, "2026-09-20T00:00:00Z", 7);
    // D: no snapshot at or before the start: not counted. E: unchanged (4 -> 4): counted, did not grow. F: worse (3 -> 6).
    const kD = await keyword(co, D);
    await snap(co, D, kD, "2026-09-10T00:00:00Z", 3);
    const kE = await keyword(co, E);
    await snap(co, E, kE, "2026-08-01T00:00:00Z", 4);
    await snap(co, E, kE, "2026-09-10T00:00:00Z", 4);
    const kF = await keyword(co, F);
    await snap(co, F, kF, "2026-08-20T00:00:00Z", 3);
    await snap(co, F, kF, "2026-09-20T00:00:00Z", 6);
    // never counted: a client of the sibling unit, an internal client, a client with no project, another tenant
    for (const [t, cl] of [[co, Cweb], [co, Int], [co, NoProj], [other, O]] as const) {
      const k = await keyword(t, cl);
      await snap(t, cl, k, "2026-08-20T00:00:00Z", 10);
      await snap(t, cl, k, "2026-09-20T00:00:00Z", 2);
    }

    // ═══ n4 ═══ (period 2026-08 is due Sep 5, end of day in the zone = 2026-09-05T16:00:00Z, exclusive)
    await report(co, A, "2026-08", "2026-09-05T15:59:59Z"); // on time, last second
    await report(co, A, "2026-08", "2026-09-05T16:00:00Z"); // one second late
    await report(co, B, "2026-08", "2026-09-01T00:00:00Z"); // child unit, on time
    await report(co, D, "2026-08", null); // not delivered, due Sep 5 <= asOf: counted, late
    await report(co, E, "2026-07", "2026-08-04T00:00:00Z"); // due Aug 5: outside the September window
    await report(co, F, "2026-09", null); // due Oct 5: outside the window
    await report(co, F, "adhoc", "2026-09-02T00:00:00Z"); // no YYYY-MM period: no due date
    await report(co, F, "2026-08", "2026-09-02T00:00:00Z", true); // deleted
    await report(co, Cweb, "2026-08", "2026-09-02T00:00:00Z");
    await report(co, Int, "2026-08", "2026-09-02T00:00:00Z");
    await report(co, NoProj, "2026-08", "2026-09-02T00:00:00Z");
    await report(other, O, "2026-08", "2026-09-02T00:00:00Z");

    // ═══ n5 ═══ budget 3,000,000/month; at asOf Sep 20 expected is 2,000,000 (on pace 1,800,000 .. 2,200,000)
    await campaign(co, A, { budget: 3_000_000, rows: [ // P1: 1,800,000 exactly. The simulated row and the Sep 21 row are ignored.
      { date: "2026-09-01", cost: 900_000 }, { date: "2026-09-20", cost: 900_000 },
      { date: "2026-09-05", cost: 5_000_000, simulated: true }, { date: "2026-09-21", cost: 9_999_999 },
    ] });
    await campaign(co, B, { budget: 3_000_000, rows: [{ date: "2026-09-02", cost: 2_200_000 }] }); // P2: 2,200,000 exactly (child unit)
    await campaign(co, A, { budget: 3_000_000, rows: [{ date: "2026-09-02", cost: 2_200_001 }] }); // P3: just over
    await campaign(co, A, { budget: 3_000_000, rows: [{ date: "2026-09-02", cost: 1_799_999 }] }); // P4: just under
    await campaign(co, A, { budget: 3_000_000, rows: [{ date: "2026-08-31", cost: 2_000_000 }] }); // P5: no row in the month
    await campaign(co, A, { budget: 3_000_000, rows: [{ date: "2026-09-02", cost: 2_000_000, currency: "USD" }] }); // P6: currency mismatch
    await campaign(co, A, { budget: 3_000_000, rows: [{ date: "2026-09-02", cost: 2_000_000, simulated: true }] }); // P7: simulated only
    await campaign(co, A, { budget: 3_000_000, status: "paused", rows: [{ date: "2026-09-02", cost: 2_000_000 }] }); // P8
    await campaign(co, A, { budget: 0, rows: [{ date: "2026-09-02", cost: 2_000_000 }] }); // P9: no budget
    await campaign(co, A, { budget: 3_000_000, deleted: true, rows: [{ date: "2026-09-02", cost: 2_000_000 }] }); // P10
    await campaign(co, Cweb, { budget: 3_000_000, rows: [{ date: "2026-09-02", cost: 2_000_000 }] }); // P11: sibling unit
    await campaign(co, Int, { budget: 3_000_000, rows: [{ date: "2026-09-02", cost: 2_000_000 }] }); // P12: internal client
    await campaign(other, O, { budget: 3_000_000, rows: [{ date: "2026-09-02", cost: 2_000_000 }] }); // P13: other tenant

    // the tenant without the search module: a client in the department, no search rows
    await mkNoSearchClient();
  }, 120_000);

  async function mkNoSearchClient() {
    const id = await createClient(off, "OffClient");
    const project = await createProject(off, "off project", undefined, id);
    await withTenants([off], (c) => c.query(`UPDATE projects SET department_id = 'd-seo' WHERE id = $1`, [project]));
  }

  afterAll(async () => {
    config.reportsTz = savedTz;
    await teardownTestDb();
  });

  // ═══════════════════════════════ n3 ═══════════════════════════════

  it("n3: clients whose mean tracked position fell over the window (A, B grew; E tied; F worse; D has no start) -> 2 of 4", async () => {
    expect(await clientsRankingGrowth(ctx())).toEqual({ value: 2 / 4, numerator: 2, denominator: 4 });
  });

  it("n3: sibling unit, internal client, no-project client and another tenant never count; a sibling unit reads its own", async () => {
    expect(await clientsRankingGrowth(ctx({ unitId: "d-web" }))).toEqual({ value: 1, numerator: 1, denominator: 1 });
    expect(await clientsRankingGrowth(ctx({ tenantId: other }))).toEqual({ value: 1, numerator: 1, denominator: 1 });
    expect(await clientsRankingGrowth(ctx({ unitId: "dv-tech" }))).toEqual({ value: 1, numerator: 1, denominator: 1 });
  });

  it("n3: null for an empty unit, a window before any snapshot, and a tenant without the search module (no error)", async () => {
    expect(await clientsRankingGrowth(ctx({ unitId: "d-empty" }))).toBeNull();
    expect(await clientsRankingGrowth(ctx({ start: "2026-01-01", end: "2026-01-31" }))).toBeNull();
    expect(await clientsRankingGrowth(ctx({ tenantId: off }))).toBeNull();
  });

  // ═══════════════════════════════ n4 ═══════════════════════════════

  it("n4: reports due in the window, delivered or already due, delivered by the end of the 5th in the zone -> 2 of 4", async () => {
    expect(await clientReportsOnTime(ctx())).toEqual({ value: 2 / 4, numerator: 2, denominator: 4 });
  });

  it("n4: the due date is an inclusive date edge (Sep 5 holds all four; Sep 1-4 and Sep 6-30 hold none)", async () => {
    expect(await clientReportsOnTime(ctx({ start: "2026-09-05", end: "2026-09-05" }))).toEqual({ value: 2 / 4, numerator: 2, denominator: 4 });
    expect(await clientReportsOnTime(ctx({ start: "2026-09-01", end: "2026-09-04" }))).toBeNull();
    expect(await clientReportsOnTime(ctx({ start: "2026-09-06", end: "2026-09-30" }))).toBeNull();
  });

  it("n4: an earlier month's report is that month's number; an undelivered report counts only once due (asOf)", async () => {
    expect(await clientReportsOnTime(ctx({ start: "2026-08-01", end: "2026-08-31", asOf: "2026-08-31" }))).toEqual({ value: 1, numerator: 1, denominator: 1 });
    // F's 2026-09 report is due Oct 5 and undelivered
    expect(await clientReportsOnTime(ctx({ start: "2026-10-01", end: "2026-10-31", asOf: "2026-10-04" }))).toBeNull();
    expect(await clientReportsOnTime(ctx({ start: "2026-10-01", end: "2026-10-31", asOf: "2026-10-05" }))).toEqual({ value: 0, numerator: 0, denominator: 1 });
  });

  it("n4: another tenant, the sibling unit and a tenant without the search module", async () => {
    expect(await clientReportsOnTime(ctx({ tenantId: other }))).toEqual({ value: 1, numerator: 1, denominator: 1 });
    expect(await clientReportsOnTime(ctx({ unitId: "d-web" }))).toEqual({ value: 1, numerator: 1, denominator: 1 });
    expect(await clientReportsOnTime(ctx({ unitId: "d-empty" }))).toBeNull();
    expect(await clientReportsOnTime(ctx({ tenantId: off }))).toBeNull();
  });

  // ═══════════════════════════════ n5 ═══════════════════════════════

  it("n5: 0.9 and 1.1 of the expected spend are on pace, one minor unit beyond is not -> 2 of 4", async () => {
    expect(await adBudgetsOnPace(ctx())).toEqual({ value: 2 / 4, numerator: 2, denominator: 4 });
  });

  it("n5: judged month-to-date at asOf (Sep 10 expects 1,000,000: only the first campaign's 900,000 is on pace)", async () => {
    expect(await adBudgetsOnPace(ctx({ asOf: "2026-09-10" }))).toEqual({ value: 1 / 4, numerator: 1, denominator: 4 });
  });

  it("n5: null when the month has no counted campaign (October), for an empty unit, and without the search module", async () => {
    expect(await adBudgetsOnPace(ctx({ asOf: "2026-10-01", start: "2026-10-01", end: "2026-10-31" }))).toBeNull();
    expect(await adBudgetsOnPace(ctx({ unitId: "d-empty" }))).toBeNull();
    expect(await adBudgetsOnPace(ctx({ tenantId: off }))).toBeNull();
  });

  it("n5: the sibling unit's and another tenant's campaign are theirs alone", async () => {
    expect(await adBudgetsOnPace(ctx({ unitId: "d-web" }))).toEqual({ value: 1, numerator: 1, denominator: 1 });
    expect(await adBudgetsOnPace(ctx({ tenantId: other }))).toEqual({ value: 1, numerator: 1, denominator: 1 });
  });
});
