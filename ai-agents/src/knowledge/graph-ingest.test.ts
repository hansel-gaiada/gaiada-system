// WS8 Step E ingestion — the event→graph mapping (pure) and its application to a graph (via a spy).
import { describe, it, expect } from "vitest";
import { eventToGraph, ingestEvent, type PlatformEvent } from "./graph-ingest";
import type { GraphNode, GraphEdge } from "./graph";

describe("graph ingestion (WS8 Step E)", () => {
  it("maps an entity event to a source-of-truth node", () => {
    const m = eventToGraph({ eventType: "client.created", tenantId: "co-1", entityType: "client", entityId: "acme", payload: { name: "Acme" } });
    expect(m.nodes).toEqual([{ tenantId: "co-1", entityKey: "client:acme", kind: "client", label: "Acme", provenance: "human", sourceRef: "client:acme" }]);
    expect(m.edges).toEqual([]);
  });

  it("derives ownership/parent edges from payload foreign keys", () => {
    const project = eventToGraph({ eventType: "project.created", tenantId: "co-1", entityType: "project", entityId: "p1", payload: { title: "Website", clientId: "acme" } });
    expect(project.edges).toContainEqual({ tenantId: "co-1", srcKey: "client:acme", rel: "owns", dstKey: "project:p1", provenance: "human" });
    // entityType === project ⇒ no self "has" edge from projectId
    expect(project.edges.find((e) => e.rel === "has")).toBeUndefined();

    const task = eventToGraph({ eventType: "task.created", tenantId: "co-1", entityType: "task", entityId: "t1", payload: { projectId: "p1", assigneeId: "u9" } });
    expect(task.edges).toContainEqual({ tenantId: "co-1", srcKey: "project:p1", rel: "has", dstKey: "task:t1", provenance: "human" });
    expect(task.edges).toContainEqual({ tenantId: "co-1", srcKey: "task:t1", rel: "assigned_to", dstKey: "person:u9", provenance: "human" });
  });

  it("falls back to the bare entity id for a label when no name/title", () => {
    const m = eventToGraph({ eventType: "deliverable.updated", tenantId: "co-1", entityType: "deliverable", entityId: "d1" });
    expect(m.nodes[0].label).toBe("d1");
  });

  it("ingestEvent upserts nodes then edges on the graph", async () => {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const spy = { upsertNode: async (n: GraphNode) => void nodes.push(n), addEdge: async (e: GraphEdge) => void edges.push(e) };
    const e: PlatformEvent = { eventType: "task.created", tenantId: "co-1", entityType: "task", entityId: "t1", payload: { projectId: "p1" } };
    const m = await ingestEvent(spy, e);
    expect(nodes.map((n) => n.entityKey)).toEqual(["task:t1"]);
    expect(edges.map((x) => x.rel)).toEqual(["has"]);
    expect(m.nodes).toHaveLength(1);
  });
});
