// SCP-5a — the monthly report against REAL Postgres and REAL Cerbos, through the real HTTP layer (BFF §63.18, PERMISSION §53.7; the
// fixture's `reports` block; owner rulings SCP-Q20 and SCP-Q22). Skips without DATABASE_URL_TEST; on CI it runs for real. The PDF round
// trip through the renderer stand-in also needs REDIS_URL_TEST (the print job token lives in Redis), which CI has.
//
// THE CLAIMS UNDER TEST (§63.21 "The monthly report")
//   1. The four states with their gates: Draft -> HoD check -> Ready -> Sent, and the HoD check's other answer, sending back.
//   2. Who: the officer drafts, edits and submits, but cannot approve, send back or send; a company_admin cannot approve, send back
//      or send; an automation holding company_admin cannot either; the HoD and GM seats, the owner and the superadmin can. The
//      writer may approve their own report (SCP-Q22). `canApprove` / `canDeliver` say the same, without a throw.
//   3. `notes_incomplete` blocks the HoD check until every area has an insight and a suggestion; the PATCH refuses bad shapes with
//      400 `{field}`, and a refused caller with a bad body is still 403.
//   4. "Draft with AI" saves nothing, falls back to the template when the gateway is down, and is refused outside draft/in_review.
//   5. Numbers: manual and simulated metric rows and the month's boosts (the client's own ad spend) are in the frozen snapshot;
//      simulated rows only while the simulator switch is on (as GET overview), and then `simulated` is set and the document says so.
//   6. Sending publishes through PV7-04a (one client report), or answers 503 `pdf_render_not_configured` with no renderer.
//   7. Needs you (§63.7): the officer's monthly report due (with and without a row, gone once sent); the seats' reports to check and
//      to send; nobody else gets the seats' queue.
//   8. One monthly report per engagement and month: a second create returns the first (`draftedVia: 'existing'`).
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
import { registerModule, resetModules } from "../registry";
import { socialModule } from "./index";
import { previousPeriod } from "./reports";
import { SCP } from "./pipeline/fixture";

const REDIS_TEST_URL = process.env.REDIS_URL_TEST ?? "";

// The gateway: a deterministic stand-in. `gw.mode` picks a good draft, a draft stating an invented number, or an outage.
const { gw } = vi.hoisted(() => ({ gw: { mode: "good" as "good" | "invented" | "down", calls: 0 } }));
const NOTES = {
  followers: { insight: "Followers held steady through the month.", suggestion: "Keep the weekly series going." },
  engagement: { insight: "Comments rose on the behind-the-scenes posts.", suggestion: "Answer every comment within a day." },
  audience: { insight: "Most of the audience is local.", suggestion: "Post at lunchtime." },
};
vi.mock("./gateway-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./gateway-client")>();
  return {
    ...actual,
    completeViaGateway: async () => {
      gw.calls++;
      if (gw.mode === "down") throw new Error("gateway down");
      const narrative = gw.mode === "invented" ? "Followers grew by 4321 this month." : "A steady month for the brand.";
      return { text: JSON.stringify({ narrative, notes: NOTES, actionPlan: [{ action: "Plan next month's reels.", owner: "agency" }] }), provider: "mock" };
    },
  };
});

const SVC = { authorization: "Bearer svc-token" };
const as = (id: string) => ({ ...SVC, "x-user-id": id });

describe.skipIf(!TEST_URL)("SCP-5a · the monthly report (BFF §63.18, PERMISSION §53.7)", () => {
  let app: NestFastifyApplication;
  let A: string;
  const U: Record<string, string> = {};
  let seq = 0;
  const flagBefore = config.socialSimulationEnabled;
  const rendererBefore = config.reportRenderer;
  let nestBaseUrl = "";
  let sidecar: Server | null = null;
  let sidecarUrl = "";
  const printed: Array<{ simulated?: boolean; tables: Array<{ key: string }> }> = [];

  const base = () => `/api/${A}/modules/social`;
  const get = (who: string, url: string) => app.inject({ method: "GET", url, headers: as(who) });
  const post = (who: string, url: string, payload: unknown = {}) => app.inject({ method: "POST", url, headers: as(who), payload: payload as object });
  const patch = (who: string, url: string, payload: unknown) => app.inject({ method: "PATCH", url, headers: as(who), payload: payload as object });
  const create = (who: string, engagementId: string, period: string, extra: Record<string, unknown> = {}) =>
    post(who, `${base()}/engagements/${engagementId}/reports`, { kind: "monthly", period, ...extra });
  const submit = (who: string, id: string) => patch(who, `${base()}/reports/${id}`, { status: "in_review" });
  const sendBack = (who: string, id: string) => patch(who, `${base()}/reports/${id}`, { status: "draft" });
  const approve = (who: string, id: string) => post(who, `${base()}/reports/${id}/approve`);
  const deliver = (who: string, id: string) => post(who, `${base()}/reports/${id}/deliver`);
  const statusOf = async (id: string) => (await adminPool().query(`SELECT status FROM social_reports WHERE id = $1`, [id])).rows[0]?.status as string;
  const rowOf = async (id: string) => (await adminPool().query(`SELECT to_jsonb(r) AS j FROM social_reports r WHERE id = $1`, [id])).rows[0]?.j as Record<string, unknown>;

  function ok(r: LightMyRequestResponse, status: number, label: string) {
    expect(r.statusCode, `${label}: ${r.body}`).toBe(status);
    return r.json();
  }
  function forbidden(r: LightMyRequestResponse, label: string) {
    expect(r.statusCode, `${label}: ${r.body}`).toBe(403);
  }
  /** A refusal with the fixture's code and status (the `reports` block). */
  function refused(r: LightMyRequestResponse, code: string, label = code) {
    const want = SCP.reports.refusals[code]?.http;
    expect(want, `${code} is catalogued in the fixture's reports block`).toBeGreaterThan(0);
    expect(r.statusCode, `${label}: ${r.body}`).toBe(want);
    expect(r.json().error, label).toBe(code);
  }

  interface Eng { id: string; clientId: string; account: string; cycle: string }
  async function makeEngagement(name: string, officer: string, reportDueDay: number | null = null): Promise<Eng> {
    const clientId = await createClient(A, `${name} ${++seq}`);
    const id = newId();
    const org = newId();
    const account = newId();
    const cycle = newId();
    const db = adminPool();
    await db.query(`INSERT INTO social_engagements (id, tenant_id, client_id, name, status, report_due_day) VALUES ($1, $2, $3, $4, 'active', $5)`,
      [id, A, clientId, `${name} engagement`, reportDueDay]);
    // A pipeline post needs a cycle (social_posts_pipeline_needs_cycle_ck); its month does not matter to a report.
    await db.query(`INSERT INTO social_cycles (id, tenant_id, engagement_id, month, deadline, ready_by, origin_site) VALUES ($1, $2, $3, '2026-09-01', '2026-08-26', '2026-08-24', 'central')`,
      [cycle, A, id]);
    await placeOfficerOnAllocation(A, id, officer);
    await db.query(`INSERT INTO social_publisher_orgs (id, tenant_id, client_id, driver, postiz_org_id, api_key_ref, status, origin_site) VALUES ($1, $2, $3, 'postiz', $4, 'default', 'active', 'central')`,
      [org, A, clientId, `scp5a-org-${++seq}`]);
    await db.query(`INSERT INTO social_accounts (id, tenant_id, client_id, publisher_org_id, network, handle, status, quota, origin_site) VALUES ($1, $2, $3, $4, 'instagram', $5, 'connected', '{}', 'central')`,
      [account, A, clientId, org, `@scp5a-${++seq}`]);
    return { id, clientId, account, cycle };
  }

  /** A pipeline post of `e` that went live on `day`, with one published variant and (optionally) one metric row of `source`. */
  async function livePost(e: Eng, day: string, o: { simulated?: boolean; metric?: { source: "pull" | "manual" | "simulated"; impressions: number } } = {}): Promise<string> {
    const id = newId();
    const v = newId();
    await adminPool().query(
      `INSERT INTO social_posts (id, tenant_id, engagement_id, cycle_id, title, pipeline_status, status_since, schedule_via, live_url, went_live_at, simulated)
       VALUES ($1, $2, $3, $4, $5, 'live', now(), 'manual', 'https://instagram.example.test/p/mock', $6::timestamptz, $7)`,
      [id, A, e.id, e.cycle, `Mock post ${++seq}`, `${day}T10:00:00Z`, o.simulated ?? false]);
    await adminPool().query(
      `INSERT INTO social_post_variants (id, tenant_id, post_id, account_id, body, status, native_import, published_url, published_at, origin_site)
       VALUES ($1, $2, $3, $4, 'copy', 'published', true, 'https://example.test/p', $5::timestamptz, 'central')`, [v, A, id, e.account, `${day}T10:00:00Z`]);
    if (o.metric) {
      await adminPool().query(
        `INSERT INTO social_post_metrics (tenant_id, variant_id, impressions, source, entered_by, fetched_at) VALUES ($1, $2, $3, $4, $5, $6::timestamptz)`,
        [A, v, o.metric.impressions, o.metric.source, o.metric.source === "manual" ? U.officer : null, `${day}T20:00:00Z`]);
    }
    return id;
  }

  /** A completed boost on `postId` that started on `startsOn` and spent `spendMinor` rupiah. */
  async function completedBoost(e: Eng, postId: string, startsOn: string, spendMinor: number, simulated = false): Promise<void> {
    await adminPool().query(
      `INSERT INTO social_boosts (id, tenant_id, post_id, client_id, status, goal, audience, daily_budget_minor, days, currency, starts_on,
                                  requested_by, approved_via, approved_by, approved_at, approval_channel, approval_note, started_at, started_by,
                                  ended_at, ended_by, spend_minor, paid_reach, clicks, results_entered_by, simulated)
       VALUES ($1, $2, $3, $4, 'completed', 'website', 'automatic', 100000, 5, 'IDR', $5::date,
               $6, 'recorded', $6, now(), 'whatsapp', 'Agreed on the phone.', $5::date, $6, $5::date + 5, $6, $7, 1500, 30, $6, $8)`,
      [newId(), A, postId, e.clientId, startsOn, U.hod, spendMinor, simulated]);
  }

  async function readyToCheck(e: Eng, period: string): Promise<string> {
    const r = ok(await create(U.officer, e.id, period), 201, `create ${period}`);
    ok(await submit(U.officer, r.id), 200, "submit");
    return r.id as string;
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    config.reportRenderer = { url: "", token: "", platformUiInternalUrl: "", timeoutMs: 5000 };
    config.socialSimulationEnabled = false;
    if (REDIS_TEST_URL) setRedis(new Redis(REDIS_TEST_URL));
    resetModules();
    registerModule(socialModule);

    A = await createCompany("SCP5a Agency", ["social"]);
    const units = await seedSocialOrgTree(A);
    const people = ["officer", "officer2", "hod", "gm", "owner", "ownerReader", "platformAdmin", "companyAdmin", "bot", "nobody"];
    for (const p of people) U[p] = await createUser(`scp5a-${p.toLowerCase()}@mock.test`, `Mock ${p}`);
    for (const p of people) await addMembership(A, U[p]);
    await withGlobal((c) => c.query(`UPDATE users SET kind = 'automation' WHERE id = $1`, [U.bot]));
    for (const p of ["officer", "officer2", "hod", "gm", "ownerReader"]) await grantSocialRole(A, U[p], "social_staff");
    await grantSocialSeat(A, units.socialMedia, U.hod);
    await grantSocialSeat(A, units.gm, U.gm);
    await grantSocialRole(A, U.owner, "owner");
    await grantSocialRole(A, U.ownerReader, "owner");
    await grantRole(U.platformAdmin, await createRole("platform_admin"), "global", null);
    await grantSocialRole(A, U.companyAdmin, "company_admin");
    await grantSocialRole(A, U.bot, "company_admin");

    app = await buildApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    nestBaseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

    // The renderer stand-in relays to OUR real print-payload route (the round trip social-reports.test.ts proves) and keeps the
    // document it was asked to print, so the test sees what the PDF would carry.
    sidecar = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", async () => {
        if (req.method !== "POST" || req.url !== "/render" || req.headers.authorization !== "Bearer render-tok") { res.writeHead(401).end(); return; }
        const { url } = JSON.parse(raw) as { url: string };
        const payloadRes = await fetch(`${nestBaseUrl}/internal/reports/print-payload/${url.slice(url.lastIndexOf("/") + 1)}`);
        if (!payloadRes.ok) { res.writeHead(502).end(); return; }
        const payload = (await payloadRes.json()) as { document: { simulated?: boolean; tables: Array<{ key: string }> } };
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
  it("the four states with their gates; the officer submits but cannot approve, send back or send; a company_admin cannot either", async () => {
    gw.mode = "good";
    const e = await makeEngagement("Lifecycle", U.officer);
    const created = ok(await create(U.officer, e.id, "2026-08"), 201, "the officer drafts");
    expect(created).toMatchObject({ status: "draft", draftedVia: "ai", notes: NOTES, simulated: false });
    expect(created.actionPlan).toEqual([{ action: "Plan next month's reels.", owner: "agency" }]);
    const id = created.id as string;

    // Draft: the officer edits; nobody approves from draft.
    ok(await patch(U.officer, `${base()}/reports/${id}`, { narrativeMd: "Edited by the officer." }), 200, "the officer edits");
    refused(await approve(U.hod, id), "cannot_approve_from_this_status");

    // HoD check: the officer submits; the officer, the company_admin and an automation cannot approve or send it back.
    ok(await submit(U.officer, id), 200, "the officer submits");
    expect(await statusOf(id)).toBe("in_review");
    for (const who of ["officer", "companyAdmin", "bot"]) {
      forbidden(await approve(U[who], id), `${who} approve`);
      forbidden(await sendBack(U[who], id), `${who} send back`);
    }
    forbidden(await patch(U.officer, `${base()}/reports/${id}`, { status: "draft", narrativeMd: "x" }), "the officer's send back with an edit");
    expect(await statusOf(id)).toBe("in_review");

    // The HoD sends it back (the check's other answer), the officer resubmits, the GM approves it.
    ok(await sendBack(U.hod, id), 200, "the HoD sends it back");
    expect(await statusOf(id)).toBe("draft");
    refused(await sendBack(U.hod, id), "cannot_send_back_from_this_status");
    ok(await submit(U.officer, id), 200, "the officer resubmits");
    refused(await submit(U.officer, id), "cannot_submit_from_this_status");
    ok(await approve(U.gm, id), 200, "the GM approves");
    expect(await statusOf(id)).toBe("approved");

    // Ready: no more edits; the officer, the company_admin and an automation cannot send it.
    refused(await patch(U.officer, `${base()}/reports/${id}`, { narrativeMd: "late" }), "report_not_editable");
    for (const who of ["officer", "companyAdmin", "bot"]) forbidden(await deliver(U[who], id), `${who} deliver`);

    // Sent: by one of the four. No renderer configured here: an honest 503, the report stays Ready.
    refused(await deliver(U.hod, id), "pdf_render_not_configured");
    expect(await statusOf(id)).toBe("approved");
  });

  it("the owner and the superadmin hold the check and the send; the writer may approve their own report (SCP-Q22); canApprove/canDeliver agree", async () => {
    gw.mode = "good";
    const e = await makeEngagement("Owner", U.officer);
    const byOwner = await readyToCheck(e, "2026-07");
    ok(await approve(U.owner, byOwner), 200, "the owner approves");
    expect(ok(await get(U.owner, `${base()}/reports`), 200, "the owner reads the list").reports.map((r: { id: string }) => r.id)).toContain(byOwner);

    const byPa = await readyToCheck(e, "2026-06");
    ok(await sendBack(U.platformAdmin, byPa), 200, "the superadmin sends back");
    ok(await submit(U.officer, byPa), 200, "resubmit");
    ok(await approve(U.platformAdmin, byPa), 200, "the superadmin approves");

    // A seat holder who wrote the report approves it: reports have no maker/checker rule.
    const own = ok(await create(U.hod, e.id, "2026-05"), 201, "the HoD writes one");
    ok(await submit(U.hod, own.id), 200, "the HoD submits their own");
    ok(await approve(U.hod, own.id), 200, "the HoD approves their own");

    const flags = async (who: string) => {
      const j = ok(await get(U[who], `${base()}/reports/${byOwner}`), 200, `${who} reads`);
      return [j.canApprove, j.canDeliver];
    };
    expect(await flags("officer")).toEqual([false, false]);
    expect(await flags("companyAdmin")).toEqual([false, false]);
    expect(await flags("hod")).toEqual([true, true]);
    expect(await flags("gm")).toEqual([true, true]);
    expect(await flags("owner")).toEqual([true, true]);
    expect(await flags("platformAdmin")).toEqual([true, true]);
    forbidden(await get(U.nobody, `${base()}/reports/${byOwner}`), "a member with no social role reads nothing");
  });

  it("the officer cannot send even a Ready report; the owner can (PV7-04a publication through the renderer)", async () => {
    gw.mode = "good";
    const e = await makeEngagement("Send", U.officer);
    const id = await readyToCheck(e, "2026-04");
    ok(await approve(U.hod, id), 200, "approve");
    forbidden(await deliver(U.officer, id), "the officer never sends (SCP-Q20)");
    if (!REDIS_TEST_URL) {
      refused(await deliver(U.owner, id), "pdf_render_not_configured");
      return;
    }
    config.reportRenderer = { url: sidecarUrl, token: "render-tok", platformUiInternalUrl: nestBaseUrl, timeoutMs: 5000 };
    try {
      const sent = ok(await deliver(U.owner, id), 200, "the owner sends");
      expect(sent.status).toBe("delivered");
      const published = await adminPool().query(`SELECT id::text AS id, status FROM client_reports WHERE source = 'social_report' AND source_id = $1`, [id]);
      expect(published.rows).toEqual([{ id: sent.clientReportId, status: "published" }]);
      const doc = printed[printed.length - 1];
      expect(doc.tables.map((t) => t.key)).toEqual(expect.arrayContaining(["notes", "action_plan"]));
      expect(doc.simulated).toBeUndefined();
      refused(await deliver(U.owner, id), "cannot_deliver_from_this_status");
    } finally {
      config.reportRenderer = { url: "", token: "", platformUiInternalUrl: "", timeoutMs: 5000 };
    }
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  it("notes_incomplete blocks the HoD check until every area has an insight and a suggestion; bad shapes are 400 {field}", async () => {
    gw.mode = "good";
    const e = await makeEngagement("Notes", U.officer);
    const id = await readyToCheck(e, "2026-03");
    const url = `${base()}/reports/${id}`;

    // The officer edits while in the HoD check; one blank suggestion blocks the check.
    ok(await patch(U.officer, url, { notes: { ...NOTES, audience: { insight: "Local.", suggestion: "   " } } }), 200, "blank a suggestion");
    expect(ok(await get(U.hod, url), 200, "read").notesComplete).toBe(false);
    refused(await approve(U.hod, id), "notes_incomplete");
    ok(await patch(U.officer, url, { notes: { followers: NOTES.followers, engagement: NOTES.engagement } }), 200, "drop an area");
    refused(await approve(U.hod, id), "notes_incomplete");
    const list = ok(await get(U.hod, `${base()}/reports?engagementId=${e.id}&period=2026-03`), 200, "list");
    expect(list.reports).toHaveLength(1);
    expect(list.reports[0]).toMatchObject({ id, period: "2026-03", notesComplete: false, simulated: false, kind: "monthly" });

    // Bad shapes: 400 with the field, nothing written.
    const before = await rowOf(id);
    for (const [body, field] of [
      [{ notes: [] }, "notes"], [{ notes: { reach: { insight: "x", suggestion: "y" } } }, "notes"],
      [{ notes: { followers: { insight: "x".repeat(501), suggestion: "y" } } }, "notes"],
      [{ actionPlan: {} }, "actionPlan"], [{ actionPlan: [{ action: "x", owner: "both" }] }, "actionPlan"],
      [{ actionPlan: Array.from({ length: 11 }, () => ({ action: "x", owner: "agency" })) }, "actionPlan"],
      [{ actionPlan: [{ action: "x", owner: "client", due: "2026-02-31" }] }, "actionPlan"],
    ] as const) {
      const r = await patch(U.officer, url, body);
      expect(r.statusCode, JSON.stringify(body)).toBe(400);
      expect(r.json(), JSON.stringify(body)).toMatchObject({ error: "invalid_field", field });
    }
    expect(await rowOf(id)).toEqual(before);
    // A refused caller with a bad body is still 403, never 400 (authorization before validation).
    forbidden(await patch(U.nobody, url, { notes: [] }), "no right, bad body");

    // Complete again: the check passes, and the action plan is stored as given.
    ok(await patch(U.officer, url, { notes: NOTES, actionPlan: [{ action: "Agree on the March promotions.", owner: "client", due: "2026-04-05" }] }), 200, "complete");
    const j = ok(await get(U.hod, url), 200, "read");
    expect(j).toMatchObject({ notes: NOTES, notesComplete: true, actionPlan: [{ action: "Agree on the March promotions.", owner: "client", due: "2026-04-05" }] });
    ok(await approve(U.hod, id), 200, "the check passes");
  });

  it("Draft with AI answers a proposal and saves nothing; the template when the gateway is down; refused outside draft and in_review", async () => {
    gw.mode = "good";
    const e = await makeEngagement("Draft", U.officer);
    const id = ok(await create(U.officer, e.id, "2026-02"), 201, "create").id as string;
    const url = `${base()}/reports/${id}/ai-draft`;
    const before = await rowOf(id);
    const activityBefore = Number((await adminPool().query(`SELECT count(*)::int AS n FROM activities WHERE target_entity_id = $1`, [id])).rows[0].n);

    const aiDraft = ok(await post(U.officer, url), 200, "the officer asks for a draft");
    expect(aiDraft).toMatchObject({ draftedVia: "ai", narrativeMd: "A steady month for the brand.", notes: NOTES });
    gw.mode = "invented";
    expect(ok(await post(U.officer, url), 200, "an invented number").draftedVia).toBe("template");
    gw.mode = "down";
    const template = ok(await post(U.officer, url), 200, "the gateway down");
    expect(template.draftedVia).toBe("template");
    expect(Object.keys(template.notes).sort()).toEqual(["audience", "engagement", "followers"]);
    expect(template.actionPlan.length).toBeGreaterThan(0);

    expect(await rowOf(id), "nothing saved").toEqual(before);
    expect(Number((await adminPool().query(`SELECT count(*)::int AS n FROM activities WHERE target_entity_id = $1`, [id])).rows[0].n)).toBe(activityBefore);

    // Gated as update: the owner (check and send only) cannot draft.
    forbidden(await post(U.owner, url), "the owner does not write the report");
    gw.mode = "good";
    ok(await submit(U.officer, id), 200, "submit");
    ok(await post(U.officer, url), 200, "still editable in the HoD check");
    ok(await approve(U.hod, id), 200, "approve");
    refused(await post(U.officer, url), "report_not_editable");
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  it("numbers: manual and simulated metric rows and the month's boosts; simulated rows only while the switch is on, then `simulated`", async () => {
    gw.mode = "good";
    const e = await makeEngagement("Numbers", U.officer);
    // September 2026: one real post with a hand-typed metric, one simulated post with a simulated metric, a real completed boost
    // and a simulated one, and a simulated daily row.
    const real = await livePost(e, "2026-09-03", { metric: { source: "manual", impressions: 300 } });
    const sim = await livePost(e, "2026-09-10", { simulated: true, metric: { source: "simulated", impressions: 700 } });
    await completedBoost(e, real, "2026-09-05", 250_000);
    await completedBoost(e, sim, "2026-09-12", 90_000, true);
    await adminPool().query(`INSERT INTO social_metrics_daily (tenant_id, account_id, date, followers, source) VALUES ($1, $2, '2026-09-15', 5000, 'simulated')`, [A, e.account]);
    // A boost of another month is not this month's spend.
    await completedBoost(e, real, "2026-10-02", 1_000_000);

    const kpi = (m: { kpis: Array<{ metricKey: string; value: number }> }, key: string) => m.kpis.find((k) => k.metricKey === key)?.value;

    // Switch OFF: the simulated rows are left out, as the overview leaves them out.
    config.socialSimulationEnabled = false;
    const off = ok(await create(U.officer, e.id, "2026-09"), 201, "switch off");
    expect(off.simulated).toBe(false);
    expect(kpi(off.metrics, "posts_published_period")).toBe(1);
    expect(off.metrics.kpis.find((k: { metricKey: string }) => k.metricKey === "followers_total")).toBeUndefined();
    expect(off.metrics.tables.find((t: { key: string }) => t.key === "top_posts").rows.map((r: { impressions: number }) => r.impressions)).toEqual([300]);
    expect(off.metrics.adSpend).toEqual([{ currency: "IDR", minorUnit: 0, boosts: 1, spendMinor: 250_000, paidReach: 1500, clicks: 30 }]);
    const spendTable = off.metrics.tables.find((t: { key: string }) => t.key === "ad_spend");
    expect(spendTable.rows.map((r: { spend: number }) => r.spend)).toEqual([250_000]);
    expect(JSON.stringify(off.metrics)).not.toMatch(/fee|margin/i);

    // Switch ON: the same month (another engagement's identical rows would do; here a fresh report of the next engagement).
    const e2 = await makeEngagement("Numbers on", U.officer);
    const real2 = await livePost(e2, "2026-09-03", { metric: { source: "pull", impressions: 300 } });
    const sim2 = await livePost(e2, "2026-09-10", { simulated: true, metric: { source: "simulated", impressions: 700 } });
    await completedBoost(e2, real2, "2026-09-05", 250_000);
    await completedBoost(e2, sim2, "2026-09-12", 90_000, true);
    config.socialSimulationEnabled = true;
    try {
      const on = ok(await create(U.officer, e2.id, "2026-09"), 201, "switch on");
      expect(on.simulated).toBe(true);
      expect(kpi(on.metrics, "posts_published_period")).toBe(2);
      expect(on.metrics.adSpend[0]).toMatchObject({ boosts: 2, spendMinor: 340_000 });
      const read = ok(await get(U.hod, `${base()}/reports/${on.id}`), 200, "read");
      expect(read.simulated).toBe(true);
      expect(read.document.simulated).toBe(true);
      const listed = ok(await get(U.hod, `${base()}/reports?engagementId=${e2.id}`), 200, "list").reports;
      expect(listed[0]).toMatchObject({ id: on.id, simulated: true });
      // The mark is frozen with the numbers: turning the switch off later does not unmark the report.
      config.socialSimulationEnabled = false;
      expect(ok(await get(U.hod, `${base()}/reports/${on.id}`), 200, "read again").document.simulated).toBe(true);

      if (REDIS_TEST_URL) {
        ok(await submit(U.officer, on.id), 200, "submit");
        ok(await approve(U.hod, on.id), 200, "approve");
        config.reportRenderer = { url: sidecarUrl, token: "render-tok", platformUiInternalUrl: nestBaseUrl, timeoutMs: 5000 };
        try {
          ok(await deliver(U.gm, on.id), 200, "the GM sends");
          expect(printed[printed.length - 1].simulated, "the PDF carries the SIMULATED mark").toBe(true);
        } finally {
          config.reportRenderer = { url: "", token: "", platformUiInternalUrl: "", timeoutMs: 5000 };
        }
      }
    } finally {
      config.socialSimulationEnabled = false;
    }
  });

  it("one monthly report per engagement and month: a second create returns the first, before any gateway call", async () => {
    gw.mode = "good";
    const e = await makeEngagement("Once", U.officer);
    const first = ok(await create(U.officer, e.id, "2026-01"), 201, "first");
    const calls = gw.calls;
    const second = ok(await create(U.officer, e.id, "2026-01", { id: newId() }), 201, "second");
    expect(second).toMatchObject({ id: first.id, draftedVia: "existing", notes: NOTES });
    expect(gw.calls).toBe(calls);
    // Two at once: one row.
    const e2 = await makeEngagement("Once at once", U.officer);
    const [a, b] = await Promise.all([create(U.officer, e2.id, "2026-01"), create(U.officer, e2.id, "2026-01")]);
    expect(ok(a, 201, "a").id).toBe(ok(b, 201, "b").id);
    const n = await adminPool().query(`SELECT count(*)::int AS n FROM social_reports WHERE engagement_id = $1`, [e2.id]);
    expect(n.rows[0].n).toBe(1);
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  it("Needs you: the officer's monthly report due (with or without a row, gone once sent); the seats' reports to check and to send", async () => {
    gw.mode = "good";
    const period = previousPeriod(todayIsoInTz(config.reportsTz));
    const needs = async (who: string) => {
      const j = ok(await get(U[who], `${base()}/needs-you`), 200, `${who} needs-you`);
      expect(j.partial, `${who} partial`).toEqual([]);
      return j.items as Array<{ id: string; kind: string; role: string; title: string; clientName: string; due?: string; href: string }>;
    };
    const due = await makeEngagement("Due", U.officer2, 31);
    await makeEngagement("Not due", U.officer2, null); // no report_due_day: never due

    // No row yet: the item opens the list.
    let items = (await needs("officer2")).filter((i) => i.kind === "report_due");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: `social:${A}:${due.id}:report_due`, role: "officer", href: "/departments/d-social-media/social-reports" });
    expect(items[0].due).toMatch(new RegExp(`^${todayIsoInTz(config.reportsTz).slice(0, 7)}-(28|29|30|31)$`));
    expect(items[0].clientName).toMatch(/^Due /);

    // A row: the item opens it, through the HoD check and Ready, and is gone once the report is sent.
    const id = ok(await create(U.officer2, due.id, period), 201, "draft").id as string;
    items = (await needs("officer2")).filter((i) => i.kind === "report_due");
    expect(items).toEqual([expect.objectContaining({ id: `social:${A}:${id}:report_due`, href: `/departments/d-social-media/social-reports/${id}` })]);

    ok(await submit(U.officer2, id), 200, "submit");
    for (const seat of ["hod", "gm"]) {
      expect((await needs(seat)).find((i) => i.id === `social:${A}:${id}:report_check`), `${seat} has it to check`)
        .toMatchObject({ kind: "report_check", role: "approver", href: `/departments/d-social-media/social-reports/${id}` });
    }
    ok(await approve(U.hod, id), 200, "approve");
    expect((await needs("gm")).find((i) => i.id === `social:${A}:${id}:report_send`), "the GM has it to send").toMatchObject({ kind: "report_send" });
    expect((await needs("hod")).find((i) => i.id === `social:${A}:${id}:report_check`), "no longer to check").toBeUndefined();
    expect((await needs("officer2")).filter((i) => i.kind === "report_due"), "still due until sent").toHaveLength(1);

    // Nobody but the seats gets the seats' queue: not the officer, not the owner, not a company_admin.
    for (const who of ["officer2", "ownerReader", "companyAdmin"]) {
      expect((await needs(who)).filter((i) => i.kind === "report_check" || i.kind === "report_send"), who).toEqual([]);
    }

    // Sent: no longer due, no longer to send. (The send itself is the renderer's; here the row is marked as a send would.)
    await adminPool().query(`UPDATE social_reports SET status = 'delivered', delivered_at = now() WHERE id = $1`, [id]);
    expect((await needs("officer2")).filter((i) => i.kind === "report_due")).toEqual([]);
    expect((await needs("gm")).find((i) => i.id === `social:${A}:${id}:report_send`)).toBeUndefined();
  });

  it("the fixture's reports block names every refusal this suite produced, notes_incomplete included", () => {
    const codes = Object.keys(SCP.reports.refusals);
    for (const c of ["notes_incomplete", "report_not_editable", "cannot_approve_from_this_status", "cannot_send_back_from_this_status",
      "cannot_submit_from_this_status", "cannot_deliver_from_this_status", "pdf_render_not_configured"]) {
      expect(codes, c).toContain(c);
    }
  });
});
