// Knowledge service (WS8-owned). Search authorization is the PLATFORM's principal:
// the caller forwards an OBO envelope; we resolve it via /principal/resolve and use the
// principal's authorized company set as the D9 pre-filter. Unlinked/low → empty set →
// zero results. Ingest/erase are service-token-only internal pipeline operations.
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { KnowledgeStore, type IngestDoc } from "./store";

export const knowledgeConfig = {
  port: Number(process.env.KNOWLEDGE_PORT ?? 3005),
  host: process.env.HOST ?? "0.0.0.0",
  serviceToken: process.env.KNOWLEDGE_SERVICE_TOKEN ?? "",
  databaseUrl: process.env.KNOWLEDGE_DATABASE_URL ?? "",
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

export type EnvelopeResolver = (provider: string, externalId: string) => Promise<string[]>; // authorized tenant set

export async function resolveViaPlatform(provider: string, externalId: string): Promise<string[]> {
  const res = await fetch(`${knowledgeConfig.platformUrl}/principal/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${knowledgeConfig.platformToken}` },
    body: JSON.stringify({ provider, externalId }),
  });
  if (!res.ok) throw new Error(`platform resolve ${res.status}`);
  const principal = (await res.json()) as { assurance: string; companies?: string[] };
  if (principal.assurance === "low") return []; // D4 ceiling: unverified → no knowledge
  return principal.companies ?? [];
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

export function buildKnowledgeApp(store: KnowledgeStore, resolveEnvelope: EnvelopeResolver): FastifyInstance {
  const app = Fastify({ logger: false });

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
    const tenantSet = provider && externalId ? await resolveEnvelope(provider, externalId) : [];
    const hits = await store.search(query, { tenantSet, scope, topK: req.body?.topK });
    return { hits };
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
  const store = new KnowledgeStore(pool, embedViaGateway);
  await store.init();
  const app = buildKnowledgeApp(store, resolveViaPlatform);
  await app.listen({ port: knowledgeConfig.port, host: knowledgeConfig.host });
  console.log(`Gaiada Knowledge service on :${knowledgeConfig.port}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  start().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
