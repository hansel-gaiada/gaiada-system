import type { ReactElement } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AGENCY, HOTEL, agencyTree, me as meFixture, member, node, person } from "@/lib/workspaceFixtures";
import { resolveMyWorkspaces } from "@/lib/workspaceAccess";

// DW-10e + DW-9 perf: the (app) layout does NOT wait for the routes read (BFF §60.9). The agency pack, which already has the Requests row, never
// reads them; any other company starts the read without awaiting it and builds the shell model with routes "inflight". Server layout: the
// readers are mocked and the element it returns is inspected (an async server layout cannot render in jsdom's client React).
vi.mock("next/headers", () => ({ headers: vi.fn(async () => ({ get: () => null })) }));
vi.mock("next/navigation", () => ({ redirect: vi.fn((to: string) => { throw new Error(`redirect:${to}`); }) }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("@/lib/platform", async () => ({ ...(await vi.importActual<typeof import("@/lib/platform")>("@/lib/platform")), getMe: vi.fn() }));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn() }));
vi.mock("@/lib/prefs", async () => ({ ...(await vi.importActual<typeof import("@/lib/prefs")>("@/lib/prefs")), getPrefs: vi.fn(async () => (await vi.importActual<typeof import("@/lib/prefs")>("@/lib/prefs")).DEFAULT_PREFS) }));
vi.mock("@/lib/workspaces-data", () => ({ myWorkspaces: vi.fn() }));
vi.mock("@/lib/approvals", () => ({ listApprovals: vi.fn(() => new Promise(() => {})) }));
vi.mock("@/lib/requests-data", () => ({ routesForShell: vi.fn() }));
vi.mock("@/components/shell/Shell", () => ({ Shell: () => null }));
vi.mock("@/components/shell/ShellApprovalsFeed", () => ({ ShellApprovalsFeed: () => null }));
vi.mock("@/components/shell/ShellRoutesFeed", () => ({ ShellRoutesFeed: () => null }));

import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { myWorkspaces } from "@/lib/workspaces-data";
import { routesForShell } from "@/lib/requests-data";
import type { ShellModel } from "@/lib/shellModel";
import AppLayout from "./layout";

type El = ReactElement<{ workspaceModel: ShellModel; routesFeed?: ReactElement }>;
async function shellOf() {
  const tree = (await AppLayout({ children: null, drawer: null })) as ReactElement<{ children: El[] }>;
  const kids = Array.isArray(tree.props.children) ? tree.props.children : [tree.props.children];
  return kids[0] as El;
}

const hotelTree = () => node("root", "Hotel", "company", [node("d-fo", "Front Office", "department", [person("p-1", "u-1")])]);

beforeEach(() => {
  vi.mocked(routesForShell).mockReset().mockResolvedValue([]);
});

describe("the layout and the routes read", () => {
  it("never reads the routes for the agency pack, and builds a model that awaits none", async () => {
    const me = meFixture([member()], [AGENCY]);
    vi.mocked(getMe).mockResolvedValue(me);
    vi.mocked(getActiveTenant).mockResolvedValue("co-a");
    vi.mocked(myWorkspaces).mockResolvedValue(resolveMyWorkspaces({ me, tenantId: "co-a", root: agencyTree({ web: ["u-1"] }) }));
    const shell = await shellOf();
    expect(routesForShell).not.toHaveBeenCalled();
    expect(shell.props.workspaceModel.awaitsRoutes).toBeUndefined();
    expect(shell.props.routesFeed).toBeUndefined();
  });

  it("starts the read for another pack WITHOUT awaiting it: the model is built in flight and a streamed feed is handed over", async () => {
    const me = meFixture([member("co-h")], [HOTEL]);
    vi.mocked(getMe).mockResolvedValue(me);
    vi.mocked(getActiveTenant).mockResolvedValue("co-h");
    vi.mocked(myWorkspaces).mockResolvedValue(resolveMyWorkspaces({ me, tenantId: "co-h", root: hotelTree() }));
    // A read that never resolves must not hold the layout: it still returns.
    vi.mocked(routesForShell).mockReturnValue(new Promise(() => {}));
    const shell = await shellOf();
    expect(routesForShell).toHaveBeenCalledTimes(1);
    expect(routesForShell).toHaveBeenCalledWith("u-1", "co-h");
    expect(shell.props.workspaceModel.awaitsRoutes).toEqual({ canSend: true });
    expect(shell.props.routesFeed).toBeDefined();
    // Nothing the routes gate is in the first-byte model: the row is marked as waiting, and no 'Ask ...' action is there.
    const fo = shell.props.workspaceModel.workspaces.find((w) => w.id === "d-fo")!;
    expect(fo.rows.work.find((r) => r.key === "requests")?.awaitsRoutes).toBe(true);
    expect(fo.creates.map((c) => c.label)).toEqual(["New task"]);
  });

});
