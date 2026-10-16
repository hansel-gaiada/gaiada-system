import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { AGENCY, HOTEL, me as meFixture, member, node, agencyTree } from "@/lib/workspaceFixtures";

// DW-10e (BFF §60.9): the new-request page offers the routes the company HAS ("To <unit> · <company>"), from `GET requests/routes` and never
// from the active company's tree; a non-agency company with routes gets the page too; with no routes it is today's page. Server page: the readers
// are mocked, the element tree is rendered.
vi.mock("next/navigation", () => ({
  redirect: vi.fn((to: string) => { throw new Error(`redirect:${to}`); }),
  notFound: vi.fn(() => { throw new Error("notFound"); }),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("next/link", () => ({ default: ({ children, href, className }: { children?: ReactNode; href: string; className?: string }) => <a href={href} className={className}>{children}</a> }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn() }));
vi.mock("@/lib/platform", async () => ({ ...(await vi.importActual<typeof import("@/lib/platform")>("@/lib/platform")), getMe: vi.fn() }));
vi.mock("@/lib/requests-data", () => ({ readRequestRoutes: vi.fn() }));
vi.mock("@/lib/campaigns-data", () => ({ readOrgRoot: vi.fn(), readSharedCampaigns: vi.fn() }));
vi.mock("@/lib/requestActions", () => ({ createRequestAction: vi.fn(), createOutboundRequestAction: vi.fn() }));

import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { readRequestRoutes } from "@/lib/requests-data";
import { readOrgRoot, readSharedCampaigns } from "@/lib/campaigns-data";
import NewRequestPage from "./page";

const R_ASSETS = "5a0c0000-0000-4000-8000-000000000001";
const R_ENG = "5a0c0000-0000-4000-8000-000000000002";
const routes = [
  { routeId: R_ASSETS, kind: "assets" as const, company: { id: "co-a", name: "Gaia Digital Agency" }, unit: { name: "Creatives" } },
  { routeId: R_ENG, kind: "engineering" as const, company: { id: "co-a", name: "Gaia Digital Agency" }, unit: { name: "Web Dev" } },
];
const withRoutes = (list = routes) => vi.mocked(readRequestRoutes).mockResolvedValue({ kind: "ok", data: { enabled: true, routes: list } });
const mount = async (sp: { to?: string; route?: string } = {}) => render(await NewRequestPage({ searchParams: Promise.resolve(sp) }));

/** An agency tree that has a Creatives department too (the fixture's has Web Dev, SEO and GM). */
const agencyWithCreatives = () => {
  const t = agencyTree();
  return { ...t, children: [...t.children, node("d-cre", "Creatives", "department")] };
};
const hotelTree = () => node("root", "Hotel", "company", [node("d-fo", "Front Office", "department")]);

const asAgencyMember = () => { vi.mocked(getMe).mockResolvedValue(meFixture([member("co-a")], [AGENCY])); vi.mocked(getActiveTenant).mockResolvedValue("co-a"); };
const asHotelMember = () => { vi.mocked(getMe).mockResolvedValue(meFixture([member("co-h")], [HOTEL])); vi.mocked(getActiveTenant).mockResolvedValue("co-h"); };

beforeEach(() => {
  vi.mocked(readRequestRoutes).mockReset();
  vi.mocked(readOrgRoot).mockReset();
  vi.mocked(readSharedCampaigns).mockReset().mockResolvedValue({ kind: "ok", data: [] });
});

describe("the chooser", () => {
  it("offers a non-agency company the routes it has, from the routes read, with no same-company targets", async () => {
    asHotelMember();
    withRoutes();
    vi.mocked(readOrgRoot).mockResolvedValue(hotelTree() as never);
    await mount();
    const assets = screen.getByRole("link", { name: "To Creatives · Gaia Digital Agency" });
    expect(assets).toHaveAttribute("href", `/requests/new?route=${R_ASSETS}`);
    expect(screen.getByRole("link", { name: "To Web Dev · Gaia Digital Agency" })).toHaveAttribute("href", `/requests/new?route=${R_ENG}`);
    expect(screen.getByText("Asset request")).toBeInTheDocument();
    expect(screen.getByText("Engineering request")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Ask Creatives for assets" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Ask Web Dev" })).toBeNull();
  });

  it("offers an agency-pack company its own departments AND the routes it has", async () => {
    asAgencyMember();
    withRoutes([routes[0]]);
    vi.mocked(readOrgRoot).mockResolvedValue(agencyWithCreatives() as never);
    await mount();
    expect(screen.getByRole("link", { name: "Ask Creatives for assets" })).toHaveAttribute("href", "/requests/new?to=creatives");
    expect(screen.getByRole("link", { name: "Ask Web Dev" })).toHaveAttribute("href", "/requests/new?to=web-dev");
    expect(screen.getByRole("link", { name: "To Creatives · Gaia Digital Agency" })).toBeInTheDocument();
  });

  it("with no routes is the page it was: the company's own departments, nothing about other companies", async () => {
    asAgencyMember();
    withRoutes([]);
    vi.mocked(readOrgRoot).mockResolvedValue(agencyWithCreatives() as never);
    await mount();
    expect(screen.getByText("Choose a department to ask.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ask Creatives for assets" })).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Other companies" })).toBeNull();
    expect(screen.queryByText(/ · /)).toBeNull();
  });

  it("says there is nobody to ask for a company with no routes and no such department", async () => {
    asHotelMember();
    withRoutes([]);
    vi.mocked(readOrgRoot).mockResolvedValue(hotelTree() as never);
    await mount();
    expect(screen.getByText("There is nobody to send a request to from this company yet.")).toBeInTheDocument();
  });

  it("does not list routes to a person who may not send across (a viewer), and says nothing false about them", async () => {
    vi.mocked(getMe).mockResolvedValue(meFixture([{ role: "viewer", scopeType: "company", scopeId: "co-h" }], [HOTEL]));
    vi.mocked(getActiveTenant).mockResolvedValue("co-h");
    withRoutes();
    vi.mocked(readOrgRoot).mockResolvedValue(hotelTree() as never);
    await mount();
    expect(screen.queryByRole("link", { name: /^To / })).toBeNull();
  });

  it("says the routes could not be read, rather than that there are none", async () => {
    asHotelMember();
    vi.mocked(readRequestRoutes).mockResolvedValue({ kind: "unavailable", reason: "boom" });
    vi.mocked(readOrgRoot).mockResolvedValue(hotelTree() as never);
    await mount();
    expect(screen.getByText(/routes to other companies cannot be read right now, so they are not listed\. That is not a statement that there are none/)).toBeInTheDocument();
    expect(screen.queryByText("There is nobody to send a request to from this company yet.")).toBeNull();
  });

  it("says when requests to other companies are switched off", async () => {
    asHotelMember();
    vi.mocked(readRequestRoutes).mockResolvedValue({ kind: "ok", data: { enabled: false, routes: [] } });
    vi.mocked(readOrgRoot).mockResolvedValue(hotelTree() as never);
    await mount();
    expect(screen.getByText("Requests to other companies are switched off.")).toBeInTheDocument();
  });
});

describe("?route=<routeId>", () => {
  it("renders the form for the route's kind: 'To <unit> · <company>', the billing line, no campaign picker", async () => {
    asHotelMember();
    withRoutes();
    await mount({ route: R_ASSETS });
    expect(screen.getByRole("heading", { name: "Ask Creatives at Gaia Digital Agency for assets" })).toBeInTheDocument();
    expect(screen.getByText("Creatives · Gaia Digital Agency")).toBeInTheDocument();
    expect(screen.getByText(/This is client work: Gaia Digital Agency bills Hotel for it as a client/)).toBeInTheDocument();
    expect(screen.getByText("What you need")).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Campaign/)).toBeNull();
    // The route is found from the routes read, never from the company's tree: the org chart is not read.
    expect(readOrgRoot).not.toHaveBeenCalled();
    expect(readSharedCampaigns).not.toHaveBeenCalled();
  });

  it("takes the engineering form for an engineering route", async () => {
    asHotelMember();
    withRoutes();
    await mount({ route: R_ENG });
    expect(screen.getByRole("heading", { name: "Ask Web Dev at Gaia Digital Agency" })).toBeInTheDocument();
    expect(screen.getByLabelText(/^What kind of change/)).toBeInTheDocument();
  });

  it("says 'Your company can no longer send requests there' for a route it does not have", async () => {
    asHotelMember();
    withRoutes([routes[0]]);
    await mount({ route: R_ENG });
    expect(screen.getByText("Your company can no longer send requests there.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Choose where to send a request" })).toHaveAttribute("href", "/requests/new");
    expect(screen.queryByRole("form")).toBeNull();
  });

  it("says unavailable when the routes cannot be read, and forbidden when they are refused", async () => {
    asHotelMember();
    vi.mocked(readRequestRoutes).mockResolvedValue({ kind: "unavailable", reason: "boom" });
    const first = await mount({ route: R_ASSETS });
    expect(screen.getByText(/Your company's routes to other companies cannot be read right now/)).toBeInTheDocument();
    first.unmount();
    vi.mocked(readRequestRoutes).mockResolvedValue({ kind: "forbidden" });
    await mount({ route: R_ASSETS });
    expect(screen.getByText(/You don't have access to your company's routes to other companies/)).toBeInTheDocument();
  });

  it("works for any company, whatever its pack: an agency company with a route to a sister agency gets the same form", async () => {
    asAgencyMember();
    withRoutes([routes[1]]);
    await mount({ route: R_ENG });
    expect(screen.getByText("Web Dev · Gaia Digital Agency")).toBeInTheDocument();
  });
});

describe("?to=<key>: the same-company form is as it was", () => {
  it("resolves the department from the company's tree and keeps the campaign picker", async () => {
    asAgencyMember();
    vi.mocked(readOrgRoot).mockResolvedValue(agencyWithCreatives() as never);
    vi.mocked(readSharedCampaigns).mockResolvedValue({ kind: "ok", data: [{ id: "c1", name: "Launch", part: { id: "p1", status: "open" } }] as never });
    await mount({ to: "creatives" });
    expect(screen.getByText("Creatives")).toBeInTheDocument();
    expect(screen.getByLabelText(/^Campaign/)).toBeInTheDocument();
    expect(readRequestRoutes).not.toHaveBeenCalled();
  });

  it("says there is no such department for a company without one", async () => {
    asHotelMember();
    vi.mocked(readOrgRoot).mockResolvedValue(hotelTree() as never);
    await mount({ to: "creatives" });
    expect(screen.getByText(/This company has no Creatives department yet/)).toBeInTheDocument();
  });
});
