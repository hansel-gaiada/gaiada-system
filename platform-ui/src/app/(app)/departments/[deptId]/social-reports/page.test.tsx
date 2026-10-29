import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";

// SCP-5a (BFF §63.18, §63.17): the Social reports list and one report. Server pages: the readers are mocked, the element tree is rendered. The list draws the server's `GET reports`
// (state, notes flag, SIMULATED mark, filters as links, the officer's draft bar); a refused read is "no access" and a failed one is "cannot tell", never an empty list; both pages belong
// to the Social Media workspace only.
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
vi.mock("@/lib/departments", () => ({ getDepartment: vi.fn() }));
vi.mock("@/lib/socialReports-data", () => ({ getSocialReports: vi.fn() }));
vi.mock("@/lib/socialAllocation-data", () => ({ getAllocation: vi.fn() }));
vi.mock("@/lib/socialReportsActions", () => ({ draftMonthlyReport: vi.fn() }));

import { getSessionUserId } from "@/lib/session-server";
import { getDepartment } from "@/lib/departments";
import { getSocialReports } from "@/lib/socialReports-data";
import { getAllocation } from "@/lib/socialAllocation-data";
import { asReportList, type SocialReportRow } from "@/lib/socialReports";
import SocialReportsPage from "./page";

const row = (over: Record<string, unknown> = {}) => ({
  id: "r1", engagementId: "e1", clientName: "Northwind Traders", period: "2026-09", kind: "monthly", status: "in_review", createdAt: "2026-10-02T04:00:00Z", approvedAt: null, deliveredAt: null,
  notesComplete: true, simulated: false, ...over,
});
const rows = (...r: Array<Record<string, unknown>>): SocialReportRow[] => asReportList({ reports: r });
const okList = (data: SocialReportRow[]) => ({ kind: "ok" as const, data });
const mount = async (search: Record<string, string> = {}, deptId = "d-soc") =>
  render(await SocialReportsPage({ params: Promise.resolve({ deptId }), searchParams: Promise.resolve(search) }));

beforeEach(() => {
  vi.mocked(getSessionUserId).mockReset().mockResolvedValue("u-1");
  vi.mocked(getDepartment).mockReset().mockResolvedValue({ id: "d-soc", name: "Social Media" } as never);
  vi.mocked(getSocialReports).mockReset().mockResolvedValue(okList(rows(row(), row({ id: "r2", clientName: "Harborlight Hotel", status: "draft", notesComplete: false, simulated: true }))));
  vi.mocked(getAllocation).mockReset().mockResolvedValue({ kind: "ok", data: [] });
});

describe("what is asked of the platform", () => {
  it("reads the list for the signed-in person in the active company, with the filters from the query", async () => {
    await mount({ status: "in_review", period: "2026-09" });
    expect(getSocialReports).toHaveBeenCalledWith("u-1", "co-a", { status: "in_review", period: "2026-09" });
    expect(getAllocation).toHaveBeenCalledWith("u-1", "co-a", { mine: true });
  });
  it("ignores a filter that is not one, so a mistyped link shows the whole list", async () => {
    await mount({ status: "sent", period: "soon" });
    expect(getSocialReports).toHaveBeenCalledWith("u-1", "co-a", { status: null, period: null });
  });
  it("sends a signed-out person to sign in", async () => {
    vi.mocked(getSessionUserId).mockResolvedValue(null as never);
    await expect(mount()).rejects.toThrow("redirect:/login");
  });
  it("is not found for a department that is not Social Media, or that does not exist, without reading anything", async () => {
    vi.mocked(getDepartment).mockResolvedValue({ id: "d-web", name: "Web Dev" } as never);
    await expect(mount({}, "d-web")).rejects.toThrow("notFound");
    vi.mocked(getDepartment).mockResolvedValue(null as never);
    await expect(mount({}, "nope")).rejects.toThrow("notFound");
    expect(getSocialReports).not.toHaveBeenCalled();
  });
});

describe("the list", () => {
  it("is titled Social reports and draws each report with its month, state, notes flag and link", async () => {
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
  it("filters by status and by month through links that keep the other filter", async () => {
    await mount({ period: "2026-09" });
    const status = screen.getByRole("group", { name: "Status" });
    expect(within(status).getByRole("link", { name: "Ready" })).toHaveAttribute("href", "/departments/d-soc/social-reports?status=approved&period=2026-09");
    expect(within(status).getByRole("link", { name: "All" })).toHaveAttribute("href", "/departments/d-soc/social-reports?period=2026-09");
    const period = screen.getByRole("group", { name: "Period" });
    expect(within(period).getByRole("link", { name: "September 2026" })).toHaveAttribute("aria-current", "true");
    expect(within(period).getByRole("link", { name: "All" })).toHaveAttribute("href", "/departments/d-soc/social-reports");
  });
  it("says so when a filter matches nothing, and offers the whole list, never a blank page", async () => {
    vi.mocked(getSocialReports).mockResolvedValue(okList([]));
    await mount({ status: "delivered" });
    expect(screen.getByRole("status")).toHaveTextContent("No report matches this filter.");
    expect(screen.getByRole("link", { name: "Show every report" })).toHaveAttribute("href", "/departments/d-soc/social-reports");
  });
  it("says a read that SUCCEEDED with nothing is empty, in the officer's words", async () => {
    vi.mocked(getSocialReports).mockResolvedValue(okList([]));
    await mount();
    expect(screen.getByRole("status")).toHaveTextContent("No client has a report yet.");
  });
  it("a refused read is no access and a failed one is cannot tell, never an empty list", async () => {
    vi.mocked(getSocialReports).mockResolvedValue({ kind: "forbidden" });
    const a = await mount();
    expect(a.container.textContent).toMatch(/Social reports/);
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText(/No client has a report yet/)).toBeNull();
    a.unmount();
    vi.mocked(getSocialReports).mockResolvedValue({ kind: "unavailable", reason: "the module is off" });
    await mount();
    expect(screen.getByText(/the module is off/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText(/No client has a report yet/)).toBeNull();
  });
});

describe("Draft this month's report", () => {
  it("is drawn for an officer with clients, offering last month (due now) and this one", async () => {
    vi.mocked(getAllocation).mockResolvedValue({
      kind: "ok",
      data: [{ engagementId: "e1", clientName: "Northwind Traders", status: "active" }, { engagementId: "e9", clientName: "Closed Co", status: "closed" }] as never,
    });
    await mount();
    const form = screen.getByRole("form", { name: "Draft a monthly report" });
    expect(within(form).getByRole("button", { name: "Draft this month's report" })).toBeInTheDocument();
    expect(within(form).getAllByRole("option").map((o) => o.textContent)).toEqual(expect.arrayContaining(["Northwind Traders"]));
    expect(within(form).queryByRole("option", { name: "Closed Co" })).toBeNull();
    expect(within(form).getAllByRole("option").some((o) => /\(due now\)/.test(o.textContent ?? ""))).toBe(true);
  });
  it("is not drawn for a person with no clients, and a failed read of the clients says so without hiding the list", async () => {
    await mount();
    expect(screen.queryByRole("form", { name: "Draft a monthly report" })).toBeNull();
    expect(screen.getByRole("table")).toBeInTheDocument();
  });
  it("names a clients read that failed, and still draws the list", async () => {
    vi.mocked(getAllocation).mockResolvedValue({ kind: "unavailable", reason: "timeout" });
    await mount();
    expect(screen.getByText(/Your clients could not be read, so the draft bar is hidden/)).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
  });
});
