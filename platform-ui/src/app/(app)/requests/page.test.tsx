import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { HOTEL, me as meFixture, member } from "@/lib/workspaceFixtures";

// DW-10e (BFF §60.9): My requests merges §32's read (`box=mine`) with the sender read (`outbound?box=mine`). A row to another company says
// "To <unit> · <company>" and opens the sender's page; the page says which scope the sender read answered (DW-D40); and when one read fails it
// shows the other AND says which part could not be read. Server page: the readers are mocked, the element tree is rendered.
vi.mock("next/navigation", () => ({
  redirect: vi.fn((to: string) => { throw new Error(`redirect:${to}`); }),
  notFound: vi.fn(() => { throw new Error("notFound"); }),
}));
vi.mock("next/link", () => ({ default: ({ children, href, className }: { children?: ReactNode; href: string; className?: string }) => <a href={href} className={className}>{children}</a> }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-h") }));
vi.mock("@/lib/platform", async () => ({ ...(await vi.importActual<typeof import("@/lib/platform")>("@/lib/platform")), getMe: vi.fn() }));
vi.mock("@/lib/requests-data", () => ({ readRequests: vi.fn(), readOutboundRequests: vi.fn() }));
vi.mock("@/lib/campaigns-data", () => ({ readOrgRoot: vi.fn(async () => null) }));

import { getMe } from "@/lib/platform";
import { readOutboundRequests, readRequests } from "@/lib/requests-data";
import { normalizeRequestRow, type RequestRow } from "@/lib/requests";
import MyRequestsPage from "./page";

const same = (over: Record<string, unknown> = {}): RequestRow => normalizeRequestRow({
  id: "s1", kind: "assets", title: "Lobby signage", status: "open", createdAt: "2026-10-10T00:00:00Z",
  fromUnit: { id: "d-fo", name: "Front Office", unitMissing: false }, toUnit: { id: "d-mk", name: "Marketing", unitMissing: false },
  requestedBy: { id: "u-1", name: "Ni Luh Sekar" }, work: { type: "pm_task", id: "t1", status: "new", isDone: false, responsibleName: null }, assetCount: 0, ...over,
})!;
const across = (over: Record<string, unknown> = {}): RequestRow => normalizeRequestRow({
  id: "x1", kind: "assets", title: "Reception banners", status: "open", createdAt: "2026-10-12T00:00:00Z",
  fromUnit: { id: "d-fo", name: "Front Office" }, toUnit: { id: "dept-2", name: "Creatives" }, requestedBy: { id: "u-1", name: "Ni Luh Sekar" },
  work: { type: "pm_task", status: "new", isDone: false, responsibleName: null }, assetCount: 0,
  receivingCompany: { id: "co-agency", name: "Gaia Digital Agency" }, routeId: "rt-1", price: null, ...over,
}, { outbound: true })!;

const mount = async (status?: string) => render(await MyRequestsPage({ searchParams: Promise.resolve(status ? { status } : {}) }));
const ok = <T,>(data: T) => ({ kind: "ok" as const, data });

beforeEach(() => {
  vi.mocked(getMe).mockResolvedValue(meFixture([member("co-h")], [HOTEL]));
  vi.mocked(readRequests).mockReset();
  vi.mocked(readOutboundRequests).mockReset();
});

describe("My requests", () => {
  it("lists both kinds, newest first, a request to another company naming the unit and the company", async () => {
    vi.mocked(readRequests).mockResolvedValue(ok([same()]));
    vi.mocked(readOutboundRequests).mockResolvedValue(ok({ scope: "own" as const, rows: [across()] }));
    await mount();
    expect(readOutboundRequests).toHaveBeenCalledWith("u-1", "co-h", { box: "mine" }, "open");
    const links = screen.getAllByRole("link", { name: /Reception banners|Lobby signage/ });
    expect(links.map((l) => l.getAttribute("aria-label"))).toEqual(["Reception banners", "Lobby signage"]);
    expect(links[0]).toHaveAttribute("href", "/requests/outbound/x1");
    expect(links[1]).toHaveAttribute("href", "/requests/s1");
    expect(screen.getByText("To Creatives · Gaia Digital Agency")).toBeInTheDocument();
    expect(screen.getByText("Marketing")).toBeInTheDocument();
  });

  it("says 'Requests you sent' and that only the caller's requests to other companies are shown, in scope own", async () => {
    vi.mocked(readRequests).mockResolvedValue(ok([]));
    vi.mocked(readOutboundRequests).mockResolvedValue(ok({ scope: "own" as const, rows: [across()] }));
    await mount();
    expect(screen.getByRole("heading", { name: /^Requests you sent/ })).toBeInTheDocument();
    expect(screen.getByText("Only the requests you sent to other companies are shown. Managers and administrators of Hotel see all of them.")).toBeInTheDocument();
  });

  it("says 'Requests <company> sent' in scope company, for a manager or administrator", async () => {
    vi.mocked(readRequests).mockResolvedValue(ok([]));
    vi.mocked(readOutboundRequests).mockResolvedValue(ok({ scope: "company" as const, rows: [across(), across({ id: "x2", requestedBy: { id: "u-9", name: "Someone Else" } })] }));
    await mount();
    expect(screen.getByRole("heading", { name: /^Requests Hotel sent/ })).toBeInTheDocument();
    expect(screen.queryByText(/Only the requests you sent/)).toBeNull();
  });

  it("when the sender read fails, shows the departments' part and says the other companies' part could not be read", async () => {
    vi.mocked(readRequests).mockResolvedValue(ok([same()]));
    vi.mocked(readOutboundRequests).mockResolvedValue({ kind: "unavailable", reason: "boom" });
    await mount();
    expect(screen.getByRole("link", { name: "Lobby signage" })).toBeInTheDocument();
    expect(screen.getByText(/The requests you sent to other companies cannot be read right now/)).toBeInTheDocument();
    expect(screen.queryByText("You have no open requests.")).toBeNull();
  });

  it("when §32's read fails, shows the other companies' part and says the departments' part could not be read", async () => {
    vi.mocked(readRequests).mockResolvedValue({ kind: "unavailable", reason: "boom" });
    vi.mocked(readOutboundRequests).mockResolvedValue(ok({ scope: "own" as const, rows: [across()] }));
    await mount();
    expect(screen.getByRole("link", { name: "Reception banners" })).toBeInTheDocument();
    expect(screen.getByText(/The requests you sent to other departments cannot be read right now/)).toBeInTheDocument();
  });

  it("when neither read answers, the page is the refusal: never a table that says 'no requests'", async () => {
    vi.mocked(readRequests).mockResolvedValue({ kind: "unavailable", reason: "boom" });
    vi.mocked(readOutboundRequests).mockResolvedValue({ kind: "unavailable", reason: "boom" });
    await mount();
    expect(screen.getByText(/Your requests cannot be read right now/)).toBeInTheDocument();
    expect(screen.queryByText("You have no open requests.")).toBeNull();
    vi.mocked(readRequests).mockResolvedValue({ kind: "forbidden" });
    vi.mocked(readOutboundRequests).mockResolvedValue({ kind: "forbidden" });
    document.body.innerHTML = "";
    await mount();
    expect(screen.getByText(/You don't have access to your requests\./)).toBeInTheDocument();
  });

  it("says there is nothing only when both reads answered with nothing", async () => {
    vi.mocked(readRequests).mockResolvedValue(ok([]));
    vi.mocked(readOutboundRequests).mockResolvedValue(ok({ scope: "own" as const, rows: [] }));
    await mount();
    expect(screen.getByText("You have no open requests.")).toBeInTheDocument();
    // With nothing sent to other companies the "only yours" note is not drawn: it would say a thing about rows that are not there.
    expect(screen.queryByText(/Only the requests you sent/)).toBeNull();
  });

  it("asks both reads for the status the person chose", async () => {
    vi.mocked(readRequests).mockResolvedValue(ok([]));
    vi.mocked(readOutboundRequests).mockResolvedValue(ok({ scope: "own" as const, rows: [] }));
    await mount("closed");
    expect(readRequests).toHaveBeenCalledWith("u-1", "co-h", { box: "mine" }, "closed");
    expect(readOutboundRequests).toHaveBeenCalledWith("u-1", "co-h", { box: "mine" }, "closed");
    expect(screen.getByText("You have no closed requests.")).toBeInTheDocument();
  });
});
