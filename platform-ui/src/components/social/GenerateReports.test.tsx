import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";

// SCP-5 W5-A4 (BFF §63.24.5, §63.24.7): "Generate with AI". One client calls the create route and opens the report; "all my clients" ("all clients" for the four) starts a run and follows it by polling its read
// at a modest interval until it settles, each client's result in place with its link; a run already going is followed, a refusal is said in words, and a run in `?run=` is followed without being started here.
// The actions are scripted, so the run's answers are exactly what each test says.
const nav = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn(), back: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => nav }));
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("@/lib/socialReportsActions", () => ({ draftReport: vi.fn(), startRun: vi.fn(), readRun: vi.fn() }));

import { refusalFromBody } from "@/lib/socialPipeline";
import { reportRefusalText, type CreatedReport } from "@/lib/socialReports";
import { asRunProgress, RUN_POLL_MS, type RunProgress } from "@/lib/socialReportRuns";
import { draftReport, readRun, startRun } from "@/lib/socialReportsActions";
import { GenerateReports } from "./GenerateReports";

const CLIENTS = [{ engagementId: "e1", clientName: "Northwind Traders" }, { engagementId: "e2", clientName: "Harborlight Hotel" }];
const created = (id = "r-new", draftedVia = "ai"): { ok: true; report: CreatedReport } => ({ ok: true, report: { id, status: "draft", simulated: false, draftedVia } });
const refused = (status: number, error: string, extra: Record<string, unknown> = {}, kind: Parameters<typeof reportRefusalText>[1] = "generate") => {
  const refusal = refusalFromBody(status, error, extra, typeof extra.field === "string" ? extra.field : undefined);
  return { ok: false as const, refusal, message: reportRefusalText(refusal, kind) };
};
const run = (over: Record<string, unknown> = {}): RunProgress => asRunProgress({
  runId: "run1", kind: "weekly", period: "2026-W41", status: "running", total: 3, done: 1, startedAt: "2026-10-16T04:00:00Z", finishedAt: null, usage: {},
  results: [{ engagementId: "e0", clientName: "Saltmarsh Day Spa", status: "skipped", reason: "kind_not_due" }], ...over,
});
const mount = (over: Partial<Parameters<typeof GenerateReports>[0]> = {}) => render(
  <GenerateReports deptId="d-soc" kind="weekly" clients={CLIENTS} isApprover={false} today="2026-10-16" rule={{ enabled: true, aiDrafting: true, freezeAt: "submit", narrativeMax: 1000 }}
    fiscalYearStartMonth={1} runs={[]} followRunId={null} {...over} />,
);
const press = (name: RegExp | string) => fireEvent.click(screen.getByRole("button", { name }));

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.useRealTimers(); });

describe("the form", () => {
  it("offers 'All my clients' first for an officer and 'All clients' for the four, and the weeks of the kind with the one still going marked", () => {
    const a = mount();
    expect(within(screen.getByLabelText("Client")).getAllByRole("option").map((o) => o.textContent)).toEqual(["All my clients", "Northwind Traders", "Harborlight Hotel"]);
    const weeks = within(screen.getByLabelText("Week")).getAllByRole("option").map((o) => o.textContent);
    expect(weeks[0]).toBe("Week 42, 2026 (12 to 18 Oct 2026) (so far)");
    expect(weeks).toHaveLength(12);
    a.unmount();
    mount({ isApprover: true });
    expect(screen.getByRole("option", { name: "All clients" })).toBeInTheDocument();
  });
  it("'all clients' on a kind frozen at create offers ended periods only; one client's monthly also offers the month so far", () => {
    mount({ kind: "quarterly", rule: { enabled: true, aiDrafting: true, freezeAt: "create", narrativeMax: null } });
    expect(within(screen.getByLabelText("Quarter")).getAllByRole("option")[0].textContent).toBe("Q3 2026");
    fireEvent.change(screen.getByLabelText("Client"), { target: { value: "e1" } });
    expect(within(screen.getByLabelText("Quarter")).getAllByRole("option")[0].textContent).toBe("Q3 2026"); // a quarter is never offered while it goes
  });
  it("one client's monthly offers the month so far", () => {
    mount({ kind: "monthly", clients: [CLIENTS[0]] });
    expect(within(screen.getByLabelText("Month")).getAllByRole("option")[0].textContent).toBe("October 2026 (so far)");
  });
  it("with AI drafting off for the kind there is no 'all clients', and the form says drafts start empty", () => {
    mount({ rule: { enabled: true, aiDrafting: false, freezeAt: "submit", narrativeMax: 1000 } });
    expect(screen.queryByRole("option", { name: /All/ })).toBeNull();
    expect(screen.getByText(/AI drafting is turned off for this kind/)).toBeInTheDocument();
  });
});

describe("one client", () => {
  it("calls the create route with the kind, the period and a fresh id, then opens the report", async () => {
    vi.mocked(draftReport).mockResolvedValue(created("r-new"));
    mount();
    fireEvent.change(screen.getByLabelText("Client"), { target: { value: "e2" } });
    fireEvent.change(screen.getByLabelText("Week"), { target: { value: "2026-W41" } });
    press("Generate with AI");
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/departments/d-soc/social-reports/r-new"));
    const [eng, kind, period, id] = vi.mocked(draftReport).mock.calls[0];
    expect([eng, kind, period]).toEqual(["e2", "weekly", "2026-W41"]);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4/);
    expect(startRun).not.toHaveBeenCalled();
  });
  it("says a refusal in words and stays on the page", async () => {
    vi.mocked(draftReport).mockResolvedValue(refused(409, "report_kind_off", {}, "create"));
    mount({ clients: [CLIENTS[0]] });
    press("Generate with AI");
    expect(await screen.findByText(/turned this kind of report off/)).toBeInTheDocument();
    expect(nav.push).not.toHaveBeenCalled();
  });
});

describe("all clients: the run", () => {
  it("starts a run with the kind and period and no client list, then shows its progress and each client's result as it lands, each with its link", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(startRun).mockResolvedValue({ ok: true, run: { runId: "run1", kind: "weekly", period: "2026-W41", total: 3 } });
    vi.mocked(readRun)
      .mockResolvedValueOnce({ ok: true, run: run() })
      .mockResolvedValueOnce({ ok: true, run: run({ done: 2, results: [...run().results, { engagementId: "e1", clientName: "Northwind Traders", reportId: "r1", status: "created", draftedVia: "ai" }] }) })
      .mockResolvedValue({ ok: true, run: run({ status: "done", done: 3, finishedAt: "2026-10-16T04:01:00Z", results: [
        { engagementId: "e0", clientName: "Saltmarsh Day Spa", status: "skipped", reason: "kind_not_due" },
        { engagementId: "e1", clientName: "Northwind Traders", reportId: "r1", status: "created", draftedVia: "ai" },
        { engagementId: "e2", clientName: "Harborlight Hotel", reportId: "r2", status: "created", draftedVia: "fallback", simulated: true },
      ] }) });
    mount();
    fireEvent.change(screen.getByLabelText("Week"), { target: { value: "2026-W41" } });
    press("Generate with AI");
    await waitFor(() => expect(startRun).toHaveBeenCalledWith("weekly", "2026-W41", expect.stringMatching(/^[0-9a-f]{8}-/)));
    const panel = await screen.findByRole("region", { name: "Run progress" });
    expect(await within(panel).findByText("1 of 3 clients done.", { exact: false })).toBeInTheDocument();
    expect(within(panel).getByRole("heading", { name: "Weekly report, Week 41, 2026 (5 to 11 Oct 2026)" })).toBeInTheDocument();
    expect(within(panel).getByText(/Skipped\. This client is not due a weekly report/)).toBeInTheDocument();
    // the next poll lands a client, in place, with its link
    await act(async () => { await vi.advanceTimersByTimeAsync(RUN_POLL_MS + 10); });
    expect(await within(panel).findByRole("link", { name: "Northwind Traders" })).toHaveAttribute("href", "/departments/d-soc/social-reports/r1");
    // the run settles: the tally is said, the page refreshes once, and polling stops
    await act(async () => { await vi.advanceTimersByTimeAsync(RUN_POLL_MS + 10); });
    expect(await within(panel).findByText(/2 drafts ready, 1 skipped\./)).toBeInTheDocument();
    expect(within(panel).getByRole("link", { name: "Harborlight Hotel" })).toHaveAttribute("href", "/departments/d-soc/social-reports/r2");
    expect(within(panel).getByText(/from the plain template/)).toBeInTheDocument();
    expect(within(panel).getAllByRole("img", { name: "Simulated" })).toHaveLength(1);
    expect(nav.refresh).toHaveBeenCalledTimes(1);
    const calls = vi.mocked(readRun).mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(RUN_POLL_MS * 3); });
    expect(vi.mocked(readRun).mock.calls.length).toBe(calls); // stopped
    expect(vi.mocked(readRun)).toHaveBeenCalledWith("run1");
  });
  it("follows the run already going instead of refusing, taking its id from the 409", async () => {
    vi.mocked(startRun).mockResolvedValue(refused(409, "generation_running", { detail: { runId: "run-going" } }));
    vi.mocked(readRun).mockResolvedValue({ ok: true, run: run({ runId: "run-going", status: "done", done: 1, total: 1, results: [] }) });
    mount();
    press("Generate with AI");
    expect(await screen.findByText(/already going\. Its progress is shown below/)).toBeInTheDocument();
    await waitFor(() => expect(readRun).toHaveBeenCalledWith("run-going"));
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("says any other refusal of the run in words: a period not over, who may generate", async () => {
    vi.mocked(startRun).mockResolvedValueOnce(refused(400, "period_not_over"));
    mount();
    press("Generate with AI");
    expect(await screen.findByText(/not over yet, so its numbers are not final/)).toBeInTheDocument();
    vi.mocked(startRun).mockResolvedValueOnce(refused(403, "not authorized: cerbos denied create on social_report"));
    press("Generate with AI");
    expect(await screen.findByText(/officer drafts for their own clients/)).toBeInTheDocument();
    expect(readRun).not.toHaveBeenCalled();
  });
  it("a failed run keeps its results and says it stopped", async () => {
    vi.mocked(startRun).mockResolvedValue({ ok: true, run: { runId: "run1", kind: "weekly", period: "2026-W41", total: 2 } });
    vi.mocked(readRun).mockResolvedValue({ ok: true, run: run({ status: "failed", total: 2, done: 1, results: [{ engagementId: "e1", clientName: "Northwind Traders", status: "failed", reason: "requester_inactive" }] }) });
    mount();
    press("Generate with AI");
    const panel = await screen.findByRole("region", { name: "Run progress" });
    expect(await within(panel).findByText(/The run could not go on; the results so far are kept\./)).toBeInTheDocument();
    expect(within(panel).getByText(/no longer active/)).toBeInTheDocument();
  });
  it("the Generate button is disabled while a run goes, so a second click cannot start another", async () => {
    vi.mocked(startRun).mockResolvedValue({ ok: true, run: { runId: "run1", kind: "weekly", period: "2026-W41", total: 3 } });
    vi.mocked(readRun).mockResolvedValue({ ok: true, run: run() });
    mount();
    press("Generate with AI");
    await screen.findByRole("region", { name: "Run progress" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Generate with AI" })).toBeDisabled());
  });
});

describe("a run named in ?run=", () => {
  it("is followed on load without being started here, its progress panel labelled for the keyboard and for a screen reader", async () => {
    vi.mocked(readRun).mockResolvedValue({ ok: true, run: run({ runId: "demo-sched-run-1", status: "done", done: 1, total: 1, results: [{ engagementId: "e1", clientName: "Northwind Traders", reportId: "r1", status: "existing" }] }) });
    mount({ followRunId: "demo-sched-run-1" });
    await waitFor(() => expect(readRun).toHaveBeenCalledWith("demo-sched-run-1"));
    expect(startRun).not.toHaveBeenCalled();
    const panel = await screen.findByRole("region", { name: "Run progress" });
    expect(await within(panel).findByText(/Already had one/)).toBeInTheDocument();
    expect(within(panel).getByRole("progressbar", { name: "Clients done" })).toBeInTheDocument();
    expect(within(panel).getByRole("list", { name: "Results by client" })).toBeInTheDocument();
  });
  it("says a run that is gone or not the person's, and stops asking", async () => {
    vi.mocked(readRun).mockResolvedValue(refused(404, "run_not_found"));
    mount({ followRunId: "nope" });
    expect(await screen.findByText(/run was not found/)).toBeInTheDocument();
    const calls = vi.mocked(readRun).mock.calls.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(vi.mocked(readRun).mock.calls.length).toBe(calls);
  });
});

describe("the recent runs", () => {
  it("lists them with their tallies and shows one's results on request, and says when they could not be read", async () => {
    vi.mocked(readRun).mockResolvedValue({ ok: true, run: run({ runId: "old", status: "done", done: 1, total: 1, results: [{ engagementId: "e1", clientName: "Northwind Traders", reportId: "r1", status: "created", draftedVia: "ai" }] }) });
    const a = mount({ runs: [{ runId: "old", kind: "weekly", period: "2026-W40", status: "done", total: 1, done: 1, counts: { created: 1, existing: 0, skipped: 0, failed: 0 }, trigger: "person", createdAt: null, finishedAt: null }] });
    expect(screen.getByText("Recent runs (1)")).toBeInTheDocument();
    expect(screen.getByText(/Finished: 1 draft ready\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Show the results of the Weekly report, Week 40, 2026/ }));
    await waitFor(() => expect(readRun).toHaveBeenCalledWith("old"));
    a.unmount();
    mount({ runs: null });
    expect(screen.getByText(/recent runs could not be read just now/)).toBeInTheDocument();
  });
});
