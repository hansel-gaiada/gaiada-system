// Knowledge service (WS8-owned). Search authorization is the PLATFORM's principal:
// the caller forwards an OBO envelope; we resolve it via /principal/resolve and use the
// principal's authorized company set as the D9 pre-filter. Unlinked/low → empty set →
// zero results. Ingest/erase are service-token-only internal pipeline operations.
import "../telemetry"; // WS9: start OTel first (before Fastify/pg) so it patches http/pg. No-op unless OTEL_ENABLED.
import { fastifyLoggerOption } from "../telemetry";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { KnowledgeStore, type IngestDoc } from "./store";
import { KnowledgeGraph } from "./graph";
import { ingestEvent, type PlatformEvent } from "./graph-ingest";
import { PgEpisodicStore } from "../memory/episodic-pg";

export const knowledgeConfig = {
  port: Number(process.env.KNOWLEDGE_PORT ?? 3005),
  host: process.env.HOST ?? "0.0.0.0",
  serviceToken: process.env.KNOWLEDGE_SERVICE_TOKEN ?? "",
  databaseUrl: process.env.KNOWLEDGE_DATABASE_URL ?? "",
  // Owner DSN for schema DDL (knowledge_owner); runtime uses knowledge_app on KNOWLEDGE_DATABASE_URL.
  migrateDatabaseUrl: process.env.MIGRATE_DATABASE_URL ?? "",
  platformUrl: process.env.PLATFORM_URL ?? "http://localhost:3004",
  platformToken: process.env.PLATFORM_SERVICE_TOKEN ?? "",
  gatewayUrl: process.env.GATEWAY_URL ?? "http://localhost:3002",
  gatewayToken: process.env.GATEWAY_TOKEN ?? "",
};

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function authorized(req: FastifyRequest): boolean {
  if (!knowledgeConfig.serviceToken) return false;
  const h = req.headers.authorization ?? "";
  const token = (Array.isArray(h) ? h[0] : h)?.startsWith("Bearer ") ? (h as string).slice(7) : "";
  return safeEqual(token, knowledgeConfig.serviceToken);
}

/** Resolved authorization for a caller: the tenant set + whether they may see cross-company
 *  "one-brain" graph nodes (group_executive / platform_admin — spec §4 / D9.1). */
export interface ResolvedAuth {
  tenantSet: string[];
  crossCompany: boolean;
}
export type EnvelopeResolver = (provider: string, externalId: string) => Promise<ResolvedAuth>;

export async function resolveViaPlatform(provider: string, externalId: string): Promise<ResolvedAuth> {
  const res = await fetch(`${knowledgeConfig.platformUrl}/principal/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${knowledgeConfig.platformToken}` },
    body: JSON.stringify({ provider, externalId }),
  });
  if (!res.ok) throw new Error(`platform resolve ${res.status}`);
  const principal = (await res.json()) as { assurance: string; companies?: string[]; roles?: { role: string }[] };
  if (principal.assurance === "low") return { tenantSet: [], crossCompany: false }; // D4 ceiling: unverified → no knowledge
  // Cross-company elevation is group_executive / platform_admin only (the "one brain" is owner-gated).
  const crossCompany = (principal.roles ?? []).some((r) => r.role === "group_executive" || r.role === "platform_admin");
  return { tenantSet: principal.companies ?? [], crossCompany };
}

export async function embedViaGateway(text: string): Promise<number[]> {
  const res = await fetch(`${knowledgeConfig.gatewayUrl}/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${knowledgeConfig.gatewayToken}` },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`gateway /embed ${res.status}`);
  return ((await res.json()) as { embedding: number[] }).embedding;
}

export function buildKnowledgeApp(
  store: KnowledgeStore,
  resolveEnvelope: EnvelopeResolver,
  graph?: KnowledgeGraph,
  episodic?: PgEpisodicStore,
): FastifyInstance {
  const app = Fastify({ logger: fastifyLoggerOption() as never });

  app.get("/health", async () => ({ ok: true }));

  app.post<{ Body: IngestDoc }>("/ingest", async (req, reply) => {
    if (!authorized(req)) return reply.code(401).send({ error: "unauthorized" });
    const doc = req.body;
    if (!doc?.tenantId || !doc.sourceRef || !Array.isArray(doc.chunks) || doc.chunks.length === 0) {
      return reply.code(400).send({ error: "tenantId, sourceRef, chunks required" });
    }
    const written = await store.ingest({ ...doc, acl: doc.acl ?? [], kind: doc.kind ?? "doc" });
    return { written };
  });

  app.post<{ Body: { query?: string; scope?: string; topK?: number } }>("/search", async (req, reply) => {
    if (!authorized(req)) return reply.code(401).send({ error: "unauthorized" });
    const provider = String(req.headers["x-obo-provider"] ?? "");
    const externalId = String(req.headers["x-obo-external-id"] ?? "");
    const { query, scope } = req.body ?? {};
    if (!query || !scope) return reply.code(400).send({ error: "query and scope required" });
    const { tenantSet } = provider && externalId ? await resolveEnvelope(provider, externalId) : { tenantSet: [] };
    const hits = await store.search(query, { tenantSet, scope, topK: req.body?.topK });
    return { hits };
  });

  // Knowledge-graph traversal (WS8 Step E). Same trust model as /search: the caller's OBO envelope
  // resolves to an authorized-tenant-set that hard pre-filters the walk (D9.1). Cross-company
  // "one-brain" nodes stay invisible here (crossCompany defaults false) — surfacing them requires a
  // group_executive elevation the platform resolver must attest (documented follow-up); fail-closed.
  app.post<{ Body: { startKey?: string; scope?: string; rel?: string; maxDepth?: number } }>("/graph/neighbors", async (req, reply) => {
    if (!authorized(req)) return reply.code(401).send({ error: "unauthorized" });
    if (!graph) return reply.code(501).send({ error: "graph not configured" });
    const provider = String(req.headers["x-obo-provider"] ?? "");
    const externalId = String(req.headers["x-obo-external-id"] ?? "");
    const { startKey, scope, rel, maxDepth } = req.body ?? {};
    if (!startKey || !scope) return reply.code(400).send({ error: "startKey and scope required" });
    const { tenantSet, crossCompany } = provider && externalId ? await resolveEnvelope(provider, externalId) : { tenantSet: [], crossCompany: false };
    const nodes = await graph.neighbors(startKey, { tenantSet, scope, crossCompany, maxDepth }, rel ? { rel } : undefined);
    return { nodes };
  });

  // Graph ingestion (WS8 Step E live wire, D9.2 "indexer subscribes to source changes"). The platform
  // graph-bridge forwards allow-listed business events here; we turn each into source-of-truth nodes +
  // edges. Service-token gated (internal pipeline, like /ingest — the platform already authorized it).
  app.post<{ Body: PlatformEvent }>("/graph/ingest", async (req, reply) => {
    if (!authorized(req)) return reply.code(401).send({ error: "unauthorized" });
    if (!graph) return reply.code(501).send({ error: "graph not configured" });
    const e = req.body;
    if (!e?.tenantId || !e.entityType || !e.entityId) return reply.code(400).send({ error: "tenantId, entityType, entityId required" });
    const m = await ingestEvent(graph, e);
    return { nodes: m.nodes.length, edges: m.edges.length };
  });

  // Human feedback on an agent run (WS8 Step D). D9.3: trust is derived from the caller's resolved
  // identity — a verified member's feedback is a TRUSTED trainer signal; an unresolved/low caller's is
  // recorded but QUARANTINED (untrusted), never auto-promoted. Service-token gated + OBO for identity.
  app.post<{ Body: { runId?: string; rating?: "up" | "down"; note?: string } }>("/feedback", async (req, reply) => {
    if (!authorized(req)) return reply.code(401).send({ error: "unauthorized" });
    if (!episodic) return reply.code(501).send({ error: "episodic store not configured" });
    const provider = String(req.headers["x-obo-provider"] ?? "");
    const externalId = String(req.headers["x-obo-external-id"] ?? "");
    const { runId, rating, note } = req.body ?? {};
    if (!runId || (rating !== "up" && rating !== "down")) return reply.code(400).send({ error: "runId and rating(up|down) required" });
    const resolved = provider && externalId ? await resolveEnvelope(provider, externalId) : { tenantSet: [], crossCompany: false };
    const trusted = resolved.tenantSet.length > 0; // a resolved member; unresolved/low → quarantined
    await episodic.addFeedback(runId, {
      rating,
      note,
      provenance: trusted ? "human" : "external",
      trust: trusted ? "trusted" : "untrusted",
      at: Date.now(),
    });
    return { ok: true, trust: trusted ? "trusted" : "untrusted" };
  });

  // Admin-console source list (service-token gated). The platform is the trust boundary:
  // it has already authorized the caller for `tenant`, so we list that tenant's sources
  // directly (same trust model as /ingest trusting the body tenantId). No chunk text.
  app.get<{ Querystring: { tenant?: string } }>("/sources", async (req, reply) => {
    if (!authorized(req)) return reply.code(401).send({ error: "unauthorized" });
    const tenant = req.query?.tenant;
    if (!tenant) return reply.code(400).send({ error: "tenant required" });
    return store.listSources([tenant]);
  });

  app.post<{ Body: { sourceRef?: string; tenantId?: string } }>("/erase", async (req, reply) => {
    if (!authorized(req)) return reply.code(401).send({ error: "unauthorized" });
    const { sourceRef, tenantId } = req.body ?? {};
    if (sourceRef) return { deleted: await store.eraseSource(sourceRef) };
    if (tenantId) return { deleted: await store.eraseTenant(tenantId) };
    return reply.code(400).send({ error: "sourceRef or tenantId required" });
  });

  return app;
}

async function start(): Promise<void> {
  const pool = new Pool({ connectionString: knowledgeConfig.databaseUrl });
  const store = new KnowledgeStore(pool, embedViaGateway, { migrateUrl: knowledgeConfig.migrateDatabaseUrl });
  await store.init();
  const graph = new KnowledgeGraph(pool, { migrateUrl: knowledgeConfig.migrateDatabaseUrl });
  await graph.init();
  const episodic = new PgEpisodicStore(pool, { migrateUrl: knowledgeConfig.migrateDatabaseUrl });
  await episodic.init();
  const app = buildKnowledgeApp(store, resolveViaPlatform, graph, episodic);
  await app.listen({ port: knowledgeConfig.port, host: knowledgeConfig.host });
  console.log(`Gaiada Knowledge service on :${knowledgeConfig.port}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  start().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
