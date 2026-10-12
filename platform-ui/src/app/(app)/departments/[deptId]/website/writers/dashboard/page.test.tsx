import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
const redirect = vi.fn((to: string) => { throw new Error(`REDIRECT:${to}`); });
vi.mock("next/navigation", () => ({ redirect: (to: string) => redirect(to) }));
vi.mock("@/lib/webdeskContent", () => ({ listSites: vi.fn() }));
vi.mock("@/components/webdesk/content/serverCtx", () => ({ requireWebsiteCtx: vi.fn() }));

import { listSites } from "@/lib/webdeskContent";
import { requireWebsiteCtx } from "@/components/webdesk/content/serverCtx";
import Page from "./page";

const sitesMock = vi.mocked(listSites);
const site = (id: string, name: string) => ({ siteId: id, name, kind: "static", environments: [] });
const tenants = (sites: ReturnType<typeof site>[]) => ({ kind: "ok" as const, data: { tenants: [{ slug: "gaiada", status: "active", defaultLocale: "en", locales: ["en"], sites }] } });

beforeEach(() => {
  redirect.mockClear();
  sitesMock.mockReset();
  vi.mocked(requireWebsiteCtx).mockResolvedValue({ userId: "u", company: "co-1", deptId: "dept-1", writersBase: "/departments/dept-1/website/writers" } as never);
});

describe("Website -> Writers' room -> Dashboard (site picker)", () => {
  it("one site goes straight to its dashboard", async () => {
    sitesMock.mockResolvedValue(tenants([site("site-1", "gaiada.com")]) as never);
    await expect(Page({ params: Promise.resolve({ deptId: "dept-1" }) })).rejects.toThrow("REDIRECT:/departments/dept-1/website/writers/dashboard/gaiada/site-1");
  });
  it("several sites are listed, each linking to its own dashboard", async () => {
    sitesMock.mockResolvedValue(tenants([site("site-1", "gaiada.com"), site("site-2", "other.com")]) as never);
    render(await Page({ params: Promise.resolve({ deptId: "dept-1" }) }));
    const hrefs = screen.getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/departments/dept-1/website/writers/dashboard/gaiada/site-2");
  });
  it("a failed read is a refusal, never an empty list of sites", async () => {
    sitesMock.mockResolvedValue({ kind: "forbidden", reason: "no" } as never);
    render(await Page({ params: Promise.resolve({ deptId: "dept-1" }) }));
    expect(screen.queryByText(/Pick a website/)).toBeNull();
  });
});
