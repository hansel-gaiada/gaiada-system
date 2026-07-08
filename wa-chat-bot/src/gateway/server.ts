// Standalone AI Gateway. Holds the model key; the bot calls it over HTTP.
// Fail-closed auth + DLP scrub before egress (defense-in-depth over ingestion scrub).
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { config, aiEnabled } from "../config";
import { complete, describeMedia } from "./provider";
import { scrub } from "../scrub";

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

export function buildGatewayApp(): FastifyInstance {
  const app = Fastify({ logger: true, bodyLimit: Math.ceil(config.mediaMaxBytes * 1.4) }); // base64 overhead

  app.get("/health", async () => ({ ok: true, ai: aiEnabled ? "on" : "echo" }));

  app.post<{ Body: { prompt?: string } }>("/complete", async (req, reply) => {
    if (!authorized(req)) return reply.code(401).send({ error: "unauthorized" });
    const prompt = req.body?.prompt;
    if (typeof prompt !== "string" || prompt.trim() === "") {
      return reply.code(400).send({ error: "prompt required" });
    }
    // DLP: redact sensitive identifiers before egress to the external model.
    const { clean } = scrub(prompt);
    const text = await complete(clean);
    return { text };
  });

  // Multimodal extraction (Phase 2): audio → transcript, image → description, pdf → text.
  // The bot sends bytes; only this service talks to the model. The derived text is
  // DLP-scrubbed here too (defense-in-depth — the worker scrubs again before persist).
  app.post<{ Body: { base64?: string; mime?: string } }>("/media", async (req, reply) => {
    if (!authorized(req)) return reply.code(401).send({ error: "unauthorized" });
    const { base64, mime } = req.body ?? {};
    if (typeof base64 !== "string" || base64 === "" || typeof mime !== "string" || mime === "") {
      return reply.code(400).send({ error: "base64 and mime required" });
    }
    const raw = await describeMedia(base64, mime);
    const { clean } = scrub(raw);
    return { text: clean };
  });

  return app;
}

async function start(): Promise<void> {
  const app = buildGatewayApp();
  try {
    await app.listen({ port: config.gatewayPort, host: config.host });
    app.log.info(`Gateway on ${config.host}:${config.gatewayPort} (AI: ${aiEnabled ? "on" : "echo"}, auth: ${config.gatewayToken ? "on" : "OFF-reject"})`);
  } catch (e) {
    app.log.error(e);
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void start();
}
