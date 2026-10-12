import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("next/navigation", () => ({ redirect: (u: string) => { throw new Error(`redirect ${u}`); } }));
vi.mock("@/lib/webdeskContent", () => ({ listSites: vi.fn() }));
vi.mock("@/components/webdesk/content/serverCtx", () => ({ requireWebsiteCtx: vi.fn() }));

import { listSites } from "@/lib/webdeskContent";
import { requireWebsiteCtx } from "@/components/webdesk/content/serverCtx";
import Page from "./page";

const site = (id: string, name: string) => ({ siteId: id, name, kind: "static", environments: [] });
const sites = (...s: ReturnType<typeof site>[]) => ({ kind: "ok" as const, data: { tenants: [{ slug: "gaiada", status: "active", defaultLocale: "en", locales: ["en"], sites: s }] } });
const mount = async () => render(await Page({ params: Promise.resolve({ deptId: "dept-1" }) }));

beforeEach(() => {
  vi.mocked(listSites).mockReset();
  vi.mocked(requireWebsiteCtx).mockReset().mockResolvedValue({ userId: "u", me: {}, company: "co-1", deptId: "dept-1", visitorsBase: "/departments/dept-1/website/visitors" } as never);
});

describe("Website -> Visitors (site picker)", () => {
  it("asks for the visitors tab context (404 without the toolkit tab or read_visitors)", async () => {
    vi.mocked(listSites).mockResolvedValue(sites(site("s1", "a.com"), site("s2", "b.com")) as never);
    await mount();
    expect(requireWebsiteCtx).toHaveBeenCalledWith("dept-1", "visitors");
    expect(screen.getByTestId("sites-list")).toBeTruthy();
  });

  it("one site goes straight to its visitors", async () => {
    vi.mocked(listSites).mockResolvedValue(sites(site("s1", "a.com")) as never);
    await expect(mount()).rejects.toThrow("redirect /departments/dept-1/website/visitors/gaiada/s1");
  });

  it("a failed read is a notice, never an empty list of sites", async () => {
    vi.mocked(listSites).mockResolvedValue({ kind: "unavailable", code: "network", reason: "down" } as never);
    await mount();
    expect(screen.getByTestId("wd-editorial-unavailable")).toBeTruthy();
    expect(screen.queryByTestId("sites-list")).toBeNull();
  });
});
