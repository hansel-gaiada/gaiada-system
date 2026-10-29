import { describe, it, expect, vi, beforeEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Me } from "@/lib/platform";
import type { ReportOverview } from "@/lib/reports-data";

// DW-4k — the Team page is a roster, not a document: it offers Print and a link to the department report for the same unit
// and period, and NO export of its own (the server builds none).
vi.mock("next/navigation", () => ({ redirect: vi.fn(() => { throw new Error("redirect"); }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a>,
}));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-head") }));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-1") }));
vi.mock("@/lib/platform", async () => {
  const actual = await vi.importActual<typeof import("@/lib/platform")>("@/lib/platform");
  return { ...actual, getMe: vi.fn() };
});
vi.mock("@/lib/reports-data", async () => {
  const actual = await vi.importActual<typeof import("@/lib/reports-data")>("@/lib/reports-data");
  return { ...actual, getReportOverview: vi.fn() };
});
// SCP-5d: the Social Media block's reads. The page is shared by every department, so these are only what the block needs to decide whether to draw.
vi.mock("@/lib/departments", () => ({ getDepartment: vi.fn() }));
vi.mock("@/lib/companyContext", () => ({ activeCompany: vi.fn(() => ({ id: "co-1", vertical: "agency" })) }));
vi.mock("@/lib/socialTeam-data", () => ({ getTeamDashboard: vi.fn() }));
// The period bar is a client component wired to the router; it is not what is under test.
vi.mock("@/components/reports/ReportPeriodBar", () => ({ ReportPeriodBar: () => <div data-testid="period-bar" /> }));

import { getMe, PlatformError } from "@/lib/platform";
import { getReportOverview } from "@/lib/reports-data";
import { getDepartment } from "@/lib/departments";
import { getTeamDashboard } from "@/lib/socialTeam-data";
import { asTeamDashboard } from "@/lib/socialTeam";
import TeamReportPage from "./page";

const ME: Me = { userId: "u-head", name: "Head", email: "h@example.test", title: null, assurance: "high", companies: [{ id: "co-1", name: "Example", type: null }], roles: [] };
const overviewMock = vi.mocked(getReportOverview);

const ROSTER: ReportOverview = {
  periodKind: "month", start: "2026-07-01", end: "2026-07-31", unit: "dept-1",
  scopes: [{ scopeRef: "u-dev", scopeName: "Made Putra", kpis: [{ metricKey: "delivery.completed", label: "Completed", unit: "count", value: 12, appraisalSafe: true }], activity: true }],
};

const mount = async (sp: { unit?: string; periodKind?: string; start?: string; end?: string }) => {
  vi.mocked(getMe).mockResolvedValue(ME);
  return render(await TeamReportPage({ searchParams: Promise.resolve(sp) }));
};

const dept = vi.mocked(getDepartment);
const teamRead = vi.mocked(getTeamDashboard);
const dashboardOf = (n: number) => asTeamDashboard({
  month: "2026-10", needsAttention: Array.from({ length: n }, (_, i) => ({ kind: i === 0 ? "late" : "blocked", postId: `p-${i}`, engagementId: "e-1", clientName: "Northwind Traders", since: "2026-10-05" })),
  clients: [], workload: [], waits: [], stepAverages: [], estimatesNotSet: [], personRowsLimited: false, partial: [],
});

beforeEach(() => {
  overviewMock.mockReset();
  dept.mockReset().mockResolvedValue({ id: "dept-1", name: "Web Dev" } as never);
  teamRead.mockReset().mockResolvedValue({ kind: "ok", data: dashboardOf(3) });
});

describe("Team report page · print and export (DW-4k)", () => {
  it("with a unit: offers Print and a link to the department report for the same unit and period, and no export of its own", async () => {
    overviewMock.mockResolvedValue(ROSTER);
    await mount({ unit: "dept-1", periodKind: "month", start: "2026-07-01" });
    expect(screen.getByRole("button", { name: "Print this report" })).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Export the department report" });
    expect(link).toHaveAttribute("href", "/reports/department?periodKind=month&start=2026-07-01&end=2026-07-31&scopeRef=dept-1");
    expect(screen.queryByRole("button", { name: /Export this report as/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /export/i })).not.toBeInTheDocument();
  });

  it("the printed copy states the period as text (the period bar does not print)", async () => {
    overviewMock.mockResolvedValue(ROSTER);
    const { container } = await mount({ unit: "dept-1", periodKind: "month", start: "2026-07-01" });
    expect(container.querySelector(".rp-printonly")).toHaveTextContent("July 2026");
  });

  it("the department picker (no unit) offers Print and no export link", async () => {
    overviewMock.mockResolvedValue({ periodKind: "month", start: "2026-07-01", end: "2026-07-31", scopes: [{ scopeRef: "dept-1", scopeName: "Web Dev", kpis: [] }] });
    await mount({});
    expect(screen.getByRole("button", { name: "Print this report" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Export the department report" })).not.toBeInTheDocument();
  });

  it("a refused read shows neither Print nor the export link", async () => {
    overviewMock.mockRejectedValue(new PlatformError(403, "forbidden"));
    await mount({ unit: "dept-1" });
    expect(screen.queryByRole("button", { name: /Print/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Export the department report" })).not.toBeInTheDocument();
  });
});

// SCP-5d (BFF §63.19): the Social Media Team dashboard's block sits on this page for the Social Media unit only, and never changes the rest of the page.
describe("Team report page · the Social Media Team dashboard block (SCP-5d)", () => {
  const social = () => dept.mockResolvedValue({ id: "dept-soc", name: "Social Media" } as never);
  const block = () => screen.queryByTestId("social-team-block");

  it("draws the block for the Social Media unit, above the roster, with a link to the full dashboard", async () => {
    social();
    overviewMock.mockResolvedValue(ROSTER);
    await mount({ unit: "dept-soc", periodKind: "month", start: "2026-07-01" });
    expect(dept).toHaveBeenCalledWith("u-head", "co-1", "dept-soc");
    expect(block()).toHaveTextContent("3 items need attention");
    expect(screen.getByRole("link", { name: "Open the Team dashboard" }).getAttribute("href")).toMatch(/^\/departments\/dept-soc\/dashboard/);
    // The roster is still there, after the block.
    const roster = screen.getByText("Made Putra");
    expect(block()!.compareDocumentPosition(roster) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("hides the block on a 403 (not one of the four) and on a failed read, and the rest of the page is as it was", async () => {
    social();
    overviewMock.mockResolvedValue(ROSTER);
    const withBlock = await mount({ unit: "dept-soc", periodKind: "month", start: "2026-07-01" });
    const shown = withBlock.container.innerHTML;
    withBlock.unmount();
    for (const refusal of [{ kind: "forbidden" }, { kind: "unavailable", reason: "503" }] as const) {
      teamRead.mockResolvedValue(refusal);
      const { container, unmount } = await mount({ unit: "dept-soc", periodKind: "month", start: "2026-07-01" });
      expect(block()).not.toBeInTheDocument();
      expect(screen.getByText("Made Putra")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Export the department report" })).toBeInTheDocument();
      // Removing the block's own markup from the drawn page leaves exactly what a refusal draws.
      const blockHtml = shown.slice(shown.indexOf('<section class="std-block"'), shown.indexOf("</section>", shown.indexOf('<section class="std-block"')) + "</section>".length);
      expect(shown.replace(blockHtml, "")).toBe(container.innerHTML);
      unmount();
    }
  });

  it("never reads the dashboard for another unit, and renders it exactly as before: the same markup as a Social unit that was refused", async () => {
    overviewMock.mockResolvedValue(ROSTER);
    const { container } = await mount({ unit: "dept-1", periodKind: "month", start: "2026-07-01" });
    expect(teamRead).not.toHaveBeenCalled();
    expect(block()).not.toBeInTheDocument();
    expect(container.querySelector(".std-block")).toBeNull();
    const web = container.innerHTML;
    cleanup();
    social();
    teamRead.mockResolvedValue({ kind: "forbidden" });
    const refused = await mount({ unit: "dept-1", periodKind: "month", start: "2026-07-01" });
    expect(refused.container.innerHTML).toBe(web);
  });

  it("does not draw it on the department picker (no unit), and does not break the page when the department lookup fails", async () => {
    overviewMock.mockResolvedValue({ periodKind: "month", start: "2026-07-01", end: "2026-07-31", scopes: [{ scopeRef: "dept-soc", scopeName: "Social Media", kpis: [] }] });
    await mount({});
    expect(dept).not.toHaveBeenCalled();
    expect(block()).not.toBeInTheDocument();
    cleanup();
    dept.mockRejectedValue(new Error("platform down"));
    overviewMock.mockResolvedValue(ROSTER);
    await mount({ unit: "dept-1", periodKind: "month", start: "2026-07-01" });
    expect(block()).not.toBeInTheDocument();
    expect(screen.getByText("Made Putra")).toBeInTheDocument();
  });

  it("a refused roster read (403) still shows the page's own refusal, and no block", async () => {
    social();
    overviewMock.mockRejectedValue(new PlatformError(403, "forbidden"));
    await mount({ unit: "dept-soc" });
    expect(block()).not.toBeInTheDocument();
    expect(teamRead).not.toHaveBeenCalled();
  });
});
