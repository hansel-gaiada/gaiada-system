// WS8 Step E ingestion wire — populate the knowledge graph from platform business events. The event
// backbone already fans out `{ eventType, tenantId, entityType, entityId, payload }` (WS1 outbox →
// relay); this maps each event to graph nodes + typed edges. Platform events are SOURCE-OF-TRUTH, so
// derived nodes carry provenance "human" (distinguishable from agent-asserted relations, D9.3).
//
// `eventToGraph` is a pure, deterministic mapping (unit-tested without a DB); `ingestEvent` applies it to
// a KnowledgeGraph. A live consumer subscribes the same way the n8n bridge does and calls ingestEvent.
import type { GraphNode, GraphEdge, KnowledgeGraph } from "./graph";

export interface PlatformEvent {
  eventType: string; // e.g. client.created, project.created, deliverable.updated
  tenantId: string;
  entityType: string; // e.g. client, project, deliverable
  entityId: string;
  payload?: Record<string, unknown>;
}

export interface GraphMutation {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

function label(e: PlatformEvent): string {
  const p = e.payload ?? {};
  return String(p.name ?? p.title ?? p.label ?? e.entityId);
}

/** Map a platform event to the graph nodes/edges it implies. Deterministic + side-effect-free. */
export function eventToGraph(e: PlatformEvent): GraphMutation {
  const key = `${e.entityType}:${e.entityId}`;
  const sourceRef = key;
  const nodes: GraphNode[] = [
    { tenantId: e.tenantId, entityKey: key, kind: e.entityType, label: label(e), provenance: "human", sourceRef },
  ];
  const edges: GraphEdge[] = [];
  const p = e.payload ?? {};

  // Parent/ownership relations we can derive from common foreign keys in the payload.
  if (typeof p.clientId === "string") {
    edges.push({ tenantId: e.tenantId, srcKey: `client:${p.clientId}`, rel: "owns", dstKey: key, provenance: "human" });
  }
  if (typeof p.projectId === "string" && e.entityType !== "project") {
    edges.push({ tenantId: e.tenantId, srcKey: `project:${p.projectId}`, rel: "has", dstKey: key, provenance: "human" });
  }
  if (typeof p.campaignId === "string") {
    edges.push({ tenantId: e.tenantId, srcKey: `campaign:${p.campaignId}`, rel: "includes", dstKey: key, provenance: "human" });
  }
  if (typeof p.assigneeId === "string") {
    edges.push({ tenantId: e.tenantId, srcKey: key, rel: "assigned_to", dstKey: `person:${p.assigneeId}`, provenance: "human" });
  }
  return { nodes, edges };
}

/** Apply an event's mutation to the graph (upsert nodes, then edges). Returns what was written. */
export async function ingestEvent(graph: Pick<KnowledgeGraph, "upsertNode" | "addEdge">, e: PlatformEvent): Promise<GraphMutation> {
  const m = eventToGraph(e);
  for (const n of m.nodes) await graph.upsertNode(n);
  for (const edge of m.edges) await graph.addEdge(edge);
  return m;
}
