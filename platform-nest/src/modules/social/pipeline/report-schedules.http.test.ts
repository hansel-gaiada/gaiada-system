// SCP-5 W5-A5 — report automation against REAL Postgres and REAL Cerbos, through the real HTTP layer (BFF §63.24.9; plan §7 wave 5 row
// W5-A5; owner rulings SCP-Q17, Q19, Q38, Q40). Skips without DATABASE_URL_TEST; on CI it runs for real. The gateway is a stand-in that
// never calls a model: the REAL gateway client (`completeViaGateway`) over a fake network, so every call writes its real `ai_usage_events`.
//
// THE CLAIMS UNDER TEST (§63.24.9's proofs)
//   1. Only the four set schedules: an officer, a company admin and a Web Dev head 403 `not_a_social_approver`; an automation 403
//      `automation_cannot_act`; 404 `schedule_not_found`; 400 `{field}` for the kind, the scope, each timing part and the clients;
//      409 `schedule_exists` `{scheduleId}`; a replayed id `created: false`. Each of the four sets one, and owns it.
//   2. The job on two instances at once (truly concurrent; the first holds its claim while the second sweeps) claims a due schedule ONCE.
//      The run acts as the OWNER: `requested_by`, every report's activity and every usage row carry the owner, with
//      `via: {automation: 'report_schedule', scheduleId, missed}`; the drafts are drafts (nothing approved or sent).
//   3. One run per schedule and period: forced due again for the same period, the job passes it over and makes no second run.
//   4. Downtime: a daily schedule three periods behind drafts only the latest, once, with `missed: 2`.
//   5. An owner who lost the seat: no run, the schedule paused `owner_not_allowed`, the owner, HoD and GM told; another of the four resumes
//      it and becomes the owner. A deactivated owner: `owner_inactive`, and the owner is not told.
//   6. Run now runs as the PRESSER (`trigger: 'run_now'`), leaves `next_run_at` alone, and answers `alreadyApplied` for a period already run.
//   7. The spend: a schedule's 30-day and month-to-date spend sums its runs' usage (SCP-Q40).
//   8. By chat: the tools through the OBO envelope act as the person (the owner is the person, `via` the agent); the tools' classes.
//   9. Delete: soft, and then 404.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { LightMyRequestResponse } from "fastify";
import { config } from "../../../config";
import { newId, withGlobal } from "../../../db";
import { buildApp } from "../../../main";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../../../testing/setup";
import { createCompany, createUser, addMembership, createClient, createRole, grantRole, linkIdentity } from "../../../testing/fixtures";
import { grantSocialRole, grantSocialSeat, placeOfficerOnAllocation, seedSocialOrgTree } from "../../../testing/social-pipeline-fixtures";
import { todayIsoInTz } from "../../reports/person-scope";
import { addDays } from "../../hr/working-days";
import { registerModule, resetModules } from "../../registry";
import { socialModule } from "../index";
import { periodOf } from "./rules-periods";
import { reportRunsIdle } from "./report-runs";
import { runReportSchedulesSweep, setReportScheduleClaimHookForTests } from "./report-schedules";

const { gw } = vi.hoisted(() => ({ gw: { calls: 0 } }));
vi.mock("../gateway-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gateway-client")>();
  return {
    ...actual,
    completeViaGateway: async (prompt: string, opts: Parameters<typeof actual.completeViaGateway>[1]) => {
      gw.calls++;
      const fetchImpl = (async () => new Response(JSON.stringify({
        text: JSON.stringify({ narrative: "A steady period for the brand.", nextPeriod: "More posts are coming." }),
        provider: "mock", usage: { promptTokens: 100, completionTokens: 40, costUsd: 0.002, source: "provider" },
      }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
      return actual.completeViaGateway(prompt, { ...opts, gatewayUrl: "http://gateway.test", gatewayToken: "test", fetchImpl });
    },
  };
});
vi.mock("../knowledge-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../knowledge-client")>();
  return { ...actual, queryBrandKnowledge: async () => [] };
});

const SVC = { authorization: "Bearer svc-token" };
const as = (id: string) => ({ ...SVC, "x-user-id": id });
const viaAgent = (externalId: string) => ({ ...SVC, "x-obo-provider": "whatsapp", "x-obo-external-id": externalId, "x-obo-agent": "mock-agent" });

describe.skipIf(!TEST_URL)("SCP-5 W5-A5 · report automation (BFF §63.24.9)", () => {
  let app: NestFastifyApplication;
  let A: string;
  const U: Record<string, string> = {};
  const E: Record<string, string> = {};
  const S: Record<string, string> = {};
  const flagBefore = config.socialSimulationEnabled;

  const TZ = config.reportsTz;
  const TODAY = todayIsoInTz(TZ);
  const week = (k: number) => periodOf("weekly", addDays(TODAY, -7 * k));
  const day = (k: number) => addDays(TODAY, -k);
  const lastMonth = periodOf("monthly", addDays(`${TODAY.slice(0, 7)}-01`, -1));

  const base = () => `/api/${A}/modules/social`;
  const list = (h: Record<string, string>) => app.inject({ method: "GET", url: `${base()}/report-schedules`, headers: h });
  const create = (h: Record<string, string>, payload: unknown) => app.inject({ method: "POST", url: `${base()}/report-schedules`, headers: h, payload: payload as object });
  const patch = (h: Record<string, string>, id: string, payload: unknown) => app.inject({ method: "PATCH", url: `${base()}/report-schedules/${id}`, headers: h, payload: payload as object });
  const del = (h: Record<string, string>, id: string) => app.inject({ method: "DELETE", url: `${base()}/report-schedules/${id}`, headers: h });
  const runNow = (h: Record<string, string>, id: string) => app.inject({ method: "POST", url: `${base()}/report-schedules/${id}/run`, headers: h, payload: {} });

  function ok(r: LightMyRequestResponse, status: number, label: string) {
    expect(r.statusCode, `${label}: ${r.body}`).toBe(status);
    return r.json();
  }
  function refused(r: LightMyRequestResponse, status: number, code: string, extra: Record<string, unknown> = {}) {
    expect(r.statusCode, `${code}: ${r.body}`).toBe(status);
    expect(r.json(), code).toMatchObject({ error: code, ...extra });
  }
  const scheduleRow = async (id: string) => (await adminPool().query(`SELECT to_jsonb(s) AS j FROM social_report_schedules s WHERE id = $1`, [id])).rows[0]?.j as Record<string, any>;
  const runsOf = async (scheduleId: string) => (await adminPool().query(
    `SELECT id::text AS id, period, trigger, requested_by::text AS requested_by, via, status, results FROM social_report_runs WHERE schedule_id = $1 ORDER BY created_at`,
    [scheduleId])).rows;
  /** Make a schedule due now, for the stored period `period`. */
  const makeDue = (id: string, period: string) => adminPool().query(
    `UPDATE social_report_schedules SET next_run_at = now() - interval '1 minute', next_period = $2 WHERE id = $1`, [id, period]);
  async function usageRows(runId: string, expected: number) {
    const until = Date.now() + 10_000;
    for (;;) {
      const { rows } = await adminPool().query(`SELECT user_id::text AS user_id, cost_usd, prompt_tokens, completion_tokens FROM ai_usage_events WHERE run_id = $1`, [runId]);
      if (rows.length >= expected || Date.now() > until) return rows;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  const notices = async (scheduleId: string) => (await adminPool().query<{ user_id: string; payload: Record<string, unknown> }>(
    `SELECT user_id::text AS user_id, payload FROM notifications WHERE type = 'social.report_schedule.paused' AND payload->>'entityId' = $1`, [scheduleId])).rows;

  async function engagement(key: string, name: string, kinds: string[]) {
    const clientId = await createClient(A, name);
    const id = newId();
    await adminPool().query(
      `INSERT INTO social_engagements (id, tenant_id, client_id, name, status, report_kinds) VALUES ($1, $2, $3, $4, 'active', $5::text[])`,
      [id, A, clientId, `${name} engagement`, kinds]);
    await placeOfficerOnAllocation(A, id, U.officer);
    E[key] = id;
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    config.socialSimulationEnabled = false;
    resetModules();
    registerModule(socialModule);

    A = await createCompany("SCP5 automation agency", ["social"]);
    const units = await seedSocialOrgTree(A);
    const people = ["hod", "gm", "owner", "padmin", "lead2", "leaver", "officer", "companyAdmin", "webDevHead", "bot"];
    for (const p of people) U[p] = await createUser(`scp5-sched-${p.toLowerCase()}@mock.test`, `Mock ${p}`);
    for (const p of people) await addMembership(A, U[p]);
    await withGlobal((c) => c.query(`UPDATE users SET kind = 'automation' WHERE id = $1`, [U.bot]));
    // The four (each also drafts: the run's second gate is `social_report` · `create`).
    await grantSocialSeat(A, units.socialMedia, U.hod);
    await grantSocialSeat(A, units.gm, U.gm);
    await grantSocialRole(A, U.owner, "owner");
    await grantRole(U.padmin, await createRole("platform_admin"), "global", null);
    for (const p of ["hod", "gm", "owner", "officer"]) await grantSocialRole(A, U[p], "social_staff");
    // Two more Social Media heads: one will lose the seat, one will be deactivated.
    for (const p of ["lead2", "leaver"]) {
      await grantSocialSeat(A, units.socialMedia, U[p]);
      await grantSocialRole(A, U[p], "social_staff");
    }
    // Refused.
    await grantSocialRole(A, U.companyAdmin, "company_admin");
    await grantSocialSeat(A, units.webDev, U.webDevHead);
    await grantSocialRole(A, U.webDevHead, "manager");
    await grantSocialRole(A, U.bot, "company_admin");
    await linkIdentity(U.hod, "whatsapp", "wa-scp5-sched-hod", true);

    await engagement("alpha", "Sched Alpha client", ["weekly", "daily"]);
    await engagement("bravo", "Sched Bravo client", ["weekly", "daily"]);
    await engagement("charlie", "Sched Charlie client", ["weekly"]);
    app = await buildApp();
  }, 180_000);

  afterAll(async () => {
    setReportScheduleClaimHookForTests(null);
    await reportRunsIdle();
    config.socialSimulationEnabled = flagBefore;
    await app?.close();
    await teardownTestDb();
  });

  it("only the four: an officer, a company admin and a Web Dev head 403; an automation 403 automation_cannot_act", async () => {
    const body = { kind: "weekly", scope: "all", timing: { weekday: 1, at: "00:00" } };
    for (const who of ["officer", "companyAdmin", "webDevHead"]) {
      refused(await list(as(U[who])), 403, "not_a_social_approver");
      refused(await create(as(U[who]), body), 403, "not_a_social_approver");
      refused(await runNow(as(U[who]), newId()), 403, "not_a_social_approver");
      refused(await patch(as(U[who]), newId(), { enabled: false }), 403, "not_a_social_approver");
    }
    refused(await list(as(U.bot)), 403, "automation_cannot_act");
    refused(await create(as(U.bot), body), 403, "automation_cannot_act");
    // 404 before 400.
    refused(await patch(as(U.hod), newId(), { timing: "nonsense" }), 404, "schedule_not_found");
    refused(await runNow(as(U.hod), newId()), 404, "schedule_not_found");
    refused(await del(as(U.hod), "not-a-uuid"), 404, "schedule_not_found");
    expect((await adminPool().query(`SELECT count(*)::int AS n FROM social_report_schedules WHERE tenant_id = $1`, [A])).rows[0].n).toBe(0);
  });

  it("400 {field}: the kind, the scope, each timing part (wrong kind included), the clients", async () => {
    const h = as(U.hod);
    refused(await create(h, { kind: "campaign", scope: "all", timing: { at: "08:00" } }), 400, "invalid_field", { field: "kind" });
    refused(await create(h, { kind: "daily", scope: "some", timing: { at: "08:00" } }), 400, "invalid_field", { field: "scope" });
    refused(await create(h, { kind: "daily", scope: "all" }), 400, "invalid_field", { field: "timing" });
    refused(await create(h, { kind: "daily", scope: "all", timing: { at: "25:00" } }), 400, "invalid_field", { field: "timing.at" });
    refused(await create(h, { kind: "daily", scope: "all", timing: { at: "08:00", weekday: 1 } }), 400, "invalid_field", { field: "timing.weekday" });
    refused(await create(h, { kind: "weekly", scope: "all", timing: { weekday: 8, at: "08:00" } }), 400, "invalid_field", { field: "timing.weekday" });
    refused(await create(h, { kind: "monthly", scope: "all", timing: { on: "week", at: "08:00" } }), 400, "invalid_field", { field: "timing.on" });
    refused(await create(h, { kind: "monthly", scope: "all", timing: { on: "day", day: 31, at: "08:00" } }), 400, "invalid_field", { field: "timing.day" });
    refused(await create(h, { kind: "yearly", scope: "all", timing: { on: "working_day", n: 21, at: "08:00" } }), 400, "invalid_field", { field: "timing.n" });
    refused(await create(h, { kind: "daily", scope: "chosen", timing: { at: "08:00" } }), 400, "invalid_field", { field: "engagementIds" });
    refused(await create(h, { kind: "daily", scope: "chosen", engagementIds: [newId()], timing: { at: "08:00" } }), 400, "invalid_field", { field: "engagementIds" });
    refused(await create(h, { kind: "daily", scope: "all", engagementIds: [E.alpha], timing: { at: "08:00" } }), 400, "invalid_field", { field: "engagementIds" });
    refused(await create(h, { kind: "daily", scope: "all", timing: { at: "08:00" }, extra: 1 }), 400, "invalid_field", { field: "extra" });
  });

  it("each of the four sets a schedule and owns it; schedule_exists for a second company-wide one; a replayed id is created: false", async () => {
    const weekly = ok(await create(as(U.hod), { id: newId(), kind: "weekly", scope: "all", timing: { weekday: 1, at: "00:00" } }), 201, "the HoD");
    S.weekly = weekly.schedule.id;
    expect(weekly).toMatchObject({
      created: true,
      schedule: {
        kind: "weekly", scope: "all", enabled: true, pausedReason: null, owner: { id: U.hod }, timingText: "Every Monday at 00:00, for the week before",
        nextPeriod: week(0), lastRun: null, spend: { last30Days: { runs: 0, calls: 0, costUsd: null } },
      },
    });
    expect(new Date(weekly.schedule.nextRunAt).getTime()).toBeGreaterThan(Date.now());
    refused(await create(as(U.gm), { kind: "weekly", scope: "all", timing: { weekday: 2, at: "09:00" } }), 409, "schedule_exists", { detail: { scheduleId: S.weekly } });
    const replay = ok(await create(as(U.hod), { id: S.weekly, kind: "weekly", scope: "all", timing: { weekday: 1, at: "00:00" } }), 200, "replay");
    expect(replay).toMatchObject({ created: false, schedule: { id: S.weekly } });

    const monthly = ok(await create(as(U.gm), { kind: "monthly", scope: "chosen", engagementIds: [E.alpha, E.charlie], timing: { on: "working_day", n: 3, at: "08:00" } }), 201, "the GM");
    S.monthly = monthly.schedule.id;
    expect(monthly.schedule).toMatchObject({ owner: { id: U.gm }, scope: "chosen", timingText: "On the 3rd working day of each month at 08:00, for the month before" });
    expect(monthly.schedule.clients.map((c: { clientName: string }) => c.clientName).sort()).toEqual(["Sched Alpha client", "Sched Charlie client"]);

    const daily = ok(await create(as(U.owner), { kind: "daily", scope: "all", timing: { at: "00:00" } }), 201, "the owner");
    S.daily = daily.schedule.id;
    expect(daily.schedule.owner.id).toBe(U.owner);
    const quarterly = ok(await create(as(U.padmin), { kind: "quarterly", scope: "all", timing: { on: "day", day: 10, at: "07:00" }, enabled: false }), 201, "the superadmin");
    S.quarterly = quarterly.schedule.id;
    expect(quarterly.schedule).toMatchObject({ enabled: false, pausedReason: "manual", nextRunAt: null, nextPeriod: null });

    const all = ok(await list(as(U.gm)), 200, "the list");
    expect(all.items.map((s: { id: string }) => s.id)).toEqual([S.weekly, S.monthly, S.daily, S.quarterly]);
    const acts = (await adminPool().query(`SELECT actor_id::text AS actor FROM activities WHERE target_entity_type = 'social_report_schedule' AND verb = 'created' AND target_entity_id = $1`, [S.weekly])).rows;
    expect(acts).toEqual([{ actor: U.hod }]);
  });

  it("two job instances at once claim a due schedule ONCE; the run acts as the owner with via; the drafts are only drafts", async () => {
    await makeDue(S.weekly, week(2));
    // The instance that claims holds the row until the other instance's sweep has finished: truly concurrent.
    let release!: () => void;
    const otherDone = new Promise<void>((r) => { release = r; });
    let claims = 0;
    setReportScheduleClaimHookForTests(async () => {
      claims++;
      await Promise.race([otherDone, new Promise((r) => setTimeout(r, 8000))]);
    });
    const one = runReportSchedulesSweep({ only: [A] });
    const two = runReportSchedulesSweep({ only: [A] });
    // Whichever sweep did not claim finishes while the other still holds the row; only then is the claimer let go.
    await Promise.race([one, two]);
    release();
    const [r1, r2] = await Promise.all([one, two]);
    setReportScheduleClaimHookForTests(null);
    expect(claims).toBe(1);
    expect(r1.ran + r2.ran).toBe(1);
    expect(r1.claimed + r2.claimed).toBe(1);
    await reportRunsIdle();

    const runs = await runsOf(S.weekly);
    expect(runs).toHaveLength(1);
    // Behind by two weeks: the latest ended week is drafted, the one before it is missed.
    expect(runs[0]).toMatchObject({
      period: week(1), trigger: "schedule", requested_by: U.hod, status: "done",
      via: { automation: "report_schedule", scheduleId: S.weekly, missed: 1 },
    });
    const made = (runs[0].results as Array<{ status: string; reportId?: string }>).filter((e) => e.status === "created").map((e) => e.reportId);
    expect(made).toHaveLength(3);
    const reports = (await adminPool().query(`SELECT status FROM social_reports WHERE id = ANY($1::uuid[])`, [made])).rows;
    expect(reports.map((r) => r.status)).toEqual(["draft", "draft", "draft"]);
    const acts = (await adminPool().query(`SELECT actor_id::text AS actor, metadata FROM activities WHERE verb = 'created' AND target_entity_type = 'social_report' AND target_entity_id = ANY($1::uuid[])`, [made])).rows;
    expect(acts).toHaveLength(3);
    for (const a of acts) expect(a).toMatchObject({ actor: U.hod, metadata: { runId: runs[0].id, via: { automation: "report_schedule", scheduleId: S.weekly } } });
    for (const u of await usageRows(runs[0].id, 3)) expect(u.user_id).toBe(U.hod);
    const run = (await adminPool().query(`SELECT actor_id::text AS actor, metadata FROM activities WHERE verb = 'run' AND target_entity_type = 'social_report_schedule' AND target_entity_id = $1`, [S.weekly])).rows;
    expect(run).toEqual([{ actor: U.hod, metadata: expect.objectContaining({ runId: runs[0].id, trigger: "schedule", missed: 1 }) }]);

    const row = await scheduleRow(S.weekly);
    expect(row).toMatchObject({ last_period: week(1), next_period: week(0), enabled: true });
    expect(new Date(row.next_run_at).getTime()).toBeGreaterThan(Date.now());
    // Not due any more: the next sweep claims nothing.
    expect((await runReportSchedulesSweep({ only: [A] })).claimed).toBe(0);
  });

  it("one run per schedule and period: forced due again for the same week, the job passes it over", async () => {
    const before = gw.calls;
    await makeDue(S.weekly, week(1));
    const sweep = await runReportSchedulesSweep({ only: [A] });
    expect(sweep).toMatchObject({ claimed: 1, ran: 0, passed: 1 });
    await reportRunsIdle();
    expect((await runsOf(S.weekly)).filter((r) => r.period === week(1))).toHaveLength(1);
    expect(gw.calls).toBe(before);
    expect((await scheduleRow(S.weekly)).next_period).toBe(week(0));
  });

  it("downtime: a daily schedule three periods behind drafts only the latest, once, with missed: 2", async () => {
    await makeDue(S.daily, day(3));
    const sweep = await runReportSchedulesSweep({ only: [A] });
    expect(sweep.ran).toBe(1);
    await reportRunsIdle();
    const runs = await runsOf(S.daily);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ period: day(1), requested_by: U.owner, status: "done", via: { automation: "report_schedule", scheduleId: S.daily, missed: 2 } });
    // Alpha and Bravo are due daily; Charlie is not.
    const res = runs[0].results as Array<{ status: string; reason?: string }>;
    expect(res.filter((e) => e.status === "created")).toHaveLength(2);
    expect(res.filter((e) => e.reason === "kind_not_due")).toHaveLength(1);
    for (const k of [3, 2]) expect((await adminPool().query(`SELECT count(*)::int AS n FROM social_reports WHERE tenant_id = $1 AND kind = 'daily' AND period = $2`, [A, day(k)])).rows[0].n).toBe(0);
    expect((await scheduleRow(S.daily)).next_period).toBe(day(0));
  });

  it("an owner who lost the seat: no run, paused owner_not_allowed, the notices sent; another of the four resumes it and owns it", async () => {
    const mine = ok(await create(as(U.lead2), { kind: "weekly", scope: "chosen", engagementIds: [E.bravo], timing: { weekday: 1, at: "00:00" } }), 201, "lead2");
    S.lead2 = mine.schedule.id;
    await adminPool().query(
      `UPDATE position_assignments SET valid_from = current_date - 30, valid_to = current_date - 1 WHERE user_id = $1 AND tenant_id = $2`, [U.lead2, A]);
    await makeDue(S.lead2, week(1));
    const before = gw.calls;
    const sweep = await runReportSchedulesSweep({ only: [A] });
    expect(sweep).toMatchObject({ claimed: 1, paused: 1, ran: 0 });
    expect(await runsOf(S.lead2)).toEqual([]);
    expect(gw.calls).toBe(before);
    expect(await scheduleRow(S.lead2)).toMatchObject({ enabled: false, paused_reason: "owner_not_allowed", paused_by: null, next_run_at: null, next_period: null });
    const told = await notices(S.lead2);
    expect(told.map((n) => n.user_id).sort()).toEqual([U.lead2, U.hod, U.gm, U.leaver].sort());
    expect(told[0].payload).toMatchObject({ reason: "owner_not_allowed", severity: "warning", title: expect.stringContaining("its owner may no longer run it") });
    const view = ok(await list(as(U.hod)), 200, "list").items.find((s: { id: string }) => s.id === S.lead2);
    expect(view).toMatchObject({ enabled: false, pausedReason: "owner_not_allowed", owner: { id: U.lead2 } });
    // lead2 no longer passes the gate.
    refused(await patch(as(U.lead2), S.lead2, { enabled: true }), 403, "not_a_social_approver");

    const resumed = ok(await patch(as(U.gm), S.lead2, { enabled: true }), 200, "the GM resumes");
    expect(resumed.schedule).toMatchObject({ enabled: true, pausedReason: null, owner: { id: U.gm }, nextPeriod: week(0) });
    const acts = (await adminPool().query(`SELECT actor_id::text AS actor, verb FROM activities WHERE target_entity_type = 'social_report_schedule' AND target_entity_id = $1 ORDER BY created_at`, [S.lead2])).rows;
    expect(acts.map((a) => a.verb)).toEqual(["created", "paused", "resumed"]);
    expect(acts[1].actor).toBe(U.lead2); // the job's row carries the owner
    expect(acts[2].actor).toBe(U.gm);
  });

  it("a deactivated owner: paused owner_inactive, and only the HoD and GM seats are told", async () => {
    const mine = ok(await create(as(U.leaver), { kind: "daily", scope: "chosen", engagementIds: [E.alpha], timing: { at: "00:00" } }), 201, "leaver");
    S.leaver = mine.schedule.id;
    await withGlobal((c) => c.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [U.leaver]));
    await makeDue(S.leaver, day(1));
    const sweep = await runReportSchedulesSweep({ only: [A] });
    expect(sweep).toMatchObject({ paused: 1, ran: 0 });
    expect(await scheduleRow(S.leaver)).toMatchObject({ enabled: false, paused_reason: "owner_inactive" });
    expect(await runsOf(S.leaver)).toEqual([]);
    const told = (await notices(S.leaver)).map((n) => n.user_id);
    expect(told).not.toContain(U.leaver);
    expect(told).toEqual(expect.arrayContaining([U.hod, U.gm]));
  });

  it("Run now runs as the presser, leaves next_run_at alone, and answers alreadyApplied for a period already run", async () => {
    // The weekly schedule already ran last week (the job): alreadyApplied with that run.
    const prior = (await runsOf(S.weekly)).find((r) => r.period === week(1));
    const again = ok(await runNow(as(U.gm), S.weekly), 200, "already");
    expect(again).toEqual({ alreadyApplied: true, runId: prior!.id, period: week(1) });

    const nextBefore = (await scheduleRow(S.monthly)).next_run_at;
    const started = ok(await runNow(as(U.owner), S.monthly), 202, "the owner presses Run now on the GM's schedule");
    expect(started).toMatchObject({ kind: "monthly", period: lastMonth, total: 2 });
    await reportRunsIdle();
    const runs = await runsOf(S.monthly);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ trigger: "run_now", requested_by: U.owner, period: lastMonth, status: "done" });
    expect((await scheduleRow(S.monthly)).next_run_at).toBe(nextBefore);
    const made = (runs[0].results as Array<{ status: string; reportId?: string }>).filter((e) => e.status === "created").map((e) => e.reportId);
    const acts = (await adminPool().query(`SELECT actor_id::text AS actor FROM activities WHERE verb = 'created' AND target_entity_type = 'social_report' AND target_entity_id = ANY($1::uuid[])`, [made])).rows;
    for (const a of acts) expect(a.actor).toBe(U.owner);
    // Paused schedules run too, and a second press is alreadyApplied.
    ok(await patch(as(U.gm), S.monthly, { enabled: false }), 200, "pause");
    expect(ok(await runNow(as(U.gm), S.monthly), 200, "again")).toMatchObject({ alreadyApplied: true, runId: runs[0].id });
  });

  it("the spend: a schedule's 30-day and month-to-date spend sums its runs' usage (SCP-Q40)", async () => {
    const runs = await runsOf(S.weekly);
    const rows = (await Promise.all(runs.map((r) => usageRows(r.id, 3)))).flat();
    const view = ok(await list(as(U.hod)), 200, "list").items.find((s: { id: string }) => s.id === S.weekly);
    const want = { runs: runs.length, calls: rows.length, promptTokens: rows.length * 100, completionTokens: rows.length * 40 };
    expect(view.spend.last30Days).toMatchObject(want);
    expect(view.spend.monthToDate).toMatchObject(want);
    expect(view.spend.last30Days.costUsd).toBeCloseTo(rows.length * 0.002, 6);
    expect(view.lastRun).toMatchObject({ runId: runs[runs.length - 1].id, status: "done", created: 3, missed: 1 });
  });

  it("by chat: the tools act as the person (the owner is the person, via the agent); the tools' classes", async () => {
    const made = ok(await create(viaAgent("wa-scp5-sched-hod"), { kind: "semester", scope: "all", timing: { on: "day", day: 5, at: "08:00" } }), 201, "by chat");
    expect(made.schedule.owner.id).toBe(U.hod);
    const paused = ok(await patch(viaAgent("wa-scp5-sched-hod"), made.schedule.id, { enabled: false }), 200, "pause by chat");
    expect(paused.schedule).toMatchObject({ enabled: false, pausedReason: "manual" });
    expect(await scheduleRow(made.schedule.id)).toMatchObject({ owner_id: U.hod, paused_by: U.hod });
    const acts = (await adminPool().query(`SELECT actor_id::text AS actor, verb, metadata FROM activities WHERE target_entity_type = 'social_report_schedule' AND target_entity_id = $1 ORDER BY created_at`, [made.schedule.id])).rows;
    expect(acts.map((a) => a.verb)).toEqual(["created", "paused"]);
    for (const a of acts) expect(a).toMatchObject({ actor: U.hod, metadata: { via: { agent: "mock-agent" } } });

    const tools = socialModule.mcpTools ?? [];
    const byName = (n: string) => tools.find((t) => t.name === n);
    expect(byName("social.reportSchedules")).toMatchObject({ method: "GET", pathTemplate: "/api/:tenantId/modules/social/report-schedules" });
    expect(byName("social.reportSchedules")?.write).toBeFalsy();
    for (const [n, method, path] of [
      ["social.saveReportSchedule", "POST", "/api/:tenantId/modules/social/report-schedules"],
      ["social.editReportSchedule", "PATCH", "/api/:tenantId/modules/social/report-schedules/:id"],
      ["social.deleteReportSchedule", "DELETE", "/api/:tenantId/modules/social/report-schedules/:id"],
      ["social.runReportSchedule", "POST", "/api/:tenantId/modules/social/report-schedules/:id/run"],
    ] as const) {
      expect(byName(n), n).toMatchObject({ write: true, impact: "medium", method, pathTemplate: path });
    }
    for (const n of ["social.reportSchedules", "social.saveReportSchedule", "social.editReportSchedule", "social.deleteReportSchedule", "social.runReportSchedule"]) {
      expect(byName(n)?.pathTemplate).not.toMatch(/approve|deliver/);
    }
  });

  it("delete: soft, then 404; the list leaves it out", async () => {
    ok(await del(as(U.gm), S.quarterly), 200, "delete");
    expect((await scheduleRow(S.quarterly)).deleted_by).toBe(U.gm);
    refused(await patch(as(U.gm), S.quarterly, { enabled: true }), 404, "schedule_not_found");
    refused(await del(as(U.gm), S.quarterly), 404, "schedule_not_found");
    const all = ok(await list(as(U.gm)), 200, "list");
    expect(all.items.map((s: { id: string }) => s.id)).not.toContain(S.quarterly);
    // A new company-wide quarterly may be set once the old one is gone.
    ok(await create(as(U.gm), { kind: "quarterly", scope: "all", timing: { on: "day", day: 10, at: "07:00" } }), 201, "a new one");
  });
});
