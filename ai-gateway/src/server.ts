// Gaiada AI Gateway (WS3): the ONE door out to AI providers. Fail-closed auth,
// fail-closed DLP before egress, provider chain + circuit breaker, daily cost cap, audit.
// HTTP contract matches what wa-chat-bot already speaks: POST /complete, POST /media.
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { config } from "./config";
import { Chain } from "./chain";
import { resolveChain } from "./providers";
import { dlp } from "./scrub";
import { auditEgress } from "./audit";
import { takeBudget, budgetState } from "./budget";
import { installEgressFloor } from "./egress";

// Optional caller-tenant header — charges that tenant's daily cap (management escalation on breach).
function tenantOf(req: FastifyRequest): string | undefined {
  const h = req.headers["x-tenant-id"];
  const s = Array.isArray(h) ? h[0] : h;
  return s && s.length ? s : undefined;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function authorized(req: FastifyRequest): boolean {
  if (!config.gatewayToken) return false; // fail-closed
  const h = req.headers["authorization"] ?? "";
  const s = Array.isArray(h) ? h[0] : h;
  const token = s?.startsWith("Bearer ") ? s.slice(7) : "";
  return safeEqual(token, config.gatewayToken);
}

export interface Chains {
  llm: Chain;
  media: Chain;
  embed: Chain;
}

export function defaultChains(): Chains {
  return {
    llm: new Chain(resolveChain(config.llmChain)),
    media: new Chain(resolveChain(config.mediaChain)),
    embed: new Chain(resolveChain(config.embedChain)),
  };
}

export function buildGatewayApp(chains: Chains = defaultChains()): FastifyInstance {
  const app = Fastify({ logger: true, bodyLimit: Math.ceil(config.mediaMaxBytes * 1.4) });

  app.get("/health", async () => ({
    ok: true,
    providers: { llm: chains.llm.state(), media: chains.media.state() },
    budget: budgetState(),
  }));

  app.post<{ Body: { prompt?: string } }>("/complete", async (req, reply) => {
    const started = Date.now();
    if (!authorized(req)) {
      auditEgress({ ts: started, capability: "llm", provider: null, ok: false, blocked: "auth", redactions: 0, latencyMs: 0 });
      return reply.code(401).send({ error: "unauthorized" });
    }
    const prompt = req.body?.prompt;
    if (typeof prompt !== "string" || prompt.trim() === "") {
      return reply.code(400).send({ error: "prompt required" });
    }
    const llmBudget = takeBudget(tenantOf(req));
    if (!llmBudget.ok) {
      auditEgress({ ts: started, capability: "llm", provider: null, ok: false, blocked: "budget", redactions: 0, latencyMs: 0 });
      return reply.code(429).send({ error: `${llmBudget.scope} daily budget exceeded — degraded until tomorrow` });
    }
    let clean: string;
    let redactions: number;
    try {
      const r = dlp(prompt); // redact before egress; throws -> BLOCK (fail-closed)
      clean = r.clean;
      redactions = r.redactions.length;
    } catch (err) {
      auditEgress({ ts: started, capability: "llm", provider: null, ok: false, blocked: "dlp", redactions: 0, latencyMs: Date.now() - started });
      return reply.code(503).send({ error: (err as Error).message });
    }
    try {
      const { result, provider } = await chains.llm.run((p) => p.complete(clean));
      auditEgress({ ts: started, capability: "llm", provider, ok: true, redactions, latencyMs: Date.now() - started });
      return { text: result };
    } catch (err) {
      auditEgress({ ts: started, capability: "llm", provider: null, ok: false, blocked: "provider", redactions, latencyMs: Date.now() - started });
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  app.post<{ Body: { base64?: string; mime?: string } }>("/media", async (req, reply) => {
    const started = Date.now();
    if (!authorized(req)) {
      auditEgress({ ts: started, capability: "media", provider: null, ok: false, blocked: "auth", redactions: 0, latencyMs: 0 });
      return reply.code(401).send({ error: "unauthorized" });
    }
    const { base64, mime } = req.body ?? {};
    if (typeof base64 !== "string" || base64 === "" || typeof mime !== "string" || mime === "") {
      return reply.code(400).send({ error: "base64 and mime required" });
    }
    const mediaBudget = takeBudget(tenantOf(req));
    if (!mediaBudget.ok) {
      auditEgress({ ts: started, capability: "media", provider: null, ok: false, blocked: "budget", redactions: 0, latencyMs: 0 });
      return reply.code(429).send({ error: `${mediaBudget.scope} daily budget exceeded — degraded until tomorrow` });
    }
    try {
      const { result, provider } = await chains.media.run((p) => p.media(base64, mime));
      // Media DLP: the extracted text is scrubbed before it returns to the caller.
      const { clean, redactions } = dlp(result);
      auditEgress({ ts: started, capability: "media", provider, ok: true, redactions: redactions.length, latencyMs: Date.now() - started });
      return { text: clean };
    } catch (err) {
      auditEgress({ ts: started, capability: "media", provider: null, ok: false, blocked: "provider", redactions: 0, latencyMs: Date.now() - started });
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  // Embeddings (knowledge platform). DLP-scrubbed before egress like everything else.
  app.post<{ Body: { text?: string } }>("/embed", async (req, reply) => {
    const started = Date.now();
    if (!authorized(req)) {
      auditEgress({ ts: started, capability: "embed", provider: null, ok: false, blocked: "auth", redactions: 0, latencyMs: 0 });
      return reply.code(401).send({ error: "unauthorized" });
    }
    const text = req.body?.text;
    if (typeof text !== "string" || text.trim() === "") return reply.code(400).send({ error: "text required" });
    const embedBudget = takeBudget(tenantOf(req));
    if (!embedBudget.ok) {
      auditEgress({ ts: started, capability: "embed", provider: null, ok: false, blocked: "budget", redactions: 0, latencyMs: 0 });
      return reply.code(429).send({ error: `${embedBudget.scope} daily budget exceeded — degraded until tomorrow` });
    }
    try {
      const { clean, redactions } = dlp(text);
      const { result, provider } = await chains.embed.run((p) => p.embed(clean));
      auditEgress({ ts: started, capability: "embed", provider, ok: true, redactions: redactions.length, latencyMs: Date.now() - started });
      return { embedding: result };
    } catch (err) {
      auditEgress({ ts: started, capability: "embed", provider: null, ok: false, blocked: "provider", redactions: 0, latencyMs: Date.now() - started });
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  return app;
}

async function start(): Promise<void> {
  const app = buildGatewayApp();
  // Deterministic egress floor (D8.3): default-deny outbound, provider hosts only.
  installEgressFloor((host) => app.log.warn({ egressBlocked: host }, "egress blocked (not on allowlist)"));
  try {
    await app.listen({ port: config.port, host: config.host });
    app.log.info(
      `Gaiada AI Gateway on ${config.host}:${config.port} — llm: [${config.llmChain.join(", ")}], media: [${config.mediaChain.join(", ")}], auth: ${config.gatewayToken ? "on" : "OFF-reject"}, cap: ${config.dailyCallCap}/day`,
    );
  } catch (e) {
    app.log.error(e);
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void start();
}
