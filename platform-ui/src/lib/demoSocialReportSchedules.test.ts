import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

// SCP-5 W5-A6 (BFF §63.24.9): DEMO_MODE's twin of report automation, in the server's order of checks. The store seeds from the day it is first touched, so the clock is pinned to Wednesday
// 14 October 2026 before the module is imported (hence vi.hoisted); only Date is faked. Every test starts from a fresh seed.
vi.hoisted(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-14T04:00:00Z"));
});
afterAll(() => vi.useRealTimers());

import { demoReportSchedulesRoute, resetDemoReportSchedules } from "./demoSocialReportSchedules";
import { socialDemo } from "./demoSocial";
import { PIPE_ENGAGEMENTS } from "./demoSocialPipeline";
import { asRunNow, asRunProgress, asSaved, asSchedules } from "./socialReportSchedules";
import fixture from "./scpStageMachine.json";

const USER = { hod: "u-pm", gm: "u-gm", officer: "u-social", owner: "demo-owner", client: "demo-client", bot: "demo-bot" };
const NEW_ID = "22222222-2222-4222-8222-222222222222";

beforeEach(() => { resetDemoReportSchedules(); vi.setSystemTime(new Date("2026-10-14T04:00:00Z")); });

const call = (m: string, tail: string, user: string, body?: unknown) => {
  const r = demoReportSchedulesRoute(m, tail, body === undefined ? undefined : JSON.stringify(body), user);
  expect(r, `${m} ${tail} is a schedule route`).not.toBeNull();
  return r!;
};
const error = (r: { json: unknown }) => (r.json as { error: string }).error;
const refused = (r: { status: number; json: unknown }, status: number, code: string) => { expect([r.status, error(r)]).toEqual([status, code]); };
const items = (user = USER.hod) => asSchedules(call("GET", "report-schedules", user).json);
const weeklyBody = (over: Record<string, unknown> = {}) => ({ id: NEW_ID, kind: "daily", scope: "all", timing: { at: "06:00" }, ...over });

describe("the seeded schedules", () => {
  it("are a weekly one on all clients with a settled last run and its spend, and a monthly one paused because its owner may no longer run it", () => {
    const [weekly, monthly] = items();
    expect(weekly).toMatchObject({ kind: "weekly", scope: "all", enabled: true, pausedReason: null, timingText: "Every Monday at 08:00, for the week before" });
    expect(weekly.nextRunAt).toBe("2026-10-19T08:00:00.000Z");
    expect(weekly.nextPeriod).toBe("2026-W42");
    expect(weekly.lastRun).toMatchObject({ status: "done", failed: 0 });
    expect(weekly.spend.last30Days.runs).toBe(3);
    expect(weekly.spend.last30Days.costUsd).toBeGreaterThan(0);
    expect(monthly).toMatchObject({ kind: "monthly", scope: "chosen", enabled: false, pausedReason: "owner_not_allowed", nextRunAt: null, nextPeriod: null });
    expect(monthly.clients).toHaveLength(2);
    expect(monthly.lastRun?.missed).toBe(1);
  });
  it("keep every refusal code in the stage-machine fixture", () => {
    const F = fixture as unknown as { refusals: Record<string, { http: number }>; reports: { refusals: Record<string, { http: number }> } };
    for (const code of ["schedule_not_found", "schedule_exists", "generation_running", "report_kind_off", "ai_drafting_off", "not_a_social_approver", "automation_cannot_act", "invalid_field"]) expect((F.refusals[code] ?? F.reports.refusals[code]), code).toBeTruthy();
  });
});

describe("the order of checks is the server's: automation, the four, 404, 400, 409", () => {
  it("refuses an automation account, then anyone but the four, on every route", () => {
    for (const [m, tail] of [["GET", "report-schedules"], ["POST", "report-schedules"], ["PATCH", "report-schedules/demo-sched-1"], ["DELETE", "report-schedules/demo-sched-1"], ["POST", "report-schedules/demo-sched-1/run"]]) {
      refused(call(m, tail, USER.bot, {}), 403, "automation_cannot_act");
      refused(call(m, tail, USER.officer, {}), 403, "not_a_social_approver");
      refused(call(m, tail, USER.client, {}), 403, "not_a_social_approver");
    }
    for (const u of [USER.hod, USER.gm, USER.owner]) expect(call("GET", "report-schedules", u).status).toBe(200);
  });
  it("answers 404 for a schedule that is not there, before it judges the body", () => {
    refused(call("PATCH", "report-schedules/nope", USER.hod, { scope: "bogus" }), 404, "schedule_not_found");
    refused(call("DELETE", "report-schedules/nope", USER.hod), 404, "schedule_not_found");
    refused(call("POST", "report-schedules/nope/run", USER.hod), 404, "schedule_not_found");
  });
  it("names the field of a 400, in the server's order", () => {
    const field = (body: unknown) => (call("POST", "report-schedules", USER.hod, body).json as { field: string }).field;
    expect(field({ ...weeklyBody(), extra: 1 })).toBe("extra");
    expect(field(weeklyBody({ kind: "hourly" }))).toBe("kind");
    expect(field(weeklyBody({ scope: "some" }))).toBe("scope");
    expect(field(weeklyBody({ scope: "chosen" }))).toBe("engagementIds");
    expect(field(weeklyBody({ scope: "chosen", engagementIds: ["not-an-engagement"] }))).toBe("engagementIds");
    expect(field(weeklyBody({ timing: undefined }))).toBe("timing");
    expect(field(weeklyBody({ timing: { at: "7pm" } }))).toBe("timing.at");
    expect(field(weeklyBody({ kind: "weekly", timing: { at: "08:00" } }))).toBe("timing.weekday");
    expect(field(weeklyBody({ timing: { at: "08:00", weekday: 1 } }))).toBe("timing.weekday");
    expect(field(weeklyBody({ kind: "monthly", timing: { on: "month", at: "08:00" } }))).toBe("timing.on");
    expect(field(weeklyBody({ kind: "monthly", timing: { on: "day", day: 29, at: "08:00" } }))).toBe("timing.day");
    expect(field(weeklyBody({ kind: "monthly", timing: { on: "working_day", n: 21, at: "08:00" } }))).toBe("timing.n");
    expect(field(weeklyBody({ kind: "monthly", timing: { on: "day", n: 3, day: 1, at: "08:00" } }))).toBe("timing.n");
    expect(field(weeklyBody({ enabled: "yes" }))).toBe("enabled");
  });
});

describe("create, edit, pause, resume and delete", () => {
  it("creates an all-clients daily schedule as the caller, on, with its next run", () => {
    const r = call("POST", "report-schedules", USER.gm, weeklyBody());
    expect(r.status).toBe(201);
    const { schedule, created } = asSaved(r.json);
    expect(created).toBe(true);
    expect(schedule).toMatchObject({ kind: "daily", enabled: true, owner: { id: USER.gm }, nextRunAt: "2026-10-14T06:00:00.000Z", nextPeriod: "2026-10-13", lastRun: null });
    expect(items()).toHaveLength(3);
  });
  it("answers a replayed id with created: false and makes nothing twice", () => {
    call("POST", "report-schedules", USER.hod, weeklyBody());
    const again = call("POST", "report-schedules", USER.hod, weeklyBody());
    expect(again.status).toBe(200);
    expect(asSaved(again.json).created).toBe(false);
    expect(items()).toHaveLength(3);
  });
  it("refuses a second all-clients schedule of a kind with schedule_exists naming the first, but allows a chosen one", () => {
    const r = call("POST", "report-schedules", USER.hod, weeklyBody({ id: undefined, kind: "weekly", timing: { weekday: 2, at: "09:00" } }));
    refused(r, 409, "schedule_exists");
    expect((r.json as { detail: { scheduleId: string } }).detail.scheduleId).toBe("demo-sched-1");
    const chosen = call("POST", "report-schedules", USER.hod, weeklyBody({ id: undefined, kind: "weekly", scope: "chosen", engagementIds: [PIPE_ENGAGEMENTS[0].id], timing: { weekday: 2, at: "09:00" } }));
    expect(chosen.status).toBe(201);
  });
  it("adds a schedule paused when asked, with the manual reason", () => {
    const s = asSaved(call("POST", "report-schedules", USER.hod, weeklyBody({ enabled: false })).json).schedule;
    expect(s).toMatchObject({ enabled: false, pausedReason: "manual", nextRunAt: null });
  });
  it("an edit changes the timing and makes the caller the owner", () => {
    const r = call("PATCH", "report-schedules/demo-sched-1", USER.gm, { timing: { weekday: 3, at: "10:00" } });
    expect(r.status).toBe(200);
    const s = (r.json as { schedule: ReturnType<typeof asSaved>["schedule"] }).schedule;
    expect(s.timingText).toBe("Every Wednesday at 10:00, for the week before");
    expect(s.owner.id).toBe(USER.gm);
    refused(call("PATCH", "report-schedules/demo-sched-1", USER.hod, { kind: "daily" }), 400, "invalid_field");
    refused(call("PATCH", "report-schedules/demo-sched-1", USER.hod, { timing: { at: "99:00", weekday: 1 } }), 400, "invalid_field");
  });
  it("pauses with the manual reason and resumes, clearing the pause and computing the next run", () => {
    const paused = (call("PATCH", "report-schedules/demo-sched-1", USER.hod, { enabled: false }).json as { schedule: { enabled: boolean; pausedReason: string; nextRunAt: string | null } }).schedule;
    expect(paused).toMatchObject({ enabled: false, pausedReason: "manual", nextRunAt: null });
    const resumed = (call("PATCH", "report-schedules/demo-sched-2", USER.gm, { enabled: true }).json as { schedule: { enabled: boolean; pausedReason: string | null; nextRunAt: string | null; owner: { id: string } } }).schedule;
    expect(resumed).toMatchObject({ enabled: true, pausedReason: null, owner: { id: USER.gm } });
    expect(resumed.nextRunAt).toBe("2026-11-04T08:00:00.000Z");
  });
  it("narrowing a schedule to chosen clients needs the clients; widening it to all can clash", () => {
    refused(call("PATCH", "report-schedules/demo-sched-1", USER.hod, { scope: "chosen" }), 400, "invalid_field");
    expect(call("PATCH", "report-schedules/demo-sched-1", USER.hod, { scope: "chosen", engagementIds: [PIPE_ENGAGEMENTS[0].id] }).status).toBe(200);
    call("POST", "report-schedules", USER.hod, weeklyBody({ id: undefined, kind: "weekly", timing: { weekday: 2, at: "09:00" } }));
    refused(call("PATCH", "report-schedules/demo-sched-1", USER.hod, { scope: "all" }), 409, "schedule_exists");
  });
  it("deletes softly: the schedule is gone from the list and from every route", () => {
    expect(call("DELETE", "report-schedules/demo-sched-1", USER.hod).json).toEqual({ id: "demo-sched-1", deleted: true });
    expect(items().map((s) => s.id)).toEqual(["demo-sched-2"]);
    refused(call("PATCH", "report-schedules/demo-sched-1", USER.hod, { enabled: false }), 404, "schedule_not_found");
  });
});

describe("Run now", () => {
  it("starts a run for the period that has just ended and shows it settling client by client, with its usage", () => {
    const r = call("POST", "report-schedules/demo-sched-1/run", USER.gm);
    expect(r.status).toBe(202);
    const a = asRunNow(r.json);
    expect(a).toMatchObject({ started: true, kind: "weekly", period: "2026-W41", total: PIPE_ENGAGEMENTS.filter((e) => e.status !== "closed").length });
    const runId = a.runId as string;
    expect(asRunProgress(call("GET", `reports/generate/${runId}`, USER.gm).json)).toMatchObject({ status: "queued", done: 0 });
    vi.setSystemTime(new Date("2026-10-14T04:00:01.500Z"));
    expect(asRunProgress(call("GET", `reports/generate/${runId}`, USER.gm).json)).toMatchObject({ status: "running", done: 1 });
    vi.setSystemTime(new Date("2026-10-14T04:01:00Z"));
    const done = asRunProgress(call("GET", `reports/generate/${runId}`, USER.gm).json);
    expect(done).toMatchObject({ status: "done", done: done.total });
    expect(done.usage.calls).toBeGreaterThan(0);
    // the schedule's last run is now this one, and the spend counts it
    const w = items()[0];
    expect(w.lastRun?.runId).toBe(runId);
    expect(w.spend.last30Days.runs).toBe(4);
  });
  it("runs a paused schedule too, and does not move its next run", () => {
    const before = items()[1];
    const r = call("POST", "report-schedules/demo-sched-2/run", USER.hod);
    // the monthly's last period is the month that just ended: already run
    expect(r.status).toBe(200);
    expect(asRunNow(r.json)).toMatchObject({ started: false, period: "2026-09" });
    expect(items()[1].nextRunAt).toBe(before.nextRunAt);
  });
  it("answers alreadyApplied for a period it already ran, and generation_running while another run of the kind and period is going", () => {
    const first = call("POST", "report-schedules/demo-sched-1/run", USER.hod);
    const again = call("POST", "report-schedules/demo-sched-1/run", USER.hod);
    expect(again.status).toBe(200);
    expect(asRunNow(again.json)).toMatchObject({ started: false, runId: asRunNow(first.json).runId, period: "2026-W41" });
    // another weekly schedule (chosen clients) meets the run still going for the same company, kind and period
    call("POST", "report-schedules", USER.hod, weeklyBody({ kind: "weekly", scope: "chosen", engagementIds: [PIPE_ENGAGEMENTS[0].id], timing: { weekday: 2, at: "09:00" } }));
    const clash = call("POST", `report-schedules/${NEW_ID}/run`, USER.hod);
    refused(clash, 409, "generation_running");
    expect((clash.json as { detail: { runId: string } }).detail.runId).toBe(asRunNow(first.json).runId);
  });
  it("leaves any run it did not make to the Reports page's own demo", () => {
    expect(demoReportSchedulesRoute("GET", "reports/generate/some-other-run", undefined, USER.hod)).toBeNull();
    refused(call("GET", "reports/generate/demo-sched-run-seed-1", USER.officer), 403, "not_a_social_approver");
  });
});

describe("the demo store answers through the module's own front door", () => {
  it("reaches these routes through socialDemo", () => {
    const r = socialDemo("GET", "/api/co-agency/modules/social/report-schedules", new URLSearchParams(), undefined, USER.hod);
    expect(r?.status).toBe(200);
    expect(asSchedules(r!.json)).toHaveLength(2);
    expect(socialDemo("GET", "/api/co-agency/modules/social/report-schedules", new URLSearchParams(), undefined, USER.officer)?.status).toBe(403);
  });
});
