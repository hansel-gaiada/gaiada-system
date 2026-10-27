import { describe, it, expect, vi, beforeEach } from "vitest";

// SCP-2 (plan SCP-2f, SCP-Q8): the link we send a client, `/portal/social?post=<id>`, passes through the portal sign-in and must bring them back to THAT
// URL, query included. The proxy sends a request with no session cookie to `/login?return=…` with the query kept (proxy.test.ts). This pins the other door:
// a cookie that is present but no longer valid passes the proxy and meets the portal layout's own redirect, which used to say `/login` and drop the link.
vi.mock("next/navigation", () => ({ redirect: vi.fn((to: string) => { throw new Error(`redirect:${to}`); }) }));
vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn() }));
vi.mock("@/lib/platform", async () => ({ ...(await vi.importActual<typeof import("@/lib/platform")>("@/lib/platform")), getMe: vi.fn() }));
vi.mock("@/lib/portal-company", () => ({ getActivePortalCompany: vi.fn(async () => ({ id: "co-1", name: "Co" })), getPortalCompanies: vi.fn(() => []) }));
vi.mock("@/lib/portal-data", () => ({ getPortalOverview: vi.fn(async () => ({ overview: null })) }));
vi.mock("@/components/portal/PortalShell", () => ({ PortalShell: () => null }));
vi.mock("@/components/portal/PortalCompanySwitch", () => ({ PortalCompanySwitch: () => null }));

import { headers } from "next/headers";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import PortalLayout from "./layout";

const asked = (pathname: string | null, search: string | null) =>
  vi.mocked(headers).mockResolvedValue(new Headers({ ...(pathname ? { "x-gaiada-pathname": pathname } : {}), ...(search !== null ? { "x-gaiada-search": search } : {}) }) as never);

beforeEach(() => {
  vi.mocked(headers).mockReset();
  vi.mocked(getSessionUserId).mockReset();
  vi.mocked(getMe).mockReset();
});

describe("PortalLayout sends a signed-out visitor to /login with the link they asked for", () => {
  it("an invalid session cookie: /login?return= carries /portal/social?post=<id>, query included", async () => {
    vi.mocked(getSessionUserId).mockResolvedValue(null);
    asked("/portal/social", "?post=soc-post-n-3");
    await expect(PortalLayout({ children: null })).rejects.toThrow(`redirect:/login?return=${encodeURIComponent("/portal/social?post=soc-post-n-3")}`);
  });

  it("a session whose user cannot be read (getMe fails) takes the same road", async () => {
    vi.mocked(getSessionUserId).mockResolvedValue("u-1");
    vi.mocked(getMe).mockRejectedValue(new Error("platform 401"));
    asked("/portal/social", "?post=soc-post-n-3&tab=approved");
    await expect(PortalLayout({ children: null })).rejects.toThrow(`redirect:/login?return=${encodeURIComponent("/portal/social?post=soc-post-n-3&tab=approved")}`);
  });

  it("without the headers (a Server Action or a client navigation) it is plain /login, as before", async () => {
    vi.mocked(getSessionUserId).mockResolvedValue(null);
    asked(null, null);
    await expect(PortalLayout({ children: null })).rejects.toThrow("redirect:/login");
    await expect(PortalLayout({ children: null })).rejects.not.toThrow("return=");
  });

  it("a forged header cannot send the visitor off the site", async () => {
    vi.mocked(getSessionUserId).mockResolvedValue(null);
    asked("//evil.test", "");
    await expect(PortalLayout({ children: null })).rejects.toThrow("redirect:/login");
    await expect(PortalLayout({ children: null })).rejects.not.toThrow("evil");
  });
});
