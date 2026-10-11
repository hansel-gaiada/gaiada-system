import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { PortalProfile } from "@/lib/portal";

// WSK-49f — the portal People page, as a client of each kind sees it. The rule under test: ONLY a client
// ADMIN (a client-wide `admin` grant on their own profile) gets the Website access card, and then only if
// the BFF agrees. A signer, a viewer, a plain website editor and a project-scoped admin see nothing new,
// and the BFF is not even asked for them; a 403 hides the card; an unreadable answer says so rather than
// showing an empty list.
vi.mock("next/navigation", () => ({ redirect: vi.fn(() => { throw new Error("redirect"); }) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-aria") }));
vi.mock("@/lib/platform", () => ({ getMe: vi.fn(async () => ({ userId: "u-aria" })) }));
vi.mock("@/lib/portal-company", () => ({ getActivePortalCompany: vi.fn(async () => ({ id: "co-agency" })) }));
vi.mock("@/lib/portal-data", () => ({ getPortalProfile: vi.fn() }));
vi.mock("@/lib/clientWebsiteAccess", () => ({ getPortalWebsiteAccess: vi.fn() }));
vi.mock("@/lib/portalActions", () => ({
  portalUpdateProfile: vi.fn(), portalRequestProfileChange: vi.fn(),
}));
vi.mock("@/lib/portalWebsiteAccessActions", () => ({
  setPortalWebsiteEditorAction: vi.fn(), refreshPortalWebsiteAccessAction: vi.fn(),
}));

import { getPortalProfile } from "@/lib/portal-data";
import { getPortalWebsiteAccess } from "@/lib/clientWebsiteAccess";
import PortalProfilePage from "./page";

const profileMock = vi.mocked(getPortalProfile);
const accessMock = vi.mocked(getPortalWebsiteAccess);

const CL = "cl-1";
function profileFor(capability: string, projectId: string | null = null): PortalProfile {
  return {
    me: { id: "u-aria", name: "Aria Hartono", email: "aria@northwind.test", title: null, memberSince: "2026-01-01T00:00:00Z" },
    clients: [{ id: CL, name: "Northwind Traders", status: "active", contact: {}, projectCount: 1, accountManager: null }],
    contacts: [
      { id: "u-aria", name: "Aria Hartono", email: "aria@northwind.test", capability, status: "active", clientId: CL, projectId, side: "client" },
      { id: "u-dana", name: "Dana Whitfield", email: "dana@northwind.test", capability: "signer", status: "active", clientId: CL, projectId: null, side: "client" },
    ],
    access: {
      canSign: capability !== "viewer",
      wholeClient: projectId === null,
      grants: [{ capability, clientId: CL, clientName: "Northwind Traders", projectId, projectName: null }],
    },
  };
}

const LIST = {
  kind: "ok" as const,
  contacts: [
    { contactId: "c-aria", userId: "u-aria", name: "Aria Hartono", email: "aria@northwind.test", capability: "admin" as const, status: "active" as const, isAdmin: true, websiteEditor: false },
    { contactId: "c-dana", userId: "u-dana", name: "Dana Whitfield", email: "dana@northwind.test", capability: "signer" as const, status: "active" as const, isAdmin: false, websiteEditor: true },
  ],
};

const mount = async () => render(await PortalProfilePage());

beforeEach(() => {
  profileMock.mockReset();
  accessMock.mockReset().mockResolvedValue(LIST);
});

describe("a client ADMIN", () => {
  it("sees the Website access card with a switch per colleague, and the BFF is asked for THEIR client in the portal company", async () => {
    profileMock.mockResolvedValue(profileFor("admin"));
    await mount();
    expect(screen.getByRole("heading", { name: "Website access" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Website access for Dana Whitfield" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Website access for Aria Hartono" })).not.toBeChecked();
    expect(accessMock).toHaveBeenCalledTimes(1);
    expect(accessMock).toHaveBeenCalledWith("u-aria", "co-agency", CL);
  });

  it("the People table shows an admin as able to sign", async () => {
    profileMock.mockResolvedValue(profileFor("admin"));
    await mount();
    expect(screen.getAllByText(/Admin, can sign, whole account/).length).toBeGreaterThan(0);
  });

  it("a 403 from the BFF hides the section entirely", async () => {
    profileMock.mockResolvedValue(profileFor("admin"));
    accessMock.mockResolvedValue({ kind: "forbidden" });
    await mount();
    expect(screen.queryByRole("heading", { name: "Website access" })).toBeNull();
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
    expect(screen.queryByText(/website access/i)).toBeNull();
    // The rest of the page is untouched.
    expect(screen.getByRole("heading", { name: /^Your people/ })).toBeInTheDocument();
  });

  it("an unreadable answer says it cannot tell: no confident empty list", async () => {
    profileMock.mockResolvedValue(profileFor("admin"));
    accessMock.mockResolvedValue({ kind: "unavailable", reason: "503" });
    await mount();
    expect(screen.getByRole("heading", { name: "Website access" })).toBeInTheDocument();
    expect(screen.getByText(/this is not a statement that there is nothing here/i)).toBeInTheDocument();
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
  });
});

describe("everyone else sees nothing new", () => {
  for (const [label, capability, projectId] of [
    ["a signer", "signer", null],
    ["a viewer", "viewer", null],
    // A plain website editor holds the role, not a capability: their contact row is signer or viewer.
    ["a plain website editor (viewer row)", "viewer", null],
    // A project-scoped admin row carries no website power: the server refuses it, so it is not asked.
    ["a project-scoped admin", "admin", "p-1"],
  ] as const) {
    it(`${label}: no section, no disabled switches, and the BFF is not asked`, async () => {
      profileMock.mockResolvedValue(profileFor(capability, projectId));
      await mount();
      expect(screen.queryByRole("heading", { name: /website access/i })).toBeNull();
      expect(screen.queryAllByRole("switch")).toHaveLength(0);
      expect(screen.queryByText(/website access/i)).toBeNull();
      expect(accessMock).not.toHaveBeenCalled();
      // The page itself is intact.
      expect(screen.getByRole("heading", { name: /^Your people/ })).toBeInTheDocument();
    });
  }
});
