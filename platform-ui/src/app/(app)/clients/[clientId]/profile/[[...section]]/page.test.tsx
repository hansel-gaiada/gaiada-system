import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// PV6-01: the Business workspace's old URLs. An old `<area>/settings` and an old leaf page `<area>/<n>`
// (bookmarks may still hold them) land on the area's Setup; `<area>/connections` is a real view and is NOT
// redirected. The portal entry page has the same test next to it.

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => { throw new Error("NOT_FOUND"); }),
  redirect: vi.fn((to: string) => { throw new Error(`REDIRECT:${to}`); }),
}));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("@/lib/platform", () => ({ getMe: vi.fn(async () => ({ userId: "u-1", companies: [], roles: [] })) }));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-1") }));
vi.mock("@/lib/entities", () => ({ getClient: vi.fn(async () => ({ id: "cl-1", isInternal: false })) }));
vi.mock("@/lib/clientCentre-data", () => ({
  getClientCentre: vi.fn(async () => ({ clientId: "cl-1", clientName: "Demo", businessType: "hotel", profile: {}, connections: {}, areas: {}, customConnections: {}, revision: 1, canEdit: true })),
  getClientCentreResults: vi.fn(async () => ({ clientId: "cl-1", generatedAt: "2026-10-13T00:00:00Z", visible: true, services: [], unavailable: [] })),
}));
vi.mock("@/lib/clientCentreActions", () => ({ patchClientCentreAction: vi.fn() }));
vi.mock("@/components/client-centre/ClientCentreShell", () => ({
  ClientCentreShell: ({ segments, basePath }: { segments: string[]; basePath: string }) => <p data-testid="shell">{basePath}|{segments.join("/")}</p>,
}));

import ClientProfilePage from "./page";
import { getClientCentreResults } from "@/lib/clientCentre-data";

const run = (section?: string[]) => ClientProfilePage({ params: Promise.resolve({ clientId: "cl-1", section }) });

beforeEach(() => vi.clearAllMocks());

describe("Client hub Profile tab · old Business URLs (PV6-01)", () => {
  it("🔴 /rs/settings redirects to the area's Setup", async () => {
    await expect(run(["rs", "settings"])).rejects.toThrow("REDIRECT:/clients/cl-1/profile/rs");
  });
  it("🔴 /mk/3 (an old leaf page) redirects to the area's Setup", async () => {
    await expect(run(["mk", "3"])).rejects.toThrow("REDIRECT:/clients/cl-1/profile/mk");
  });
  it("/rs/connections renders, with no redirect", async () => {
    render(await run(["rs", "connections"]));
    expect(screen.getByTestId("shell").textContent).toBe("/clients/cl-1/profile|rs/connections");
  });
  it("/rs and the bare URL render too", async () => {
    render(await run(["rs"]));
    expect(screen.getByTestId("shell").textContent).toContain("|rs");
    render(await run(undefined));
    expect(screen.getAllByTestId("shell")).toHaveLength(2);
  });
});

describe("Client hub Profile tab · results are read only where shown (PV6-03)", () => {
  it("Home reads results once (the per-area counts)", async () => {
    render(await run(undefined));
    expect(getClientCentreResults).toHaveBeenCalledTimes(1);
  });
  it("an area's results part reads results once", async () => {
    render(await run(["se", "results"]));
    expect(getClientCentreResults).toHaveBeenCalledTimes(1);
  });
  it("🔴 an area's Setup and Connections parts and Business details read no results", async () => {
    render(await run(["se"]));
    render(await run(["se", "connections"]));
    render(await run(["company"]));
    expect(getClientCentreResults).not.toHaveBeenCalled();
  });
});
