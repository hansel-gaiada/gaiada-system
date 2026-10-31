import { describe, it, expect, vi, afterAll } from "vitest";

// SCP-5 W5-A4 (BFF §63.24): DEMO_MODE's twin of "Generate with AI" for every client, the periodic kinds of the report store, and `GET rules`. The clock is pinned to Friday 16 October 2026 before the
// stores seed (hence vi.hoisted); only Date is faked, and a run settles as the clock moves.
vi.hoisted(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-16T04:00:00Z"));
});
afterAll(() => vi.useRealTimers());

import { socialDemo } from "./demoSocial";
import { DEMO_RUN_STEP_MS, demoRunStore } from "./demoSocialReportRuns";
import { asReportDetail, asReportList, asProposal } from "./socialReports";
import { asRunList, asRunProgress, asRunStarted } from "./socialReportRuns";
import { asReportRules, offeredTabs } from "./socialReportKinds";

const USER = { officer: "u-social", officer2: "u-social-2", hod: "u-pm", client: "demo-client" };
const call = (method: string, tail: string, user: string, body?: unknown, query = "") =>
  socialDemo(method, `/api/co/modules/social/${tail}`, new URLSearchParams(query), body === undefined ? undefined : JSON.stringify(body), user)!;
const code = (r: { json: unknown }) => (r.json as { error: string }).error;
const wait = (steps: number) => vi.setSystemTime(Date.now() + steps * DEMO_RUN_STEP_MS);
let n = 0;
const newId = () => `test-run-${++n}`;

describe("GET rules", () => {
  it("answers the seed: every kind on, drafted by AI, the daily and weekly frozen at submit", () => {
    const r = asReportRules(call("GET", "rules", USER.officer).json);
    expect(offeredTabs(r)).toEqual(["daily", "weekly", "monthly", "quarterly", "semester", "yearly", "other"]);
    expect(r.kinds.weekly).toMatchObject({ enabled: true, aiDrafting: true, freezeAt: "submit" });
    expect((call("GET", "rules", USER.hod).json as { canEdit: boolean }).canEdit).toBe(true);
    expect((call("GET", "rules", USER.officer).json as { canEdit: boolean }).canEdit).toBe(false);
    expect(call("GET", "rules", USER.client).status).toBe(403);
  });
});

describe("the other kinds in the report store", () => {
  it("seeds a little of each, in Draft and Sent, and filters the list by kind and by any period form", () => {
    const all = asReportList(call("GET", "reports", USER.hod).json);
    const kinds = new Set(all.map((r) => r.kind));
    for (const k of ["daily", "weekly", "monthly", "quarterly", "semester", "yearly"]) expect(kinds.has(k), k).toBe(true);
    for (const r of all.filter((x) => x.kind !== "monthly")) expect(["draft", "delivered"]).toContain(r.status);
    const weekly = asReportList(call("GET", "reports", USER.hod, undefined, "kind=weekly").json);
    expect(weekly.length).toBeGreaterThan(1);
    expect(weekly.every((r) => r.kind === "weekly")).toBe(true);
    expect(asReportList(call("GET", "reports", USER.hod, undefined, "kind=weekly&period=2026-W41").json).every((r) => r.period === "2026-W41")).toBe(true);
    expect(call("GET", "reports", USER.hod, undefined, "kind=hourly").status).toBe(400);
    expect(call("GET", "reports", USER.hod, undefined, "period=2026-W99x").status).toBe(400);
  });
  it("a short kind reads live while a draft, with its summary, next-period line, best post and the next period's table", () => {
    const row = asReportList(call("GET", "reports", USER.hod, undefined, "kind=weekly&period=2026-W42").json).find((r) => r.clientName === "Northwind Traders")!;
    expect(row).toMatchObject({ live: true, summaryPresent: true, due: "2026-10-19" });
    const d = asReportDetail(call("GET", `reports/${row.id}`, USER.hod).json);
    expect(d).toMatchObject({ kind: "weekly", live: true, due: "2026-10-19", notesComplete: true });
    expect(d.nextPeriod).toMatch(/next week/);
    expect(d.document.narrative.text).toContain(`Next week: ${d.nextPeriod}`);
    expect(d.document.tables.map((t) => t.key)).toContain("best_post");
    expect(d.document.kpis.map((k) => k.label)).toContain("Posts approved by the client");
  });
  it("creates a weekly report with its summary and line, refuses a period in the future, and a quarter still going", () => {
    const eng = asReportList(call("GET", "reports", USER.hod).json).find((r) => r.clientName === "Harborlight Hotel")!.engagementId;
    const made = call("POST", `engagements/${eng}/reports`, USER.officer2, { id: "demo-weekly-1", kind: "weekly", period: "2026-W40" });
    expect(made.status).toBe(201);
    expect(made.json).toMatchObject({ draftedVia: "fallback", status: "draft" }); // the hotel's numbers are simulated: the plain template
    expect((made.json as { nextPeriod: string }).nextPeriod).toMatch(/next week/);
    expect(call("POST", `engagements/${eng}/reports`, USER.officer2, { kind: "weekly", period: "2026-W40" }).json).toMatchObject({ draftedVia: "existing" });
    const bad = call("POST", `engagements/${eng}/reports`, USER.officer2, { kind: "weekly", period: "2026-W50" });
    expect([bad.status, code(bad), (bad.json as { field: string }).field]).toEqual([400, "invalid_field", "period"]);
    const going = call("POST", `engagements/${eng}/reports`, USER.officer2, { kind: "quarterly", period: "2026-Q4" });
    expect([going.status, code(going)]).toEqual([400, "period_not_over"]);
    expect(call("POST", `engagements/${eng}/reports`, USER.officer2, { kind: "quarterly", period: "2026-Q3" }).status).toBe(201);
  });
  it("a short kind takes a summary and a line, refuses notes, and the check needs the summary", () => {
    const row = asReportList(call("GET", "reports", USER.hod, undefined, "kind=daily").json)[0];
    expect(call("PATCH", `reports/${row.id}`, USER.officer, { notes: {} }).json).toMatchObject({ error: "invalid_field", field: "notes" });
    expect(call("PATCH", `reports/${row.id}`, USER.officer, { narrativeMd: "x".repeat(1001) }).json).toMatchObject({ field: "narrativeMd" });
    expect(call("PATCH", `reports/${row.id}`, USER.officer, { narrativeMd: "", nextPeriod: null }).status).toBe(200);
    expect(call("PATCH", `reports/${row.id}`, USER.officer, { status: "in_review" }).status).toBe(200);
    const a = call("POST", `reports/${row.id}/approve`, USER.hod);
    expect([a.status, code(a)]).toEqual([400, "summary_missing"]);
    expect(call("PATCH", `reports/${row.id}`, USER.hod, { narrativeMd: "A good day." }).status).toBe(200);
    expect(call("POST", `reports/${row.id}/approve`, USER.hod).status).toBe(200);
  });
  it("a short kind's Draft with AI is a proposal of the summary and the line", () => {
    const row = asReportList(call("GET", "reports", USER.hod, undefined, "kind=weekly&period=2026-W42").json)[0];
    const p = asProposal(call("POST", `reports/${row.id}/ai-draft`, USER.officer).json);
    expect(p.narrativeMd).toBeTruthy();
    expect(p.nextPeriod).toMatch(/next week/);
  });
  it("a notes kind (quarterly) is not complete until its areas are written", () => {
    const row = asReportList(call("GET", "reports", USER.hod, undefined, "kind=quarterly").json).find((r) => r.clientName === "Northwind Traders")!;
    expect(row.notesComplete).toBe(false);
  });
});

describe("Generate with AI for every client (POST reports/generate)", () => {
  it("is refused to a client contact, for a kind that is not one, and for a period that is not one or not begun", () => {
    expect(call("POST", "reports/generate", USER.client, { kind: "weekly", period: "2026-W41" }).status).toBe(403);
    expect(call("POST", "reports/generate", USER.hod, { kind: "hourly", period: "2026-W41" }).json).toMatchObject({ error: "invalid_field", field: "kind" });
    expect(call("POST", "reports/generate", USER.hod, { kind: "weekly", period: "2026-W50" }).json).toMatchObject({ error: "invalid_field", field: "period" });
    expect(call("POST", "reports/generate", USER.hod, { kind: "weekly", period: "nope" }).json).toMatchObject({ field: "period" });
  });
  it("needs every kind frozen at create to be ended, the monthly included; a short kind may still be going", () => {
    expect(code(call("POST", "reports/generate", USER.hod, { kind: "monthly", period: "2026-10" }))).toBe("period_not_over");
    expect(code(call("POST", "reports/generate", USER.hod, { kind: "quarterly", period: "2026-Q4" }))).toBe("period_not_over");
    expect(call("POST", "reports/generate", USER.hod, { id: newId(), kind: "daily", period: "2026-10-16" }).status).toBe(202);
  });
  it("lists the clients once (the four: every active client; an officer: their own), skipping a client not due the kind, and settles client by client", () => {
    const id = newId();
    const started = call("POST", "reports/generate", USER.hod, { id, kind: "weekly", period: "2026-W39" });
    expect(started.status).toBe(202);
    const s = asRunStarted(started.json);
    expect(s).toMatchObject({ runId: id, kind: "weekly", period: "2026-W39", total: 3 });
    const r0 = asRunProgress(call("GET", `reports/generate/${id}`, USER.hod).json);
    expect(r0).toMatchObject({ status: "running", total: 3 });
    // the spa is due no weekly report: skipped at once, so it is listed already
    expect(r0.results.map((r) => [r.clientName, r.status, r.reason])).toEqual([["Saltmarsh Day Spa", "skipped", "kind_not_due"]]);
    wait(1);
    const r1 = asRunProgress(call("GET", `reports/generate/${id}`, USER.hod).json);
    expect(r1.done).toBe(2);
    expect(r1.results.find((r) => r.clientName === "Harborlight Hotel")).toMatchObject({ status: "created", draftedVia: "fallback", simulated: true });
    wait(5);
    const r2 = asRunProgress(call("GET", `reports/generate/${id}`, USER.hod).json);
    expect(r2).toMatchObject({ status: "done", done: 3 });
    expect(r2.results.find((r) => r.clientName === "Northwind Traders")).toMatchObject({ status: "created", draftedVia: "ai", simulated: false });
    expect(r2.results.every((r) => r.status === "skipped" || r.reportId)).toBe(true);
    expect(r2.finishedAt).not.toBeNull();
    // the drafts are real reports of the store
    const made = asReportList(call("GET", "reports", USER.hod, undefined, "kind=weekly&period=2026-W39").json);
    expect(made.map((m) => m.clientName).sort()).toEqual(["Harborlight Hotel", "Northwind Traders"]);
  });
  it("never redrafts a client that has a report, and an officer drafts only for their own clients", () => {
    const id = newId();
    call("POST", "reports/generate", USER.officer, { id, kind: "weekly", period: "2026-W41" });
    wait(10);
    const r = asRunProgress(call("GET", `reports/generate/${id}`, USER.officer).json);
    // u-social is the officer of Northwind and the hotel, not the spa (u-social-2's): the spa is not listed at all, and both clients' reports for the week are seeded, so neither is redrafted
    expect(r.results.map((x) => [x.clientName, x.status])).toEqual([["Harborlight Hotel", "existing"], ["Northwind Traders", "existing"]]);
  });
  it("is 409 generation_running with the run's id while one goes; a replayed id answers the run as it stands", () => {
    const id = newId();
    call("POST", "reports/generate", USER.hod, { id, kind: "daily", period: "2026-10-13" });
    const again = call("POST", "reports/generate", USER.hod, { id: newId(), kind: "daily", period: "2026-10-13" });
    expect([again.status, code(again), (again.json as { detail: { runId: string } }).detail.runId]).toEqual([409, "generation_running", id]);
    const replay = call("POST", "reports/generate", USER.hod, { id, kind: "daily", period: "2026-10-13" });
    expect(replay.status).toBe(200);
    expect(asRunProgress(replay.json).runId).toBe(id);
    wait(10);
    expect(call("POST", "reports/generate", USER.hod, { id: newId(), kind: "daily", period: "2026-10-13" }).status).toBe(202); // finished: a new run may start
  });
  it("shows a run only to its person and to the four, and lists the recent runs the same way", () => {
    const id = newId();
    call("POST", "reports/generate", USER.officer, { id, kind: "daily", period: "2026-10-12" });
    expect(call("GET", `reports/generate/${id}`, USER.officer2).status).toBe(404);
    expect(code(call("GET", `reports/generate/${id}`, USER.officer2))).toBe("run_not_found");
    expect(call("GET", `reports/generate/${id}`, USER.hod).status).toBe(200);
    const mine = asRunList(call("GET", "reports/generate", USER.officer2).json);
    expect(mine.map((r) => r.runId)).not.toContain(id);
    expect(asRunList(call("GET", "reports/generate", USER.hod).json).map((r) => r.runId)).toContain(id);
    expect(asRunList(call("GET", "reports/generate", USER.hod).json).find((r) => r.runId === "demo-run-seed-1")).toMatchObject({ kind: "weekly", status: "done" });
  });
  it("leaves A6's runs and a schedule's list to A6's demo: null for demo-sched-run ids and for a list by schedule", () => {
    expect(socialDemo("GET", "/api/co/modules/social/reports/generate/demo-sched-run-1", new URLSearchParams(), undefined, USER.hod)?.json).not.toMatchObject({ error: "run_not_found" });
    expect(demoRunStore.runs.some((r) => r.id.startsWith("demo-sched-run-"))).toBe(false);
  });
});
