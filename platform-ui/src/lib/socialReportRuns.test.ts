import { describe, it, expect } from "vitest";
import {
  RUN_POLL_MS, asRunList, asRunProgress, asRunResult, asRunStarted, isSettled, progressLine, reasonWords, resultHref, resultWords, runRefusalText, runStatusWords, runTitle, runningRunId,
  tallyLine, tallyOf, type RunResult,
} from "./socialReportRuns";
import { GENERATE_REASON } from "./socialReports";

// SCP-5 W5-A4 (BFF §63.24.5): the run's answers, parsed defensively, and the words for each client's result and for each refusal of the run routes.

const result = (over: Record<string, unknown> = {}) => ({ engagementId: "e1", clientName: "Northwind Traders", reportId: "r1", status: "created", draftedVia: "ai", simulated: false, ...over });
const progress = (over: Record<string, unknown> = {}) => ({
  runId: "run1", kind: "weekly", period: "2026-W45", status: "running", total: 3, done: 1, results: [result()], startedAt: "2026-11-10T08:00:00Z", finishedAt: null, trigger: "person", scheduleId: null,
  usage: { calls: 2, promptTokens: 900, completionTokens: 300, costUsd: null }, ...over,
});

describe("the run's progress", () => {
  it("is parsed with its results and its usage; a cost not known yet stays null, never zero", () => {
    const p = asRunProgress(progress());
    expect(p).toMatchObject({ runId: "run1", kind: "weekly", period: "2026-W45", status: "running", total: 3, done: 1, usage: { calls: 2, promptTokens: 900, completionTokens: 300, costUsd: null } });
    expect(p.results).toEqual([{ engagementId: "e1", clientName: "Northwind Traders", reportId: "r1", status: "created", draftedVia: "ai", reason: null, simulated: false }]);
    expect(asRunProgress(progress({ usage: { calls: 1, costUsd: 0.02 } })).usage.costUsd).toBe(0.02);
  });
  it("drops a result that is not one, and throws on an answer that is not a run", () => {
    expect(asRunProgress(progress({ results: [result(), { engagementId: "e2", status: "pending" }, "x"] })).results).toHaveLength(1);
    expect(asRunResult({ engagementId: "e1", status: "waiting" })).toBeNull();
    expect(() => asRunProgress({})).toThrow();
    expect(() => asRunProgress(progress({ results: null }))).toThrow();
    expect(() => asRunStarted({ kind: "daily" })).toThrow();
    expect(() => asRunList({})).toThrow();
  });
  it("a started run answers its id and size, from the 202 and from the 200 of a replayed id alike", () => {
    expect(asRunStarted({ runId: "run1", kind: "weekly", period: "2026-W45", total: 12, clients: [] })).toEqual({ runId: "run1", kind: "weekly", period: "2026-W45", total: 12 });
    expect(asRunStarted(progress({ clients: [] }))).toMatchObject({ runId: "run1", total: 3 });
  });
  it("settles on done or failed, and polls at a modest interval", () => {
    expect(["queued", "running"].map(isSettled)).toEqual([false, false]);
    expect(["done", "failed"].map(isSettled)).toEqual([true, true]);
    expect(RUN_POLL_MS).toBeGreaterThanOrEqual(3000);
  });
  it("lists the recent runs with their tallies", () => {
    const items = asRunList({ items: [{ runId: "a", kind: "daily", period: "2026-11-09", status: "done", total: 4, done: 4, counts: { created: 3, existing: 1, skipped: 0, failed: 0 }, trigger: "person", createdAt: "2026-11-10T08:00:00Z", finishedAt: "2026-11-10T08:05:00Z" }, { nope: true }] });
    expect(items).toEqual([{ runId: "a", kind: "daily", period: "2026-11-09", status: "done", total: 4, done: 4, counts: { created: 3, existing: 1, skipped: 0, failed: 0 }, trigger: "person", createdAt: "2026-11-10T08:00:00Z", finishedAt: "2026-11-10T08:05:00Z" }]);
  });
});

describe("the words", () => {
  it("says the progress and the status", () => {
    expect(progressLine({ done: 3, total: 12 })).toBe("3 of 12 clients done.");
    expect(progressLine({ done: 0, total: 1 })).toBe("0 of 1 client done.");
    expect(runStatusWords("queued")).toBe("Waiting its turn");
    expect(runStatusWords("failed")).toBe("Stopped");
    expect(runStatusWords("odd")).toBe("odd");
    expect(runTitle("weekly", "Week 45, 2026")).toBe("Weekly report, Week 45, 2026");
  });
  it("tallies as the notice does: 12 drafts ready, 6 already there, 1 failed", () => {
    expect(tallyLine({ created: 12, existing: 6, skipped: 0, failed: 1 })).toBe("12 drafts ready, 6 already there, 1 failed");
    expect(tallyLine({ created: 1, existing: 0, skipped: 2, failed: 0 })).toBe("1 draft ready, 2 skipped");
    expect(tallyLine({ created: 0, existing: 0, skipped: 0, failed: 0 })).toBe("Nothing to draft");
    const rs = [result(), result({ status: "existing" }), result({ status: "skipped", reportId: null }), result({ status: "failed" })].map((r) => asRunResult(r)!);
    expect(tallyOf(rs)).toEqual({ created: 1, existing: 1, skipped: 1, failed: 1 });
  });
  it("words each client's result, and links only a result that has a report", () => {
    const r = (o: Record<string, unknown>): RunResult => asRunResult(result(o))!;
    expect(resultWords(r({}), "daily")).toBe("Draft ready.");
    expect(resultWords(r({ draftedVia: "fallback" }), "daily")).toMatch(/plain template/);
    expect(resultWords(r({ draftedVia: "none" }), "daily")).toMatch(/AI drafting is off/);
    expect(resultWords(r({ status: "existing" }), "daily")).toMatch(/Already had one/);
    expect(resultWords(r({ status: "skipped", reportId: null, reason: "kind_not_due" }), "weekly")).toBe("Skipped. This client is not due a weekly report. Turn it on for the client on the Allocation page.");
    expect(resultWords(r({ status: "skipped", reportId: null, reason: "internal_client" }), "weekly")).toMatch(/Our own company is not a client/);
    expect(resultWords(r({ status: "failed", reportId: null, reason: "period_not_over" }), "monthly")).toMatch(/^Failed\. That period is not over yet/);
    expect(resultHref("d-soc", r({}))).toBe("/departments/d-soc/social-reports/r1");
    expect(resultHref("d-soc", r({ status: "failed", reportId: null }))).toBeNull();
  });
  it("never shows a bare code: an unknown reason is said plainly", () => {
    expect(reasonWords("something_new", "daily")).toBe("The draft could not be made (something new).");
    expect(reasonWords("requester_inactive", "daily")).toMatch(/no longer active/);
    expect(reasonWords(null, "daily")).toBe("");
  });
});

describe("the refusals of the run routes", () => {
  it("a 403 says who may generate, and an unattended automation keeps its own sentence", () => {
    expect(runRefusalText({ status: 403, error: "not authorized: cerbos denied create on social_report" })).toBe(`You cannot do this. ${GENERATE_REASON}`);
    expect(runRefusalText({ status: 403, error: "automation_cannot_act" })).not.toMatch(/Social Media head/);
  });
  it("names a run still going, with its id, and a run that is gone", () => {
    const r = { status: 409, error: "generation_running", detail: { runId: "run9" } };
    expect(runRefusalText(r)).toMatch(/already going/);
    expect(runningRunId(r)).toBe("run9");
    expect(runningRunId({ status: 409, error: "generation_running" })).toBeNull();
    expect(runningRunId({ status: 409, error: "report_kind_off" })).toBeNull();
    expect(runRefusalText({ status: 404, error: "run_not_found" })).toMatch(/run was not found/);
  });
  it("words the run's other refusals: a kind off, AI drafting off, a period not over, a field", () => {
    expect(runRefusalText({ status: 409, error: "report_kind_off" })).toMatch(/turned this kind of report off/);
    expect(runRefusalText({ status: 409, error: "ai_drafting_off" })).toMatch(/written by hand/);
    expect(runRefusalText({ status: 400, error: "period_not_over" })).toMatch(/not over yet/);
    expect(runRefusalText({ status: 400, error: "invalid_field", field: "period" })).toMatch(/real day, week, month/);
    expect(runRefusalText({ status: 400, error: "invalid_field", field: "kind" })).toMatch(/not known/);
  });
});
