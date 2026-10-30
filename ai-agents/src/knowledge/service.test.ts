import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { Pool } from "pg";
import { KnowledgeStore, parseDepartmentBoost, type Hit, type IngestDoc, type SearchCtx } from "./store";
import { KnowledgeGraph } from "./graph";
import { PgEpisodicStore } from "../memory/episodic-pg";
import { buildKnowledgeApp, GatewayBudgetError, knowledgeConfig } from "./service";
import { TEST_DB_URL as url, testDbReachable } from "./testdb";

const dbUp = await testDbReachable();
const T_A = "bbbbbbbb-0000-4000-8000-000000000001";

/** The embedding width these tests use. The store must be built with the SAME `dim`: on pgvector the column is `vector(dim)` and
 *  a vector of another length is a hard INSERT error, while plain Postgres (a float array) accepts any length. Until AIP-03d
 *  (2026-10-30) the stores here took the default 768 against 32-wide vectors, so this file passed only on plain Postgres. */
const DIMS = 32;
async function hashEmbed(text: string): Promise<number[]> {
  const v = new Array<number>(DIMS).fill(0);
  for (const t of text.toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length > 2)) {
    let h = 0;
    for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
    v[h % DIMS] += 1;
  }
  if (!v.some((x) => x !== 0)) v[DIMS - 1] = 1; // pgvector's cosine of an all-zero vector is NaN
  return v;
}

describe.skipIf(!dbUp)("knowledge service", () => {
  let pool: Pool;
  let app: ReturnType<typeof buildKnowledgeApp>;
  const svc = { authorization: "Bearer know-token" };

  beforeAll(async () => {
    pool = new Pool({ connectionString: url });
    // The suites share one test database and run one file at a time; store.test.ts leaves a table of ITS width behind.
    await pool.query("DROP TABLE IF EXISTS knowledge_chunks");
    const store = new KnowledgeStore(pool, hashEmbed, { dim: DIMS });
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

  // ⚠ UPDATED 2026-08-26 — this assertion was STALE and had been red on main, which is worse than
  // useless: it reads as a tenant-isolation leak to anyone who looks, and a red test masks the next
  // real failure.
  //
  // It predates D9.4's two-tier corpus. `audience: "public"` (the gaiada.com crawl) is readable with
  // NO identity at all, on purpose — that is how a lead or client on WhatsApp gets an answer, and the
  // live estate verified an anonymous caller receiving public hits. So "unknown envelope -> zero
  // hits" stopped being the design, and the test kept asserting it.
  //
  // The property that DOES still matter is narrower and is what is asserted now: an unknown envelope
  // may see the public tier and must NEVER see `internal`. Asserting zero hits tested isolation only
  // by accident; asserting "public only" tests it on purpose.
  it("an unknown envelope sees the PUBLIC tier only — never internal", async () => {
    const r = await app.inject({
      method: "POST", url: "/search", headers: { ...svc, "x-obo-provider": "whatsapp", "x-obo-external-id": "nobody" },
      payload: { query: "diesel delivery thursday", scope: "anything" },
    });
    const { hits } = r.json() as { hits: Array<{ audience?: string }> };
    expect(hits.every((h) => h.audience === "public")).toBe(true);
    expect(hits.some((h) => h.audience === "internal")).toBe(false);
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

  it("a platform_admin (crossCompany attested) sees the cross-company one-brain node", async () => {
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

// The gateway's 429 on /embed must reach the platform as a 429 on /ingest (its sweep stops on that
// status), with the stored source untouched.
describe.skipIf(!dbUp)("knowledge service: embedding budget refusal", () => {
  let pool: Pool;
  let app: ReturnType<typeof buildKnowledgeApp>;
  const svc = { authorization: "Bearer know-token" };
  const REF = "budget-doc";
  let refuse = false;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url });
    const store = new KnowledgeStore(
      pool,
      async (t) => {
        if (refuse) throw new GatewayBudgetError();
        return hashEmbed(t);
      },
      { dim: DIMS },
    );
    await store.init();
    knowledgeConfig.serviceToken = "know-token";
    app = buildKnowledgeApp(store, async () => ({ tenantSet: [], crossCompany: false }));
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM knowledge_chunks WHERE source_ref = $1`, [REF]);
    await app.close();
    await pool.end();
  });

  it("a gateway 429 answers /ingest 429 and leaves the stored chunks as they were", async () => {
    const payload = { tenantId: T_A, sourceRef: REF, acl: [], kind: "doc", chunks: ["budget paragraph one"], provenance: "human", trust: "trusted" };
    const ok = await app.inject({ method: "POST", url: "/ingest", headers: svc, payload });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ written: 1, embedded: 1, reused: 0 });

    refuse = true;
    const refused = await app.inject({ method: "POST", url: "/ingest", headers: svc, payload: { ...payload, chunks: ["budget paragraph one", "a new paragraph"] } });
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toEqual({ error: "embedding_budget_exhausted" });
    const { rows } = await pool.query(`SELECT text FROM knowledge_chunks WHERE source_ref = $1`, [REF]);
    expect(rows).toEqual([{ text: "budget paragraph one" }]);

    // An unchanged re-ingest needs no embedding, so it succeeds even while the budget is gone.
    const unchanged = await app.inject({ method: "POST", url: "/ingest", headers: svc, payload });
    expect(unchanged.statusCode).toBe(200);
    expect(unchanged.json()).toEqual({ written: 1, embedded: 0, reused: 1 });
    refuse = false;
  });
});

// AIP-11 / AIP-12 at the HTTP edge. A recording stub stands in for the store, so these run without a database: what is
// proved here is what the service passes DOWN (and what it refuses to), and the store's own behaviour is proved in store.test.ts.
describe("knowledge service: department on /ingest and /search (AIP-11/12)", () => {
  const svc = { authorization: "Bearer know-token" };
  const member = { ...svc, "x-obo-provider": "telegram", "x-obo-external-id": "tg:555" };
  const DEPT_TENANT = "bbbbbbbb-0000-4000-8000-0000000000d1";
  const ingested: IngestDoc[] = [];
  const searched: Array<{ query: string; ctx: SearchCtx }> = [];
  let hitsToReturn: Hit[] = [];
  let app: ReturnType<typeof buildKnowledgeApp>;
  let savedBoost: number;
  let savedToken: string;

  beforeAll(() => {
    savedToken = knowledgeConfig.serviceToken;
    savedBoost = knowledgeConfig.departmentBoost;
    knowledgeConfig.serviceToken = "know-token";
    const stub = {
      ingestDetailed: async (doc: IngestDoc) => {
        ingested.push(doc);
        return { written: doc.chunks.length, embedded: doc.chunks.length, reused: 0 };
      },
      search: async (query: string, ctx: SearchCtx) => {
        searched.push({ query, ctx });
        return hitsToReturn;
      },
    } as unknown as KnowledgeStore;
    app = buildKnowledgeApp(stub, async () => ({ tenantSet: [T_A], crossCompany: false }));
  });
  beforeEach(() => {
    ingested.length = 0;
    searched.length = 0;
    hitsToReturn = [];
    knowledgeConfig.departmentBoost = savedBoost;
  });
  afterAll(async () => {
    knowledgeConfig.serviceToken = savedToken;
    knowledgeConfig.departmentBoost = savedBoost;
    await app.close();
  });

  const ingest = (extra: Record<string, unknown>) =>
    app.inject({
      method: "POST", url: "/ingest", headers: svc,
      payload: { tenantId: T_A, sourceRef: "dept-svc", acl: [], kind: "doc", chunks: ["a paragraph"], provenance: "human", trust: "trusted", ...extra },
    });
  const search = (extra: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/search", headers: member, payload: { query: "diesel", scope: "s", ...extra } });

  it("/ingest passes a valid departmentId down, trimmed", async () => {
    expect((await ingest({ departmentId: "d-seo" })).statusCode).toBe(200);
    expect((await ingest({ departmentId: "  d-seo  " })).statusCode).toBe(200);
    expect(ingested.map((d) => d.departmentId)).toEqual(["d-seo", "d-seo"]);
  });

  it("/ingest coerces a missing, wrong-typed, blank or over-long departmentId to null and never answers 400", async () => {
    for (const bad of [undefined, null, "", "   ", 7, true, {}, ["d-seo"], "x".repeat(101)]) {
      const r = await ingest(bad === undefined ? {} : { departmentId: bad });
      expect(r.statusCode).toBe(200);
    }
    expect(ingested).toHaveLength(9);
    for (const d of ingested) expect(d.departmentId).toBeNull();
  });

  it("/search passes a valid department and the configured boost through", async () => {
    knowledgeConfig.departmentBoost = 1.5;
    expect((await search({ department: { tenantId: DEPT_TENANT, nodeId: "d-seo" } })).statusCode).toBe(200);
    expect(searched).toHaveLength(1);
    expect(searched[0].ctx.department).toEqual({ tenantId: DEPT_TENANT, nodeId: "d-seo" });
    expect(searched[0].ctx.departmentBoost).toBe(1.5);
    expect(searched[0].ctx.tenantSet).toEqual([T_A]); // the tenant set is still the resolved envelope's, never the department's
  });

  it("/search IGNORES an invalid department: no boost, never an error", async () => {
    const bad: unknown[] = [
      "d-seo", 5, [], null,
      { tenantId: "not-a-uuid", nodeId: "d-seo" },
      { tenantId: DEPT_TENANT },
      { tenantId: DEPT_TENANT, nodeId: "" },
      { tenantId: DEPT_TENANT, nodeId: "x".repeat(101) },
      { tenantId: 9, nodeId: "d-seo" },
      { tenantId: DEPT_TENANT, nodeId: 9 },
    ];
    for (const department of bad) expect((await search({ department })).statusCode).toBe(200);
    expect((await search({})).statusCode).toBe(200); // and no department at all is today's call
    expect(searched).toHaveLength(bad.length + 1);
    for (const s of searched) expect(s.ctx.department).toBeUndefined();
  });

  it("/search returns departmentId on every hit", async () => {
    hitsToReturn = [
      { tenantId: T_A, sourceRef: "erp:project:1", kind: "doc", text: "t", provenance: "human", confidence: 1, score: 0.9, audience: "internal", departmentId: "d-seo" },
      { tenantId: T_A, sourceRef: "erp:client:1", kind: "doc", text: "t", provenance: "human", confidence: 1, score: 0.8, audience: "internal", departmentId: null },
    ];
    const r = await search({});
    expect((r.json() as { hits: Hit[] }).hits.map((h) => h.departmentId)).toEqual(["d-seo", null]);
  });

  it("the boost env: KNOWLEDGE_DEPARTMENT_BOOST is read through the clamp (default 1.25, NaN or missing 1.25, [1, 2])", () => {
    expect(knowledgeConfig.departmentBoost).toBe(parseDepartmentBoost(process.env.KNOWLEDGE_DEPARTMENT_BOOST));
    expect(parseDepartmentBoost(undefined)).toBe(1.25);
    expect(parseDepartmentBoost("not a number")).toBe(1.25);
    expect(parseDepartmentBoost("1.6")).toBe(1.6);
    expect(parseDepartmentBoost("0.2")).toBe(1);
    expect(parseDepartmentBoost("7")).toBe(2);
  });
});
