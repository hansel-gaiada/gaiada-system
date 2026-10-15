import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { PortalReport } from "@/lib/portal";

// PV7-04b — the portal Reports page, rendered as the server renders it. Pins: the list is the backend's (newest first, not
// re-sorted, and only what it returned: a project-scoped contact's list simply has no client-wide report), each row says its
// title, period, project or "Whole account" and published date, the New marker is the server's `readAt === null`, the
// download label follows the FILE's content type (never hard-coded PDF), and a failed read is never shown as "no reports".

vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => { throw new Error("redirect"); }),
  notFound: vi.fn(() => { throw new Error("notFound"); }),
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-client") }));
vi.mock("@/lib/platform", () => ({ getMe: vi.fn(async () => ({ userId: "u-client" })) }));
vi.mock("@/lib/portal-company", () => ({ getActivePortalCompany: vi.fn(async () => ({ id: "northwind" })) }));
vi.mock("@/lib/portal-data", () => ({ listPortalReports: vi.fn() }));
vi.mock("@/lib/portalActions", () => ({ markPortalReportRead: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/components/portal/PortalLive", () => ({ PortalLive: ({ topics }: { topics?: string[] }) => <span data-testid="live" data-topics={(topics ?? []).join(",")} /> }));

import { getActivePortalCompany } from "@/lib/portal-company";
import { listPortalReports } from "@/lib/portal-data";
import PortalReportsPage from "./page";

const listMock = vi.mocked(listPortalReports);
const mount = async (items: PortalReport[] | null) => {
  listMock.mockResolvedValue(items);
  render(await PortalReportsPage());
};

const rep = (over: Partial<PortalReport> & { id: string }): PortalReport => ({
  title: "Social media performance, September 2026", source: "social_report",
  periodStart: "2026-09-01", periodEnd: "2026-09-30", clientId: "cl-1", clientName: "Northwind Traders",
  projectId: null, projectName: null, publishedAt: "2026-10-12T08:00:00Z",
  file: { id: `f-${over.id}`, filename: "report.pdf", contentType: "application/pdf", byteSize: 1000 },
  readAt: null, ...over,
});

const REPORTS: PortalReport[] = [
  rep({ id: "r1" }),
  rep({
    id: "r2", title: "Search performance, August 2026", source: "search_report", periodStart: "2026-08-01", periodEnd: "2026-08-31",
    projectId: "p1", projectName: "Website relaunch", publishedAt: "2026-10-03T08:00:00Z",
    file: { id: "f-r2", filename: "search.md", contentType: "text/markdown", byteSize: 500 }, readAt: "2026-10-04T08:00:00Z",
  }),
];

beforeEach(() => { listMock.mockReset(); });

describe("portal Reports page", () => {
  it("has one h1, Reports, and refreshes on the reports topic", async () => {
    await mount(REPORTS);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "Reports" })).toBeInTheDocument();
    expect(screen.getByTestId("live")).toHaveAttribute("data-topics", "reports");
  });

  it("lists every report in the backend's order with title, readable period, project or Whole account, and published date", async () => {
    await mount(REPORTS);
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Social media performance, September 2026");
    expect(rows[0]).toHaveTextContent(/01 Sept? 2026 to 30 Sept? 2026/)  // "Sept" in newer ICU builds;
    expect(rows[0]).toHaveTextContent("Whole account");
    expect(rows[0]).toHaveTextContent("Published 12 Oct 2026");
    expect(rows[1]).toHaveTextContent("Search performance, August 2026");
    expect(rows[1]).toHaveTextContent("Website relaunch");
    expect(rows[1]).toHaveTextContent("Published 03 Oct 2026");
    // The row is the link target of the deliverables' "Open report" (`/portal/reports#<id>`).
    expect(rows[0]).toHaveAttribute("id", "r1");
    expect(rows[1]).toHaveAttribute("id", "r2");
  });

  it("marks a report New only when this user has not opened it (readAt null)", async () => {
    await mount(REPORTS);
    const rows = screen.getAllByRole("listitem");
    expect(within(rows[0]).getByText("New")).toBeInTheDocument();
    expect(within(rows[1]).queryByText("New")).toBeNull();
  });

  it("labels each download from the file's content type, and links the portal's own file route", async () => {
    await mount([...REPORTS, rep({ id: "r3", file: { id: "f-r3", filename: "x.bin", contentType: "application/octet-stream", byteSize: 1 }, readAt: "2026-10-05T00:00:00Z" })]);
    const rows = screen.getAllByRole("listitem");
    const link = (i: number) => within(rows[i]).getByRole("link");
    expect(link(0)).toHaveTextContent("Download PDF");
    expect(link(1)).toHaveTextContent("Download (Markdown)");
    expect(link(2)).toHaveTextContent(/^Download →$/);
    expect(link(0)).toHaveAttribute("href", "/api/northwind/portal/files/f-r1");
    expect(link(1)).toHaveAttribute("href", "/api/northwind/portal/files/f-r2");
  });

  it("a project-scoped contact's list shows only the project's report: nothing is added or re-derived here", async () => {
    await mount([REPORTS[1]]);
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.queryByText("Whole account")).toBeNull();
    expect(screen.queryByText(/Social media performance/)).toBeNull();
  });

  it("an empty list says no report has been published yet", async () => {
    await mount([]);
    expect(screen.getByText("No reports have been published yet.")).toBeInTheDocument();
    expect(screen.queryByRole("listitem")).toBeNull();
  });

  it("a failed read says it could not load, and is never the empty state", async () => {
    await mount(null);
    expect(screen.getByText(/Reports could not be loaded/)).toBeInTheDocument();
    expect(screen.queryByText("No reports have been published yet.")).toBeNull();
  });

  it("with no linked client account it explains instead of listing", async () => {
    vi.mocked(getActivePortalCompany).mockResolvedValueOnce(null as never);
    render(await PortalReportsPage());
    expect(screen.getByText(/No client account is linked/)).toBeInTheDocument();
    expect(listMock).not.toHaveBeenCalled();
  });
});
