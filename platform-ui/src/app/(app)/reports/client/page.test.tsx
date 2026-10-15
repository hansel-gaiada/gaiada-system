import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// PV7-05 — /reports/client. Pinned: with no scopeRef it is a client picker over `reports/overview?grain=client` (each card
// opens `/reports/client?scopeRef=…`); with one it renders `ReportPageClient` (which carries Export and Print) for a CLIENT
// document; a 403 is the existing ReportAccessDenied, a too-large range is ReportRangeError, any other failure throws.

vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("@/lib/platform", () => ({ getMe: vi.fn(async () => ({ userId: "u-1", companies: [], roles: [] })), PlatformError: class extends Error {} }));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-1") }));
vi.mock("@/lib/reports-data", () => ({
  getReportDocument: vi.fn(), getReportOverview: vi.fn(),
  isForbidden: (e: unknown) => (e as { status?: number })?.status === 403,
  isRangeTooLarge: (e: unknown) => (e as { status?: number })?.status === 422,
}));
vi.mock("@/components/reports/ReportPageClient", () => ({
  ReportPageClient: ({ document, children }: { document: { header: { grain: string; scopeRef: string } }; children?: React.ReactNode }) => (
    <div data-testid="report" data-grain={document.header.grain} data-scope={document.header.scopeRef}>{children}</div>
  ),
}));
vi.mock("@/components/reports/GrainCharts", () => ({ ClientCharts: () => <div data-testid="client-charts" /> }));

import { getReportDocument, getReportOverview } from "@/lib/reports-data";
import ClientReportPage from "./page";

const err = (status: number) => Object.assign(new Error(String(status)), { status });
const mount = async (search: Record<string, string> = {}) => render(await ClientReportPage({ searchParams: Promise.resolve(search) }));

beforeEach(() => {
  vi.mocked(getReportDocument).mockReset();
  vi.mocked(getReportOverview).mockReset();
});

describe("/reports/client · the picker", () => {
  it("lists the clients of the overview, each opening its own report, from the client grain", async () => {
    vi.mocked(getReportOverview).mockResolvedValue({
      periodKind: "month", start: "2026-10-15", end: "2026-10-15",
      scopes: [
        { scopeRef: "c-acme", scopeName: "Acme Hospitality", kpis: [{ metricKey: "delivery.tasks_completed", label: "Tasks completed", unit: "count", value: 14 }] },
        { scopeRef: "c-sun", scopeName: "Sunrise Resorts", kpis: [] },
      ],
    } as never);
    await mount({ periodKind: "month", start: "2026-10-01", end: "2026-10-31" });
    expect(vi.mocked(getReportOverview)).toHaveBeenCalledWith("co-1", "u-1", { grain: "client", periodKind: "month", start: "2026-10-01", end: "2026-10-31" });
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    const links = screen.getAllByRole("link", { name: "View report" });
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
      "/reports/client?periodKind=month&start=2026-10-01&end=2026-10-31&scopeRef=c-acme",
      "/reports/client?periodKind=month&start=2026-10-01&end=2026-10-31&scopeRef=c-sun",
    ]);
    expect(screen.getByText("Acme Hospitality")).toBeTruthy();
  });

  it("says so when no client has report data, rather than drawing an empty grid", async () => {
    vi.mocked(getReportOverview).mockResolvedValue({ periodKind: "month", start: "a", end: "b", scopes: [] } as never);
    await mount();
    expect(screen.getByText(/No clients have report data yet/)).toBeTruthy();
  });

  it("a 403 on the picker is the existing access-denied state", async () => {
    vi.mocked(getReportOverview).mockRejectedValue(err(403));
    await mount();
    expect(screen.getByText(/do not have access to this client/)).toBeTruthy();
  });

  it("a range that is too large is the range error", async () => {
    vi.mocked(getReportOverview).mockRejectedValue(err(422));
    await mount({ start: "2020-01-01", end: "2026-10-15" });
    expect(screen.queryByRole("link", { name: "View report" })).toBeNull();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("any other failure is not swallowed", async () => {
    vi.mocked(getReportOverview).mockRejectedValue(err(500));
    await expect(mount()).rejects.toThrow("500");
  });
});

describe("/reports/client?scopeRef= · the report", () => {
  it("renders the client document through ReportPageClient (Export and Print live there), with a way to change client", async () => {
    vi.mocked(getReportDocument).mockResolvedValue({ header: { grain: "client", scopeRef: "c-acme", scopeName: "Acme Hospitality" } } as never);
    await mount({ scopeRef: "c-acme", periodKind: "month", start: "2026-10-01", end: "2026-10-31" });
    expect(vi.mocked(getReportDocument)).toHaveBeenCalledWith("co-1", "u-1", { grain: "client", scopeRef: "c-acme", periodKind: "month", start: "2026-10-01", end: "2026-10-31" });
    const report = screen.getByTestId("report");
    expect(report.getAttribute("data-grain")).toBe("client");
    expect(report.getAttribute("data-scope")).toBe("c-acme");
    expect(screen.getByTestId("client-charts")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Acme Hospitality");
    expect(screen.getByRole("link", { name: "Change client" }).getAttribute("href")).toBe("/reports/client");
  });

  it("🔴 a 403 is ReportAccessDenied, never a report and never a crash", async () => {
    vi.mocked(getReportDocument).mockRejectedValue(err(403));
    await mount({ scopeRef: "c-acme" });
    expect(screen.getByText(/do not have access to this client/)).toBeTruthy();
    expect(screen.queryByTestId("report")).toBeNull();
  });

  it("a too-large range is the range error", async () => {
    vi.mocked(getReportDocument).mockRejectedValue(err(422));
    await mount({ scopeRef: "c-acme", start: "2020-01-01", end: "2026-10-15" });
    expect(screen.queryByTestId("report")).toBeNull();
  });
});
