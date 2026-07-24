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
import { postToGroupsEnabled, setPostToGroups } from "./safety/post-toggle";
import { readActionAudit } from "./safety/audit";
import { startMediaWorker } from "./media";
import { queueEnabled } from "./media-queue";
import { initStore } from "./store";
import { startSession, getSessionStatus, getQr, stopSession, logoutSession, restartSession, refreshSelfJid } from "./waha-admin";
import { lastEvent, lastKnownStatus, transitions } from "./session-state";
import { groupsSnapshot, writeGroups, setManagementGroupId, ensureGroupsSeed } from "./groups";
import { listChats, chatMessages } from "./chat-admin";
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

  app.get("/health", async () => ({ ok: true, ai: aiEnabled ? "on" : "echo", session: lastKnownStatus() }));

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

  // Admin: WAHA session lifecycle (WhatsApp go-live self-service from the ERP). Every
  // route is ADMIN_TOKEN-gated (fail-closed, same pattern as above) and operates ONLY on
  // the configured session (config.wahaSession) — no route accepts a session name from
  // the caller, so the ERP can never touch another WAHA session on this bot instance.
  app.post("/admin/session/start", async (req, reply) => {
    if (!config.adminToken) return reply.code(503).send({ error: "admin routes disabled — set ADMIN_TOKEN" });
    if (!safeEqual(bearer(req), config.adminToken)) return reply.code(401).send({ error: "unauthorized" });
    return startSession();
  });

  app.get("/admin/session/status", async (req, reply) => {
    if (!config.adminToken) return reply.code(503).send({ error: "admin routes disabled — set ADMIN_TOKEN" });
    if (!safeEqual(bearer(req), config.adminToken)) return reply.code(401).send({ error: "unauthorized" });
    const st = await getSessionStatus();
    return { ...st, lastEvent: lastEvent() };
  });

  // QR is a pairing secret (scanning it = owning the WhatsApp identity): no-store,
  // never logged, held only in this response body — never persisted.
  app.get("/admin/session/qr", async (req, reply) => {
    if (!config.adminToken) return reply.code(503).send({ error: "admin routes disabled — set ADMIN_TOKEN" });
    if (!safeEqual(bearer(req), config.adminToken)) return reply.code(401).send({ error: "unauthorized" });
    reply.header("Cache-Control", "no-store");
    return getQr();
  });

  app.post("/admin/session/stop", async (req, reply) => {
    if (!config.adminToken) return reply.code(503).send({ error: "admin routes disabled — set ADMIN_TOKEN" });
    if (!safeEqual(bearer(req), config.adminToken)) return reply.code(401).send({ error: "unauthorized" });
    return stopSession();
  });

  app.post("/admin/session/logout", async (req, reply) => {
    if (!config.adminToken) return reply.code(503).send({ error: "admin routes disabled — set ADMIN_TOKEN" });
    if (!safeEqual(bearer(req), config.adminToken)) return reply.code(401).send({ error: "unauthorized" });
    return logoutSession();
  });

  app.post("/admin/session/restart", async (req, reply) => {
    if (!config.adminToken) return reply.code(503).send({ error: "admin routes disabled — set ADMIN_TOKEN" });
    if (!safeEqual(bearer(req), config.adminToken)) return reply.code(401).send({ error: "unauthorized" });
    return restartSession();
  });

  // Admin: group registry — read/full-replace-write. ADMIN_TOKEN-gated, same fail-closed
  // pattern as every other admin route. Validation + atomic write live in groups.ts.
  app.get("/admin/groups", async (req, reply) => {
    if (!config.adminToken) return reply.code(503).send({ error: "admin routes disabled — set ADMIN_TOKEN" });
    if (!safeEqual(bearer(req), config.adminToken)) return reply.code(401).send({ error: "unauthorized" });
    return groupsSnapshot();
  });

  app.put<{ Body: { groups?: unknown } }>("/admin/groups", async (req, reply) => {
    if (!config.adminToken) return reply.code(503).send({ error: "admin routes disabled — set ADMIN_TOKEN" });
    if (!safeEqual(bearer(req), config.adminToken)) return reply.code(401).send({ error: "unauthorized" });
    const err = await writeGroups(req.body?.groups);
    if (err) return reply.code(400).send({ error: err.error, ...(err.field ? { field: err.field } : {}) });
    return groupsSnapshot();
  });

  // Admin: safe config snapshot + editable fields (ONLY {postToGroups, managementGroupId}
  // are writable — everything else is read-only, per design doc §2.3).
  app.get("/admin/config", async (req, reply) => {
    if (!config.adminToken) return reply.code(503).send({ error: "admin routes disabled — set ADMIN_TOKEN" });
    if (!safeEqual(bearer(req), config.adminToken)) return reply.code(401).send({ error: "unauthorized" });
    return configFields();
  });

  app.put<{ Body: { postToGroups?: unknown; managementGroupId?: unknown } }>("/admin/config", async (req, reply) => {
    if (!config.adminToken) return reply.code(503).send({ error: "admin routes disabled — set ADMIN_TOKEN" });
    if (!safeEqual(bearer(req), config.adminToken)) return reply.code(401).send({ error: "unauthorized" });
    const body = req.body ?? {};
    if ("postToGroups" in body) {
      if (typeof body.postToGroups !== "boolean") {
        return reply.code(400).send({ error: "postToGroups must be a boolean", field: "postToGroups" });
      }
      setPostToGroups(body.postToGroups);
    }
    if ("managementGroupId" in body) {
      if (typeof body.managementGroupId !== "string") {
        return reply.code(400).send({ error: "managementGroupId must be a string", field: "managementGroupId" });
      }
      const err = await setManagementGroupId(body.managementGroupId);
      if (err) return reply.code(400).send({ error: err.error, field: err.field ?? "managementGroupId" });
    }
    return configFields();
  });

  // Admin: read-only chat viewer + logs for the ERP's WA/TG Bot page. Same fail-closed
  // ADMIN_TOKEN pattern as every other admin route above.
  app.get<{ Querystring: { limit?: string } }>("/admin/chats", async (req, reply) => {
    if (!config.adminToken) return reply.code(503).send({ error: "admin routes disabled — set ADMIN_TOKEN" });
    if (!safeEqual(bearer(req), config.adminToken)) return reply.code(401).send({ error: "unauthorized" });
    const limit = Math.max(1, Math.min(Number(req.query.limit ?? 100) || 100, 1000));
    return listChats(limit);
  });

  app.get<{ Params: { chatId: string }; Querystring: { limit?: string } }>(
    "/admin/chats/:chatId/messages",
    async (req, reply) => {
      if (!config.adminToken) return reply.code(503).send({ error: "admin routes disabled — set ADMIN_TOKEN" });
      if (!safeEqual(bearer(req), config.adminToken)) return reply.code(401).send({ error: "unauthorized" });
      const limit = Math.max(1, Math.min(Number(req.query.limit ?? 100) || 100, 1000));
      const result = await chatMessages(req.params.chatId, limit);
      if (!result.ok) return reply.code(result.status).send({ error: result.error });
      return { chatId: result.chatId, messages: result.messages };
    },
  );

  // Session status transitions (ring buffer, oldest-first — same order session-state.ts
  // keeps internally) for the ERP's session-history panel.
  app.get("/admin/session/events", async (req, reply) => {
    if (!config.adminToken) return reply.code(503).send({ error: "admin routes disabled — set ADMIN_TOKEN" });
    if (!safeEqual(bearer(req), config.adminToken)) return reply.code(401).send({ error: "unauthorized" });
    return { events: transitions() };
  });

  return app;
}

/** GET/PUT /admin/config shape (mirrors nest's ConfigField): read-only descriptive fields
 *  plus the two editable safe fields. Recomputed on every call — never cached, since
 *  managementGroupId/monitoredCount depend on the live (hot-reloadable) registry. */
function configFields(): {
  fields: Array<{ key: string; value: unknown; editable: boolean; type: "text" | "bool" | "number" }>;
} {
  const snapshot = groupsSnapshot();
  return {
    fields: [
      { key: "wahaSession", value: config.wahaSession, editable: false, type: "text" },
      { key: "botName", value: config.botName, editable: false, type: "text" },
      { key: "postToGroups", value: postToGroupsEnabled(), editable: true, type: "bool" },
      { key: "managementGroupId", value: snapshot.managementGroupId, editable: true, type: "text" },
      {
        key: "monitoredCount",
        value: snapshot.groups.filter((g) => !g.isManagement).length,
        editable: false,
        type: "number",
      },
    ],
  };
}

async function start(): Promise<void> {
  const app = buildApp();
  try {
    if (ensureGroupsSeed()) {
      app.log.info(`[groups] seeded ${config.groupsFile} from ${config.groupsSeedFile} (first boot)`);
    }
    await initStore();
    await app.listen({ port: config.port, host: config.host });
    // If the session is already paired (survives restart), learn the bot's own JID now so real
    // @mentions trigger without waiting for the next WORKING event. Best-effort, never blocks boot.
    void refreshSelfJid().catch(() => {});
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
