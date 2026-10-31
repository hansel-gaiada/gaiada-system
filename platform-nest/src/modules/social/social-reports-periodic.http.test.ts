// SCP-5 W5-A2 — the periodic report kinds against REAL Postgres and REAL Cerbos, through the real HTTP layer (BFF §63.24.1 to §63.24.4,
// §63.30; plan §7 wave 5 row W5-A2; owner rulings SCP-Q25, Q26, Q37, Q39, Q41). Skips without DATABASE_URL_TEST; on CI it runs for
// real. The PDF round trip through the renderer stand-in also needs REDIS_URL_TEST (the print job token lives in Redis), which CI has.
// The monthly report keeps SCP-5a's suite (social-reports.http.test.ts), unchanged; this one proves the other five kinds and what the
// company's rules change.
//
// THE CLAIMS UNDER TEST (§63.24.8, the first six lines and the rules)
//   1. Per kind, the period accepted and refused through the route: format, a real date or week, not in the future, and ended when the
//      kind's numbers freeze at create (400 `invalid_field` `{field: 'period'}`, 400 `period_not_over`).
//   2. The short kinds (daily, weekly) are live while a draft, frozen at submit, taken again after a send-back; `summary_numbers_changed`
//      when a number the summary states has moved; their own facts (approved posts, best post by reach, what comes next).
//   3. The long kinds (quarterly, semester, yearly) are frozen at create.
//   4. `summary_missing` and `notes_incomplete` each on their own kinds only; notes, an action plan and a next-period line refused where
//      the report's rules leave them out.
//   5. One report per client, kind and period under concurrent creates; the existing one answered, with no second gateway call.
//   6. The officer drafts and submits every kind but cannot approve, send back or send; a company_admin cannot; each of the four can;
//      sending publishes with each kind's title.
//   7. The due day (`GET reports`, `GET reports/:id`), Needs you's `periodic_report_due`, the allocation's `reportKinds`, the
//      dashboard's `reportKind`.
//   8. The company's rules: a kind turned off is 409 `report_kind_off`; AI drafting off writes an empty draft; a rules change applies to
//      new reports only (a report keeps its `rules_ref`); an added notes area is required by the check; a fiscal year from April.
//   9. The SIMULATED rule holds for the short kinds' numbers.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { LightMyRequestResponse } from "fastify";
import Redis from "ioredis";
import { config } from "../../config";
import { newId, withGlobal } from "../../db";
import { buildApp } from "../../main";
import { setRedis, closeRedis } from "../../events/redis";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient } from "../../testing/fixtures";
import { grantSocialRole, grantSocialSeat, placeOfficerOnAllocation, seedSocialOrgTree } from "../../testing/social-pipeline-fixtures";
import { todayIsoInTz } from "../reports/person-scope";
import { addDays } from "../hr/working-days";
import { registerModule, resetModules } from "../registry";
import { socialModule } from "./index";
import { periodicWhen } from "../../core/report-period-label";
import { DEFAULTS_VERSION, DEFAULT_RULES, type PeriodicKind, type RulesDoc } from "./pipeline/rules";
import { periodOf, periodRange } from "./pipeline/rules-periods";
import { SCP } from "./pipeline/fixture";
import { KIND_LABEL } from "./report-kinds";
import { pickDuePeriod } from "./report-periodic-due";

const REDIS_TEST_URL = process.env.REDIS_URL_TEST ?? "";

// The gateway: a deterministic stand-in. `gw.mode` picks a good draft, a draft stating an invented number, or an outage. A short
// kind's prompt asks for `nextPeriod`; a long kind's for the notes and the plan.
const { gw } = vi.hoisted(() => ({ gw: { mode: "good" as "good" | "invented" | "down", calls: 0 } }));
const NOTES = {
  followers: { insight: "Followers held steady through the period.", suggestion: "Keep the weekly series going." },
  engagement: { insight: "Comments rose on the behind-the-scenes posts.", suggestion: "Answer every comment within a day." },
  audience: { insight: "Most of the audience is local.", suggestion: "Post at lunchtime." },
};
vi.mock("./gateway-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./gateway-client")>();
  return {
    ...actual,
    completeViaGateway: async (prompt: string) => {
      gw.calls++;
      if (gw.mode === "down") throw new Error("gateway down");
      if (prompt.includes('"nextPeriod"')) {
        const narrative = gw.mode === "invented" ? "Followers grew by 4321 in the period." : "A good period for the brand.";
        return { text: JSON.stringify({ narrative, nextPeriod: "More posts are coming." }), provider: "mock" };
      }
      const narrative = gw.mode === "invented" ? "Followers grew by 4321 this period." : "A steady period for the brand.";
      return { text: JSON.stringify({ narrative, notes: NOTES, actionPlan: [{ action: "Plan the next period's reels.", owner: "agency" }] }), provider: "mock" };
    },
  };
});

const SVC = { authorization: "Bearer svc-token" };
const as = (id: string) => ({ ...SVC, "x-user-id": id });

/** A name with no digit in it: a digit in a client's or engagement's name is a "grounded number" the guard would accept. */
const alpha = (n: number): string => {
  let s = "";
  let k = n;
  do { s = String.fromCharCode(97 + (k % 26)) + s; k = Math.floor(k / 26) - 1; } while (k >= 0);
  return s;
};

describe.skipIf(!TEST_URL)("SCP-5 W5-A2 · the periodic report kinds (BFF §63.24, §63.30)", () => {
  let app: NestFastifyApplication;
  let A: string;
  const U: Record<string, string> = {};
  let seq = 0;
  const flagBefore = config.socialSimulationEnabled;
  const rendererBefore = config.reportRenderer;
  let nestBaseUrl = "";
  let sidecar: Server | null = null;
  let sidecarUrl = "";
  const printed: Array<{ simulated?: boolean; tables: Array<{ key: string }>; narrative: { text: string }; header: { periodLabel: string } }> = [];

  const TODAY = todayIsoInTz(config.reportsTz);
  const rangeOf = (k: PeriodicKind, p: string, fy = 1) => periodRange(k, p, fy)!;
  const curPeriod = (k: PeriodicKind, fy = 1) => periodOf(k, TODAY, fy);
  const prevPeriod = (k: PeriodicKind, fy = 1) => periodOf(k, addDays(rangeOf(k, curPeriod(k, fy), fy).start, -1), fy);
  const nextPeriodOf = (k: PeriodicKind, fy = 1) => periodOf(k, addDays(rangeOf(k, curPeriod(k, fy), fy).end, 1), fy);
  /** The first working day after `day` for a company with no holiday calendar (Monday to Friday). */
  const workingDayAfter = (day: string): string => {
    let d = addDays(day, 1);
    while ([6, 0].includes(new Date(`${d}T00:00:00Z`).getUTCDay())) d = addDays(d, 1);
    return d;
  };

  const base = () => `/api/${A}/modules/social`;
  const get = (who: string, url: string) => app.inject({ method: "GET", url, headers: as(who) });
  const post = (who: string, url: string, payload: unknown = {}) => app.inject({ method: "POST", url, headers: as(who), payload: payload as object });
  const patch = (who: string, url: string, payload: unknown) => app.inject({ method: "PATCH", url, headers: as(who), payload: payload as object });
  const create = (who: string, engagementId: string, kind: string, period: string | undefined, extra: Record<string, unknown> = {}) =>
    post(who, `${base()}/engagements/${engagementId}/reports`, { kind, ...(period === undefined ? {} : { period }), ...extra });
  const submit = (who: string, id: string) => patch(who, `${base()}/reports/${id}`, { status: "in_review" });
  const sendBack = (who: string, id: string) => patch(who, `${base()}/reports/${id}`, { status: "draft" });
  const approve = (who: string, id: string) => post(who, `${base()}/reports/${id}/approve`);
  const deliver = (who: string, id: string) => post(who, `${base()}/reports/${id}/deliver`);
  const read = async (who: string, id: string) => ok(await get(U[who], `${base()}/reports/${id}`), 200, `${who} reads ${id}`);
  const rowOf = async (id: string) => (await adminPool().query(`SELECT to_jsonb(r) AS j FROM social_reports r WHERE id = $1`, [id])).rows[0]?.j as Record<string, any>;
  const statusOf = async (id: string) => (await adminPool().query(`SELECT status FROM social_reports WHERE id = $1`, [id])).rows[0]?.status as string;
  const kpi = (m: { kpis: Array<{ metricKey: string; value: number }> }, key: string) => m.kpis.find((k) => k.metricKey === key)?.value;

  function ok(r: LightMyRequestResponse, status: number, label: string) {
    expect(r.statusCode, `${label}: ${r.body}`).toBe(status);
    return r.json();
  }
  function forbidden(r: LightMyRequestResponse, label: string) {
    expect(r.statusCode, `${label}: ${r.body}`).toBe(403);
  }
  /** A refusal: its status and its code (the module's `refuse()` is 400, the two rules refusals 409). */
  function refused(r: LightMyRequestResponse, code: string, status = 400, extra: Record<string, unknown> = {}) {
    expect(r.statusCode, `${code}: ${r.body}`).toBe(status);
    expect(r.json(), code).toMatchObject({ error: code, ...extra });
  }
  const badPeriod = (r: LightMyRequestResponse, label: string) => refused(r, "invalid_field", 400, { field: "period" });

  interface Eng { id: string; clientId: string; account: string; cycle: string }
  async function makeEngagement(name: string, officer: string, o: { reportDueDay?: number | null; reportKinds?: string[] } = {}): Promise<Eng> {
    const n = ++seq;
    const clientId = await createClient(A, `${name} ${alpha(n)}`);
    const id = newId();
    const org = newId();
    const account = newId();
    const cycle = newId();
    const db = adminPool();
    await db.query(
      `INSERT INTO social_engagements (id, tenant_id, client_id, name, status, report_due_day, report_kinds) VALUES ($1, $2, $3, $4, 'active', $5, $6::text[])`,
      [id, A, clientId, `${name} engagement`, o.reportDueDay ?? null, o.reportKinds ?? []]);
    // A pipeline post needs a cycle (social_posts_pipeline_needs_cycle_ck); its month does not matter to a report.
    await db.query(`INSERT INTO social_cycles (id, tenant_id, engagement_id, month, deadline, ready_by, origin_site) VALUES ($1, $2, $3, '2026-09-01', '2026-08-26', '2026-08-24', 'central')`,
      [cycle, A, id]);
    await placeOfficerOnAllocation(A, id, officer);
    await db.query(`INSERT INTO social_publisher_orgs (id, tenant_id, client_id, driver, postiz_org_id, api_key_ref, status, origin_site) VALUES ($1, $2, $3, 'postiz', $4, 'default', 'active', 'central')`,
      [org, A, clientId, `scp5b-org-${n}`]);
    await db.query(`INSERT INTO social_accounts (id, tenant_id, client_id, publisher_org_id, network, handle, status, quota, origin_site) VALUES ($1, $2, $3, $4, 'instagram', $5, 'connected', '{}', 'central')`,
      [account, A, clientId, org, `@scp5b-${n}`]);
    return { id, clientId, account, cycle };
  }

  /** A pipeline post of `e` that went live on `day`, with one published variant and (optionally) one metric row. */
  async function livePost(e: Eng, day: string, o: { simulated?: boolean; metric?: { source: "pull" | "manual" | "simulated"; impressions: number; reach?: number } } = {}): Promise<{ id: string; variant: string; title: string }> {
    const id = newId();
    const v = newId();
    const title = `Mock post ${alpha(++seq)}`;
    await adminPool().query(
      `INSERT INTO social_posts (id, tenant_id, engagement_id, cycle_id, title, pipeline_status, status_since, schedule_via, live_url, went_live_at, simulated)
       VALUES ($1, $2, $3, $4, $5, 'live', now(), 'manual', 'https://instagram.example.test/p/mock', $6::timestamptz, $7)`,
      [id, A, e.id, e.cycle, title, `${day}T10:00:00Z`, o.simulated ?? false]);
    await adminPool().query(
      `INSERT INTO social_post_variants (id, tenant_id, post_id, account_id, body, status, native_import, published_url, published_at, origin_site)
       VALUES ($1, $2, $3, $4, 'copy', 'published', true, 'https://example.test/p', $5::timestamptz, 'central')`, [v, A, id, e.account, `${day}T10:00:00Z`]);
    if (o.metric) {
      await adminPool().query(
        `INSERT INTO social_post_metrics (tenant_id, variant_id, impressions, reach, source, entered_by, fetched_at) VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)`,
        [A, v, o.metric.impressions, o.metric.reach ?? null, o.metric.source, o.metric.source === "manual" ? U.officer : null, `${day}T20:00:00Z`]);
    }
    return { id, variant: v, title };
  }

  /** The client's recorded approval of a post's variant, decided at `at`. */
  async function clientApproved(e: Eng, variant: string, at: string): Promise<void> {
    await adminPool().query(
      `INSERT INTO social_post_client_reviews (tenant_id, variant_id, client_id, status, requested_at, decided_at) VALUES ($1, $2, $3, 'approved', $4::timestamptz, $4::timestamptz)`,
      [A, variant, e.clientId, at]);
  }

  /** A pipeline post scheduled at `at` (`scheduled`, by hand). */
  async function scheduledPost(e: Eng, at: string, o: { archived?: boolean; deleted?: boolean } = {}): Promise<string> {
    const id = newId();
    await adminPool().query(
      `INSERT INTO social_posts (id, tenant_id, engagement_id, cycle_id, title, format, pipeline_status, status_since, schedule_via, scheduled_at,
                                archived_at, archived_by, archive_reason, deleted_at)
       VALUES ($1, $2, $3, $4, $5, 'reel', 'scheduled', now(), 'manual', $6::timestamptz, $7, $8, $9, $10)`,
      [id, A, e.id, e.cycle, `Coming ${alpha(++seq)}`, at, o.archived ? new Date() : null, o.archived ? U.officer : null,
        o.archived ? "Mock archive" : null, o.deleted ? new Date() : null]);
    return id;
  }

  /** A new version of the company's rules (the whole document), as a save from Settings would write it. */
  async function saveRules(mutate: (doc: RulesDoc) => void, section = "reports"): Promise<number> {
    const cur = (await adminPool().query(`SELECT version, rules FROM social_rule_versions WHERE tenant_id = $1 ORDER BY version DESC LIMIT 1`, [A])).rows[0];
    const doc: RulesDoc = JSON.parse(JSON.stringify(cur ? cur.rules : DEFAULT_RULES));
    mutate(doc);
    const version = (cur?.version ?? 0) + 1;
    await adminPool().query(
      `INSERT INTO social_rule_versions (tenant_id, version, rules, section, defaults_version, edited_by) VALUES ($1, $2, $3::jsonb, $4, $5, $6)`,
      [A, version, JSON.stringify(doc), section, DEFAULTS_VERSION, U.owner]);
    return version;
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    config.reportRenderer = { url: "", token: "", platformUiInternalUrl: "", timeoutMs: 5000 };
    config.socialSimulationEnabled = false;
    if (REDIS_TEST_URL) setRedis(new Redis(REDIS_TEST_URL));
    resetModules();
    registerModule(socialModule);

    A = await createCompany("SCP5b Agency", ["social"]);
    const units = await seedSocialOrgTree(A);
    const people = ["officer", "officer2", "hod", "gm", "owner", "platformAdmin", "companyAdmin", "bot", "nobody"];
    for (const p of people) U[p] = await createUser(`scp5b-${p.toLowerCase()}@mock.test`, `Mock ${p}`);
    for (const p of people) await addMembership(A, U[p]);
    await withGlobal((c) => c.query(`UPDATE users SET kind = 'automation' WHERE id = $1`, [U.bot]));
    for (const p of ["officer", "officer2", "hod", "gm"]) await grantSocialRole(A, U[p], "social_staff");
    await grantSocialSeat(A, units.socialMedia, U.hod);
    await grantSocialSeat(A, units.gm, U.gm);
    await grantSocialRole(A, U.owner, "owner");
    await grantRole(U.platformAdmin, await createRole("platform_admin"), "global", null);
    await grantSocialRole(A, U.companyAdmin, "company_admin");
    await grantSocialRole(A, U.bot, "company_admin");

    app = await buildApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    nestBaseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

    // The renderer stand-in relays to OUR real print-payload route and keeps the document it was asked to print.
    sidecar = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", async () => {
        if (req.method !== "POST" || req.url !== "/render" || req.headers.authorization !== "Bearer render-tok") { res.writeHead(401).end(); return; }
        const { url } = JSON.parse(raw) as { url: string };
        const payloadRes = await fetch(`${nestBaseUrl}/internal/reports/print-payload/${url.slice(url.lastIndexOf("/") + 1)}`);
        if (!payloadRes.ok) { res.writeHead(502).end(); return; }
        const payload = (await payloadRes.json()) as { document: (typeof printed)[number] };
        printed.push(payload.document);
        res.writeHead(200, { "content-type": "application/pdf" }).end(Buffer.from("%PDF-fake"));
      });
    });
    await new Promise<void>((resolve) => sidecar!.listen(0, "127.0.0.1", resolve));
    sidecarUrl = `http://127.0.0.1:${(sidecar.address() as AddressInfo).port}`;
  }, 180_000);

  afterAll(async () => {
    config.socialSimulationEnabled = flagBefore;
    config.reportRenderer = rendererBefore;
    if (sidecar) await new Promise<void>((r) => sidecar!.close(() => r()));
    await app?.close();
    if (REDIS_TEST_URL) await closeRedis();
    await teardownTestDb();
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // 1. The period of each kind, accepted and refused
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  it("daily: YYYY-MM-DD, a real day, not in the future; the numbers are the day's, the report keeps the seed's rules", async () => {
    gw.mode = "good";
    const e = await makeEngagement("Daily period", U.officer);
    const day = addDays(TODAY, -3);
    const made = ok(await create(U.officer, e.id, "daily", day), 201, "a past day");
    expect(made).toMatchObject({ status: "draft", draftedVia: "ai", narrativeMd: "A good period for the brand.", nextPeriod: "More posts are coming.", notes: {}, actionPlan: [] });
    expect(made.metrics).toMatchObject({ rangeStart: day, rangeEnd: day });
    expect(await rowOf(made.id)).toMatchObject({ kind: "daily", period: day, rules_ref: `default:${DEFAULTS_VERSION}`, next_period: "More posts are coming." });
    ok(await create(U.officer, e.id, "daily", TODAY), 201, "today: the day is still going, its numbers live until submit");
    for (const p of ["2026-02-30", "2026-13-01", "26-11-09", "2026-11-9", "2026-11", "", "tomorrow"]) badPeriod(await create(U.officer, e.id, "daily", p), `daily ${p}`);
    badPeriod(await create(U.officer, e.id, "daily", addDays(TODAY, 1)), "the future");
    badPeriod(await create(U.officer, e.id, "daily", undefined), "no period");
    expect(await adminPool().query(`SELECT 1 FROM social_reports WHERE engagement_id = $1`, [e.id]).then((r) => r.rowCount)).toBe(2);
  });

  it("weekly: ISO YYYY-Www, Monday to Sunday, the week still going allowed (live), a week 53 only in a year that has one", async () => {
    gw.mode = "good";
    const e = await makeEngagement("Weekly period", U.officer);
    const last = prevPeriod("weekly");
    const made = ok(await create(U.officer, e.id, "weekly", last), 201, "last week");
    expect(made.metrics).toMatchObject({ rangeStart: rangeOf("weekly", last).start, rangeEnd: rangeOf("weekly", last).end });
    expect(new Date(`${made.metrics.rangeStart}T00:00:00Z`).getUTCDay()).toBe(1); // a Monday
    ok(await create(U.officer, e.id, "weekly", curPeriod("weekly")), 201, "this week");
    for (const p of ["2026-W00", "2026-W54", "2026-W1", "2026W46", "2026-w46", "2026-46", "2025-W53"]) badPeriod(await create(U.officer, e.id, "weekly", p), `weekly ${p}`); // 2025 has 52 weeks
    badPeriod(await create(U.officer, e.id, "weekly", nextPeriodOf("weekly")), "next week");
  });

  it("quarterly, semester and yearly: the period must have ended (period_not_over), in its format, never in the future", async () => {
    gw.mode = "good";
    const e = await makeEngagement("Long periods", U.officer);
    for (const [kind, malformed] of [["quarterly", ["2026-Q5", "2026-Q0", "2026Q1", "2026-q1", "2026-Q"]], ["semester", ["2026-H3", "2026-H0", "2026-1"]], ["yearly", ["26", "20260", "abcd"]]] as const) {
      const last = prevPeriod(kind);
      const made = ok(await create(U.officer, e.id, kind, last), 201, `${kind} ${last}`);
      expect(made.metrics).toMatchObject({ rangeStart: rangeOf(kind, last).start, rangeEnd: rangeOf(kind, last).end });
      expect(made.notes, kind).toEqual(NOTES);
      expect(made.actionPlan.length, kind).toBeGreaterThan(0);
      expect(made.nextPeriod, kind).toBeNull();
      expect(await rowOf(made.id), kind).toMatchObject({ kind, period: last, rules_ref: `default:${DEFAULTS_VERSION}`, next_period: null });
      refused(await create(U.officer, e.id, kind, curPeriod(kind)), "period_not_over"); // the period still going would freeze half of it
      for (const p of malformed) badPeriod(await create(U.officer, e.id, kind, p), `${kind} ${p}`);
      badPeriod(await create(U.officer, e.id, kind, nextPeriodOf(kind)), `${kind} in the future`);
      badPeriod(await create(U.officer, e.id, kind, undefined), `${kind} with no period`);
    }
  });

  it("an unknown kind is invalid_kind; the monthly keeps SCP-5a's create (any period, or none); campaign and ad hoc are SMM-23's", async () => {
    gw.mode = "good";
    const e = await makeEngagement("Other kinds", U.officer);
    refused(await create(U.officer, e.id, "hourly", "2026-11-09"), "invalid_kind");
    const monthly = ok(await create(U.officer, e.id, "monthly", "2026-02"), 201, "a monthly");
    expect(monthly).toMatchObject({ draftedVia: "ai", notes: NOTES });
    ok(await create(U.officer, e.id, "monthly", undefined), 201, "a monthly with no period: SMM-23's behaviour");
    ok(await create(U.officer, e.id, "campaign", "2026-Q4"), 201, "a campaign report keeps any period (the trailing 30 days)");
    ok(await create(U.officer, e.id, "adhoc", undefined), 201, "an ad hoc report");
    expect(Number((await adminPool().query(`SELECT count(*)::int AS n FROM social_reports WHERE engagement_id = $1 AND kind IN ('campaign','adhoc')`, [e.id])).rows[0].n)).toBe(2);
  });

  it("a client whose report_kinds do not name a kind can still have that kind written (BFF §63.24.2: report_kinds drives Needs you and the runs, not create)", async () => {
    gw.mode = "good";
    const e = await makeEngagement("Not due", U.officer, { reportKinds: [] });
    ok(await create(U.officer, e.id, "weekly", prevPeriod("weekly")), 201, "weekly for a client not due it");
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // 2. The short kinds: live until submit, frozen at submit, taken again after a send-back
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  it("daily and weekly are live while a draft, frozen at submit, taken again after a send-back; summary_numbers_changed when a stated number moved", async () => {
    gw.mode = "good";
    const e = await makeEngagement("Live", U.officer);
    const day = addDays(TODAY, -4);
    await livePost(e, day);
    await livePost(e, day);
    const id = ok(await create(U.officer, e.id, "daily", day), 201, "create").id as string;
    expect(kpi((await rowOf(id)).metrics, "posts_published_period")).toBe(2);

    // Live: a third post appears; the draft answers it at once, and the stored snapshot is still the one made at create.
    await livePost(e, day);
    let j = await read("officer", id);
    expect(j).toMatchObject({ kind: "daily", period: day, live: true, nextPeriod: "More posts are coming." });
    expect(kpi({ kpis: j.document.kpis }, "posts_published_period")).toBe(3);
    expect(kpi((await rowOf(id)).metrics, "posts_published_period"), "stored: not yet frozen").toBe(2);
    expect(ok(await get(U.officer, `${base()}/reports?engagementId=${e.id}`), 200, "list").reports[0]).toMatchObject({ id, live: true, summaryPresent: true });

    // The summary states 2 posts; the numbers now say 3: the submit is refused, with the number, and nothing changes.
    ok(await patch(U.officer, `${base()}/reports/${id}`, { narrativeMd: "We published 2 posts." }), 200, "the officer writes the summary");
    const before = await rowOf(id);
    refused(await submit(U.officer, id), "summary_numbers_changed", 400, { detail: { numbers: ["2"] } });
    expect(await rowOf(id), "a refused submit changes nothing").toEqual(before);
    ok(await patch(U.officer, `${base()}/reports/${id}`, { narrativeMd: "We published 3 posts." }), 200, "the summary follows the numbers");
    ok(await submit(U.officer, id), 200, "submit");

    // Frozen: the snapshot was taken in the submit; a fourth post changes nothing now.
    expect(kpi((await rowOf(id)).metrics, "posts_published_period")).toBe(3);
    await livePost(e, day);
    j = await read("hod", id);
    expect(j).toMatchObject({ status: "in_review", live: false });
    expect(kpi({ kpis: j.document.kpis }, "posts_published_period")).toBe(3);

    // A send-back keeps the snapshot; the draft is live again, and the next submit takes the numbers again (and runs the guard again).
    ok(await sendBack(U.hod, id), 200, "send back");
    expect(kpi((await rowOf(id)).metrics, "posts_published_period"), "kept").toBe(3);
    j = await read("officer", id);
    expect(j.live).toBe(true);
    expect(kpi({ kpis: j.document.kpis }, "posts_published_period")).toBe(4);
    refused(await submit(U.officer, id), "summary_numbers_changed", 400, { detail: { numbers: ["3"] } });
    ok(await patch(U.officer, `${base()}/reports/${id}`, { narrativeMd: "We published 4 posts." }), 200, "follow the numbers again");
    ok(await submit(U.officer, id), 200, "resubmit");
    expect(kpi((await rowOf(id)).metrics, "posts_published_period")).toBe(4);
    ok(await approve(U.hod, id), 200, "the HoD approves what the client will receive");
    refused(await patch(U.officer, `${base()}/reports/${id}`, { narrativeMd: "late" }), "report_not_editable");
  });

  it("a short report's own facts: the posts the client approved in the period (once each), the best post by reach, what is dated in the next day", async () => {
    gw.mode = "good";
    const e = await makeEngagement("Facts", U.officer);
    const day = addDays(TODAY, -5);
    const a = await livePost(e, day, { metric: { source: "manual", impressions: 100, reach: 500 } });
    const b = await livePost(e, day, { metric: { source: "manual", impressions: 200, reach: 900 } });
    const other = await livePost(e, addDays(day, -1), { metric: { source: "manual", impressions: 50, reach: 5000 } }); // the day before: not this day's best
    await clientApproved(e, a.variant, `${day}T12:00:00Z`);
    await clientApproved(e, b.variant, `${day}T13:00:00Z`);
    await clientApproved(e, other.variant, `${addDays(day, -1)}T12:00:00Z`); // approved the day before: not this day's
    const next = addDays(day, 1);
    await scheduledPost(e, `${next}T09:00:00Z`);
    await scheduledPost(e, `${addDays(day, 2)}T09:00:00Z`); // two days on: not the next day
    await scheduledPost(e, `${next}T10:00:00Z`, { archived: true });
    await scheduledPost(e, `${next}T11:00:00Z`, { deleted: true });
    const id = ok(await create(U.officer, e.id, "daily", day), 201, "create").id as string;
    const doc = (await read("officer", id)).document;
    expect(kpi(doc, "posts_approved_period")).toBe(2);
    expect(kpi(doc, "posts_published_period")).toBe(2);
    expect(doc.tables.find((t: { key: string }) => t.key === "best_post").rows).toEqual([expect.objectContaining({ post: b.title, reach: 900 })]);
    const comingRows = doc.tables.find((t: { key: string }) => t.key === "next_period").rows;
    expect(comingRows).toHaveLength(1);
    expect(comingRows[0]).toMatchObject({ format: "reel", phase: SCP.phaseOf.scheduled, scheduledAt: `${next}T09:00:00.000Z` });
    expect(comingRows[0].postId).toEqual(expect.any(String));
  });

  it("the SIMULATED rule: a short report counts simulated rows only while the simulator switch is on, then `simulated`, frozen with the numbers", async () => {
    gw.mode = "good";
    const e = await makeEngagement("Simulated short", U.officer);
    const day = addDays(TODAY, -6);
    await livePost(e, day);
    await livePost(e, day, { simulated: true, metric: { source: "simulated", impressions: 700, reach: 50 } });
    try {
      config.socialSimulationEnabled = false;
      const id = ok(await create(U.officer, e.id, "daily", day), 201, "switch off").id as string;
      let j = await read("officer", id);
      expect(j.simulated).toBe(false);
      expect(kpi({ kpis: j.document.kpis }, "posts_published_period")).toBe(1);
      expect(j.document.simulated).toBeUndefined();
      config.socialSimulationEnabled = true;
      j = await read("officer", id);
      expect(j.simulated, "live: the switch is read now").toBe(true);
      expect(kpi({ kpis: j.document.kpis }, "posts_published_period")).toBe(2);
      expect(j.document.simulated).toBe(true);
      ok(await submit(U.officer, id), 200, "submit with the switch on");
      expect(await rowOf(id)).toMatchObject({ simulated: true });
      config.socialSimulationEnabled = false;
      j = await read("hod", id);
      expect(j.simulated, "frozen with the numbers").toBe(true);
      expect(kpi({ kpis: j.document.kpis }, "posts_published_period")).toBe(2);
    } finally {
      config.socialSimulationEnabled = false;
    }
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // 3. The long kinds are frozen at create
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  it("quarterly, semester and yearly are frozen at create: a post that appears later changes nothing; the draft is never live", async () => {
    gw.mode = "good";
    for (const kind of ["quarterly", "semester", "yearly"] as const) {
      const e = await makeEngagement(`Frozen ${kind}`, U.officer); // one client each: the three ranges overlap
      const period = prevPeriod(kind);
      const inside = addDays(rangeOf(kind, period).start, 3);
      await livePost(e, inside);
      const id = ok(await create(U.officer, e.id, kind, period), 201, kind).id as string;
      expect(kpi((await rowOf(id)).metrics, "posts_published_period"), kind).toBe(1);
      await livePost(e, inside);
      const j = await read("officer", id);
      expect(j.live, kind).toBe(false);
      expect(kpi({ kpis: j.document.kpis }, "posts_published_period"), kind).toBe(1);
      // A long kind has no short kind's tables.
      expect(j.document.tables.map((t: { key: string }) => t.key), kind).not.toEqual(expect.arrayContaining(["best_post"]));
    }
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // 4. The content rule and the check, per kind
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  it("summary_missing binds the short kinds only; notes and an action plan are 400 {field} on them, a next-period line on the long kinds", async () => {
    gw.mode = "good";
    const e = await makeEngagement("Summary", U.officer);
    for (const kind of ["daily", "weekly"] as const) {
      const id = ok(await create(U.officer, e.id, kind, kind === "daily" ? addDays(TODAY, -7) : prevPeriod("weekly")), 201, kind).id as string;
      const url = `${base()}/reports/${id}`;
      // The edit rules: the report's own rules decide the parts.
      refused(await patch(U.officer, url, { notes: NOTES }), "invalid_field", 400, { field: "notes" });
      refused(await patch(U.officer, url, { notes: {} }), "invalid_field", 400, { field: "notes" });
      refused(await patch(U.officer, url, { actionPlan: [] }), "invalid_field", 400, { field: "actionPlan" });
      refused(await patch(U.officer, url, { narrativeMd: "x".repeat(1001) }), "invalid_field", 400, { field: "narrativeMd" });
      refused(await patch(U.officer, url, { nextPeriod: "x".repeat(1001) }), "invalid_field", 400, { field: "nextPeriod" });
      ok(await patch(U.officer, url, { narrativeMd: "x".repeat(1000), nextPeriod: "Next: a reel." }), 200, "a summary of 1,000 and a line");
      // The check: an empty summary is refused, in the HoD check as well as from there; a summary and no next-period line passes.
      ok(await patch(U.officer, url, { narrativeMd: "" }), 200, "blank the summary");
      ok(await submit(U.officer, id), 200, "the officer may submit it");
      refused(await approve(U.hod, id), "summary_missing");
      ok(await patch(U.officer, url, { narrativeMd: "   " }), 200, "whitespace is no summary");
      refused(await approve(U.hod, id), "summary_missing");
      ok(await patch(U.officer, url, { narrativeMd: "A summary.", nextPeriod: null }), 200, "a summary, no line");
      ok(await approve(U.hod, id), 200, "the check passes: by default a short kind needs its summary only");
      expect(await statusOf(id)).toBe("approved");
    }
    // The long kinds: no next-period line; their summary is not what the check needs.
    for (const kind of ["quarterly", "semester", "yearly"] as const) {
      const id = ok(await create(U.officer, e.id, kind, prevPeriod(kind)), 201, kind).id as string;
      const url = `${base()}/reports/${id}`;
      refused(await patch(U.officer, url, { nextPeriod: "Next quarter: more." }), "invalid_field", 400, { field: "nextPeriod" });
      ok(await patch(U.officer, url, { narrativeMd: "x".repeat(5000) }), 200, "the long kinds' narrative has no limit");
      ok(await patch(U.officer, url, { narrativeMd: "" }), 200, "blank the narrative");
      ok(await submit(U.officer, id), 200, "submit");
      ok(await approve(U.hod, id), 200, "a long kind passes without a summary: its notes are complete");
    }
  });

  it("notes_incomplete binds the long kinds only: one blank suggestion blocks the check, and the check is re-checked in the UPDATE", async () => {
    gw.mode = "good";
    const e = await makeEngagement("Notes", U.officer);
    for (const kind of ["quarterly", "semester", "yearly"] as const) {
      const id = ok(await create(U.officer, e.id, kind, prevPeriod(kind)), 201, kind).id as string;
      const url = `${base()}/reports/${id}`;
      ok(await submit(U.officer, id), 200, "submit");
      ok(await patch(U.officer, url, { notes: { ...NOTES, audience: { insight: "Local.", suggestion: "   " } } }), 200, "blank a suggestion");
      expect(ok(await get(U.officer, `${base()}/reports?engagementId=${e.id}&kind=${kind}`), 200, "list").reports[0]).toMatchObject({ id, notesComplete: false, kind });
      refused(await approve(U.hod, id), "notes_incomplete");
      ok(await patch(U.officer, url, { notes: { followers: NOTES.followers } }), 200, "drop two areas");
      refused(await approve(U.hod, id), "notes_incomplete");
      // The shapes: 400 {field}, nothing written.
      const before = await rowOf(id);
      for (const [body, field] of [
        [{ notes: [] }, "notes"], [{ notes: { reach: { insight: "x", suggestion: "y" } } }, "notes"],
        [{ notes: { followers: { insight: "x".repeat(501), suggestion: "y" } } }, "notes"],
        [{ actionPlan: {} }, "actionPlan"], [{ actionPlan: Array.from({ length: 11 }, () => ({ action: "x", owner: "agency" })) }, "actionPlan"],
      ] as const) refused(await patch(U.officer, url, body), "invalid_field", 400, { field });
      expect(await rowOf(id)).toEqual(before);
      forbidden(await patch(U.nobody, url, { notes: [] }), "no right, bad body: still 403");
      ok(await patch(U.officer, url, { notes: NOTES }), 200, "complete again");
      ok(await approve(U.hod, id), 200, "the check passes");
    }
    // A daily or weekly report has no notes to complete: the list's flag reads true.
    const daily = ok(await create(U.officer, e.id, "daily", addDays(TODAY, -8)), 201, "daily").id as string;
    expect(ok(await get(U.officer, `${base()}/reports?engagementId=${e.id}&kind=daily`), 200, "list").reports.find((r: { id: string }) => r.id === daily)).toMatchObject({ notesComplete: true });
    // Campaign and ad hoc: the check needs nothing, as built.
    const campaign = ok(await create(U.officer, e.id, "campaign", "2026-09"), 201, "campaign").id as string;
    ok(await patch(U.officer, `${base()}/reports/${campaign}`, { narrativeMd: "", notes: {} }), 200, "an empty campaign report");
    ok(await submit(U.officer, campaign), 200, "submit");
    ok(await approve(U.hod, campaign), 200, "approved with nothing written, as SMM-23 built it");
  });

  it("Draft with AI: a short kind answers {narrativeMd, nextPeriod, draftedVia}, a long kind as the monthly; a proposal, nothing saved; the template when the gateway is down", async () => {
    gw.mode = "good";
    const e = await makeEngagement("Proposal", U.officer);
    const daily = ok(await create(U.officer, e.id, "daily", addDays(TODAY, -9)), 201, "daily").id as string;
    const quarterly = ok(await create(U.officer, e.id, "quarterly", prevPeriod("quarterly")), 201, "quarterly").id as string;
    const before = [await rowOf(daily), await rowOf(quarterly)];

    expect(ok(await post(U.officer, `${base()}/reports/${daily}/ai-draft`), 200, "daily")).toEqual({ narrativeMd: "A good period for the brand.", nextPeriod: "More posts are coming.", draftedVia: "ai" });
    expect(ok(await post(U.officer, `${base()}/reports/${quarterly}/ai-draft`), 200, "quarterly")).toMatchObject({ narrativeMd: "A steady period for the brand.", notes: NOTES, draftedVia: "ai" });
    gw.mode = "invented";
    expect(ok(await post(U.officer, `${base()}/reports/${daily}/ai-draft`), 200, "an invented number").draftedVia).toBe("template");
    gw.mode = "down";
    const t = ok(await post(U.officer, `${base()}/reports/${daily}/ai-draft`), 200, "gateway down");
    expect(t).toMatchObject({ draftedVia: "template", nextPeriod: expect.stringMatching(/scheduled|Nothing is scheduled/) });
    expect(Object.keys(ok(await post(U.officer, `${base()}/reports/${quarterly}/ai-draft`), 200, "quarterly down").notes).sort()).toEqual(["audience", "engagement", "followers"]);
    expect([await rowOf(daily), await rowOf(quarterly)], "nothing saved").toEqual(before);
    forbidden(await post(U.owner, `${base()}/reports/${daily}/ai-draft`), "the owner does not write the report");
    gw.mode = "good";
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // 5. One report per client, kind and period
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  it("one report per client, kind and period: the second create returns the first before any gateway call; concurrent creates make one", async () => {
    gw.mode = "good";
    const e = await makeEngagement("Once", U.officer);
    for (const [kind, period] of [["daily", addDays(TODAY, -10)], ["weekly", prevPeriod("weekly")], ["quarterly", prevPeriod("quarterly")], ["semester", prevPeriod("semester")], ["yearly", prevPeriod("yearly")]] as const) {
      const first = ok(await create(U.officer, e.id, kind, period), 201, `${kind} first`);
      const calls = gw.calls;
      const second = ok(await create(U.officer, e.id, kind, period, { id: newId() }), 201, `${kind} second`);
      expect(second, kind).toMatchObject({ id: first.id, draftedVia: "existing" });
      expect(gw.calls, `${kind}: no gateway call spent on an existing report`).toBe(calls);
      // Another client's report of the same kind and period is another report.
      const e2 = await makeEngagement("Once other", U.officer);
      expect(ok(await create(U.officer, e2.id, kind, period), 201, `${kind} other client`).id).not.toBe(first.id);
    }
    // Two and three at once, per kind: one row, one id.
    for (const [kind, period] of [["daily", addDays(TODAY, -11)], ["weekly", periodOf("weekly", addDays(TODAY, -14))], ["quarterly", periodOf("quarterly", addDays(TODAY, -200))]] as const) {
      const e2 = await makeEngagement("Race", U.officer);
      const rs = await Promise.all([create(U.officer, e2.id, kind, period), create(U.officer, e2.id, kind, period), create(U.officer, e2.id, kind, period)]);
      const ids = new Set(rs.map((r, i) => ok(r, 201, `${kind} racer ${i}`).id));
      expect(ids.size, kind).toBe(1);
      expect(Number((await adminPool().query(`SELECT count(*)::int AS n FROM social_reports WHERE engagement_id = $1 AND kind = $2 AND period = $3`, [e2.id, kind, period])).rows[0].n), kind).toBe(1);
    }
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // 6. Who: the officer, the four; sending, with each kind's title
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  it("every kind: the officer drafts and submits but cannot approve, send back or send; a company_admin and an automation cannot; the four can", async () => {
    gw.mode = "good";
    const e = await makeEngagement("Who", U.officer);
    const cases: Array<[PeriodicKind, string]> = [
      ["daily", addDays(TODAY, -12)], ["weekly", prevPeriod("weekly")], ["quarterly", prevPeriod("quarterly")], ["semester", prevPeriod("semester")], ["yearly", prevPeriod("yearly")],
    ];
    const approvers = ["hod", "gm", "owner", "platformAdmin"];
    for (const [i, [kind, period]] of cases.entries()) {
      const id = ok(await create(U.officer, e.id, kind, period), 201, kind).id as string;
      ok(await submit(U.officer, id), 200, `${kind} submit`);
      for (const who of ["officer", "companyAdmin", "bot", "nobody"]) {
        forbidden(await approve(U[who], id), `${kind}: ${who} approve`);
        forbidden(await sendBack(U[who], id), `${kind}: ${who} send back`);
      }
      const j = await read("officer", id);
      expect([j.canApprove, j.canDeliver], kind).toEqual([false, false]);
      expect(await statusOf(id)).toBe("in_review");
      const checker = approvers[i % approvers.length];
      ok(await sendBack(U[checker], id), 200, `${kind}: ${checker} sends back`);
      ok(await submit(U.officer, id), 200, `${kind}: resubmit`);
      ok(await approve(U[checker], id), 200, `${kind}: ${checker} approves`);
      for (const who of ["officer", "companyAdmin", "bot"]) forbidden(await deliver(U[who], id), `${kind}: ${who} deliver`);
      expect([(await read(checker, id)).canApprove, (await read(checker, id)).canDeliver], `${kind} ${checker}`).toEqual([true, true]);
    }
  });

  it("sending publishes each kind with its title (PV7-04a), and the PDF carries a short report's summary and next-period line", async () => {
    gw.mode = "good";
    const e = await makeEngagement("Send", U.officer);
    const cases: Array<[PeriodicKind, string]> = [
      ["daily", addDays(TODAY, -13)], ["weekly", prevPeriod("weekly")], ["quarterly", prevPeriod("quarterly")], ["semester", prevPeriod("semester")], ["yearly", prevPeriod("yearly")],
    ];
    const ids: Array<[PeriodicKind, string, string]> = [];
    for (const [kind, period] of cases) {
      const id = ok(await create(U.officer, e.id, kind, period), 201, kind).id as string;
      ok(await submit(U.officer, id), 200, `${kind} submit`);
      ok(await approve(U.hod, id), 200, `${kind} approve`);
      ids.push([kind, period, id]);
    }
    if (!REDIS_TEST_URL) {
      for (const [kind, , id] of ids) refused(await deliver(U.owner, id), "pdf_render_not_configured", 503);
      return;
    }
    config.reportRenderer = { url: sidecarUrl, token: "render-tok", platformUiInternalUrl: nestBaseUrl, timeoutMs: 5000 };
    try {
      for (const [kind, period, id] of ids) {
        const sent = ok(await deliver(U.owner, id), 200, `${kind}: the owner sends`);
        expect(sent.status).toBe("delivered");
        const range = rangeOf(kind, period);
        const title = (await adminPool().query(`SELECT title, status FROM client_reports WHERE source = 'social_report' AND source_id = $1`, [id])).rows[0];
        expect(title, kind).toMatchObject({ status: "published", title: `${KIND_LABEL[kind]}, ${periodicWhen(kind, period, range.start, range.end)}` });
        const doc = printed[printed.length - 1];
        expect(doc.header.periodLabel, kind).toBe(periodicWhen(kind, period, range.start, range.end));
        if (kind === "daily" || kind === "weekly") expect(doc.narrative.text, kind).toBe(`A good period for the brand.\n\nNext ${kind === "daily" ? "day" : "week"}: More posts are coming.`);
        else expect(doc.tables.map((t) => t.key), kind).toEqual(expect.arrayContaining(["notes", "action_plan"]));
        expect(doc.simulated, kind).toBeUndefined();
        refused(await deliver(U.owner, id), "cannot_deliver_from_this_status");
      }
    } finally {
      config.reportRenderer = { url: "", token: "", platformUiInternalUrl: "", timeoutMs: 5000 };
    }
  });

  it("W5-Q: the PDF carries the SIMULATED mark when a number was simulated, and only then (BFF §63.24.8's last proof)", async () => {
    gw.mode = "good";
    const e = await makeEngagement("Send simulated", U.officer);
    const day = addDays(TODAY, -9);
    await livePost(e, day);
    await livePost(e, day, { simulated: true, metric: { source: "simulated", impressions: 700, reach: 50 } });
    const plain = await makeEngagement("Send plain", U.officer);
    await livePost(plain, day);
    let simId = "";
    let plainId = "";
    try {
      config.socialSimulationEnabled = true;
      simId = ok(await create(U.officer, e.id, "daily", day), 201, "simulated numbers").id as string;
      ok(await submit(U.officer, simId), 200, "submit with the switch on");
      plainId = ok(await create(U.officer, plain.id, "daily", day), 201, "no simulated number").id as string;
      ok(await submit(U.officer, plainId), 200, "submit, nothing simulated");
    } finally {
      config.socialSimulationEnabled = false;
    }
    expect(await rowOf(simId)).toMatchObject({ simulated: true });
    expect(await rowOf(plainId)).toMatchObject({ simulated: false });
    ok(await approve(U.hod, simId), 200, "approve the simulated one");
    ok(await approve(U.hod, plainId), 200, "approve the plain one");
    if (!REDIS_TEST_URL) {
      refused(await deliver(U.owner, simId), "pdf_render_not_configured", 503);
      return;
    }
    config.reportRenderer = { url: sidecarUrl, token: "render-tok", platformUiInternalUrl: nestBaseUrl, timeoutMs: 5000 };
    try {
      expect(ok(await deliver(U.owner, simId), 200, "send the simulated one").status).toBe("delivered");
      expect(printed[printed.length - 1].simulated, "the document the PDF is drawn from says simulated").toBe(true);
      expect(ok(await deliver(U.owner, plainId), 200, "send the plain one").status).toBe("delivered");
      expect(printed[printed.length - 1].simulated, "no simulated number, no mark").toBeUndefined();
    } finally {
      config.reportRenderer = { url: "", token: "", platformUiInternalUrl: "", timeoutMs: 5000 };
    }
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // 7. Due, Needs you, the allocation, the dashboard
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  it("GET reports and GET reports/:id answer `due` by each report's own rules, `summaryPresent` and `live`; `kind` filters and `period` takes every form", async () => {
    gw.mode = "good";
    const e = await makeEngagement("Due list", U.officer, { reportDueDay: 10 });
    const day = addDays(TODAY, -14);
    const week = prevPeriod("weekly");
    const quarter = prevPeriod("quarterly");
    const year = prevPeriod("yearly");
    const ids = {
      daily: ok(await create(U.officer, e.id, "daily", day), 201, "daily").id as string,
      weekly: ok(await create(U.officer, e.id, "weekly", week), 201, "weekly").id as string,
      quarterly: ok(await create(U.officer, e.id, "quarterly", quarter), 201, "quarterly").id as string,
      yearly: ok(await create(U.officer, e.id, "yearly", year), 201, "yearly").id as string,
    };
    // Monday to Friday, no holidays: the first working day after the period; a long kind falls due on the client's day of the month after.
    const monthAfter = (end: string) => { const d = new Date(`${end.slice(0, 7)}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1); return `${d.toISOString().slice(0, 7)}-10`; };
    const expected = {
      daily: workingDayAfter(day), weekly: workingDayAfter(rangeOf("weekly", week).end),
      quarterly: monthAfter(rangeOf("quarterly", quarter).end), yearly: monthAfter(rangeOf("yearly", year).end),
    };
    const list = ok(await get(U.officer, `${base()}/reports?engagementId=${e.id}`), 200, "list").reports as Array<{ id: string; kind: string; due: string | null; live: boolean; summaryPresent: boolean }>;
    for (const [kind, id] of Object.entries(ids)) {
      const row = list.find((r) => r.id === id)!;
      expect(row.due, `${kind} in the list`).toBe(expected[kind as keyof typeof expected]);
      expect((await read("officer", id)).due, `${kind} read`).toBe(expected[kind as keyof typeof expected]);
      expect(row.live, kind).toBe(kind === "daily" || kind === "weekly");
      expect(row.summaryPresent, kind).toBe(true);
    }
    // No report_due_day on the client: a long kind has no due day, a short one still does.
    const none = await makeEngagement("Due none", U.officer);
    const q = ok(await create(U.officer, none.id, "quarterly", quarter), 201, "no due day").id as string;
    const d = ok(await create(U.officer, none.id, "daily", day), 201, "daily").id as string;
    expect((await read("officer", q)).due).toBeNull();
    expect((await read("officer", d)).due).toBe(workingDayAfter(day));

    // The filters.
    const byKind = ok(await get(U.officer, `${base()}/reports?engagementId=${e.id}&kind=weekly`), 200, "kind filter").reports;
    expect(byKind.map((r: { id: string }) => r.id)).toEqual([ids.weekly]);
    for (const [period, id] of [[day, ids.daily], [week, ids.weekly], [quarter, ids.quarterly], [year, ids.yearly]] as const) {
      expect(ok(await get(U.officer, `${base()}/reports?engagementId=${e.id}&period=${period}`), 200, `period ${period}`).reports.map((r: { id: string }) => r.id)).toEqual([id]);
    }
    for (const [qs, field] of [["kind=hourly", "kind"], ["period=2026-13", "period"], ["period=latest", "period"], ["period=2026-Q5", "period"], ["status=sent", "status"]]) {
      refused(await get(U.officer, `${base()}/reports?${qs}`), "invalid_field", 400, { field });
    }
  });

  it("Needs you: `periodic_report_due` for each kind in the client's report_kinds that the company has on, from the due day until it is sent; the monthly item is as built", async () => {
    gw.mode = "good";
    const kinds = ["daily", "weekly", "quarterly", "yearly"] as const; // not semester: the client is not due it
    const e = await makeEngagement("Needs", U.officer2, { reportDueDay: 10, reportKinds: [...kinds] });
    await makeEngagement("Needs not due", U.officer2, { reportDueDay: 10, reportKinds: [] }); // no kinds: no periodic item
    const needs = async (who: string) => {
      const j = ok(await get(U[who], `${base()}/needs-you`), 200, `${who} needs-you`);
      expect(j.partial, `${who} partial`).toEqual([]);
      return j.items as Array<{ id: string; kind: string; role: string; title: string; clientName: string; due?: string; since: string; href: string }>;
    };
    const expectedFor = (k: PeriodicKind) => pickDuePeriod(k, TODAY, 1, DEFAULT_RULES.reports.kinds[k].due, { reportDueDay: 10, calendar: {} }, "reached");
    const periodic = async () => (await needs("officer2")).filter((i) => i.kind === "periodic_report_due");

    let items = await periodic();
    const want = kinds.filter((k) => expectedFor(k) !== null);
    expect(items, JSON.stringify(items)).toHaveLength(want.length);
    for (const k of want) {
      const x = expectedFor(k)!;
      const item = items.find((i) => i.id === `social:${A}:${e.id}:${k}:${x.period}:periodic_report_due`)!;
      expect(item, `${k} ${x.period}`).toMatchObject({ role: "officer", due: x.due, since: `${x.due}T00:00:00.000Z`, href: "/departments/d-social-media/social-reports" });
      expect(item.title.startsWith(`${KIND_LABEL[k]}, `), k).toBe(true);
      expect(item.clientName).toMatch(/^Needs [a-z]+$/);
    }
    // The monthly item keeps its own kind.
    expect((await needs("officer2")).filter((i) => i.kind === "report_due" && i.id.includes(e.id))).toHaveLength(1);
    // Nobody else's: another officer, and the seats, get no item of this officer's clients.
    for (const who of ["officer", "hod"]) expect((await needs(who)).filter((i) => i.kind === "periodic_report_due" && i.clientName.startsWith("Needs ")), who).toEqual([]);

    // A report of the period: the item opens it, and it stays through the HoD check and Ready, and is gone once the report is sent.
    const k0 = want[0];
    const x0 = expectedFor(k0)!;
    const id = ok(await create(U.officer2, e.id, k0, x0.period), 201, "the report").id as string;
    items = await periodic();
    expect(items.find((i) => i.id === `social:${A}:${id}:periodic_report_due`), "the item names the report").toMatchObject({ href: `/departments/d-social-media/social-reports/${id}`, due: x0.due });
    ok(await submit(U.officer2, id), 200, "submit");
    ok(await approve(U.hod, id), 200, "approve");
    expect((await periodic()).some((i) => i.id === `social:${A}:${id}:periodic_report_due`), "still due until sent").toBe(true);
    await adminPool().query(`UPDATE social_reports SET status = 'delivered', delivered_at = now() WHERE id = $1`, [id]);
    expect((await periodic()).some((i) => i.id === `social:${A}:${id}:periodic_report_due`), "gone once sent").toBe(false);
    expect(await periodic()).toHaveLength(want.length - 1);
    // The seats' queue names each kind by its own label.
    const ready = ok(await create(U.officer2, e.id, "weekly", periodOf("weekly", addDays(TODAY, -28))), 201, "weekly for the queue").id as string;
    ok(await submit(U.officer2, ready), 200, "submit");
    const check = (await needs("hod")).find((i) => i.id === `social:${A}:${ready}:report_check`)!;
    expect(check).toMatchObject({ kind: "report_check", role: "approver", href: `/departments/d-social-media/social-reports/${ready}` });
    expect(check.title.startsWith("Weekly report, ")).toBe(true);
  });

  it("the allocation carries `reportKinds`: set by PATCH (the four), de-duplicated, the five kinds only; the monthly is every client's", async () => {
    const e = await makeEngagement("Allocation", U.officer);
    const rowFor = async (who: string) => (ok(await get(U[who], `${base()}/allocation`), 200, "allocation").items as Array<{ engagementId: string; reportKinds: string[] }>).find((r) => r.engagementId === e.id)!;
    expect((await rowFor("hod")).reportKinds).toEqual([]);
    const set = await patch(U.hod, `${base()}/engagements/${e.id}/allocation`, { reportKinds: ["weekly", "daily", "weekly", "daily", "yearly"] });
    expect(ok(set, 200, "set").reportKinds).toEqual(["weekly", "daily", "yearly"]);
    expect((await rowFor("officer")).reportKinds).toEqual(["weekly", "daily", "yearly"]);
    expect((await adminPool().query(`SELECT report_kinds FROM social_engagements WHERE id = $1`, [e.id])).rows[0].report_kinds).toEqual(["weekly", "daily", "yearly"]);
    for (const bad of [["monthly"], ["campaign"], ["hourly"], "daily", [3]]) {
      refused(await patch(U.hod, `${base()}/engagements/${e.id}/allocation`, { reportKinds: bad }), "invalid_field", 400, { field: "reportKinds" });
    }
    forbidden(await patch(U.officer, `${base()}/engagements/${e.id}/allocation`, { reportKinds: [] }), "the officer does not plan");
    ok(await patch(U.hod, `${base()}/engagements/${e.id}/allocation`, { reportKinds: [] }), 200, "cleared");
    expect((await rowFor("hod")).reportKinds).toEqual([]);
  });

  it("the Team dashboard's report_due items carry `reportKind` for a periodic report, from the day after its due day, whatever the month; the monthly's carry none", async () => {
    gw.mode = "good";
    const e = await makeEngagement("Dashboard", U.officer, { reportDueDay: 1, reportKinds: ["daily", "weekly", "quarterly"] });
    const expectedFor = (k: PeriodicKind) => pickDuePeriod(k, TODAY, 1, DEFAULT_RULES.reports.kinds[k].due, { reportDueDay: 1, calendar: {} }, "after");
    const team = async (qs = "") => ok(await get(U.platformAdmin, `${base()}/team${qs}`), 200, "team").needsAttention as Array<{ kind: string; reportKind?: string; reportId?: string; engagementId: string; title: string; since: string }>;
    const mine = (items: Awaited<ReturnType<typeof team>>) => items.filter((i) => i.kind === "report_due" && i.engagementId === e.id);
    const check = (items: Awaited<ReturnType<typeof team>>) => {
      const periodic = mine(items).filter((i) => i.reportKind !== undefined);
      for (const k of ["daily", "weekly", "quarterly"] as const) {
        const x = expectedFor(k);
        const item = periodic.find((i) => i.reportKind === k);
        if (!x) { expect(item, `${k} not due yet`).toBeUndefined(); continue; }
        expect(item, k).toMatchObject({ title: `${KIND_LABEL[k]} ${x.period}`, since: addDays(x.due, 1) });
        expect("reportId" in item!, `${k}: no report yet, the id is omitted`).toBe(false);
      }
      return periodic;
    };
    check(await team());
    check(await team(`?month=${addDays(TODAY, -90).slice(0, 7)}`)); // whatever the month
    expect(mine(await team()).filter((i) => i.reportKind === undefined), "the monthly's item has none").toHaveLength(1);
    // A draft of the due period: the item names it; sent: gone.
    const k0 = (["daily", "weekly", "quarterly"] as const).find((k) => expectedFor(k) !== null);
    if (k0) {
      const x = expectedFor(k0)!;
      const id = ok(await create(U.officer, e.id, k0, x.period), 201, "draft").id as string;
      expect(mine(await team()).find((i) => i.reportKind === k0)).toMatchObject({ reportId: id });
      await adminPool().query(`UPDATE social_reports SET status = 'delivered', delivered_at = now() WHERE id = $1`, [id]);
      expect(mine(await team()).some((i) => i.reportKind === k0)).toBe(false);
    }
    forbidden(await get(U.officer, `${base()}/team`), "the officer is no approver");
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // 8. The company's rules (kept last: each save is a new version of the one company's rules)
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  it("a rules change applies to new reports only: a report keeps its rules_ref, its due day, its content and its check", async () => {
    gw.mode = "good";
    const e = await makeEngagement("Versions", U.officer);
    const oldDay = addDays(TODAY, -20);
    const old = ok(await create(U.officer, e.id, "daily", oldDay), 201, "made under the seed").id as string;
    expect((await rowOf(old)).rules_ref).toBe(`default:${DEFAULTS_VERSION}`);

    const v = await saveRules((d) => {
      d.reports.kinds.daily.content.narrative.max = 50;
      d.reports.kinds.daily.checkRequires = ["narrative", "nextPeriodLine"];
      d.reports.kinds.daily.due = { rule: "working_days_after", n: 3 };
    });
    expect(v).toBe(1);

    // The old report: its summary may still be long, its check still needs only the summary, its due day is still the first working day.
    ok(await patch(U.officer, `${base()}/reports/${old}`, { narrativeMd: "x".repeat(500), nextPeriod: null }), 200, "a long summary: its rules allow it");
    expect((await read("officer", old)).due).toBe(workingDayAfter(oldDay));
    ok(await submit(U.officer, old), 200, "submit");
    ok(await approve(U.hod, old), 200, "approved without a next-period line: its rules did not ask for one");

    // The next report is made under the company's version 1.
    const fresh = ok(await create(U.officer, e.id, "daily", addDays(TODAY, -21)), 201, "made under company:1").id as string;
    expect((await rowOf(fresh)).rules_ref).toBe("company:1");
    refused(await patch(U.officer, `${base()}/reports/${fresh}`, { narrativeMd: "x".repeat(51) }), "invalid_field", 400, { field: "narrativeMd" });
    ok(await patch(U.officer, `${base()}/reports/${fresh}`, { narrativeMd: "x".repeat(50) }), 200, "50 is the limit");
    let due = addDays(TODAY, -21);
    for (let n = 0; n < 3; n++) due = workingDayAfter(due);
    expect((await read("officer", fresh)).due).toBe(due);
    ok(await submit(U.officer, fresh), 200, "submit");
    ok(await patch(U.officer, `${base()}/reports/${fresh}`, { nextPeriod: null }), 200, "the line is blanked in the check");
    refused(await approve(U.hod, fresh), "next_period_missing");
    ok(await patch(U.officer, `${base()}/reports/${fresh}`, { nextPeriod: "Next: a reel." }), 200, "the line is back");
    ok(await approve(U.hod, fresh), 200, "the check passes under company:1");
    // The old report did not move.
    expect((await rowOf(old)).rules_ref).toBe(`default:${DEFAULTS_VERSION}`);
    // The AI's draft honours the new limit: a 28-character summary fits 50; the template is cut to it.
    gw.mode = "down";
    const t = ok(await create(U.officer, e.id, "daily", addDays(TODAY, -22)), 201, "gateway down under company:1");
    expect(t.narrativeMd.length).toBeLessThanOrEqual(50);
    gw.mode = "good";
  });

  it("a kind the company turned off is 409 report_kind_off on create; with AI drafting off a create writes an empty draft with no gateway call, and ai-draft is 409 ai_drafting_off", async () => {
    gw.mode = "good";
    const e = await makeEngagement("Off", U.officer);
    await saveRules((d) => {
      d.reports.kinds.weekly.enabled = false;
      d.reports.kinds.yearly.aiDrafting = false;
    });
    refused(await create(U.officer, e.id, "weekly", prevPeriod("weekly")), "report_kind_off", 409);
    expect(Number((await adminPool().query(`SELECT count(*)::int AS n FROM social_reports WHERE engagement_id = $1`, [e.id])).rows[0].n)).toBe(0);
    ok(await create(U.officer, e.id, "daily", addDays(TODAY, -23)), 201, "the other kinds are still on");

    const calls = gw.calls;
    const empty = ok(await create(U.officer, e.id, "yearly", prevPeriod("yearly")), 201, "AI drafting off");
    expect(empty).toMatchObject({ draftedVia: "none", narrativeMd: "", notes: {}, actionPlan: [], nextPeriod: null });
    expect(gw.calls, "no gateway call").toBe(calls);
    expect(await rowOf(empty.id)).toMatchObject({ narrative_md: "", notes: {}, action_plan: [], rules_ref: expect.stringMatching(/^company:\d+$/) });
    refused(await post(U.officer, `${base()}/reports/${empty.id}/ai-draft`), "ai_drafting_off", 409);
    // The officer writes it by hand; the check needs the notes.
    ok(await submit(U.officer, empty.id), 200, "submit");
    refused(await approve(U.hod, empty.id), "notes_incomplete");
    ok(await patch(U.officer, `${base()}/reports/${empty.id}`, { notes: NOTES }), 200, "by hand");
    ok(await approve(U.hod, empty.id), 200, "approved");
    // A kind that is off leaves Needs you.
    const needsE = await makeEngagement("Off needs", U.officer2, { reportKinds: ["weekly"] });
    const items = ok(await get(U.officer2, `${base()}/needs-you`), 200, "needs-you").items as Array<{ id: string; kind: string }>;
    expect(items.some((i) => i.kind === "periodic_report_due" && i.id.includes(needsE.id))).toBe(false);
    // A report made before the kind went off is still read, checked and sent under its own rules.
    const h = await adminPool().query(`SELECT id FROM social_reports WHERE engagement_id = $1 AND kind = 'daily'`, [e.id]);
    expect((await read("officer", h.rows[0].id)).kind).toBe("daily");
  });

  it("an added notes area is required by the check, and a draft fills it; a fiscal year from April makes Q1 April to June", async () => {
    gw.mode = "good";
    const e = await makeEngagement("Areas", U.officer);
    await saveRules((d) => {
      d.reports.kinds.weekly.enabled = true;
      d.reports.kinds.quarterly.content.notes.areas = [{ key: "followers", label: "Followers" }, { key: "sales", label: "Sales" }];
    });
    const period = prevPeriod("quarterly");
    const made = ok(await create(U.officer, e.id, "quarterly", period), 201, "quarterly with a company's own areas");
    // The gateway stand-in answers the three default areas: the draft is the template, with the company's two.
    expect(made.draftedVia).toBe("fallback");
    expect(Object.keys(made.notes).sort()).toEqual(["followers", "sales"]);
    ok(await submit(U.officer, made.id), 200, "submit");
    ok(await patch(U.officer, `${base()}/reports/${made.id}`, { notes: { followers: NOTES.followers, sales: { insight: "Sales rose.", suggestion: "  " } } }), 200, "a blank suggestion in the added area");
    refused(await approve(U.hod, made.id), "notes_incomplete");
    refused(await patch(U.officer, `${base()}/reports/${made.id}`, { notes: { audience: NOTES.audience } }), "invalid_field", 400, { field: "notes" }); // not this report's area
    ok(await patch(U.officer, `${base()}/reports/${made.id}`, { notes: { followers: NOTES.followers, sales: { insight: "Sales rose.", suggestion: "Do more." } } }), 200, "complete");
    ok(await approve(U.hod, made.id), 200, "the check passes");

    // A fiscal year starting in April: the quarter before today's, in fiscal terms, is a different period of the same name space.
    await saveRules((d) => { d.reports.fiscalYearStartMonth = 4; });
    const fiscal = prevPeriod("quarterly", 4);
    const e2 = await makeEngagement("Fiscal", U.officer);
    const q = ok(await create(U.officer, e2.id, "quarterly", fiscal), 201, "a fiscal quarter");
    expect(q.metrics).toMatchObject({ rangeStart: rangeOf("quarterly", fiscal, 4).start, rangeEnd: rangeOf("quarterly", fiscal, 4).end });
    expect(q.metrics.rangeStart.slice(5)).toMatch(/^(04|07|10|01)-01$/);
    refused(await create(U.officer, e2.id, "yearly", curPeriod("yearly", 4)), "period_not_over");
    ok(await create(U.officer, e2.id, "yearly", prevPeriod("yearly", 4)), 201, "a fiscal year, named by the calendar year it starts in");
    expect(rangeOf("quarterly", "2026-Q1", 4)).toEqual({ start: "2026-04-01", end: "2026-06-30" });
  });
});
