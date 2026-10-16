import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactElement } from "react";
import { AGENCY, HOTEL, agencyTree, me as meFixture, member, node, person } from "@/lib/workspaceFixtures";
import { resolveMyWorkspaces } from "@/lib/workspaceAccess";
import type { RequestRoute } from "@/lib/requests";

// DW-10e + DW-9 perf: the Overview frame awaits the routes only for a company whose pack lacks the Requests row (it is a page under loading.tsx,
// already off the shell's first-byte path, and the read is the layout's own memoised promise). The agency pack never reads them.
vi.mock("@/lib/prefs", async () => {
  const actual = await vi.importActual<typeof import("@/lib/prefs")>("@/lib/prefs");
  return { ...actual, getPrefs: vi.fn(async () => actual.DEFAULT_PREFS) };
});
vi.mock("@/lib/modules", () => ({ moduleGate: vi.fn(async () => ({ isEnabled: () => true })) }));
vi.mock("@/lib/workspaces-data", () => ({ myWorkspaces: vi.fn() }));
vi.mock("@/lib/requests-data", () => ({ routesForShell: vi.fn() }));
vi.mock("@/lib/prefsActions", () => ({ setOverviewWidgetAction: vi.fn() }));
vi.mock("./WorkspaceOverview", () => ({ WorkspaceOverview: () => null }));

import { myWorkspaces } from "@/lib/workspaces-data";
import { routesForShell } from "@/lib/requests-data";
import { pilotFrame } from "./pilot";

const ROUTES: RequestRoute[] = [{ routeId: "r-1", kind: "assets", company: { id: "co-a", name: "Gaia" }, unit: { name: "Creatives" } }];
const hotelTree = () => node("root", "Hotel", "company", [node("d-fo", "Front Office", "department", [person("p-1", "u-1")])]);
const sp = Promise.resolve({});
const subjectOf = (frame: NonNullable<Awaited<ReturnType<typeof pilotFrame>>>) => (frame(null) as ReactElement<{ subject: { routes?: unknown } }>).props.subject;

beforeEach(() => {
  vi.mocked(routesForShell).mockReset().mockResolvedValue(ROUTES);
});

describe("pilotFrame and the routes", () => {
  it("never reads them for the agency pack", async () => {
    const me = meFixture([member()], [AGENCY]);
    vi.mocked(myWorkspaces).mockResolvedValue(resolveMyWorkspaces({ me, tenantId: "co-a", root: agencyTree({ web: ["u-1"] }) }));
    const frame = await pilotFrame(me, "co-a", { deptId: "d-web" }, sp);
    expect(frame).not.toBeNull();
    expect(routesForShell).not.toHaveBeenCalled();
    expect(subjectOf(frame!).routes).toBeUndefined();
  });

  it("awaits them for another pack, and hands them to the Overview for its gate and its per-route actions", async () => {
    const me = meFixture([member("co-h")], [HOTEL]);
    vi.mocked(myWorkspaces).mockResolvedValue(resolveMyWorkspaces({ me, tenantId: "co-h", root: hotelTree() }));
    const frame = await pilotFrame(me, "co-h", { deptId: "d-fo" }, sp);
    expect(routesForShell).toHaveBeenCalledWith("u-1", "co-h");
    expect(subjectOf(frame!).routes).toEqual(ROUTES);
  });

  it("a failed read (null) is handed over as such, which hides every routes-gated block and action", async () => {
    const me = meFixture([member("co-h")], [HOTEL]);
    vi.mocked(myWorkspaces).mockResolvedValue(resolveMyWorkspaces({ me, tenantId: "co-h", root: hotelTree() }));
    vi.mocked(routesForShell).mockResolvedValue(null);
    const frame = await pilotFrame(me, "co-h", { deptId: "d-fo" }, sp);
    expect(subjectOf(frame!).routes).toBeNull();
  });
});
