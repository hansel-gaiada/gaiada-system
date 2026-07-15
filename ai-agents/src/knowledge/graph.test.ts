// WS8 Step E — knowledge-graph D9 invariants: tenant + acl retrieval-time pre-filter (D9.1), the
// cross-company one-brain gate, bounded traversal, and erasure (D9.2). DB-backed; skips cleanly
// without a reachable DATABASE_URL_TEST.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { KnowledgeGraph } from "./graph";
import { TEST_DB_URL as url, testDbReachable } from "./testdb";

const dbUp = await testDbReachable();
const T_A = "cccccccc-0000-4000-8000-000000000001";
const T_B = "cccccccc-0000-4000-8000-000000000002";

describe.skipIf(!dbUp)("knowledge graph (D9)", () => {
  let pool: Pool;
  let g: KnowledgeGraph;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url });
    await pool.query("DROP TABLE IF EXISTS graph_nodes, graph_edges");
    g = new KnowledgeGraph(pool);
    await g.init();

    // Tenant A: acme → website → alice; a scope-restricted bob; a cross-company brand node.
    await g.upsertNode({ tenantId: T_A, entityKey: "client:acme", kind: "client", label: "Acme" });
    await g.upsertNode({ tenantId: T_A, entityKey: "project:website", kind: "project", label: "Website" });
    await g.upsertNode({ tenantId: T_A, entityKey: "person:alice", kind: "person", label: "Alice" });
    await g.upsertNode({ tenantId: T_A, entityKey: "person:bob", kind: "person", label: "Bob", acl: ["proj-secret"] });
    await g.upsertNode({ tenantId: T_A, entityKey: "brand:one-brain", kind: "brand", label: "Group Brand", crossCompany: true });
    await g.addEdge({ tenantId: T_A, srcKey: "client:acme", rel: "owns", dstKey: "project:website" });
    await g.addEdge({ tenantId: T_A, srcKey: "project:website", rel: "assigned_to", dstKey: "person:alice" });
    await g.addEdge({ tenantId: T_A, srcKey: "project:website", rel: "assigned_to", dstKey: "person:bob" });
    await g.addEdge({ tenantId: T_A, srcKey: "client:acme", rel: "rolls_up_to", dstKey: "brand:one-brain" });

    // Tenant B: a separate client, invisible to A.
    await g.upsertNode({ tenantId: T_B, entityKey: "client:other", kind: "client", label: "Other" });
  });
  afterAll(async () => {
    await pool.query("DROP TABLE IF EXISTS graph_nodes, graph_edges");
    await pool.end();
  });

  const ctxA = { tenantSet: [T_A], scope: "public" };

  it("D9.1: bounded BFS returns the tenant's reachable nodes (acl-open) and no restricted node", async () => {
    const hits = await g.neighbors("client:acme", ctxA);
    const keys = hits.map((h) => h.entityKey).sort();
    expect(keys).toContain("client:acme"); // start (depth 0)
    expect(keys).toContain("project:website"); // depth 1
    expect(keys).toContain("person:alice"); // depth 2
    expect(keys).not.toContain("person:bob"); // acl-restricted to proj-secret
    expect(keys).not.toContain("brand:one-brain"); // cross-company, caller not elevated
  });

  it("acl scope grants a restricted node only when the scope matches", async () => {
    const hits = await g.neighbors("client:acme", { tenantSet: [T_A], scope: "proj-secret" });
    expect(hits.map((h) => h.entityKey)).toContain("person:bob");
  });

  it("cross-company one-brain node is invisible unless the caller is cross-company-elevated", async () => {
    const notElevated = await g.neighbors("client:acme", ctxA);
    expect(notElevated.map((h) => h.entityKey)).not.toContain("brand:one-brain");
    const elevated = await g.neighbors("client:acme", { ...ctxA, crossCompany: true });
    expect(elevated.map((h) => h.entityKey)).toContain("brand:one-brain");
  });

  it("tenant isolation: another tenant's start node is invisible (empty result)", async () => {
    expect(await g.neighbors("client:other", ctxA)).toEqual([]);
    // ...and a B caller cannot reach A's graph:
    expect(await g.neighbors("client:acme", { tenantSet: [T_B], scope: "public" })).toEqual([]);
  });

  it("no tenant context ⇒ nothing, ever", async () => {
    expect(await g.neighbors("client:acme", { tenantSet: [], scope: "public" })).toEqual([]);
  });

  it("maxDepth bounds the walk", async () => {
    const d1 = await g.neighbors("client:acme", { ...ctxA, maxDepth: 1 });
    expect(d1.map((h) => h.entityKey).sort()).toEqual(["client:acme", "project:website"]); // no depth-2 alice
  });

  it("a relation filter restricts which edges are traversed", async () => {
    const owns = await g.neighbors("client:acme", ctxA, { rel: "owns" });
    expect(owns.map((h) => h.entityKey)).toContain("project:website");
    expect(owns.map((h) => h.entityKey)).not.toContain("person:alice"); // reached via assigned_to, filtered out
  });

  it("D9.2: eraseTenant hard-deletes the tenant's nodes + edges", async () => {
    const g2 = new KnowledgeGraph(pool);
    await g2.upsertNode({ tenantId: T_B, entityKey: "client:tmp", kind: "client", label: "Tmp" });
    const deleted = await g2.eraseTenant(T_B);
    expect(deleted).toBeGreaterThanOrEqual(1);
    expect(await g2.neighbors("client:other", { tenantSet: [T_B], scope: "public" })).toEqual([]);
  });
});
