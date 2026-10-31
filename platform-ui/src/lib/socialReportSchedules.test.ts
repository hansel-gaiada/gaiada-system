import { describe, it, expect } from "vitest";
import fixture from "./scpStageMachine.json";
import { REFUSAL_WORDS } from "./socialPipeline";
import {
  SCHEDULE_KINDS, asRunNow, asRunProgress, asSaved, asSchedule, asSchedules, buildBody, clientsWords, emptyForm, formOf, formatUsd, lastEndedPeriod, lastRunWords, missedWords,
  ordinal, pausedWords, periodOf, periodRange, periodWords, previewRuns, scheduleRefusalText, spendWords, timingOfForm, timingWords, type ReportSchedule, type ScheduleForm,
} from "./socialReportSchedules";

const NOW = Date.parse("2026-10-14T04:00:00Z"); // Wednesday
const zero = { runs: 0, calls: 0, promptTokens: 0, completionTokens: 0, costUsd: null };
const raw = (over: Record<string, unknown> = {}) => ({
  id: "s1", kind: "weekly", scope: "all", clients: [], timing: { weekday: 1, at: "08:00" }, timingText: "Every Monday at 08:00, for the week before", enabled: true, pausedReason: null,
  owner: { id: "u1", name: "Dewi Santoso" }, nextRunAt: "2026-10-19T08:00:00.000Z", nextPeriod: "2026-W42", lastRunAt: null, lastPeriod: null, lastRun: null,
  spend: { last30Days: zero, monthToDate: zero }, ...over,
});
const sched = (over: Record<string, unknown> = {}): ReportSchedule => asSchedule(raw(over));

describe("the parsers read the server's shapes and refuse the rest", () => {
  it("reads a schedule with its last run and spend", () => {
    const s = asSchedule(raw({
      kind: "monthly", scope: "chosen", clients: [{ engagementId: "e1", clientName: "Northwind" }], timing: { on: "working_day", n: 3, at: "08:00" }, enabled: false, pausedReason: "owner_not_allowed",
      lastRun: { runId: "r1", status: "done", created: 9, existing: 2, skipped: 1, failed: 0, missed: 1 },
      spend: { last30Days: { runs: 3, calls: 36, promptTokens: 54000, completionTokens: 18000, costUsd: 0.24 }, monthToDate: zero },
    }));
    expect(s.kind).toBe("monthly");
    expect(s.clients).toEqual([{ engagementId: "e1", clientName: "Northwind" }]);
    expect(s.timing).toEqual({ on: "working_day", n: 3, at: "08:00" });
    expect(s.pausedReason).toBe("owner_not_allowed");
    expect(s.lastRun?.missed).toBe(1);
    expect(s.spend.last30Days.costUsd).toBe(0.24);
  });
  it("throws on a body that is not a list or a schedule, so the page says it cannot tell", () => {
    expect(() => asSchedules({})).toThrow();
    expect(() => asSchedules({ items: [{ id: "x" }] })).toThrow();
    expect(() => asSchedule(raw({ kind: "hourly" }))).toThrow();
    expect(asSchedules({ items: [] })).toEqual([]);
  });
  it("reads the create answer and the two answers of Run now", () => {
    expect(asSaved({ schedule: raw(), created: false }).created).toBe(false);
    expect(asRunNow({ runId: "r9", kind: "weekly", period: "2026-W41", total: 12, clients: [] })).toEqual({ started: true, runId: "r9", kind: "weekly", period: "2026-W41", total: 12 });
    expect(asRunNow({ alreadyApplied: true, runId: "r1", period: "2026-W41" })).toEqual({ started: false, runId: "r1", period: "2026-W41" });
    expect(() => asRunNow({})).toThrow();
  });
  it("reads a run's progress with its usage", () => {
    const r = asRunProgress({ runId: "r1", kind: "weekly", period: "2026-W41", status: "running", total: 12, done: 4, usage: { calls: 4, promptTokens: 100, completionTokens: 50, costUsd: null } });
    expect(r).toMatchObject({ status: "running", done: 4, usage: { calls: 4, costUsd: null } });
  });
});

describe("periods are calendar-wise (SCP-Q39)", () => {
  it("names the period each kind has just finished", () => {
    const today = "2026-10-14";
    expect(SCHEDULE_KINDS.map((k) => lastEndedPeriod(k, today))).toEqual(["2026-10-13", "2026-W41", "2026-09", "2026-Q3", "2026-H1", "2025"]);
  });
  it("finds the range of each, and refuses what is not a period", () => {
    expect(periodRange("weekly", "2026-W41")).toEqual({ start: "2026-10-05", end: "2026-10-11" });
    expect(periodRange("weekly", "2026-W53")).toEqual({ start: "2026-12-28", end: "2027-01-03" });
    expect(periodRange("weekly", "2026-W54")).toBeNull();
    expect(periodRange("monthly", "2026-02")).toEqual({ start: "2026-02-01", end: "2026-02-28" });
    expect(periodRange("quarterly", "2026-Q4")).toEqual({ start: "2026-10-01", end: "2026-12-31" });
    expect(periodRange("semester", "2026-H1")).toEqual({ start: "2026-01-01", end: "2026-06-30" });
    expect(periodRange("daily", "2026-02-30")).toBeNull();
    expect(periodOf("weekly", "2027-01-01")).toBe("2026-W53");
  });
  it("says a period in words", () => {
    expect(periodWords("weekly", "2026-W41")).toBe("the week of 5 to 11 October 2026");
    expect(periodWords("weekly", "2026-W44")).toBe("the week of 26 October to 1 November 2026");
    expect(periodWords("monthly", "2026-09")).toBe("September 2026");
    expect(periodWords("quarterly", "2026-Q3")).toBe("the third quarter of 2026");
    expect(periodWords("semester", "2026-H2")).toBe("the second half of 2026");
    expect(periodWords("daily", "2026-10-13")).toBe("13 October 2026");
    expect(periodWords("yearly", "2026")).toBe("2026");
    expect(periodWords("weekly", "garbage")).toBe("garbage");
  });
});

describe("the timing in words and the preview (computed here: there is no preview route)", () => {
  it("words each kind as the server does", () => {
    expect(timingWords("weekly", { weekday: 1, at: "08:00" })).toBe("Every Monday at 08:00, for the week before");
    expect(timingWords("daily", { at: "06:00" })).toBe("Every day at 06:00, for the day before");
    expect(timingWords("monthly", { on: "working_day", n: 3, at: "08:00" })).toBe("On the 3rd working day of each month at 08:00, for the month before");
    expect(timingWords("quarterly", { on: "day", day: 1, at: "09:00" })).toBe("On day 1 of the month after each quarter at 09:00, for the quarter that ended");
    expect(timingWords("semester", { on: "day", day: 5, at: "09:00" })).toContain("half year");
    expect([ordinal(1), ordinal(2), ordinal(3), ordinal(11), ordinal(12), ordinal(13), ordinal(21), ordinal(20)]).toEqual(["1st", "2nd", "3rd", "11th", "12th", "13th", "21st", "20th"]);
  });
  it("a weekly one runs the Monday after the week and drafts the week before it", () => {
    const p = previewRuns("weekly", { weekday: 1, at: "08:00" }, NOW)!;
    expect(p.map((x) => x.text)).toEqual(["Monday 19 October at 08:00", "Monday 26 October at 08:00", "Monday 2 November at 08:00"]);
    expect(p[0].drafts).toBe("the week of 12 to 18 October 2026");
    expect(p[0].period).toBe("2026-W42");
  });
  it("a daily one that is still ahead today runs today and drafts yesterday", () => {
    const p = previewRuns("daily", { at: "06:00" }, NOW, 2)!;
    expect(p[0]).toMatchObject({ runDay: "2026-10-14", drafts: "13 October 2026" });
    expect(p[1].runDay).toBe("2026-10-15");
    // a time already past today starts tomorrow
    expect(previewRuns("daily", { at: "03:00" }, NOW, 1)![0].runDay).toBe("2026-10-15");
  });
  it("a monthly N-th working day skips the weekend: the 3rd working day of November 2026 is Wednesday the 4th", () => {
    const p = previewRuns("monthly", { on: "working_day", n: 3, at: "08:00" }, NOW)!;
    expect(p.map((x) => x.runDay)).toEqual(["2026-11-04", "2026-12-03", "2027-01-05"]);
    expect(p[0].drafts).toBe("October 2026");
  });
  it("a quarter and a year run in the month after they end, across the year turn", () => {
    expect(previewRuns("quarterly", { on: "day", day: 1, at: "09:00" }, NOW, 1)![0]).toMatchObject({ runDay: "2027-01-01", drafts: "the fourth quarter of 2026", text: "Friday 1 January 2027 at 09:00" });
    expect(previewRuns("yearly", { on: "day", day: 15, at: "10:00" }, NOW, 1)![0]).toMatchObject({ runDay: "2027-01-15", period: "2026" });
  });
  it("answers null for a timing that is not complete", () => {
    expect(previewRuns("weekly", { at: "" }, NOW)).toBeNull();
    expect(previewRuns("weekly", null, NOW)).toBeNull();
  });
});

describe("the form builds the server's body, and refuses what the server would, in the server's field names", () => {
  const f = (over: Partial<ScheduleForm> = {}): ScheduleForm => ({ ...emptyForm(), ...over });
  it("builds a create for every kind and form", () => {
    expect(buildBody(f(), { id: "id1" })).toEqual({ ok: true, body: { id: "id1", kind: "weekly", scope: "all", timing: { weekday: 1, at: "08:00" }, enabled: true } });
    expect(buildBody(f({ kind: "daily", at: "06:30" }), { id: "i" })).toMatchObject({ ok: true, body: { timing: { at: "06:30" } } });
    expect(buildBody(f({ kind: "monthly", monthlyOn: "day", day: "28" }), { id: "i" })).toMatchObject({ ok: true, body: { timing: { on: "day", day: 28, at: "08:00" } } });
    expect(buildBody(f({ kind: "yearly", monthlyOn: "working_day", n: "20", enabled: false }), { id: "i" })).toMatchObject({ ok: true, body: { timing: { on: "working_day", n: 20, at: "08:00" }, enabled: false } });
    expect(buildBody(f({ kind: "semester", scope: "chosen", engagementIds: ["e1", "e2"] }), { id: "i" })).toMatchObject({ ok: true, body: { scope: "chosen", engagementIds: ["e1", "e2"] } });
  });
  it("names the field the server names", () => {
    expect(buildBody(f({ at: "25:00" }), { id: "i" })).toMatchObject({ ok: false, field: "timing.at" });
    expect(buildBody(f({ weekday: "8" }), { id: "i" })).toMatchObject({ ok: false, field: "timing.weekday" });
    expect(buildBody(f({ kind: "monthly", monthlyOn: "day", day: "29" }), { id: "i" })).toMatchObject({ ok: false, field: "timing.day" });
    expect(buildBody(f({ kind: "monthly", monthlyOn: "working_day", n: "21" }), { id: "i" })).toMatchObject({ ok: false, field: "timing.n" });
    expect(buildBody(f({ kind: "monthly", monthlyOn: "working_day", n: "" }), { id: "i" })).toMatchObject({ ok: false, field: "timing.n" });
    expect(buildBody(f({ scope: "chosen" }), { id: "i" })).toMatchObject({ ok: false, field: "engagementIds" });
    expect(timingOfForm(f({ at: "08:00" })).ok).toBe(true);
  });
  it("an edit sends only what changed, never the kind, and nothing when nothing changed", () => {
    const s = sched();
    expect(buildBody(formOf(s), { original: s })).toEqual({ ok: true, body: {} });
    expect(buildBody({ ...formOf(s), at: "09:30" }, { original: s })).toEqual({ ok: true, body: { timing: { weekday: 1, at: "09:30" } } });
    expect(buildBody({ ...formOf(s), scope: "chosen", engagementIds: ["e1"] }, { original: s })).toEqual({ ok: true, body: { scope: "chosen", engagementIds: ["e1"] } });
    const c = sched({ scope: "chosen", clients: [{ engagementId: "e1", clientName: "A" }] });
    expect(buildBody({ ...formOf(c), engagementIds: ["e1", "e2"] }, { original: c })).toEqual({ ok: true, body: { scope: "chosen", engagementIds: ["e1", "e2"] } });
    expect(buildBody({ ...formOf(c), scope: "all" }, { original: c })).toEqual({ ok: true, body: { scope: "all" } });
  });
  it("round-trips a monthly working-day schedule into the form", () => {
    const s = sched({ kind: "quarterly", timing: { on: "working_day", n: 5, at: "10:15" } });
    expect(formOf(s)).toMatchObject({ kind: "quarterly", monthlyOn: "working_day", n: "5", at: "10:15" });
  });
});

describe("what the card says", () => {
  it("says a pause in words, for every reason the server has", () => {
    expect(pausedWords("owner_not_allowed")).toBe("Paused: its owner may no longer run it");
    expect(pausedWords("owner_inactive")).toContain("no longer an active user");
    expect(pausedWords("kind_off")).toContain("turned this report kind off");
    expect(pausedWords("ai_drafting_off")).toContain("drafted by hand");
    expect(pausedWords("manual")).toBe("Paused by a person");
    expect(pausedWords(null)).toBe("Paused");
  });
  it("says the spend plainly: tracked, with the cost or 'not recorded', never a limit", () => {
    expect(spendWords(zero)).toBe("No runs");
    expect(spendWords({ runs: 3, calls: 36, promptTokens: 54000, completionTokens: 18000, costUsd: 0.24 })).toBe("3 runs, 36 AI calls, 72,000 tokens, cost $0.2400");
    expect(spendWords({ runs: 1, calls: 1, promptTokens: 10, completionTokens: 5, costUsd: null })).toBe("1 run, 1 AI call, 15 tokens, cost not recorded");
    expect(formatUsd(12.3456)).toBe("$12.35");
    expect(spendWords(zero)).not.toMatch(/limit|cap/i);
  });
  it("says the clients, the last run and the missed periods", () => {
    expect(clientsWords(sched())).toBe("All clients");
    expect(clientsWords(sched({ scope: "chosen", clients: [{ engagementId: "e1", clientName: "A" }, { engagementId: "e2", clientName: "B" }] }))).toBe("2 clients: A, B");
    expect(lastRunWords({ runId: "r", status: "done", created: 9, existing: 2, skipped: 1, failed: 0, missed: 0 })).toBe("Finished: 9 drafts made, 2 already there, 1 skipped, 0 failed");
    expect(lastRunWords({ runId: "r", status: "running", created: 1, existing: 0, skipped: 0, failed: 0, missed: 0 })).toMatch(/^Still drafting/);
    expect(missedWords(0)).toBe("");
    expect(missedWords(2)).toContain("2 earlier periods missed");
  });
});

describe("the refusals of the schedule routes: in both fixture twins, with plain words", () => {
  const F = fixture as unknown as { refusals: Record<string, { http: number; with?: string }> };
  // The codes the five routes send (platform-nest/src/modules/social/pipeline/report-schedules.ts and report-runs.ts), with the server's own status and `with`.
  const SERVER: Record<string, { http: number; with?: string }> = {
    automation_cannot_act: { http: 403 }, not_a_social_approver: { http: 403 }, schedule_not_found: { http: 404 }, invalid_field: { http: 400, with: "field" },
    schedule_exists: { http: 409, with: "detail {scheduleId}" }, generation_running: { http: 409, with: "detail {runId}" }, report_kind_off: { http: 409 }, ai_drafting_off: { http: 409 },
  };
  it("lists every code with the server's http status and `with`", () => {
    for (const [code, want] of Object.entries(SERVER)) expect(F.refusals[code], code).toEqual(want);
  });
  it("has words for each: a sentence, never a bare token", () => {
    for (const code of Object.keys(SERVER)) {
      const text = scheduleRefusalText({ status: SERVER[code].http, error: code }, "save");
      expect(text, code).toMatch(/[.]$/);
      expect(text, code).not.toContain("_");
    }
    for (const code of ["schedule_not_found", "schedule_exists", "generation_running", "report_kind_off", "ai_drafting_off"]) expect(REFUSAL_WORDS[code], code).toBeTruthy();
  });
  it("puts a field's words beside it, branching on the code and the field, never on the message", () => {
    expect(scheduleRefusalText({ status: 400, error: "invalid_field", field: "timing.at" }, "save")).toBe("Choose a time of day, from 00:00 to 23:59.");
    expect(scheduleRefusalText({ status: 400, error: "invalid_field", field: "engagementIds" }, "save")).toContain("still open");
    expect(scheduleRefusalText({ status: 403, error: "not_authorized: cerbos denied create on social_report" }, "run")).toContain("right to create");
    expect(scheduleRefusalText({ status: 403, error: "not_a_social_approver" }, "pause")).toContain("set report automation");
  });
});
