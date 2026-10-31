import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";

// SCP-5a (BFF §63.18, §63.17), SCP-5 W5-A4 (§63.24.7): the Social reports list. Server page: the readers are mocked, the element tree is rendered. The list draws the server's `GET reports` of the chosen
// KIND (state, notes or summary flag, due day, SIMULATED mark, filters as links), the kind switch shows only the kinds the company has on, "Generate with AI" follows the person's clients and `?run=`; a
// refused read is "no access" and a failed one is "cannot tell", never an empty list; the page belongs to the Social Media workspace only.
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((to: string) => { throw new Error(`redirect:${to}`); }),
  notFound: vi.fn(() => { throw new Error("notFound"); }),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("@/lib/platform", async (orig) => ({
  ...(await orig<typeof import("@/lib/platform")>()),
  getMe: vi.fn(async () => ({ userId: "u-1", roles: [], companies: [{ id: "co-a", vertical: "agency" }] })),
}));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-a") }));
vi.mock("@/lib/companyContext", () => ({ activeCompany: vi.fn(() => ({ id: "co-a", vertical: "agency" })) }));
vi.mock("@/lib/departments", () => ({ getDepartmentNode: vi.fn() }));
vi.mock("@/lib/socialReports-data", () => ({ getSocialReports: vi.fn(), getReportRules: vi.fn(), getReportRuns: vi.fn() }));
vi.mock("@/lib/socialAllocation-data", () => ({ getAllocation: vi.fn() }));
vi.mock("@/lib/socialReportsActions", () => ({
  draftReport: vi.fn(), startRun: vi.fn(),
  readRun: vi.fn(async () => ({ ok: false, refusal: { status: 404, error: "run_not_found" }, message: "That run was not found." })),
}));

import { getSessionUserId } from "@/lib/session-server";
import { getDepartmentNode } from "@/lib/departments";
import { getReportRules, getReportRuns, getSocialReports } from "@/lib/socialReports-data";
import { getAllocation } from "@/lib/socialAllocation-data";
import { readRun } from "@/lib/socialReportsActions";
import { asReportList, type SocialReportRow } from "@/lib/socialReports";
import { asReportRules } from "@/lib/socialReportKinds";
import defaults from "@/lib/socialRulesDefaults.json";
import SocialReportsPage from "./page";

const row = (over: Record<string, unknown> = {}) => ({
  id: "r1", engagementId: "e1", clientName: "Northwind Traders", period: "2026-09", kind: "monthly", status: "in_review", createdAt: "2026-10-02T04:00:00Z", approvedAt: null, deliveredAt: null,
  notesComplete: true, simulated: false, ...over,
});
const rows = (...r: Array<Record<string, unknown>>): SocialReportRow[] => asReportList({ reports: r });
const okList = (data: SocialReportRow[]) => ({ kind: "ok" as const, data });
const rulesWith = (edit: (r: { reports: { kinds: Record<string, { enabled: boolean }> } }) => void) => {
  const rules = JSON.parse(JSON.stringify(defaults));
  edit(rules);
  return { kind: "ok" as const, data: asReportRules({ rules }) };
};
const mount = async (search: Record<string, string> = {}, deptId = "d-soc") =>
  render(await SocialReportsPage({ params: Promise.resolve({ deptId }), searchParams: Promise.resolve(search) }));
const alloc = (...r: Array<Record<string, unknown>>) => ({ kind: "ok" as const, data: r as never });

beforeEach(() => {
  vi.mocked(getSessionUserId).mockReset().mockResolvedValue("u-1");
  vi.mocked(getDepartmentNode).mockReset().mockResolvedValue({ id: "d-soc", name: "Social Media" } as never);
  vi.mocked(getSocialReports).mockReset().mockResolvedValue(okList(rows(row(), row({ id: "r2", clientName: "Harborlight Hotel", status: "draft", notesComplete: false, simulated: true }))));
  vi.mocked(getAllocation).mockReset().mockResolvedValue({ kind: "ok", data: [] });
  vi.mocked(getReportRules).mockReset().mockResolvedValue({ kind: "ok", data: asReportRules({ rules: defaults }) });
  vi.mocked(getReportRuns).mockReset().mockResolvedValue({ kind: "ok", data: [] });
  vi.mocked(readRun).mockClear();
});

describe("what is asked of the platform", () => {
  it("reads the list for the signed-in person in the active company, with the filters from the query and the kind the company has on", async () => {
    await mount({ status: "in_review", period: "2026-09" });
    // no kind in the query: the monthly report
    expect(getSocialReports).toHaveBeenCalledWith("u-1", "co-a", { status: "in_review", period: "2026-09", kind: "monthly" });
    expect(getAllocation).toHaveBeenCalledWith("u-1", "co-a");
    expect(getReportRules).toHaveBeenCalledWith("u-1", "co-a");
  });
  it("ignores a filter that is not one, so a mistyped link shows the whole list", async () => {
    await mount({ status: "sent", period: "soon" });
    expect(getSocialReports).toHaveBeenCalledWith("u-1", "co-a", { status: null, period: null, kind: "monthly" });
  });
  it("sends a signed-out person to sign in", async () => {
    vi.mocked(getSessionUserId).mockResolvedValue(null as never);
    await expect(mount()).rejects.toThrow("redirect:/login");
  });
  it("is not found for a department that is not Social Media, or that does not exist, without reading anything", async () => {
    vi.mocked(getDepartmentNode).mockResolvedValue({ id: "d-web", name: "Web Dev" } as never);
    await expect(mount({}, "d-web")).rejects.toThrow("notFound");
    vi.mocked(getDepartmentNode).mockResolvedValue(null as never);
    await expect(mount({}, "nope")).rejects.toThrow("notFound");
    expect(getSocialReports).not.toHaveBeenCalled();
  });
});

describe("the list", () => {
  it("is titled Social reports and draws each report with its period, state, notes flag and link", async () => {
    await mount();
    expect(screen.getByRole("heading", { name: "Social reports" })).toBeInTheDocument();
    const table = screen.getByRole("table");
    const north = within(table).getByRole("link", { name: "Northwind Traders" }).closest("tr")!;
    expect(north).toHaveTextContent("September 2026");
    expect(north).toHaveTextContent("HoD check");
    expect(north).toHaveTextContent("Complete");
    expect(within(table).getByRole("link", { name: "Northwind Traders" })).toHaveAttribute("href", "/departments/d-soc/social-reports/r1");
    const hotel = within(table).getByRole("link", { name: "Harborlight Hotel" }).closest("tr")!;
    expect(hotel).toHaveTextContent("Draft · notes incomplete");
    expect(hotel).toHaveTextContent("Incomplete");
  });
  it("marks a simulated report, and only that one", async () => {
    await mount();
    const marks = screen.getAllByRole("img", { name: "Simulated" });
    expect(marks).toHaveLength(1);
    expect(marks[0].closest("tr")).toHaveTextContent("Harborlight Hotel");
  });
  it("filters by status through links that keep the kind and the period", async () => {
    await mount({ period: "2026-09" });
    const status = screen.getByRole("group", { name: "Status" });
    expect(within(status).getByRole("link", { name: "Ready" })).toHaveAttribute("href", "/departments/d-soc/social-reports?kind=monthly&status=approved&period=2026-09");
    expect(within(status).getByRole("link", { name: "All" })).toHaveAttribute("href", "/departments/d-soc/social-reports?kind=monthly&period=2026-09");
  });
  it("says so when a filter matches nothing, and offers the whole list, never a blank page", async () => {
    vi.mocked(getSocialReports).mockResolvedValue(okList([]));
    await mount({ status: "delivered" });
    expect(screen.getByRole("status")).toHaveTextContent("No report matches this filter.");
    expect(screen.getByRole("link", { name: "Show every report of this kind" })).toHaveAttribute("href", "/departments/d-soc/social-reports?kind=monthly");
  });
  it("says a read that SUCCEEDED with nothing is empty, in the officer's words", async () => {
    vi.mocked(getSocialReports).mockResolvedValue(okList([]));
    await mount();
    expect(screen.getByRole("status")).toHaveTextContent("No client has a monthly report yet.");
  });
  it("a refused read is no access and a failed one is cannot tell, never an empty list", async () => {
    vi.mocked(getSocialReports).mockResolvedValue({ kind: "forbidden" });
    const a = await mount();
    expect(a.container.textContent).toMatch(/Social reports/);
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText(/No client has a monthly report yet/)).toBeNull();
    a.unmount();
    vi.mocked(getSocialReports).mockResolvedValue({ kind: "unavailable", reason: "the module is off" });
    await mount();
    expect(screen.getByText(/the module is off/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText(/No client has a monthly report yet/)).toBeNull();
  });
});

describe("the kind switch and the period picker", () => {
  it("offers the seven kinds the company has on, with the chosen one marked and the others as links that keep the status", async () => {
    await mount({ status: "draft" });
    const nav = screen.getByRole("navigation", { name: "Kind of report" });
    expect(within(nav).getAllByRole("link").map((a) => a.textContent)).toEqual(["Daily", "Weekly", "Monthly", "Quarterly", "Half-year", "Yearly", "Other"]);
    expect(within(nav).getByRole("link", { name: "Monthly" })).toHaveAttribute("aria-current", "true");
    expect(within(nav).getByRole("link", { name: "Weekly" })).toHaveAttribute("href", "/departments/d-soc/social-reports?kind=weekly&status=draft");
  });
  it("shows only the kinds the company has on", async () => {
    vi.mocked(getReportRules).mockResolvedValue(rulesWith((r) => { r.reports.kinds.daily.enabled = false; r.reports.kinds.yearly.enabled = false; }));
    await mount();
    expect(within(screen.getByRole("navigation", { name: "Kind of report" })).getAllByRole("link").map((a) => a.textContent)).toEqual(["Weekly", "Monthly", "Quarterly", "Half-year", "Other"]);
  });
  it("a kind the company has off falls back to the monthly report", async () => {
    vi.mocked(getReportRules).mockResolvedValue(rulesWith((r) => { r.reports.kinds.weekly.enabled = false; }));
    await mount({ kind: "weekly" });
    expect(getSocialReports).toHaveBeenCalledWith("u-1", "co-a", expect.objectContaining({ kind: "monthly" }));
  });
  it("asks the server for the chosen kind and period, and draws a weekly list with its summary and due columns", async () => {
    vi.mocked(getSocialReports).mockResolvedValue(okList(rows(row({ id: "w1", kind: "weekly", period: "2026-W45", status: "draft", summaryPresent: false, notesComplete: true, due: "2026-11-10", live: true }))));
    await mount({ kind: "weekly", period: "2026-W45" });
    expect(getSocialReports).toHaveBeenCalledWith("u-1", "co-a", { status: null, period: "2026-W45", kind: "weekly" });
    const table = screen.getByRole("table");
    expect(within(table).getByRole("columnheader", { name: "Summary" })).toBeInTheDocument();
    const r = within(table).getByRole("link", { name: "Northwind Traders" }).closest("tr")!;
    expect(r).toHaveTextContent("Week 45, 2026 (2 to 8 Nov 2026) · live");
    expect(r).toHaveTextContent("Draft · no summary");
    expect(r).toHaveTextContent("Not written");
    expect(r).toHaveTextContent("10 Nov 2026");
    // the period picker offers the kind's recent weeks and "Any period", and keeps the chosen one
    const picker = screen.getByRole("combobox", { name: "Period" });
    expect(within(picker).getByRole("option", { name: "Any period" })).toBeInTheDocument();
    expect((picker as HTMLSelectElement).value).toBe("2026-W45");
  });
  it("Other lists the campaign and ad hoc reports only, and has no period picker", async () => {
    vi.mocked(getSocialReports).mockResolvedValue(okList(rows(row({ id: "c1", kind: "campaign", clientName: "Campaign Co" }), row({ id: "m1" }))));
    await mount({ kind: "other" });
    expect(getSocialReports).toHaveBeenCalledWith("u-1", "co-a", expect.objectContaining({ kind: null }));
    expect(screen.getByRole("link", { name: "Campaign Co" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Northwind Traders" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Period" })).toBeNull();
  });
  it("a rules read that failed offers the monthly report and Other only, and says so", async () => {
    vi.mocked(getReportRules).mockResolvedValue({ kind: "unavailable", reason: "timeout" });
    await mount();
    expect(within(screen.getByRole("navigation", { name: "Kind of report" })).getAllByRole("link").map((a) => a.textContent)).toEqual(["Monthly", "Other"]);
    expect(screen.getByText(/report kinds could not be read/)).toBeInTheDocument();
  });
});

describe("Generate with AI", () => {
  it("is drawn for an officer with their own clients only, with 'All my clients' first, and the periods of the kind", async () => {
    vi.mocked(getAllocation).mockResolvedValue(alloc(
      { engagementId: "e1", clientName: "Northwind Traders", status: "active", officer: { id: "u-1", name: "Me" }, canPlan: false },
      { engagementId: "e2", clientName: "Someone Else's Client", status: "active", officer: { id: "u-2", name: "Other" }, canPlan: false },
      { engagementId: "e9", clientName: "Closed Co", status: "closed", officer: { id: "u-1", name: "Me" }, canPlan: false },
    ));
    await mount();
    const form = screen.getByRole("form", { name: /Generate monthly reports with AI/ });
    expect(within(form).getAllByRole("option").slice(0, 2).map((o) => o.textContent)).toEqual(["All my clients", "Northwind Traders"]);
    expect(within(form).queryByRole("option", { name: "Someone Else's Client" })).toBeNull();
    expect(within(form).queryByRole("option", { name: "Closed Co" })).toBeNull();
    expect(within(form).getByRole("button", { name: "Generate with AI" })).toBeInTheDocument();
  });
  it("says 'All clients' for the four approvers (the allocation read's canPlan), and lists every open client", async () => {
    vi.mocked(getAllocation).mockResolvedValue(alloc(
      { engagementId: "e1", clientName: "Northwind Traders", status: "active", officer: { id: "u-2", name: "Other" }, canPlan: true },
      { engagementId: "e2", clientName: "Harborlight Hotel", status: "active", officer: null, canPlan: true },
    ));
    await mount({ kind: "weekly" });
    const form = screen.getByRole("form", { name: /Generate weekly reports with AI/ });
    expect(within(form).getAllByRole("option").slice(0, 3).map((o) => o.textContent)).toEqual(["All clients", "Northwind Traders", "Harborlight Hotel"]);
  });
  it("is not drawn for a person with no clients and no recent runs, and a failed read of the clients says so without hiding the list", async () => {
    const a = await mount();
    expect(screen.queryByRole("form", { name: /Generate/ })).toBeNull();
    expect(screen.getByRole("table")).toBeInTheDocument();
    a.unmount();
    vi.mocked(getAllocation).mockResolvedValue({ kind: "unavailable", reason: "timeout" });
    await mount();
    expect(screen.getByText(/Your clients could not be read, so the Generate with AI bar is hidden/)).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
  });
  it("opens the run in `?run=` on load, a run this page did not start included, and says when its progress cannot be read", async () => {
    await mount({ kind: "weekly", run: "demo-sched-run-1" });
    await waitFor(() => expect(readRun).toHaveBeenCalledWith("demo-sched-run-1"));
    expect(await screen.findByText(/run was not found/)).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Run progress" })).toBeInTheDocument();
  });
  it("a run link works even on Other and without a clients read, so a link to a run never lands on a blank page", async () => {
    vi.mocked(getAllocation).mockResolvedValue({ kind: "unavailable", reason: "timeout" });
    await mount({ kind: "other", run: "r-9" });
    expect(screen.getByRole("region", { name: "Run progress" })).toBeInTheDocument();
  });
  it("lists the recent runs with their tallies", async () => {
    vi.mocked(getAllocation).mockResolvedValue(alloc({ engagementId: "e1", clientName: "Northwind Traders", status: "active", officer: { id: "u-1", name: "Me" }, canPlan: false }));
    vi.mocked(getReportRuns).mockResolvedValue({ kind: "ok", data: [{ runId: "run1", kind: "weekly", period: "2026-W41", status: "done", total: 3, done: 3, counts: { created: 2, existing: 0, skipped: 1, failed: 0 }, trigger: "person", createdAt: null, finishedAt: null }] });
    await mount();
    expect(screen.getByText("Recent runs (1)")).toBeInTheDocument();
    expect(screen.getByText(/Finished: 2 drafts ready, 1 skipped\./)).toBeInTheDocument();
  });
});
