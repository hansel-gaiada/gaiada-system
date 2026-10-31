// SCP-5 W5-Q — the report run and schedule proofs that 63.24.8, 63.24.9 and 63.30.7 name and no other file holds, against REAL Postgres and
// REAL Cerbos, through the real HTTP layer. Skips without DATABASE_URL_TEST; on the CI gate it runs for real. The company here is this
// file's own (mock names only), so nothing it saves in the rules can reach another test. The gateway is the same stand-in as
// report-schedules.http.test.ts: the REAL gateway client over a fake network.
//
// THE CLAIMS UNDER TEST
//   1. Who a run covers: the four get every active client of the company (the internal client skipped `internal_client`, a paused one left
//      out), an officer only their own (63.24.8).
//   2. The company's rules reach a run (63.30.7, 63.24.8): `POST reports/generate` is 409 `report_kind_off` for a kind turned off and
//      409 `ai_drafting_off` for a kind drafted by hand, and makes no run and no draft; a run records the rules it was started under
//      (`rules_ref`) and keeps them when the rules change after.
//   3. A schedule follows the rules (63.24.9, 63.30.7): a kind turned off, or drafted by hand, pauses it at its next run (`kind_off`,
//      `ai_drafting_off`) with no run and no gateway call, the owner and the seats told; Run now is 409 with the same codes; resuming does not
//      re-check the rules (as built), so the job pauses it again; with the rules back, it runs, and its run keeps its rules.
//   4. A `chosen` schedule keeps to the clients the person may draft for: the internal client in the list is skipped, never drafted.
//   5. PATCH report-schedules/:id (as built, W5-A5): a schedule never takes a `kind`; `scope: all` refuses a non-empty `engagementIds`; a
//      `chosen` edit needs its clients, open ones; a bad `scope`, `timing` or `enabled` names its field; a refused edit changes nothing;
//      moving a schedule to company-wide while another holds the kind is 409 `schedule_exists`; the editor becomes the owner.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { LightMyRequestResponse } from "fastify";
import { config } from "../../../config";
import { newId, withGlobal } from "../../../db";
import { buildApp } from "../../../main";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../../../testing/setup";
import { createCompany, createUser, addMembership, createClient } from "../../../testing/fixtures";
import { grantSocialRole, grantSocialSeat, placeOfficerOnAllocation, seedSocialOrgTree } from "../../../testing/social-pipeline-fixtures";
import { todayIsoInTz } from "../../reports/person-scope";
import { addDays } from "../../hr/working-days";
import { registerModule, resetModules } from "../../registry";
import { socialModule } from "../index";
import { DEFAULTS_VERSION, DEFAULT_RULES, type RulesDoc } from "./rules";
import { periodOf } from "./rules-periods";
import { reportRunsIdle } from "./report-runs";
import { runReportSchedulesSweep } from "./report-schedules";

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

describe.skipIf(!TEST_URL)("SCP-5 W5-Q · report runs and schedules follow the company's rules (BFF §63.24.8, §63.24.9, §63.30.7)", () => {
  let app: NestFastifyApplication;
  let A: string;
  const U: Record<string, string> = {};
  const E: Record<string, string> = {};
  const S: Record<string, string> = {};
  const flagBefore = config.socialSimulationEnabled;

  const TODAY = todayIsoInTz(config.reportsTz);
  const week = (k: number) => periodOf("weekly", addDays(TODAY, -7 * k));
  const day = (k: number) => addDays(TODAY, -k);

  const base = () => `/api/${A}/modules/social`;
  const generate = (h: Record<string, string>, payload: Record<string, unknown>) => app.inject({ method: "POST", url: `${base()}/reports/generate`, headers: h, payload });
  const create = (h: Record<string, string>, payload: unknown) => app.inject({ method: "POST", url: `${base()}/report-schedules`, headers: h, payload: payload as object });
  const patch = (h: Record<string, string>, id: string, payload: unknown) => app.inject({ method: "PATCH", url: `${base()}/report-schedules/${id}`, headers: h, payload: payload as object });
  const runNow = (h: Record<string, string>, id: string) => app.inject({ method: "POST", url: `${base()}/report-schedules/${id}/run`, headers: h, payload: {} });

  function ok(r: LightMyRequestResponse, status: number, label: string) {
    expect(r.statusCode, `${label}: ${r.body}`).toBe(status);
    return r.json();
  }
  function refused(r: LightMyRequestResponse, status: number, code: string, extra: Record<string, unknown> = {}) {
    expect(r.statusCode, `${code}: ${r.body}`).toBe(status);
    expect(r.json(), code).toMatchObject({ error: code, ...extra });
  }
  const runRow = async (runId: string) => (await adminPool().query(`SELECT to_jsonb(r) AS j FROM social_report_runs r WHERE id = $1`, [runId])).rows[0]?.j as Record<string, any>;
  const runsFor = async (kind: string, period: string) => (await adminPool().query(
    `SELECT id::text AS id, rules_ref, status, results FROM social_report_runs WHERE tenant_id = $1 AND kind = $2 AND period = $3 ORDER BY created_at`, [A, kind, period])).rows;
  const scheduleRow = async (id: string) => (await adminPool().query(`SELECT to_jsonb(s) AS j FROM social_report_schedules s WHERE id = $1`, [id])).rows[0]?.j as Record<string, any>;
  const runsOf = async (scheduleId: string) => (await adminPool().query(
    `SELECT id::text AS id, period, trigger, requested_by::text AS requested_by, rules_ref, status, results FROM social_report_runs WHERE schedule_id = $1 ORDER BY created_at`,
    [scheduleId])).rows;
  const makeDue = (id: string, period: string) => adminPool().query(
    `UPDATE social_report_schedules SET next_run_at = now() - interval '1 minute', next_period = $2 WHERE id = $1`, [id, period]);
  const notices = async (scheduleId: string) => (await adminPool().query<{ user_id: string; payload: Record<string, unknown> }>(
    `SELECT user_id::text AS user_id, payload FROM notifications WHERE type = 'social.report_schedule.paused' AND payload->>'entityId' = $1`, [scheduleId])).rows;
  const byName = (results: Array<{ clientName: string }>, name: string) => results.find((r) => r.clientName.startsWith(name));
  const reportCount = async (kind: string, period: string) => Number((await adminPool().query(
    `SELECT count(*)::int AS n FROM social_reports WHERE tenant_id = $1 AND kind = $2 AND period = $3 AND deleted_at IS NULL`, [A, kind, period])).rows[0].n);

  /** A new version of the company's rules (the whole document), as a save from Settings would write it. */
  async function saveRules(mutate: (doc: RulesDoc) => void): Promise<number> {
    const cur = (await adminPool().query(`SELECT version, rules FROM social_rule_versions WHERE tenant_id = $1 ORDER BY version DESC LIMIT 1`, [A])).rows[0];
    const doc: RulesDoc = JSON.parse(JSON.stringify(cur ? cur.rules : DEFAULT_RULES));
    mutate(doc);
    const version = (cur?.version ?? 0) + 1;
    await adminPool().query(
      `INSERT INTO social_rule_versions (tenant_id, version, rules, section, defaults_version, edited_by) VALUES ($1, $2, $3::jsonb, 'reports', $4, $5)`,
      [A, version, JSON.stringify(doc), DEFAULTS_VERSION, U.owner]);
    return version;
  }

  async function engagement(key: string, name: string, officer: string, o: { kinds?: string[]; status?: string; internal?: boolean } = {}) {
    let clientId: string;
    if (o.internal) {
      const prior = await adminPool().query<{ id: string }>(`SELECT id::text AS id FROM clients WHERE tenant_id = $1 AND is_internal AND deleted_at IS NULL`, [A]);
      clientId = prior.rows[0]?.id ?? (await createClient(A, name));
      await adminPool().query(`UPDATE clients SET is_internal = true, name = $2 WHERE id = $1`, [clientId, name]);
    } else {
      clientId = await createClient(A, name);
    }
    const id = newId();
    await adminPool().query(
      `INSERT INTO social_engagements (id, tenant_id, client_id, name, status, report_kinds) VALUES ($1, $2, $3, $4, $5, $6::text[])`,
      [id, A, clientId, `${name} engagement`, o.status ?? "active", o.kinds ?? ["weekly"]]);
    await placeOfficerOnAllocation(A, id, officer);
    E[key] = id;
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    config.socialSimulationEnabled = false;
    resetModules();
    registerModule(socialModule);

    A = await createCompany("SCP5 W5-Q rules agency", ["social"]);
    const units = await seedSocialOrgTree(A);
    const people = ["hod", "gm", "owner", "officer", "officer2"];
    for (const p of people) U[p] = await createUser(`scp5-wq-rules-${p}@mock.test`, `Mock WQ ${p}`);
    for (const p of people) await addMembership(A, U[p]);
    await grantSocialSeat(A, units.socialMedia, U.hod);
    await grantSocialSeat(A, units.gm, U.gm);
    await grantSocialRole(A, U.owner, "owner");
    for (const p of ["hod", "gm", "owner", "officer", "officer2"]) await grantSocialRole(A, U[p], "social_staff");

    await engagement("alpha", "WQ Alpha client", U.officer, { kinds: ["weekly", "daily"] });
    await engagement("bravo", "WQ Bravo client", U.officer2, { kinds: ["weekly", "daily"] });
    await engagement("internal", "WQ Juliet internal", U.officer, { kinds: ["weekly", "daily"], internal: true });
    await engagement("paused", "WQ Kilo client", U.officer, { kinds: ["weekly"], status: "paused" });
    app = await buildApp();
  }, 180_000);

  afterAll(async () => {
    await reportRunsIdle();
    config.socialSimulationEnabled = flagBefore;
    await app?.close();
    await teardownTestDb();
  });

  it("who a run covers: the four every active client (the internal one skipped, a paused one left out), an officer only their own", async () => {
    const hod = ok(await generate(as(U.hod), { kind: "weekly", period: week(5) }), 202, "the HoD's run");
    await reportRunsIdle();
    const p = ok(await app.inject({ method: "GET", url: `${base()}/reports/generate/${hod.runId}`, headers: as(U.hod) }), 200, "the HoD's progress");
    expect(byName(p.results, "WQ Alpha")).toMatchObject({ status: "created" });
    expect(byName(p.results, "WQ Bravo")).toMatchObject({ status: "created" });
    expect(byName(p.results, "WQ Juliet")).toMatchObject({ status: "skipped", reason: "internal_client" });
    expect(byName(p.results, "WQ Kilo")).toBeUndefined();
    expect(await reportCount("weekly", week(5))).toBe(2);

    const mine = ok(await generate(as(U.officer), { kind: "weekly", period: week(6) }), 202, "the officer's run");
    await reportRunsIdle();
    const q = ok(await app.inject({ method: "GET", url: `${base()}/reports/generate/${mine.runId}`, headers: as(U.officer) }), 200, "the officer's progress");
    expect(byName(q.results, "WQ Alpha")).toMatchObject({ status: "created" });
    expect(byName(q.results, "WQ Bravo")).toBeUndefined();
    expect(await reportCount("weekly", week(6))).toBe(1);
  });

  it("generate follows the rules: 409 report_kind_off and ai_drafting_off make no run and no draft; a run records its rules and keeps them", async () => {
    const first = ok(await generate(as(U.hod), { kind: "weekly", period: week(7) }), 202, "under the seed");
    await reportRunsIdle();
    expect((await runRow(first.runId)).rules_ref).toBe(`default:${DEFAULTS_VERSION}`);

    const calls = gw.calls;
    await saveRules((d) => { d.reports.kinds.weekly.enabled = false; });
    refused(await generate(as(U.hod), { kind: "weekly", period: week(8) }), 409, "report_kind_off");
    expect(await runsFor("weekly", week(8))).toEqual([]);
    expect(await reportCount("weekly", week(8))).toBe(0);

    await saveRules((d) => { d.reports.kinds.weekly.enabled = true; d.reports.kinds.weekly.aiDrafting = false; });
    refused(await generate(as(U.hod), { kind: "weekly", period: week(9) }), 409, "ai_drafting_off");
    expect(await runsFor("weekly", week(9))).toEqual([]);
    expect(await reportCount("weekly", week(9))).toBe(0);
    expect(gw.calls, "a refused start calls no model").toBe(calls);

    const v = await saveRules((d) => { d.reports.kinds.weekly.aiDrafting = true; });
    const again = ok(await generate(as(U.hod), { kind: "weekly", period: week(10) }), 202, "the rules are back");
    await reportRunsIdle();
    expect((await runRow(again.runId)).rules_ref).toBe(`company:${v}`);
    expect((await runRow(first.runId)).rules_ref, "the earlier run keeps the rules it was started under").toBe(`default:${DEFAULTS_VERSION}`);
  });

  it("a schedule follows the rules: kind_off and ai_drafting_off pause it with the notices; Run now is 409; resuming does not re-check; with the rules back it runs and keeps them", async () => {
    // The previous test left the weekly kind on and drafted by AI.
    const made = ok(await create(as(U.hod), { kind: "weekly", scope: "all", timing: { weekday: 1, at: "00:00" } }), 201, "the HoD's weekly schedule");
    S.weekly = made.schedule.id;

    await saveRules((d) => { d.reports.kinds.weekly.enabled = false; });
    await makeDue(S.weekly, week(1));
    let before = gw.calls;
    expect(await runReportSchedulesSweep({ only: [A] })).toMatchObject({ claimed: 1, paused: 1, ran: 0 });
    expect(await runsOf(S.weekly)).toEqual([]);
    expect(gw.calls).toBe(before);
    expect(await scheduleRow(S.weekly)).toMatchObject({ enabled: false, paused_reason: "kind_off", paused_by: null, next_run_at: null, next_period: null });
    const told = await notices(S.weekly);
    expect(told.map((n) => n.user_id)).toEqual(expect.arrayContaining([U.hod, U.gm]));
    expect(told[0].payload).toMatchObject({ reason: "kind_off" });
    refused(await runNow(as(U.gm), S.weekly), 409, "report_kind_off");
    expect(await runsOf(S.weekly)).toEqual([]);

    // Resuming does not re-check the kind (as built): it answers 200, the GM owns it, and the job pauses it again.
    const resumed = ok(await patch(as(U.gm), S.weekly, { enabled: true }), 200, "the GM resumes while the kind is off");
    expect(resumed.schedule).toMatchObject({ enabled: true, pausedReason: null, owner: { id: U.gm } });
    await makeDue(S.weekly, week(1));
    expect(await runReportSchedulesSweep({ only: [A] })).toMatchObject({ claimed: 1, paused: 1, ran: 0 });
    expect(await scheduleRow(S.weekly)).toMatchObject({ enabled: false, paused_reason: "kind_off" });

    // The kind is on again but drafted by hand.
    await saveRules((d) => { d.reports.kinds.weekly.enabled = true; d.reports.kinds.weekly.aiDrafting = false; });
    refused(await runNow(as(U.gm), S.weekly), 409, "ai_drafting_off");
    ok(await patch(as(U.hod), S.weekly, { enabled: true }), 200, "the HoD resumes");
    await makeDue(S.weekly, week(1));
    before = gw.calls;
    expect(await runReportSchedulesSweep({ only: [A] })).toMatchObject({ claimed: 1, paused: 1, ran: 0 });
    expect(await scheduleRow(S.weekly)).toMatchObject({ enabled: false, paused_reason: "ai_drafting_off" });
    expect(gw.calls).toBe(before);
    expect(await runsOf(S.weekly)).toEqual([]);

    // The rules are back: it runs, as its owner, under the rules of that moment, and a later change leaves the run's rules alone.
    const v = await saveRules((d) => { d.reports.kinds.weekly.aiDrafting = true; });
    ok(await patch(as(U.hod), S.weekly, { enabled: true }), 200, "the HoD resumes again");
    await makeDue(S.weekly, week(1));
    expect(await runReportSchedulesSweep({ only: [A] })).toMatchObject({ claimed: 1, ran: 1 });
    await reportRunsIdle();
    const runs = await runsOf(S.weekly);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ period: week(1), trigger: "schedule", requested_by: U.hod, status: "done", rules_ref: `company:${v}` });
    await saveRules((d) => { d.reports.kinds.weekly.aiDrafting = false; });
    expect((await runsOf(S.weekly))[0].rules_ref).toBe(`company:${v}`);
    await saveRules((d) => { d.reports.kinds.weekly.aiDrafting = true; });
  });

  it("a chosen schedule keeps to the clients its owner may draft for: the internal client in the list is skipped, never drafted", async () => {
    const made = ok(await create(as(U.gm), { kind: "daily", scope: "chosen", engagementIds: [E.alpha, E.internal], timing: { at: "00:00" } }), 201, "the GM's chosen schedule");
    S.chosen = made.schedule.id;
    await makeDue(S.chosen, day(1));
    expect(await runReportSchedulesSweep({ only: [A] })).toMatchObject({ claimed: 1, ran: 1 });
    await reportRunsIdle();
    const runs = await runsOf(S.chosen);
    expect(runs).toHaveLength(1);
    const res = runs[0].results as Array<{ clientName: string; status: string; reason?: string }>;
    expect(res).toHaveLength(2);
    expect(byName(res, "WQ Alpha")).toMatchObject({ status: "created" });
    expect(byName(res, "WQ Juliet")).toMatchObject({ status: "skipped", reason: "internal_client" });
    expect(byName(res, "WQ Bravo")).toBeUndefined();
    expect(await reportCount("daily", day(1))).toBe(1);
  });

  it("PATCH: a schedule never takes a kind; scope all refuses clients; chosen needs open clients; a bad field is named; a refusal changes nothing; schedule_exists; the editor owns it", async () => {
    const mine = ok(await create(as(U.gm), { kind: "quarterly", scope: "chosen", engagementIds: [E.alpha], timing: { on: "working_day", n: 3, at: "08:00" } }), 201, "chosen quarterly");
    S.quarterlyChosen = mine.schedule.id;
    const other = ok(await create(as(U.hod), { kind: "quarterly", scope: "all", timing: { on: "working_day", n: 3, at: "08:00" } }), 201, "company-wide quarterly");
    S.quarterlyAll = other.schedule.id;
    const before = await scheduleRow(S.quarterlyChosen);

    const h = as(U.gm);
    refused(await patch(h, S.quarterlyChosen, { kind: "daily" }), 400, "invalid_field", { field: "kind" });
    refused(await patch(h, S.quarterlyChosen, { scope: "some" }), 400, "invalid_field", { field: "scope" });
    refused(await patch(h, S.quarterlyChosen, { scope: "all", engagementIds: [E.alpha] }), 400, "invalid_field", { field: "engagementIds" });
    refused(await patch(h, S.quarterlyChosen, { engagementIds: [newId()] }), 400, "invalid_field", { field: "engagementIds" });
    refused(await patch(h, S.quarterlyChosen, { engagementIds: [] }), 400, "invalid_field", { field: "engagementIds" });
    refused(await patch(h, S.quarterlyChosen, { enabled: "yes" }), 400, "invalid_field", { field: "enabled" });
    refused(await patch(h, S.quarterlyChosen, { timing: { at: "25:00", on: "working_day", n: 3 } }), 400, "invalid_field", { field: "timing.at" });
    refused(await patch(h, S.quarterlyAll, { scope: "chosen" }), 400, "invalid_field", { field: "engagementIds" });
    expect(await scheduleRow(S.quarterlyChosen), "a refused edit changes nothing").toEqual(before);

    // A chosen schedule cannot become a second company-wide one.
    refused(await patch(h, S.quarterlyChosen, { scope: "all" }), 409, "schedule_exists", { detail: { scheduleId: S.quarterlyAll } });
    expect(await scheduleRow(S.quarterlyChosen)).toEqual(before);

    // The editor becomes the owner, and the clients are replaced.
    const edited = ok(await patch(as(U.owner), S.quarterlyChosen, { engagementIds: [E.alpha, E.bravo] }), 200, "the owner edits the GM's schedule");
    expect(edited.schedule).toMatchObject({ scope: "chosen", owner: { id: U.owner } });
    expect(await scheduleRow(S.quarterlyChosen)).toMatchObject({ owner_id: U.owner, engagement_ids: [E.alpha, E.bravo].map((x) => x.toLowerCase()) });
    // And back to company-wide once the other one is gone.
    ok(await app.inject({ method: "DELETE", url: `${base()}/report-schedules/${S.quarterlyAll}`, headers: as(U.hod) }), 200, "the company-wide one is deleted");
    const wide = ok(await patch(h, S.quarterlyChosen, { scope: "all" }), 200, "now company-wide");
    expect(wide.schedule).toMatchObject({ scope: "all", owner: { id: U.gm } });
    expect((await scheduleRow(S.quarterlyChosen)).engagement_ids).toEqual([]);
  });
});
