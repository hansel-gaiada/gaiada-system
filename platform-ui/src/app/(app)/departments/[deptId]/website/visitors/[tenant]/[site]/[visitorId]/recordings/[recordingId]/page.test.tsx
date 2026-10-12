import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { render, screen } from "@testing-library/react";

// The player page: 404 without search.replay.view (before any read), the signed-domains redirect that lets proxy.ts set the page's
// CSP, words for every failure, and plain links out (a full page load drops this page's policy).

class Redirected extends Error { constructor(public to: string) { super(`redirect:${to}`); } }
class NotFound extends Error { constructor() { super("notFound"); } }
vi.mock("next/navigation", () => ({
  notFound: () => { throw new NotFound(); },
  redirect: (to: string) => { throw new Redirected(to); },
}));
vi.mock("@/lib/replays", () => ({ resolveSiteForReplay: vi.fn() }));
vi.mock("@/components/webdesk/content/serverCtx", () => ({ requireWebsiteCtx: vi.fn() }));
vi.mock("@/components/webdesk/visitors/ReplayPlayer", () => ({
  ReplayPlayer: (p: { propertyId: string; recordingId: string; backHref: string }) => <div data-testid="player-stub" data-property={p.propertyId} data-recording={p.recordingId} data-back={p.backHref} />,
}));

import { resolveSiteForReplay } from "@/lib/replays";
import { requireWebsiteCtx } from "@/components/webdesk/content/serverCtx";
import { signedDomainParams, verifiedDomains } from "@/lib/replaysCsp";
import Page from "./page";

const V = "0194a3b2-1111-7000-8000-000000000001";
const R = "0194a3b2-bbbb-7000-8000-0000000000b1";
const P = "0194a3b2-aaaa-7000-8000-00000000000a";
const BASE = "/departments/dept-1/website/visitors";
const HERE = `${BASE}/gaiada/site-1/${V}/recordings/${R}`;
const meOf = (role: string) => ({ userId: "u", name: "U", email: "u@x.com", title: null, assurance: "high", companies: [], roles: [{ role, scopeType: "company", scopeId: "co-1" }] });
const ctxMock = vi.mocked(requireWebsiteCtx);
const siteMock = vi.mocked(resolveSiteForReplay);
const asViewer = (role: string) => ctxMock.mockResolvedValue({ userId: "u", me: meOf(role), company: "co-1", deptId: "dept-1", visitorsBase: BASE } as never);
const params = (o: Record<string, string> = {}) => Promise.resolve({ deptId: "dept-1", tenant: "gaiada", site: "site-1", visitorId: V, recordingId: R, ...o });
const mount = async (search: Record<string, string> = {}, p: Record<string, string> = {}) => render(await Page({ params: params(p), searchParams: Promise.resolve(search) }));
const okSite = { kind: "ok", siteName: "gaiada.com", property: { id: P, domain: "gaiada.com", umamiSiteId: "u" }, domains: ["gaiada.com", "staging.gaiada.com"] } as never;

beforeAll(() => { process.env.SESSION_SECRET = "test-secret-for-player-page"; });
beforeEach(() => {
  ctxMock.mockReset(); siteMock.mockReset();
  asViewer("search_manager");
  siteMock.mockResolvedValue(okSite);
});

describe("Website -> Visitors -> visitor -> recording (the player page)", () => {
  it("asks for the visitors tab context", async () => {
    const good = signedDomainParams("gaiada", "site-1", ["gaiada.com", "staging.gaiada.com"]);
    await mount(good);
    expect(ctxMock).toHaveBeenCalledWith("dept-1", "visitors");
  });

  it("404s for a viewer without search.replay.view, and reads nothing", async () => {
    asViewer("search_staff");
    await expect(mount()).rejects.toBeInstanceOf(NotFound);
    expect(siteMock).not.toHaveBeenCalled();
  });

  it("404s for an id that is not an id", async () => {
    await expect(mount({}, { recordingId: "../etc" })).rejects.toBeInstanceOf(NotFound);
    await expect(mount({}, { visitorId: "nope" })).rejects.toBeInstanceOf(NotFound);
    expect(siteMock).not.toHaveBeenCalled();
  });

  it("with the right signed domains in the URL it renders the player for this property and recording, and reads no recording content", async () => {
    const good = signedDomainParams("gaiada", "site-1", ["gaiada.com", "staging.gaiada.com"]);
    await mount(good);
    const stub = screen.getByTestId("player-stub");
    expect(stub.getAttribute("data-property")).toBe(P);
    expect(stub.getAttribute("data-recording")).toBe(R);
    expect(stub.getAttribute("data-back")).toBe(`${BASE}/gaiada/site-1/${V}`);
  });

  it("without the signed pair it redirects once to the canonical URL, whose params the proxy verifies as exactly the site's domains", async () => {
    let to = "";
    try { await mount(); } catch (e) { if (e instanceof Redirected) to = e.to; else throw e; }
    expect(to.startsWith(`${HERE}?`)).toBe(true);
    const q = new URLSearchParams(to.split("?")[1]);
    expect(verifiedDomains("gaiada", "site-1", q.get("d"), q.get("s"))).toEqual(["gaiada.com", "staging.gaiada.com"]);
  });

  it("a forged or stale list is redirected to the canonical one, not rendered", async () => {
    const stale = signedDomainParams("gaiada", "site-1", ["old.gaiada.com"]);
    await expect(mount(stale)).rejects.toBeInstanceOf(Redirected);
    await expect(mount({ d: "evil.com", s: "forged" })).rejects.toBeInstanceOf(Redirected);
  });

  it("a site with no domains settles on the empty signed list (the floor), without looping", async () => {
    siteMock.mockResolvedValue({ ...(okSite as object), domains: [] } as never);
    const empty = signedDomainParams("gaiada", "site-1", []);
    expect(empty.d).toBe("");
    await mount(empty);
    expect(screen.getByTestId("player-stub")).toBeTruthy();
  });

  it("leaves by plain links, never client-side navigation (a full load drops this page's policy)", async () => {
    const { container } = await mount(signedDomainParams("gaiada", "site-1", ["gaiada.com", "staging.gaiada.com"]));
    const links = [...container.querySelectorAll("[data-testid=replay-crumbs] a")].map((a) => a.getAttribute("href"));
    expect(links).toEqual([BASE, `${BASE}/gaiada/site-1`, `${BASE}/gaiada/site-1/${V}`]);
  });

  it("an unknown site, no property and a failed read are words", async () => {
    siteMock.mockResolvedValue({ kind: "no_site" });
    const a = await mount();
    expect(a.container.textContent?.toLowerCase()).toMatch(/not found|no such|site/);
    expect(screen.queryByTestId("player-stub")).toBeNull();
    a.unmount();

    siteMock.mockResolvedValue({ kind: "no_property", siteName: "gaiada.com" });
    const b = await mount();
    expect(b.container.textContent).toContain("No search property matches gaiada.com");
    b.unmount();

    siteMock.mockResolvedValue({ kind: "unavailable", code: "network", reason: "boom" });
    await mount();
    expect(screen.getByTestId("wd-editorial-unavailable")).toBeTruthy();
    expect(screen.queryByTestId("player-stub")).toBeNull();
  });
});
