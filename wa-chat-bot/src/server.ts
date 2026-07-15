import "./telemetry"; // WS9: start OTel first (before Fastify/gateway/store) so it patches http/pg/ioredis
import { fastifyLoggerOption } from "./telemetry";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { config, aiEnabled } from "./config";
import { WahaGateway, type WhatsAppGateway } from "./waha";
import { TelegramGateway, startTelegramPoller } from "./telegram";
import { normalizeWahaEvent, normalizeTelegramEvent } from "./gateway/events";
import { SurfaceRouter } from "./surface";
import { handleInbound, handleEvent } from "./bot";
import { summarizeChat } from "./summarize";
import { getMessages } from "./store";
import { runDigests, startScheduler } from "./schedule";
import { actionsEnabled, setActionsEnabled } from "./safety/kill-switch";
import { readActionAudit } from "./safety/audit";
import { startMediaWorker } from "./media";
import { queueEnabled } from "./media-queue";
import { initStore } from "./store";
import type { Slot } from "./window";

/** Constant-time string comparison (avoids timing side-channels on token checks). */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

const CHAT_ID_RE = /^([0-9]+@(g\.us|c\.us)|tg:-?[0-9]+)$/;

/** Webhook is authorized only if a secret is configured AND matches (fail-closed). */
function webhookAuthorized(req: FastifyRequest): boolean {
  if (!config.webhookSecret) return false;
  const headerToken = req.headers["x-webhook-token"];
  const queryToken = (req.query as { token?: string } | undefined)?.token;
  const provided = (Array.isArray(headerToken) ? headerToken[0] : headerToken) ?? queryToken ?? "";
  return safeEqual(String(provided), config.webhookSecret);
}

function bearer(req: FastifyRequest): string {
  const h = req.headers["authorization"] ?? "";
  const s = Array.isArray(h) ? h[0] : h;
  return s?.startsWith("Bearer ") ? s.slice(7) : "";
}

export function buildApp(gateway: WhatsAppGateway = new SurfaceRouter()): FastifyInstance {
  const app = Fastify({ logger: fastifyLoggerOption() as never });

  app.get("/health", async () => ({ ok: true, ai: aiEnabled ? "on" : "echo" }));

  // WAHA posts message events here. Must carry the shared secret (?token= or X-Webhook-Token).
  app.post("/webhook", async (req, reply) => {
    if (!webhookAuthorized(req)) {
      if (!config.webhookSecret) {
        app.log.warn("WEBHOOK_SECRET not set — webhook is fail-closed and rejects all events. Set it and append ?token=<secret> to the WAHA hook URL.");
      }
      return reply.code(401).send({ error: "unauthorized" });
    }
    const event = normalizeWahaEvent(req.body);
    reply.code(200).send({ received: true });
    if (event) {
      handleEvent(gateway, event).catch((e) => app.log.error(e, "handleEvent failed"));
    }
  });

  // Telegram fallback surface: Bot API webhook. Fail-closed on Telegram's secret-token
  // header (set the same value when calling setWebhook). Replies go via the Bot API.
  app.post("/telegram-webhook", async (req, reply) => {
    const secret = req.headers["x-telegram-bot-api-secret-token"];
    const provided = (Array.isArray(secret) ? secret[0] : secret) ?? "";
    if (!config.telegramWebhookSecret || !safeEqual(String(provided), config.telegramWebhookSecret)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const event = normalizeTelegramEvent(req.body);
    reply.code(200).send({ received: true });
    if (event) {
      handleEvent(new TelegramGateway(), event).catch((e) => app.log.error(e, "telegram handleEvent failed"));
    }
  });

  // Admin: manually trigger a digest (stands in for the 12:00/18:00 scheduler).
  // Requires ADMIN_TOKEN; validates chatId format; only sends to a chat we've actually seen.
  app.post<{ Params: { chatId: string } }>("/digest/:chatId", async (req, reply) => {
    if (!config.adminToken) {
      return reply.code(503).send({ error: "admin routes disabled — set ADMIN_TOKEN" });
    }
    if (!safeEqual(bearer(req), config.adminToken)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const { chatId } = req.params;
    if (!CHAT_ID_RE.test(chatId)) {
      return reply.code(400).send({ error: "invalid chatId" });
    }
    const msgs = await getMessages(chatId);
    if (msgs.length === 0) {
      return reply.code(404).send({ error: "unknown chat (no stored messages)" });
    }
    const digest = await summarizeChat(msgs);
    await gateway.sendText(chatId, digest).catch((e) => app.log.error(e, "send digest failed"));
    return { chatId, digest };
  });

  // Admin: manually run a full scheduled digest sweep (stands in for the cron trigger while testing).
  app.post<{ Params: { slot: string } }>("/run-digests/:slot", async (req, reply) => {
    if (!config.adminToken) return reply.code(503).send({ error: "admin routes disabled — set ADMIN_TOKEN" });
    if (!safeEqual(bearer(req), config.adminToken)) return reply.code(401).send({ error: "unauthorized" });
    const { slot } = req.params;
    if (slot !== "noon" && slot !== "evening") return reply.code(400).send({ error: "slot must be noon|evening" });
    return runDigests(gateway, slot as Slot);
  });

  // Admin: the action kill-switch (incident response) — flip ALL mutating actions off/on at
  // runtime, no redeploy. Reads/Q&A keep working when off. ADMIN_TOKEN-gated.
  app.post<{ Params: { state: string } }>("/admin/actions/:state", async (req, reply) => {
    if (!config.adminToken) return reply.code(503).send({ error: "admin routes disabled — set ADMIN_TOKEN" });
    if (!safeEqual(bearer(req), config.adminToken)) return reply.code(401).send({ error: "unauthorized" });
    const { state } = req.params;
    if (state !== "on" && state !== "off") return reply.code(400).send({ error: "state must be on|off" });
    setActionsEnabled(state === "on");
    return { actionsEnabled: actionsEnabled() };
  });

  // Admin: read the append-only action audit (incident review). ADMIN_TOKEN-gated.
  app.get<{ Querystring: { limit?: string } }>("/admin/actions/audit", async (req, reply) => {
    if (!config.adminToken) return reply.code(503).send({ error: "admin routes disabled — set ADMIN_TOKEN" });
    if (!safeEqual(bearer(req), config.adminToken)) return reply.code(401).send({ error: "unauthorized" });
    const limit = Math.max(1, Math.min(Number(req.query.limit ?? 100) || 100, 1000));
    return { enabled: actionsEnabled(), entries: await readActionAudit(limit) };
  });

  return app;
}

async function start(): Promise<void> {
  const app = buildApp();
  try {
    await initStore();
    await app.listen({ port: config.port, host: config.host });
    startScheduler(new SurfaceRouter());
    // Queue active -> the dedicated media-worker process consumes; here we only reconcile.
    startMediaWorker(queueEnabled() ? config.mediaReconcileSeconds : config.mediaPollSeconds);
    // Telegram intake: long-polling needs no public URL — preferred for local/trial runs.
    // If TELEGRAM_WEBHOOK_SECRET is set we assume a webhook is registered instead.
    if (config.telegramBotToken && !config.telegramWebhookSecret) {
      startTelegramPoller((m) => handleInbound(new TelegramGateway(), m));
      app.log.info("Telegram poller started (getUpdates long-polling)");
    }
    app.log.info(`Gaiada WA bot on ${config.host}:${config.port} (AI: ${aiEnabled ? "on" : "echo"}, webhook auth: ${config.webhookSecret ? "on" : "OFF-reject"}, digests: 12:00 & 18:00 ${config.scheduleTimezone}, media worker: every ${config.mediaPollSeconds}s)`);
  } catch (e) {
    app.log.error(e);
    process.exit(1);
  }
}

// Run only when executed directly (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void start();
}
