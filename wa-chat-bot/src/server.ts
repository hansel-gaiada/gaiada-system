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
import { recordInbound, processRecorded, reconcileInbound, startIntakeReconciler } from "./intake";
import { summarizeChat } from "./summarize";
import { getMessages, getMessagesPage } from "./store";
import { runDigests, startScheduler, startDigestRun } from "./schedule";
import { actionsEnabled, setActionsEnabled } from "./safety/kill-switch";
import { postToGroupsEnabled, setPostToGroups } from "./safety/post-toggle";
import { readActionAudit } from "./safety/audit";
import { startMediaWorker } from "./media";
import { queueEnabled } from "./media-queue";
import { initStore, getPendingMedia } from "./store";
import { startSession, getSessionStatus, getQr, stopSession, logoutSession, restartSession, refreshSelfJid } from "./waha-admin";
import { lastEvent, lastKnownStatus, transitions, loadSessionEvents } from "./session-state";
import { groupsSnapshot, writeGroups, setManagementGroupId, ensureGroupsSeed, writeIgnoredGroups } from "./groups";
import { backfillDiscoveredNames } from "./group-names";
import { listChats, chatMessages, searchAllChats, isValidChatId, type ChatKind } from "./chat-admin";
import { digestHistory } from "./digest-history";
import { nextRuns } from "./next-run";
import { listSkills } from "./skills";
import { composeCheckinReminder } from "./checkin";
import { HubDeniedError } from "./hub";
import type { Slot } from "./window";

/** Constant-time string comparison (avoids timing side-channels on token checks). */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// Chat-id validation lives in chat-admin.ts (isValidChatId) — a second copy here drifted out of
// sync and rejected the @lid DMs the NOWEB engine produces.

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
    if (!event) {
      // Not a usable event (status@broadcast, an unsupported type) — nothing to persist or lose.
      return reply.code(200).send({ received: true });
    }
    // PERSIST -> ACK -> process. Answering 200 before the event is durable meant a crash in the
    // gap lost the message forever (WAHA never redelivers a 200). If we cannot persist, we must
    // NOT claim receipt: a 503 makes WAHA retry, which is the whole point.
    const id = await recordInbound(event);
    if (!id) {
      return reply.code(503).send({ error: "intake unavailable — retry" });
    }
    reply.code(200).send({ received: true });
    // Now safe to process detached: the durable row survives a death here and the reconciler
    // replays it. processRecorded settles the row and never throws.
    void processRecorded(gateway, id, event);
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
    if (!event) return reply.code(200).send({ received: true });
    // Same persist-then-ACK contract as the WAHA webhook above. Telegram also retries on non-2xx.
    const id = await recordInbound(event);
    if (!id) {
      return reply.code(503).send({ error: "intake unavailable — retry" });
    }
    reply.code(200).send({ received: true });
    void processRecorded(new TelegramGateway(), id, event);
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
    if (!isValidChatId(chatId)) {
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

  // Admin: ASYNC digest trigger. A real run takes ~90s (11 groups, each summarized through the
  // AI gateway) — too long for the nest proxy's HTTP budget, which was returning a false "502
  // bot admin unreachable" while the run actually completed fine seconds later. This route never
  // awaits the run: it starts it (startDigestRun, schedule.ts) and answers 202 immediately with
  // something the caller can correlate against the digest-history table (the source of truth for
  // the outcome). 409 if this slot already has a run in flight — two concurrent runs of the same
  // slot would double-post every group. The existing synchronous /run-digests/:slot above is left
  // untouched: it's what the n8n digest-fanout automation calls directly (BOT_ADMIN_TOKEN).
  app.post<{ Params: { slot: string } }>("/admin/digests/run/:slot", async (req, reply) => {
    if (!config.adminToken) return reply.code(503).send({ error: "admin routes disabled — set ADMIN_TOKEN" });
    if (!safeEqual(bearer(req), config.adminToken)) return reply.code(401).send({ error: "unauthorized" });
    const { slot } = req.params;
    if (slot !== "noon" && slot !== "evening") return reply.code(400).send({ error: "slot must be noon|evening" });
    const { started } = startDigestRun(gateway, slot as Slot);
    if (!started) {
      return reply.code(409).send({ error: `a ${slot} digest run is already in progress`, slot });
    }
    return reply.code(202).send({ started: true, slot, startedAt: Date.now() });
  });

  // Admin: read-only digest PREVIEW — generates the digest text for one chat's most recent
  // messages WITHOUT sending anything (no gateway.sendText call anywhere in this route; that is
  // the whole point). Lets an operator check what a digest will say before it ever reaches
  // WhatsApp. Reuses the same summarizeChat() the real digest run uses, over the last `limit`
  // stored messages for that chat (getMessagesPage — same "last N, oldest->newest" contract the
  // chat viewer already uses), filtering out the bot's own messages the same way runDigests does.
  // Deliberately NOT persisted anywhere (digest bodies never land in the history file — that
  // file stays counts-only by design) and never logged.
  const PREVIEW_DEFAULT_LIMIT = 300;
  const PREVIEW_MAX_LIMIT = 2000;
  app.get<{ Querystring: { chatId?: string; limit?: string } }>("/admin/digests/preview", async (req, reply) => {
    if (!config.adminToken) return reply.code(503).send({ error: "admin routes disabled — set ADMIN_TOKEN" });
    if (!safeEqual(bearer(req), config.adminToken)) return reply.code(401).send({ error: "unauthorized" });
    const chatId = req.query.chatId ?? "";
    if (!isValidChatId(chatId)) return reply.code(400).send({ error: "invalid chatId" });
    const limit = Math.max(1, Math.min(Number(req.query.limit ?? PREVIEW_DEFAULT_LIMIT) || PREVIEW_DEFAULT_LIMIT, PREVIEW_MAX_LIMIT));
    const msgs = (await getMessagesPage(chatId, { limit })).filter((m) => !m.fromBot);
    if (msgs.length === 0) {
      return reply.code(404).send({ error: "unknown chat (no stored messages)" });
    }
    const digest = await summarizeChat(msgs);
    return { chatId, digest };
  });

  // Admin: TR-11's minimal check-in reminder notify. n8n's reports-eod-reminder flow calls this
  // ONCE per WA-linked pending user (chatId resolved from GET /checkins/pending-reminders'
  // additive `waExternalId` field — for a WA DM the external_id IS the chat id, waha.ts sets
  // InboundMessage.chatId := senderId for a 1:1 chat). Deliberately minimal: this route does NOT
  // accept arbitrary text — it only knows how to compose and remember ONE thing (today's check-in
  // reminder), so it can never become a generic "send whatever text n8n hands it" relay. The bot —
  // never n8n — fetches the prefill (as the recipient's OWN OBO envelope, same D4 pattern /projects
  // and /know already use) and never asserts whose identity this is; it only relays what the
  // platform's own OBO resolution already decided. Idempotent by construction: composeCheckinReminder
  // no-ops (sends nothing) when the day is already submitted, so a retried/re-driven n8n run can
  // never double-nag someone who already checked in.
  app.post<{ Body: { tenantId?: string; chatId?: string } }>("/admin/notify", async (req, reply) => {
    if (!config.adminToken) return reply.code(503).send({ error: "admin routes disabled — set ADMIN_TOKEN" });
    if (!safeEqual(bearer(req), config.adminToken)) return reply.code(401).send({ error: "unauthorized" });
    const { tenantId, chatId } = req.body ?? {};
    if (!tenantId || !chatId) return reply.code(400).send({ error: "tenantId and chatId required" });
    if (!isValidChatId(chatId)) return reply.code(400).send({ error: "invalid chatId" });
    if (!config.hubServiceToken) return reply.code(503).send({ error: "notify unavailable — HUB_SERVICE_TOKEN unset" });
    try {
      const text = await composeCheckinReminder(tenantId, chatId, config.checkinReminderTtlMs);
      if (text === null) return reply.code(200).send({ sent: false, reason: "already submitted" });
      await gateway.sendText(chatId, text);
      return { sent: true, chatId };
    } catch (err) {
      if (err instanceof HubDeniedError) return reply.code(403).send({ error: "denied", detail: err.message });
      return reply.code(502).send({ error: `notify failed: ${(err as Error).message}` });
    }
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
    // Late-bind subjects for any nameless discovered group before answering, so the ERP's
    // Groups tab shows real names on first load. Best-effort: failures leave the JID.
    await backfillDiscoveredNames().catch(() => 0);
    return groupsSnapshot();
  });

  app.put<{ Body: { groups?: unknown } }>("/admin/groups", async (req, reply) => {
    if (!config.adminToken) return reply.code(503).send({ error: "admin routes disabled — set ADMIN_TOKEN" });
    if (!safeEqual(bearer(req), config.adminToken)) return reply.code(401).send({ error: "unauthorized" });
    const err = await writeGroups(req.body?.groups);
    if (err) return reply.code(400).send({ error: err.error, ...(err.field ? { field: err.field } : {}) });
    return groupsSnapshot();
  });

  // Admin: 1a ignore list — full-replace, same validation/atomic-write/fail-closed pattern
  // as /admin/groups. An ignored group is dropped from ingestion + digests in BOTH registry
  // modes (see groups.ts/bot.ts/schedule.ts); un-ignoring is just omitting the id next PUT.
  app.put<{ Body: { ids?: unknown } }>("/admin/groups/ignored", async (req, reply) => {
    if (!config.adminToken) return reply.code(503).send({ error: "admin routes disabled — set ADMIN_TOKEN" });
    if (!safeEqual(bearer(req), config.adminToken)) return reply.code(401).send({ error: "unauthorized" });
    const err = await writeIgnoredGroups(req.body?.ids);
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
  // ADMIN_TOKEN pattern as every other admin route above. 1e: `q`/`kind` filter the list.
  app.get<{ Querystring: { limit?: string; q?: string; kind?: string } }>("/admin/chats", async (req, reply) => {
    if (!config.adminToken) return reply.code(503).send({ error: "admin routes disabled — set ADMIN_TOKEN" });
    if (!safeEqual(bearer(req), config.adminToken)) return reply.code(401).send({ error: "unauthorized" });
    const limit = Math.max(1, Math.min(Number(req.query.limit ?? 100) || 100, 1000));
    const kind: ChatKind | undefined = req.query.kind === "group" || req.query.kind === "dm" ? req.query.kind : undefined;
    return listChats(limit, { q: req.query.q, kind });
  });

  // 1e: `beforeTs` pages backwards; a malformed value is ignored (fail-soft) rather than 400ing.
  app.get<{ Params: { chatId: string }; Querystring: { limit?: string; beforeTs?: string } }>(
    "/admin/chats/:chatId/messages",
    async (req, reply) => {
      if (!config.adminToken) return reply.code(503).send({ error: "admin routes disabled — set ADMIN_TOKEN" });
      if (!safeEqual(bearer(req), config.adminToken)) return reply.code(401).send({ error: "unauthorized" });
      const limit = Math.max(1, Math.min(Number(req.query.limit ?? 100) || 100, 1000));
      const rawBeforeTs = Number(req.query.beforeTs);
      const beforeTs = req.query.beforeTs !== undefined && Number.isFinite(rawBeforeTs) ? rawBeforeTs : undefined;
      const result = await chatMessages(req.params.chatId, limit, beforeTs);
      if (!result.ok) return reply.code(result.status).send({ error: result.error });
      return { chatId: result.chatId, messages: result.messages, hasMore: result.hasMore };
    },
  );

  // 1e: message search across every stored chat. Empty/whitespace q -> {results: []} (the
  // store contract, not a special case here) rather than a 400 — a blank search box is a
  // normal UI state, not an error.
  app.get<{ Querystring: { q?: string; limit?: string } }>("/admin/search", async (req, reply) => {
    if (!config.adminToken) return reply.code(503).send({ error: "admin routes disabled — set ADMIN_TOKEN" });
    if (!safeEqual(bearer(req), config.adminToken)) return reply.code(401).send({ error: "unauthorized" });
    const limit = Math.max(1, Math.min(Number(req.query.limit ?? 20) || 20, 200));
    return searchAllChats(req.query.q ?? "", limit);
  });

  // 1b: digest run history + next scheduled run per slot.
  app.get<{ Querystring: { limit?: string } }>("/admin/digests", async (req, reply) => {
    if (!config.adminToken) return reply.code(503).send({ error: "admin routes disabled — set ADMIN_TOKEN" });
    if (!safeEqual(bearer(req), config.adminToken)) return reply.code(401).send({ error: "unauthorized" });
    const limit = Math.max(1, Math.min(Number(req.query.limit ?? 50) || 50, 50));
    return {
      history: digestHistory(limit),
      nextRun: nextRuns(Date.now(), config.scheduleTimezone),
      timezone: config.scheduleTimezone,
    };
  });

  // 1c: read-only skills catalog — what the bot answers, for an operator who hasn't read the code.
  app.get("/admin/skills", async (req, reply) => {
    if (!config.adminToken) return reply.code(503).send({ error: "admin routes disabled — set ADMIN_TOKEN" });
    if (!safeEqual(bearer(req), config.adminToken)) return reply.code(401).send({ error: "unauthorized" });
    return {
      commandPrefix: config.commandPrefix,
      botMention: config.botMention,
      skills: listSkills().map((s) => ({ name: s.name, description: s.description })),
    };
  });

  // 1d: media-queue health — counts only, never media refs or text. `limit` here is a health-
  // check cap (10k), not a UI page size: PgStore's getPendingMedia sorts ts ASC so this is the
  // exact oldest-first set; FileStore's is insertion-order, so with a genuinely enormous
  // backlog the true oldest could theoretically fall outside the cap — an edge case dwarfed
  // by the fact that a backlog anywhere near 10k pending items is already an incident.
  const MEDIA_STATUS_LIMIT = 10_000;
  app.get("/admin/media/status", async (req, reply) => {
    if (!config.adminToken) return reply.code(503).send({ error: "admin routes disabled — set ADMIN_TOKEN" });
    if (!safeEqual(bearer(req), config.adminToken)) return reply.code(401).send({ error: "unauthorized" });
    const pending = await getPendingMedia(MEDIA_STATUS_LIMIT);
    return {
      queueEnabled: queueEnabled(),
      pending: pending.length,
      oldestPendingTs: pending.length > 0 ? Math.min(...pending.map((m) => m.ts)) : null,
    };
  });

  // Session status transitions (ring buffer, oldest-first — same order session-state.ts
  // keeps internally) for the ERP's session-history panel.
  app.get("/admin/session/events", async (req, reply) => {
    if (!config.adminToken) return reply.code(503).send({ error: "admin routes disabled — set ADMIN_TOKEN" });
    if (!safeEqual(bearer(req), config.adminToken)) return reply.code(401).send({ error: "unauthorized" });
    return { events: transitions() };
  });

  return app;
}

/** The one field whose raw value (a WhatsApp group JID like `120363...@g.us`) is unreadable and
 *  easy to mistype — the operator picks a group by name instead. Only this function decides
 *  between the two representations; the route/write path above never widens.
 *
 *  - Registry has groups: a "select" with an explicit "None" (-> "") option — clearing the
 *    management group is a supported operation (falls back to MANAGEMENT_GROUP_ID) and must
 *    stay reachable from the dropdown, not just the text box it replaces.
 *  - Current value not among the registry's groups (env-only fallback, or a JID set before the
 *    registry existed): appended as its own option rather than silently dropped, so the operator
 *    always sees what's actually in effect and never loses it just by opening the picker.
 *  - Registry is EMPTY (trial mode — the common case right now): there is nothing to choose
 *    from, and a select with only "None" would hide whatever value is already set. Stay a text
 *    field so the current value stays visible/editable rather than presenting a dead-end select.
 */
function managementGroupField(snapshot: ReturnType<typeof groupsSnapshot>): {
  key: string;
  value: unknown;
  editable: boolean;
  type: "text" | "select";
  optionItems?: Array<{ value: string; label: string }>;
} {
  const current = snapshot.managementGroupId;
  const optionItems: Array<{ value: string; label: string }> = [{ value: "", label: "None" }];
  for (const g of snapshot.groups) optionItems.push({ value: g.id, label: g.name || g.id });

  // Also offer AUTO-DISCOVERED groups, not just registry entries. The registry is empty in trial
  // mode — the common case — and restricting the dropdown to it left an operator typing raw JIDs
  // into a text box, which is the whole problem this field was meant to solve. A management group
  // is a DELIVERY target that is never ingested, and setManagementGroupId() already creates a
  // registry entry for an id it doesn't know, so any visible group is a legitimate choice.
  // (`snapshot.discovered` already excludes ignored groups.)
  const known = new Set(snapshot.groups.map((g) => g.id));
  for (const d of snapshot.discovered) {
    if (known.has(d.id)) continue;
    known.add(d.id);
    optionItems.push({ value: d.id, label: d.name ? `${d.name} (discovered)` : `${d.id} (discovered)` });
  }

  // Fall back to free text unless there is at least one REAL group to pick. A select built from
  // nothing but "None" + the already-configured value offers no choice while REMOVING the ability
  // to type an id — strictly worse than the text box it replaced.
  const hasRealChoice = optionItems.length > 1;
  if (!hasRealChoice) {
    return { key: "managementGroupId", value: current, editable: true, type: "text" };
  }

  // Never silently drop a configured value (e.g. one set via MANAGEMENT_GROUP_ID before the bot
  // ever saw the group) — it must stay selected and selectable.
  if (current && !known.has(current)) {
    optionItems.push({ value: current, label: `${current} (not in registry)` });
  }
  return { key: "managementGroupId", value: current, editable: true, type: "select", optionItems };
}

/** GET/PUT /admin/config shape (mirrors nest's ConfigField): read-only descriptive fields
 *  plus the two editable safe fields. Recomputed on every call — never cached, since
 *  managementGroupId/monitoredCount depend on the live (hot-reloadable) registry. */
function configFields(): {
  fields: Array<{
    key: string;
    value: unknown;
    editable: boolean;
    type: "text" | "bool" | "number" | "select";
    optionItems?: Array<{ value: string; label: string }>;
  }>;
} {
  const snapshot = groupsSnapshot();
  return {
    fields: [
      { key: "wahaSession", value: config.wahaSession, editable: false, type: "text" },
      { key: "botName", value: config.botName, editable: false, type: "text" },
      { key: "postToGroups", value: postToGroupsEnabled(), editable: true, type: "bool" },
      managementGroupField(snapshot),
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
    // Restore the session timeline before anything can append to it, so a restart doesn't
    // blank the Logs tab / report session "unknown" on /health.
    loadSessionEvents();
    await initStore();
    // Crash recovery: replay anything a previous run persisted but never finished. minAge 0 —
    // a fresh process has no in-flight work of its own, so every pending row is orphaned.
    const replayed = await reconcileInbound(new SurfaceRouter(), 0).catch(() => 0);
    if (replayed > 0) app.log.warn(`[intake] replayed ${replayed} orphaned inbound event(s) at boot`);
    await app.listen({ port: config.port, host: config.host });
    // If the session is already paired (survives restart), learn the bot's own JID now so real
    // @mentions trigger without waiting for the next WORKING event. Best-effort, never blocks
    // boot. This also seeds the current status into the timeline (getSessionStatus observes it).
    void refreshSelfJid().catch(() => {});
    startScheduler(new SurfaceRouter());
    // Queue active -> the dedicated media-worker process consumes; here we only reconcile.
    startMediaWorker(queueEnabled() ? config.mediaReconcileSeconds : config.mediaPollSeconds);
    // Intake reconciler: catches a row whose inline processing died AFTER boot (the boot sweep
    // above only covers the previous run). Store-backed, so it works even with Redis down.
    startIntakeReconciler(new SurfaceRouter());
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
