import { describe, it, expect } from "vitest";
import {
  summarizeHealth, buildTopology, buildGraph, countNodes, describeLastSync, isDiscoveryStale,
  layoutGraph, shortType, type Device, type DeviceLink, type DiscoveryRun, type N8nWorkflow,
} from "./it";

const dev = (over: Partial<Device>): Device => ({
  id: over.id ?? "d", name: over.name ?? "D", kind: over.kind ?? "other", status: over.status ?? "online", ...over,
});
const link = (child: string, parent: string, over: Partial<DeviceLink> = {}): DeviceLink => ({
  childDeviceId: child, parentDeviceId: parent, port: null, medium: "wireless", ...over,
});

describe("summarizeHealth", () => {
  it("counts devices by status", () => {
    const s = summarizeHealth([
      dev({ status: "online" }), dev({ status: "online" }), dev({ status: "offline" }),
      dev({ status: "degraded" }), dev({ status: "unknown" }),
    ]);
    expect(s).toEqual({ total: 5, online: 2, degraded: 1, offline: 1, unknown: 1 });
  });
});

describe("buildTopology", () => {
  it("groups by site then network and sorts, pushing Unassigned last", () => {
    const sites = buildTopology([
      dev({ id: "a", name: "A", site: "HQ", network: "Core" }),
      dev({ id: "b", name: "B", site: "HQ", network: "Core" }),
      dev({ id: "c", name: "C", site: "HQ", network: "CCTV" }),
      dev({ id: "d", name: "D" }), // no site/network -> Unassigned/Unassigned
    ]);
    expect(sites.map((s) => s.name)).toEqual(["HQ", "Unassigned"]);
    const hq = sites[0];
    expect(hq.networks.map((n) => n.name)).toEqual(["CCTV", "Core"]);
    expect(hq.networks.find((n) => n.name === "Core")!.devices.map((d) => d.name)).toEqual(["A", "B"]);
  });
});

// IT-06 — the real topology forest, replacing the free-text regroup above.
describe("buildGraph", () => {
  // The shape actually observed in the office: gateway → one AP → wireless clients.
  const gw = dev({ id: "gw", name: "Gateway", kind: "network", deviceClass: "infrastructure" });
  const ap = dev({ id: "ap", name: "AP Office", kind: "network", deviceClass: "infrastructure" });
  const c1 = dev({ id: "c1", name: "GDA-01", kind: "workstation" });
  const c2 = dev({ id: "c2", name: "GDA-07", kind: "workstation" });

  it("nests children under parents and sorts siblings by name", () => {
    const g = buildGraph([gw, ap, c2, c1], [
      link("ap", "gw", { medium: "wired", port: 3 }),
      link("c1", "ap"),
      link("c2", "ap"),
    ]);
    expect(g.roots.map((r) => r.device.id)).toEqual(["gw"]);
    const apNode = g.roots[0].children[0];
    expect(apNode.device.id).toBe("ap");
    expect(apNode.medium).toBe("wired");
    expect(apNode.port).toBe(3);
    expect(apNode.children.map((c) => c.device.name)).toEqual(["GDA-01", "GDA-07"]);
    expect(g.unlinked).toEqual([]);
    expect(countNodes(g.roots)).toBe(4);
  });

  it("puts devices with no edge at all in `unlinked` rather than dropping them", () => {
    // Hand-registered devices never report an uplink; silently omitting them would make the map
    // disagree with the device list.
    const manual = dev({ id: "m", name: "Office Printer", kind: "printer" });
    const g = buildGraph([gw, ap, manual], [link("ap", "gw")]);
    expect(g.roots.map((r) => r.device.id)).toEqual(["gw"]);
    expect(g.unlinked.map((d) => d.id)).toEqual(["m"]);
    expect(countNodes(g.roots) + g.unlinked.length).toBe(3);
  });

  it("treats a child whose parent is missing from the device list as a root", () => {
    const g = buildGraph([c1], [link("c1", "ghost")]);
    // The dangling edge is ignored entirely, so c1 is simply unlinked — never a crash and never a
    // phantom "ghost" node in the drawing.
    expect(g.roots).toEqual([]);
    expect(g.unlinked.map((d) => d.id)).toEqual(["c1"]);
  });

  it("breaks a cycle instead of recursing forever", () => {
    // The DB's unique-child index makes this near-impossible, but a ring would hang the render.
    const a = dev({ id: "a", name: "A" });
    const b = dev({ id: "b", name: "B" });
    const g = buildGraph([a, b], [link("a", "b"), link("b", "a")]);
    expect(countNodes(g.roots)).toBeLessThanOrEqual(2);
  });

  it("handles an empty estate", () => {
    const g = buildGraph([], []);
    expect(g).toEqual({ roots: [], unlinked: [] });
  });
});

describe("isDiscoveryStale", () => {
  const now = new Date("2026-08-03T12:00:00Z");
  const run = (over: Partial<DiscoveryRun> = {}): DiscoveryRun => ({
    startedAt: "2026-08-03T11:58:00Z", finishedAt: "2026-08-03T11:58:30Z",
    ok: true, devicesSeen: 58, byodCount: 25, error: null, ...over,
  });

  it("no run at all is stale — silence must never read as 'all clear'", () => {
    expect(isDiscoveryStale(null, now)).toBe(true);
  });
  it("a fresh successful run is not stale", () => {
    expect(isDiscoveryStale(run(), now)).toBe(false);
  });
  it("a failed run is stale even if recent", () => {
    expect(isDiscoveryStale(run({ ok: false }), now)).toBe(true);
  });
  it("an old run is stale", () => {
    expect(isDiscoveryStale(run({ finishedAt: "2026-08-03T11:00:00Z" }), now)).toBe(true);
  });
  it("falls back to startedAt when the run never finished, and copes with junk", () => {
    expect(isDiscoveryStale(run({ finishedAt: null }), now)).toBe(false);
    expect(isDiscoveryStale(run({ finishedAt: null, startedAt: null }), now)).toBe(true);
    expect(isDiscoveryStale(run({ finishedAt: "nonsense" }), now)).toBe(true);
  });
});

describe("describeLastSync", () => {
  const now = new Date("2026-08-03T12:00:00Z");
  it("words the age in the largest sensible unit", () => {
    expect(describeLastSync(null, now)).toBe("never");
    expect(describeLastSync({ startedAt: null, finishedAt: "2026-08-03T11:59:40Z", ok: true, devicesSeen: 1, byodCount: 0, error: null }, now)).toBe("just now");
    expect(describeLastSync({ startedAt: null, finishedAt: "2026-08-03T11:56:00Z", ok: true, devicesSeen: 1, byodCount: 0, error: null }, now)).toBe("4 min ago");
    expect(describeLastSync({ startedAt: null, finishedAt: "2026-08-03T09:00:00Z", ok: true, devicesSeen: 1, byodCount: 0, error: null }, now)).toBe("3h ago");
    expect(describeLastSync({ startedAt: null, finishedAt: "2026-08-01T12:00:00Z", ok: true, devicesSeen: 1, byodCount: 0, error: null }, now)).toBe("2d ago");
  });
});

describe("layoutGraph", () => {
  const wf: N8nWorkflow = {
    id: "w", name: "w",
    nodes: [
      { name: "A", type: "n8n-nodes-base.webhook", position: [100, 200] },
      { name: "B", type: "n8n-nodes-base.httpRequest", position: [400, 200] },
      { name: "C", type: "n8n-nodes-base.openAi", position: [700, 260] },
    ],
    connections: {
      A: { main: [[{ node: "B", type: "main", index: 0 }]] },
      B: { main: [[{ node: "C", type: "main", index: 0 }, { node: "missing", type: "main", index: 0 }]] },
    },
  };

  it("positions nodes, shortens types, and resolves edges (dropping dangling targets)", () => {
    const g = layoutGraph(wf);
    expect(g.nodes.map((n) => n.type)).toEqual(["webhook", "httpRequest", "openAi"]);
    expect(g.edges).toEqual([{ from: "A", to: "B" }, { from: "B", to: "C" }]);
    expect(g.bounds).toEqual({ minX: 100, minY: 200, maxX: 700, maxY: 260 });
  });

  it("handles a null workflow safely", () => {
    const g = layoutGraph(null);
    expect(g.nodes).toEqual([]);
    expect(g.edges).toEqual([]);
  });
});

describe("shortType", () => {
  it("takes the segment after the last dot", () => {
    expect(shortType("n8n-nodes-base.scheduleTrigger")).toBe("scheduleTrigger");
    expect(shortType("plain")).toBe("plain");
  });
});
