import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
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
// The period bar is a client component wired to the router; it is not what is under test.
vi.mock("@/components/reports/ReportPeriodBar", () => ({ ReportPeriodBar: () => <div data-testid="period-bar" /> }));

import { getMe, PlatformError } from "@/lib/platform";
import { getReportOverview } from "@/lib/reports-data";
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

beforeEach(() => { overviewMock.mockReset(); });

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
