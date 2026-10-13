import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// PV6-01: the portal Business tab's old URLs. An old `<area>/settings` and an old leaf page `<area>/<n>`
// land on the area's Setup; `<area>/connections` is a real view. (The client hub has the same test.)

vi.mock("next/navigation", () => ({
  redirect: vi.fn((to: string) => { throw new Error(`REDIRECT:${to}`); }),
}));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("@/lib/platform", () => ({ getMe: vi.fn(async () => ({ userId: "u-1", companies: [], roles: [] })) }));
vi.mock("@/lib/portal-company", () => ({ getActivePortalCompany: vi.fn(async () => ({ id: "co-1" })) }));
vi.mock("@/lib/clientCentre-data", () => ({
  listPortalCentres: vi.fn(async () => [{ clientId: "cl-1", clientName: "Demo", canEdit: true }]),
  getPortalCentre: vi.fn(async () => ({ clientId: "cl-1", clientName: "Demo", businessType: "hotel", profile: {}, connections: {}, areas: {}, customConnections: {}, revision: 1, canEdit: true })),
}));
vi.mock("@/lib/clientCentreActions", () => ({ patchPortalCentreAction: vi.fn() }));
vi.mock("@/lib/portalCentreClient", () => ({ getActivePortalClient: vi.fn(async () => "cl-1"), switchPortalClient: vi.fn() }));
vi.mock("@/components/portal/PortalBits", () => ({ PortalPageHead: () => null }));
vi.mock("@/components/systems/EmptyNote", () => ({ EmptyNote: () => null }));
vi.mock("@/components/client-centre/ClientCentreShell", () => ({
  ClientCentreShell: ({ segments, basePath }: { segments: string[]; basePath: string }) => <p data-testid="shell">{basePath}|{segments.join("/")}</p>,
}));

import PortalCompanyPage from "./page";

const run = (section?: string[]) => PortalCompanyPage({ params: Promise.resolve({ section }) });

beforeEach(() => vi.clearAllMocks());

describe("Portal Business tab · old URLs (PV6-01)", () => {
  it("🔴 /rs/settings redirects to the area's Setup", async () => {
    await expect(run(["rs", "settings"])).rejects.toThrow("REDIRECT:/portal/company/rs");
  });
  it("🔴 /mk/3 (an old leaf page) redirects to the area's Setup", async () => {
    await expect(run(["mk", "3"])).rejects.toThrow("REDIRECT:/portal/company/mk");
  });
  it("/rs/connections renders, with no redirect", async () => {
    render(await run(["rs", "connections"]));
    expect(screen.getByTestId("shell").textContent).toBe("/portal/company|rs/connections");
  });
});
