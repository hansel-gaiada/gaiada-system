import { render, screen, act } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { buildShellModel, applyRoutes, type ShellModel } from "@/lib/shellModel";
import { needsRoutesRead, resolveMyWorkspaces } from "@/lib/workspaceAccess";
import { AGENCY, HOTEL, agencyTree, me as meFixture, member, node, person } from "@/lib/workspaceFixtures";
import type { RequestRoute } from "@/lib/requests";
import { ShellRoutesFeed } from "./ShellRoutesFeed";
import { ShellRoutesSettle, WorkspaceShellProvider, useWorkspaceShell } from "./WorkspaceShellContext";

// DW-10e + DW-9 perf (BFF §60.9): the routes read is NOT on the shell's first-byte path. A company whose pack has the Requests row never reads
// it; any other company builds the model with routes "inflight", which HIDES every routes-gated row and "Ask ..." action, and a streamed child
// settles them: shown when routes exist, hidden when there are none or the read failed.
vi.mock("next/navigation", () => ({ usePathname: () => "/departments/d-fo" }));

const route = (n: number, over: Partial<RequestRoute> = {}): RequestRoute => ({
  routeId: `5a0c0000-0000-4000-8000-00000000000${n}`, kind: "assets", company: { id: "co-a", name: "Gaia Digital Agency" }, unit: { name: "Creatives" }, ...over,
});
const ROUTES = [route(1), route(2, { kind: "engineering", unit: { name: "Web Dev" } })];

const hotelMember = meFixture([member("co-h")], [HOTEL]);
const hotelViewer = meFixture([{ role: "viewer", scopeType: "company", scopeId: "co-h" }], [HOTEL]);
const hotelTree = () => node("root", "Hotel", "company", [node("d-fo", "Front Office", "department", [person("p-1", "u-1")])]);
const hotelModel = (m = hotelMember, routes?: "inflight" | RequestRoute[] | null): ShellModel =>
  buildShellModel({ me: m, tenantId: "co-h", workspaces: resolveMyWorkspaces({ me: m, tenantId: "co-h", root: hotelTree() }), approvals: { pending: 0 }, routes });
const fo = (m: ShellModel) => m.workspaces.find((w) => w.id === "d-fo")!;
const workKeys = (m: ShellModel) => fo(m).rows.work.map((r) => r.key);
const createLabels = (m: ShellModel) => fo(m).creates.map((c) => c.label);

describe("the model built with the routes read in flight", () => {
  it("carries the Requests row marked as awaiting, and no 'Ask ...' create yet", () => {
    const m = hotelModel(hotelMember, "inflight");
    expect(m.awaitsRoutes).toEqual({ canSend: true });
    expect(fo(m).rows.work.find((r) => r.key === "requests")?.awaitsRoutes).toBe(true);
    expect(createLabels(m)).toEqual(["New task"]);
  });

  it("marks nothing for a company that already has the row by its pack (the agency)", () => {
    const m = buildShellModel({
      me: meFixture([member()], [AGENCY]), tenantId: "co-a", approvals: { pending: 0 }, routes: "inflight",
      workspaces: resolveMyWorkspaces({ me: meFixture([member()], [AGENCY]), tenantId: "co-a", root: agencyTree({ web: ["u-1"] }) }),
    });
    const rows = m.workspaces.flatMap((w) => [...w.rows.top, ...w.rows.work, ...w.rows.performance, ...w.rows.you]);
    expect(rows.some((r) => r.awaitsRoutes)).toBe(false);
    expect(rows.some((r) => r.key === "requests")).toBe(true);
  });

  it("is not a routes-aware model when the read is not made: nothing awaits and applyRoutes passes it through as is", () => {
    const m = hotelModel(hotelMember, undefined);
    expect(m.awaitsRoutes).toBeUndefined();
    expect(applyRoutes(m, ROUTES)).toBe(m);
    expect(workKeys(m)).not.toContain("requests");
  });
});

describe("applyRoutes", () => {
  it("HIDES the row and every action while the read is in flight, and withholds the tab's path", () => {
    const m = applyRoutes(hotelModel(hotelMember, "inflight"), "inflight");
    expect(workKeys(m)).not.toContain("requests");
    expect(createLabels(m)).toEqual(["New task"]);
    expect(fo(m).withheld).toContain("/departments/d-fo/requests/sent");
    expect(m.awaitsRoutes).toBeUndefined();
  });

  it("SHOWS the row and one 'Ask ...' create per route once routes exist", () => {
    const m = applyRoutes(hotelModel(hotelMember, "inflight"), ROUTES);
    expect(workKeys(m)).toContain("requests");
    expect(fo(m).rows.work.find((r) => r.key === "requests")).not.toHaveProperty("awaitsRoutes");
    expect(createLabels(m)).toEqual(["New task", "Ask Creatives at Gaia Digital Agency for assets", "Ask Web Dev at Gaia Digital Agency"]);
    expect(fo(m).withheld).not.toContain("/departments/d-fo/requests/sent");
  });

  it("shows the row but offers no 'Ask ...' to a person who may not send across", () => {
    const m = applyRoutes(hotelModel(hotelViewer, "inflight"), ROUTES);
    expect(workKeys(m)).toContain("requests");
    expect(createLabels(m)).toEqual(["New task"]);
  });

  it("keeps everything hidden when there are no routes, and when the read failed", () => {
    for (const read of [[], null] as const) {
      const m = applyRoutes(hotelModel(hotelMember, "inflight"), read);
      expect(workKeys(m), String(read)).not.toContain("requests");
      expect(createLabels(m), String(read)).toEqual(["New task"]);
    }
  });

  it("is the same as building the model with the settled routes in the first place", () => {
    const settled = hotelModel(hotelMember, ROUTES);
    const streamed = applyRoutes(hotelModel(hotelMember, "inflight"), ROUTES);
    expect(workKeys(streamed)).toEqual(workKeys(settled));
    expect(createLabels(streamed)).toEqual(createLabels(settled));
  });
});

describe("the streamed feed", () => {
  it("hands the resolved routes to the client provider, and null when the read failed or the promise rejects", async () => {
    expect((await ShellRoutesFeed({ read: Promise.resolve(ROUTES) })).props.read).toEqual(ROUTES);
    expect((await ShellRoutesFeed({ read: Promise.resolve(null) })).props.read).toBeNull();
    expect((await ShellRoutesFeed({ read: Promise.reject(new Error("boom")) })).props.read).toBeNull();
  });
});

describe("the provider settles the model", () => {
  function Probe() {
    const shell = useWorkspaceShell();
    const ws = shell?.model.workspaces.find((w) => w.id === "d-fo");
    return (
      <p data-testid="p">
        {ws?.rows.work.map((r) => r.key).join(",")} | {ws?.creates.map((c) => c.label).join(",")}
      </p>
    );
  }
  const draw = (read: readonly RequestRoute[] | null | "none") => (
    <WorkspaceShellProvider model={hotelModel(hotelMember, "inflight")}>
      {read === "none" ? null : <ShellRoutesSettle read={read} />}
      <Probe />
    </WorkspaceShellProvider>
  );

  it("hides the routes-gated row and actions before the read arrives", () => {
    render(draw("none"));
    expect(screen.getByTestId("p").textContent).toBe("pm,tools | New task");
  });

  it("shows them when the streamed read arrives with routes", async () => {
    await act(async () => { render(draw(ROUTES)); });
    expect(screen.getByTestId("p").textContent).toBe("pm,requests,tools | New task,Ask Creatives at Gaia Digital Agency for assets,Ask Web Dev at Gaia Digital Agency");
  });

  it("keeps them hidden when the read arrives empty or failed", async () => {
    const empty = await act(async () => render(draw([])));
    expect(screen.getByTestId("p").textContent).toBe("pm,tools | New task");
    empty.unmount();
    await act(async () => { render(draw(null)); });
    expect(screen.getByTestId("p").textContent).toBe("pm,tools | New task");
  });
});

describe("which companies read the routes at all", () => {
  it("the agency pack never does; any other pack does", () => {
    expect(needsRoutesRead(meFixture([member()], [AGENCY]), "co-a")).toBe(false);
    expect(needsRoutesRead(hotelMember, "co-h")).toBe(true);
    expect(needsRoutesRead(hotelMember, null)).toBe(false);
  });
});
