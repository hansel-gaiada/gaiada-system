import { describe, it, expect } from "vitest";
import {
  GM_CONDITION_OPTIONS, MAX_APPRAISAL_TEXT, TOO_FEW_NOTE, cycleAcceptsWrites, cycleRange, cycleStatusLabel, explainAppraisalWriteError,
  historyLabel, isGmCondition, maxBandCount, monthShort, parseAppraisalText, parseAssessment, peopleHeadline, sortCyclesNewestFirst,
  statusRows,
} from "./deptAppraisalFormat";
import { conditionLabel } from "./deptKpiFormat";

// DW-4e-3 — the pure side of the department appraisal (lib/deptAppraisalFormat.ts, BFF §41). The numbers are the API's; these
// are the words around them, the picker's order, and the two forms' own validation (which only saves a round trip: the server
// validates the same rules and stays the authority).

describe("the cycle picker", () => {
  const c = (name: string, periodStart: string, periodEnd: string) => ({ id: name, name, periodStart, periodEnd, status: "open" as const });
  it("lists cycles newest first: by period start, then period end, then name", () => {
    const list = [
      c("H1 2026", "2026-01-01", "2026-06-30"),
      c("H2 2026", "2026-07-01", "2026-12-31"),
      c("Q3 2026", "2026-07-01", "2026-09-30"),
      c("H2 2025", "2025-07-01", "2025-12-31"),
      c("A-Q3 2026", "2026-07-01", "2026-09-30"),
    ];
    expect(sortCyclesNewestFirst(list).map((x) => x.name)).toEqual(["H2 2026", "A-Q3 2026", "Q3 2026", "H1 2026", "H2 2025"]);
  });
  it("never mutates its input", () => {
    const list = [c("a", "2026-01-01", "2026-02-01"), c("b", "2026-03-01", "2026-04-01")];
    const copy = [...list];
    sortCyclesNewestFirst(list);
    expect(list).toEqual(copy);
  });
  it("words a cycle's status and range", () => {
    expect(cycleStatusLabel("in_review")).toBe("In review");
    expect(cycleStatusLabel("closed")).toBe("Closed");
    expect(cycleStatusLabel("mystery")).toBe("mystery");
    expect(cycleRange("2026-07-01", "2026-12-31")).toBe("1 Jul 2026 to 31 Dec 2026");
    expect(monthShort("2026-09-01")).toBe("Sep 2026");
  });
  it("offers the forms for every status except closed (§41.2: writes end when the cycle is closed)", () => {
    for (const s of ["draft", "open", "in_review"]) expect(cycleAcceptsWrites(s), s).toBe(true);
    expect(cycleAcceptsWrites("closed")).toBe(false);
  });
});

describe("the people block wording", () => {
  it("says how many appraisals, and says so when there are none", () => {
    expect(peopleHeadline({ total: 0 })).toBe("No appraisals in this cycle yet");
    expect(peopleHeadline({ total: 1 })).toBe("1 appraisal");
    expect(peopleHeadline({ total: 6 })).toBe("6 appraisals");
  });
  it("lists every status in lifecycle order, zeros kept", () => {
    const rows = statusRows({ byStatus: { draft: 1, submitted: 2, acknowledged: 0, disputed: 0, finalized: 3 } });
    expect(rows.map((r) => [r.label, r.count])).toEqual([["Draft", 1], ["Submitted", 2], ["Acknowledged", 0], ["Disputed", 0], ["Finalized", 3]]);
  });
  it("draws the bars relative to the widest, never dividing by zero", () => {
    expect(maxBandCount([{ count: 1 }, { count: 4 }, { count: 2 }])).toBe(4);
    expect(maxBandCount([{ count: 0 }, { count: 0 }])).toBe(1);
  });
  it("explains a withheld distribution instead of leaving a gap", () => {
    expect(TOO_FEW_NOTE).toMatch(/too few/i);
    expect(TOO_FEW_NOTE).toMatch(/no individual/);
  });
});

describe("the history", () => {
  it("describes a month in words, never by colour alone", () => {
    expect(historyLabel({ month: "2026-09-01", condition: "at_risk" }, conditionLabel)).toBe("Sep 2026: at risk");
    expect(historyLabel({ month: "2026-10-01", condition: "unavailable" }, conditionLabel)).toBe("Oct 2026: unavailable");
  });
});

describe("the two forms' validation", () => {
  it("trims the text and accepts 1 to 4000 characters", () => {
    expect(parseAppraisalText("  Solid half.  ")).toEqual({ ok: true, text: "Solid half." });
    expect(parseAppraisalText("x".repeat(MAX_APPRAISAL_TEXT))).toMatchObject({ ok: true });
  });
  it("refuses an empty or too long text, naming the field", () => {
    expect(parseAppraisalText("")).toMatchObject({ ok: false, field: "text" });
    expect(parseAppraisalText("   \n ")).toMatchObject({ ok: false, field: "text" });
    const long = parseAppraisalText("x".repeat(MAX_APPRAISAL_TEXT + 1));
    expect(long).toMatchObject({ ok: false, field: "text" });
    expect(long.ok === false && long.error).toMatch(/4,000/);
  });
  it("knows the three conditions the GM may judge, and no other (unavailable is the engine's, never a judgement)", () => {
    expect(GM_CONDITION_OPTIONS.map((o) => o.value)).toEqual(["on_track", "at_risk", "off_track"]);
    expect(isGmCondition("at_risk")).toBe(true);
    expect(isGmCondition("unavailable")).toBe(false);
    expect(isGmCondition(undefined)).toBe(false);
  });
  it("parses an assessment, checking the text before the condition", () => {
    expect(parseAssessment({ text: " Fine. ", condition: "on_track" })).toEqual({ ok: true, body: { text: "Fine.", condition: "on_track" } });
    expect(parseAssessment({ text: "", condition: "on_track" })).toMatchObject({ ok: false, field: "text" });
    expect(parseAssessment({ text: "Fine.", condition: "" })).toMatchObject({ ok: false, field: "condition" });
    expect(parseAssessment({ text: "Fine.", condition: "great" })).toMatchObject({ ok: false, field: "condition" });
  });
  it("words the machine codes a writer can meet and passes any other message through verbatim", () => {
    expect(explainAppraisalWriteError("cycle_closed")).toMatch(/closed/);
    expect(explainAppraisalWriteError("cycle_not_found")).toMatch(/no longer exists/);
    expect(explainAppraisalWriteError("unit_not_found")).toMatch(/no longer exists/);
    expect(explainAppraisalWriteError("not authorized: x")).toBe("not authorized: x");
  });
});
