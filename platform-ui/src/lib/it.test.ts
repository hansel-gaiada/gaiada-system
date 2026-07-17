import { describe, it, expect } from "vitest";
import { summarizeHealth, buildTopology, layoutGraph, shortType, type Device, type N8nWorkflow } from "./it";

const dev = (over: Partial<Device>): Device => ({
  id: over.id ?? "d", name: over.name ?? "D", kind: over.kind ?? "other", status: over.status ?? "online", ...over,
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
