import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { KnowledgeStore } from "./store";
import { KnowledgeGraph } from "./graph";
import { PgEpisodicStore } from "../memory/episodic-pg";
import { buildKnowledgeApp, knowledgeConfig } from "./service";
import { TEST_DB_URL as url, testDbReachable } from "./testdb";

const dbUp = await testDbReachable();
const T_A = "bbbbbbbb-0000-4000-8000-000000000001";

async function hashEmbed(text: string): Promise<number[]> {
  const v = new Array<number>(32).fill(0);
  for (const t of text.toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length > 2)) {
    let h = 0;
    for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
    v[h % 32] += 1;
  }
  return v;
}

describe.skipIf(!dbUp)("knowledge service", () => {
  let pool: Pool;
  let app: ReturnType<typeof buildKnowledgeApp>;
  const svc = { authorization: "Bearer know-token" };

  beforeAll(async () => {
    pool = new Pool({ connectionString: url });
    const store = new KnowledgeStore(pool, hashEmbed);
    await store.init();
    const graph = new KnowledgeGraph(pool);
    await pool.query("DROP TABLE IF EXISTS graph_nodes, graph_edges, agent_episodes, agent_episode_feedback");
    await graph.init();
    const episodic = new PgEpisodicStore(pool);
    await episodic.init();
    // Tenant-A graph: client:acme → project:web, plus a cross-company "one brain" node behind it.
    await graph.upsertNode({ tenantId: T_A, entityKey: "client:acme", kind: "client", label: "Acme" });
    await graph.upsertNode({ tenantId: T_A, entityKey: "project:web", kind: "project", label: "Web" });
    await graph.upsertNode({ tenantId: T_A, entityKey: "brand:group", kind: "brand", label: "Group", crossCompany: true });
    await graph.addEdge({ tenantId: T_A, srcKey: "client:acme", rel: "owns", dstKey: "project:web" });
    await graph.addEdge({ tenantId: T_A, srcKey: "client:acme", rel: "rolls_up_to", dstKey: "brand:group" });
    knowledgeConfig.serviceToken = "know-token";
    // Fake platform resolver: tg:555 = a plain tenant-A member; tg:exec = a cross-company owner.
    app = buildKnowledgeApp(
      store,
      async (provider, externalId) => {
        if (provider === "telegram" && externalId === "tg:555") return { tenantSet: [T_A], crossCompany: false };
        if (provider === "telegram" && externalId === "tg:exec") return { tenantSet: [T_A], crossCompany: true };
        return { tenantSet: [], crossCompany: false };
      },
      graph,
      episodic,
    );
    await app.inject({
      method: "POST", url: "/ingest", headers: svc,
      payload: { tenantId: T_A, sourceRef: "svc-doc", acl: [], kind: "doc", chunks: ["diesel delivery arrives thursday morning"], provenance: "human", trust: "trusted" },
    });
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it("fail-closed without the service token", async () => {
    const r = await app.inject({ method: "POST", url: "/search", payload: { query: "x", scope: "s" } });
    expect(r.statusCode).toBe(401);
  });

  it("a resolved envelope searches its own tenant's knowledge", async () => {
    const r = await app.inject({
      method: "POST", url: "/search", headers: { ...svc, "x-obo-provider": "telegram", "x-obo-external-id": "tg:555" },
      payload: { query: "diesel delivery thursday", scope: "anything" },
    });
    const { hits } = r.json() as { hits: Array<{ text: string }> };
    expect(hits[0].text).toContain("diesel");
  });

  it("an unknown envelope resolves to an empty tenant set → zero hits", async () => {
    const r = await app.inject({
      method: "POST", url: "/search", headers: { ...svc, "x-obo-provider": "whatsapp", "x-obo-external-id": "nobody" },
      payload: { query: "diesel delivery thursday", scope: "anything" },
    });
    expect((r.json() as { hits: unknown[] }).hits).toEqual([]);
  });

  it("lists sources for a tenant (service-token gated)", async () => {
    const unauth = await app.inject({ method: "GET", url: `/sources?tenant=${T_A}` });
    expect(unauth.statusCode).toBe(401);

    const missing = await app.inject({ method: "GET", url: "/sources", headers: svc });
    expect(missing.statusCode).toBe(400);

    const r = await app.inject({ method: "GET", url: `/sources?tenant=${T_A}`, headers: svc });
    expect(r.statusCode).toBe(200);
    const rows = r.json() as Array<{ sourceRef: string; status: string; chunks: number }>;
    const doc = rows.find((s) => s.sourceRef === "svc-doc")!;
    expect(doc).toBeTruthy();
    expect(doc.status).toBe("indexed");
    expect(doc.chunks).toBeGreaterThan(0);
  });

  it("graph traversal honors the resolved tenant set; cross-company node hidden for a plain member", async () => {
    const r = await app.inject({
      method: "POST", url: "/graph/neighbors", headers: { ...svc, "x-obo-provider": "telegram", "x-obo-external-id": "tg:555" },
      payload: { startKey: "client:acme", scope: "public" },
    });
    const keys = (r.json() as { nodes: Array<{ entityKey: string }> }).nodes.map((n) => n.entityKey);
    expect(keys).toContain("project:web");
    expect(keys).not.toContain("brand:group"); // cross-company, member not elevated
  });

  it("a group_executive (crossCompany attested) sees the cross-company one-brain node", async () => {
    const r = await app.inject({
      method: "POST", url: "/graph/neighbors", headers: { ...svc, "x-obo-provider": "telegram", "x-obo-external-id": "tg:exec" },
      payload: { startKey: "client:acme", scope: "public" },
    });
    const keys = (r.json() as { nodes: Array<{ entityKey: string }> }).nodes.map((n) => n.entityKey);
    expect(keys).toContain("brand:group");
  });

  it("an unknown envelope gets no graph nodes", async () => {
    const r = await app.inject({
      method: "POST", url: "/graph/neighbors", headers: { ...svc, "x-obo-provider": "whatsapp", "x-obo-external-id": "nobody" },
      payload: { startKey: "client:acme", scope: "public" },
    });
    expect((r.json() as { nodes: unknown[] }).nodes).toEqual([]);
  });

  it("graph ingestion turns a platform event into nodes+edges that are then traversable", async () => {
    const ing = await app.inject({
      method: "POST", url: "/graph/ingest", headers: svc,
      payload: { eventType: "project.created", tenantId: T_A, entityType: "project", entityId: "p2", payload: { title: "Rebrand", clientId: "acme" } },
    });
    expect(ing.statusCode).toBe(200);
    expect((ing.json() as { nodes: number; edges: number }).edges).toBe(1); // client:acme -owns-> project:p2
    const r = await app.inject({
      method: "POST", url: "/graph/neighbors", headers: { ...svc, "x-obo-provider": "telegram", "x-obo-external-id": "tg:555" },
      payload: { startKey: "client:acme", scope: "public" },
    });
    expect((r.json() as { nodes: Array<{ entityKey: string }> }).nodes.map((n) => n.entityKey)).toContain("project:p2");
  });

  it("feedback is TRUSTED for a resolved member and QUARANTINED for an unresolved caller (D9.3)", async () => {
    const trusted = await app.inject({
      method: "POST", url: "/feedback", headers: { ...svc, "x-obo-provider": "telegram", "x-obo-external-id": "tg:555" },
      payload: { runId: "eval:run-1", rating: "up", note: "great" },
    });
    expect(trusted.json()).toMatchObject({ ok: true, trust: "trusted" });
    const quarantined = await app.inject({
      method: "POST", url: "/feedback", headers: { ...svc, "x-obo-provider": "whatsapp", "x-obo-external-id": "nobody" },
      payload: { runId: "eval:run-1", rating: "down" },
    });
    expect(quarantined.json()).toMatchObject({ ok: true, trust: "untrusted" });
  });

  it("erase hard-deletes by source", async () => {
    const r = await app.inject({ method: "POST", url: "/erase", headers: svc, payload: { sourceRef: "svc-doc" } });
    expect((r.json() as { deleted: number }).deleted).toBeGreaterThan(0);
  });
});
