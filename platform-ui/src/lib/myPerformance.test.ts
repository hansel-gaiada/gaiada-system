import { describe, it, expect } from "vitest";
import type { ReadResult } from "./readResult";
import type { CheckinHistory, CheckinHistoryEntry } from "./checkins";
import type { MyLearning, MyEnrollment } from "./lms";
import type { ReportDocument } from "./reports";
import {
  CHECKIN_ENTRIES_SHOWN, PERFORMANCE_SECTIONS, SECTION_MODULE, appraisalSection, checkinsView, learningSection, moduleOff, numbersHref,
  numbersSection, sectionOf, timeSection,
} from "./myPerformance";

const ok = <T,>(data: T): ReadResult<T> => ({ kind: "ok", data });
const forbidden: ReadResult<never> = { kind: "forbidden" };
const unavailable: ReadResult<never> = { kind: "unavailable", reason: "boom" };

describe("sectionOf", () => {
  it("keeps a refusal and a failure apart, and never turns either into data", () => {
    expect(sectionOf(forbidden, () => "x")).toEqual({ kind: "forbidden" });
    expect(sectionOf(unavailable, () => "x")).toEqual({ kind: "unavailable" });
    expect(sectionOf(ok(1), (n) => n + 1)).toEqual({ kind: "ok", data: 2 });
  });

  it("calls an odd payload unavailable instead of throwing into the page", () => {
    expect(sectionOf(ok(null as unknown as { a: { b: number } }), (d) => d.a.b)).toEqual({ kind: "unavailable" });
  });
});

describe("the section modules", () => {
  it("gates numbers and appraisal on reports, check-ins on hr, learning on lms; time and activity on none", () => {
    expect(SECTION_MODULE).toEqual({ numbers: "reports", checkins: "hr", appraisal: "reports", learning: "lms" });
    expect([...PERFORMANCE_SECTIONS]).toEqual(["numbers", "checkins", "appraisal", "learning", "time", "activity"]);
  });

  it("is off only for the module that is off", () => {
    const only = (off: string) => (k: string) => k !== off;
    expect(PERFORMANCE_SECTIONS.filter((s) => moduleOff(s, only("hr")))).toEqual(["checkins"]);
    expect(PERFORMANCE_SECTIONS.filter((s) => moduleOff(s, only("lms")))).toEqual(["learning"]);
    expect(PERFORMANCE_SECTIONS.filter((s) => moduleOff(s, only("reports")))).toEqual(["numbers", "appraisal"]);
    expect(PERFORMANCE_SECTIONS.filter((s) => moduleOff(s, () => true))).toEqual([]);
  });
});

describe("numbers", () => {
  it("reads the month, linking to My report for the same month", () => {
    expect(numbersHref("2026-10-15")).toBe("/reports/person?periodKind=month&start=2026-10-15");
  });

  it("is unavailable for a document it cannot read, never an empty set of tiles", () => {
    expect(numbersSection(ok({} as ReportDocument))).toEqual({ kind: "unavailable" });
    expect(numbersSection(unavailable)).toEqual({ kind: "unavailable" });
  });
});

const entry = (date: string, status: CheckinHistoryEntry["status"], over: Partial<CheckinHistoryEntry> = {}): CheckinHistoryEntry => ({
  id: date, date, status, summary: `did ${date}`, blockers: null, edited: false, source: "web", submittedAt: null, excusedReason: null, ...over,
});
const history = (checkins: CheckinHistoryEntry[]): CheckinHistory => ({ userId: "u", from: "2026-09-01", to: "2026-10-15", checkins });

describe("checkinsView", () => {
  it("counts the streak, never charges an excused day, and lists the newest first", () => {
    const v = checkinsView(history([
      entry("2026-10-12", "submitted"), entry("2026-10-13", "excused", { summary: "", excusedReason: "Sick" }),
      entry("2026-10-14", "submitted"), entry("2026-10-09", "auto_missed", { summary: "" }),
    ]));
    expect(v.streak).toBe(2);
    expect(v.rate).toBe("67%");
    expect([v.submitted, v.missed, v.excused, v.windowDays]).toEqual([2, 1, 1, 4]);
    expect(v.entries.map((e) => [e.date, e.status, e.summary])).toEqual([
      ["2026-10-14", "Submitted", "did 2026-10-14"],
      ["2026-10-13", "Excused", "Sick"],
      ["2026-10-12", "Submitted", "did 2026-10-12"],
      ["2026-10-09", "Missed", ""],
    ]);
  });

  it("says no data, not 0%, when nothing was expected", () => {
    const v = checkinsView(history([]));
    expect(v.rate).toBeNull();
    expect(v.entries).toEqual([]);
  });

  it("lists at most the last 14 entries", () => {
    const days = Array.from({ length: 20 }, (_, i) => entry(`2026-10-${String(i + 1).padStart(2, "0")}`, "submitted"));
    const v = checkinsView(history(days));
    expect(v.entries).toHaveLength(CHECKIN_ENTRIES_SHOWN);
    expect(v.entries[0].date).toBe("2026-10-20");
    expect(v.entries.at(-1)?.date).toBe("2026-10-07");
  });
});

describe("appraisalSection", () => {
  const pack = (over: Record<string, unknown>) => ({
    cycleName: "2026 H1", status: "submitted" as const, submittedAt: "2026-07-01T00:00:00Z", createdAt: "2026-06-01T00:00:00Z", acks: [],
    // The rest of a real pack: scores with an effort axis, a composite. None of it may reach the view.
    composite: 4.4, scores: { effort: { value: 99 } }, ...over,
  });

  it("takes the latest, and says whether it was acknowledged", () => {
    const s = appraisalSection(ok({ appraisals: [
      pack({ cycleName: "2025 H2", submittedAt: "2026-01-01T00:00:00Z" }),
      pack({ cycleName: "2026 H1", status: "acknowledged" }),
    ] } as never));
    expect(s).toEqual({ kind: "ok", data: { cycleName: "2026 H1", status: "acknowledged", statusText: "Acknowledged", acknowledged: true } });
  });

  it("reads an acknowledgement from the trail too, and a disputed pack is not acknowledged", () => {
    const acked = appraisalSection(ok({ appraisals: [pack({ status: "finalized", acks: [{ action: "acknowledged" }] })] } as never));
    expect(acked.kind === "ok" && acked.data?.acknowledged).toBe(true);
    const disputed = appraisalSection(ok({ appraisals: [pack({ status: "disputed", acks: [{ action: "disputed" }] })] } as never));
    expect(disputed.kind === "ok" && disputed.data?.acknowledged).toBe(false);
  });

  it("carries exactly four fields: no score, no composite, no axis, no effort", () => {
    const s = appraisalSection(ok({ appraisals: [pack({})] } as never));
    expect(s.kind === "ok" && s.data && Object.keys(s.data).sort()).toEqual(["acknowledged", "cycleName", "status", "statusText"]);
    expect(JSON.stringify(s)).not.toMatch(/effort|composite|scores|4\.4|99/);
  });

  it("is null (a real 'no appraisal yet') only when the read succeeded and held none", () => {
    expect(appraisalSection(ok({ appraisals: [] }))).toEqual({ kind: "ok", data: null });
    expect(appraisalSection(unavailable)).toEqual({ kind: "unavailable" });
    expect(appraisalSection(forbidden)).toEqual({ kind: "forbidden" });
  });
});

describe("learningSection", () => {
  const enrol = (over: Partial<MyEnrollment>): MyEnrollment => ({ status: "assigned", isMandatory: false, overdue: false, ...over } as MyEnrollment);

  it("counts outstanding, and the mandatory and overdue among them", () => {
    const data = { certifications: [], enrolments: [
      enrol({ status: "assigned", isMandatory: true }), enrol({ status: "in_progress", overdue: true }),
      enrol({ status: "completed", isMandatory: true, overdue: true }), enrol({ status: "waived", isMandatory: true }),
    ] } as MyLearning;
    expect(learningSection(ok(data))).toEqual({ kind: "ok", data: { outstanding: 2, mandatory: 1, overdue: 1 } });
  });

  it("is unavailable, never 'no training', when the read threw", () => {
    expect(learningSection(unavailable)).toEqual({ kind: "unavailable" });
  });
});

describe("timeSection", () => {
  const today = "2026-10-15";
  it("sums this month and the last 7 days from the entries it is given", () => {
    const s = timeSection(ok([
      { entry_date: "2026-10-15", minutes: 90 }, { entry_date: "2026-10-09", minutes: 60 }, // inside the 7 days (9..15)
      { entry_date: "2026-10-08", minutes: 30 }, // this month, outside the 7 days
      { entry_date: "2026-09-30", minutes: 600 }, // last month
    ]), today);
    expect(s).toEqual({ kind: "ok", data: { monthLabel: "October 2026", monthMinutes: 180, weekMinutes: 150, monthText: "3 h", weekText: "2.5 h", entryCount: 4 } });
  });

  it("is 0 h only for a read that succeeded; a failure is unavailable", () => {
    const s = timeSection(ok([]), today);
    expect(s.kind === "ok" && s.data.monthText).toBe("0 h");
    expect(timeSection(unavailable, today)).toEqual({ kind: "unavailable" });
    expect(timeSection(forbidden, today)).toEqual({ kind: "forbidden" });
  });
});
