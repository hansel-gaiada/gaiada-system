import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { PortalDeliverable } from "@/lib/portal";

// PV7-04b — the portal Deliverables page. Pins the new "Open report" link: a deliverable row the backend says a published,
// in-reach report links (`reportId`) points at that report's row on the Reports page; a row without one has no link.

vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => { throw new Error("redirect"); }),
  notFound: vi.fn(() => { throw new Error("notFound"); }),
}));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-client") }));
vi.mock("@/lib/platform", () => ({ getMe: vi.fn(async () => ({ userId: "u-client" })) }));
vi.mock("@/lib/portal-company", () => ({ getActivePortalCompany: vi.fn(async () => ({ id: "northwind" })) }));
vi.mock("@/lib/portal-data", () => ({ listPortalDeliverables: vi.fn() }));
vi.mock("@/components/portal/PortalLive", () => ({ PortalLive: ({ topics }: { topics?: string[] }) => <span data-testid="live" data-topics={(topics ?? []).join(",")} /> }));

import { listPortalDeliverables } from "@/lib/portal-data";
import PortalDeliverablesPage from "./page";

const listMock = vi.mocked(listPortalDeliverables);
const del = (over: Partial<PortalDeliverable> & { id: string; name: string }): PortalDeliverable => ({
  status: "delivered", dueDate: "2026-10-01", updatedAt: "2026-10-02T00:00:00Z", projectId: "p1", projectName: "Website relaunch", files: [], ...over,
});

beforeEach(() => { listMock.mockReset(); });

describe("portal Deliverables: Open report", () => {
  it("links a deliverable that carries a reportId to that report's row on the Reports page", async () => {
    listMock.mockResolvedValue([del({ id: "d1", name: "Search report", reportId: "rep-9" }), del({ id: "d2", name: "Homepage design" })]);
    render(await PortalDeliverablesPage());
    const links = screen.getAllByRole("link", { name: /Open report/ });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "/portal/reports#rep-9");
    // It sits with the deliverable it belongs to, not the other one.
    const d1 = screen.getByText("Search report").closest("div")!.parentElement!;
    expect(within(d1).getByRole("link", { name: /Open report/ })).toBeInTheDocument();
    const d2 = screen.getByText("Homepage design").closest("div")!.parentElement!;
    expect(within(d2).queryByRole("link", { name: /Open report/ })).toBeNull();
  });

  it("no link for a null reportId or an older server that sends none", async () => {
    listMock.mockResolvedValue([del({ id: "d1", name: "A", reportId: null }), del({ id: "d2", name: "B" })]);
    render(await PortalDeliverablesPage());
    expect(screen.queryByRole("link", { name: /Open report/ })).toBeNull();
  });

  it("refreshes on the reports topic too, since the link depends on a published report", async () => {
    listMock.mockResolvedValue([]);
    render(await PortalDeliverablesPage());
    expect(screen.getByTestId("live").getAttribute("data-topics")).toContain("reports");
  });
});
