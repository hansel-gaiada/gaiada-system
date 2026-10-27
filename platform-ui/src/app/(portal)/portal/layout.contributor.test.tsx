import { describe, it, expect, vi, beforeEach } from "vitest";

// M5-W1f: the fence-refused /api/me case is pinned in (app)/layout.test.tsx (the same expression); a contributor who opens a portal URL is sent to their own shell. A client is not redirected (the portal renders). Server layout: readers mocked.
vi.mock("next/navigation", () => ({ redirect: vi.fn((to: string) => { throw new Error(`redirect:${to}`); }) }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("@/lib/platform", async () => ({ ...(await vi.importActual<typeof import("@/lib/platform")>("@/lib/platform")), getMe: vi.fn() }));
vi.mock("@/lib/portal-company", () => ({ getActivePortalCompany: vi.fn(async () => ({ id: "co-1", name: "Co" })), getPortalCompanies: vi.fn(() => []) }));
vi.mock("@/lib/portal-data", () => ({ getPortalOverview: vi.fn(async () => ({ overview: null })) }));
vi.mock("@/components/portal/PortalShell", () => ({ PortalShell: () => null }));
vi.mock("@/components/portal/PortalCompanySwitch", () => ({ PortalCompanySwitch: () => null }));

import { getMe, type Me } from "@/lib/platform";
import PortalLayout from "./layout";

const me = (over: Partial<Me>): Me => ({ userId: "u-1", name: "Dana", email: "d@x", title: null, assurance: "high", companies: [], roles: [], ...over });
beforeEach(() => vi.mocked(getMe).mockReset());

describe("PortalLayout and the contributor", () => {
  it("redirects a contributor to /contributor", async () => {
    vi.mocked(getMe).mockResolvedValue(me({ kind: "contributor", roles: [{ role: "webdesk_writer", scopeType: "company", scopeId: "co-1" }] }));
    await expect(PortalLayout({ children: null })).rejects.toThrow("redirect:/contributor");
  });
  it("a client is not redirected: the portal renders", async () => {
    vi.mocked(getMe).mockResolvedValue(me({ roles: [{ role: "client", scopeType: "global", scopeId: null }] }));
    await expect(PortalLayout({ children: null })).resolves.toBeTruthy();
  });
});
