import "dotenv/config";

export const config = {
  port: Number(process.env.PORT ?? 3001),
  geminiApiKey: process.env.GEMINI_API_KEY ?? "",
  geminiModel: process.env.GEMINI_MODEL ?? "gemini-1.5-flash",
  wahaUrl: process.env.WAHA_URL ?? "http://localhost:3000",
  wahaSession: process.env.WAHA_SESSION ?? "default",
  // API key WAHA requires on its REST API (X-Api-Key). Set the same value in both processes.
  wahaApiKey: process.env.WAHA_API_KEY ?? "",
  commandPrefix: process.env.COMMAND_PREFIX ?? "/",
  // Text-mention token (case-insensitive; matched as a standalone word). Matches the bot's name so
  // "@Rhea"/"@rhea"/"@RHEA" all trigger. Real WhatsApp @mentions (which tag the bot's JID, not this
  // text) are handled separately via the session `me` JID — see bot.ts mentionsSelfJid.
  botMention: (process.env.BOT_MENTION ?? "@Rhea").toLowerCase(),
  // Persona identity used in chat-facing replies (see persona.ts). Cosmetic only — does not
  // affect gating or auth. The agency name frames the bot as an in-house assistant.
  botName: process.env.BOT_NAME ?? "Rhea",
  agencyName: process.env.AGENCY_NAME ?? "Gaiada",
  retentionDays: Number(process.env.RETENTION_DAYS ?? 90),
  host: process.env.HOST ?? "0.0.0.0",
  // Shared secret WAHA must include when calling the webhook (append ?token=... to the hook URL).
  // If empty, the webhook rejects everything (fail-closed).
  webhookSecret: process.env.WEBHOOK_SECRET ?? "",
  // Bearer token for admin routes (e.g. /digest). If empty, admin routes are disabled.
  adminToken: process.env.ADMIN_TOKEN ?? "",
  // DM reply policy (SAFETY — esp. when the bot shares a personal number): who the bot answers in
  // 1:1 chats. "off" = never auto-reply to DMs (store only); "allowlist" = only numbers in
  // dmAllowlist; "all" = any DM. Default "off" so personal contacts are never auto-answered.
  dmReplyPolicy: (process.env.DM_REPLY_POLICY ?? "off").toLowerCase(),
  // Numbers (digits, any format) allowed to get DM replies when dmReplyPolicy="allowlist".
  dmAllowlist: (process.env.DM_ALLOWLIST ?? "").split(",").map((s) => s.replace(/\D/g, "")).filter(Boolean),
  // Never REPLY to a message older than this (ms). WAHA delivers a backlog of unread messages on
  // (re)connect; without this the bot would answer hours-old history. Stored either way; only the
  // reply is suppressed. Default 3 min.
  replyMaxAgeMs: Number(process.env.REPLY_MAX_AGE_MS ?? 180_000),
  // Scheduler
  scheduleTimezone: process.env.SCHEDULE_TZ ?? "Asia/Singapore",
  managementGroupId: process.env.MANAGEMENT_GROUP_ID ?? "",
  // Group registry file. If it exists, ONLY listed groups are monitored; if absent,
  // the bot falls back to trial behavior (all groups) and logs discovered groups.
  groupsFile: process.env.GROUPS_FILE ?? "config/groups.yaml",
  // First-boot seed for the (now writable) groups file: if groupsFile is absent and this
  // exists, it's copied into place once at boot (A2 / design doc §2.6). Empty -> no seeding.
  groupsSeedFile: process.env.GROUPS_SEED_FILE ?? "",
  // Where the digest DELIVERY TARGET is persisted. Deliberately NOT the group registry: writing
  // it there used to create a registry entry, which flipped the bot out of trial mode into
  // registry mode with zero monitored groups — silently stopping ingestion for every group.
  // Empty -> derived as <dirname(groupsFile)>/digest-target.json.
  digestTargetFile: process.env.DIGEST_TARGET_FILE ?? "",
  // Where auto-discovery persists the groups the bot has seen but that aren't in the
  // registry yet (so the ERP's "discovered groups" list survives a restart). Empty ->
  // derived as <dirname(groupsFile)>/discovered-groups.json, i.e. it follows the groups
  // registry onto the writable data volume without a second env var to keep in sync.
  discoveredGroupsFile: process.env.DISCOVERED_GROUPS_FILE ?? "",
  // Where the ignore list persists (1a: "monitor everything except these" — orthogonal to the
  // registry mode). Empty -> derived as <dirname(groupsFile)>/ignored-groups.json, same
  // co-location convention as discoveredGroupsFile.
  ignoredGroupsFile: process.env.IGNORED_GROUPS_FILE ?? "",
  // Digest run history (1b): last 50 runs, counts/status only — no message text, no digest
  // body (keeps PII out of a long-lived file).
  digestHistoryFile: process.env.DIGEST_HISTORY_FILE ?? "data/digest-history.json",
  // Where the session-status timeline is persisted. WAHA only emits `session.status` on a
  // CHANGE, so a long-lived WORKING session produces no events — without this file the Logs
  // tab and /health go blank/"unknown" after every bot restart.
  sessionEventsFile: process.env.SESSION_EVENTS_FILE ?? "data/session-events.json",
  // Where the scheduler persists last-run timestamps (gap-safe windows).
  scheduleStateFile: process.env.SCHEDULE_STATE_FILE ?? "data/schedule.json",
  // File store location (used when DATABASE_URL is unset).
  messagesFile: process.env.MESSAGES_FILE ?? "data/messages.json",
  // Media queue (5a.1): BullMQ over Redis. Empty REDIS_URL -> queue disabled; the
  // in-process poller does all the work (dev/FileStore mode). With Redis, jobs drive
  // processing and the poller becomes a slow reconciler (nothing is ever silently lost).
  redisUrl: process.env.REDIS_URL ?? "",
  mediaQueueName: process.env.MEDIA_QUEUE_NAME ?? "gaiada-media",
  mediaWorkerConcurrency: Number(process.env.MEDIA_WORKER_CONCURRENCY ?? 2),
  mediaReconcileSeconds: Number(process.env.MEDIA_RECONCILE_SECONDS ?? 300),
  // Media worker: poll interval + max file size fetched for enrichment.
  mediaPollSeconds: Number(process.env.MEDIA_POLL_SECONDS ?? 30),
  mediaMaxBytes: Number(process.env.MEDIA_MAX_BYTES ?? 15 * 1024 * 1024),
  // Discovery telemetry (interaction metadata only — never content or identifiers).
  discoveryFile: process.env.DISCOVERY_FILE ?? "data/discovery.jsonl",
  // Digest map-reduce threshold: windows whose transcript exceeds this many chars are
  // chunked, summarized per-chunk, then reduced into one digest (5a.6).
  summarizeMaxChars: Number(process.env.SUMMARIZE_MAX_CHARS ?? 12000),
  // Governed Drive connector (5a.11 / D8.4). Empty token -> disabled (captures still
  // store locally). User supplies an OAuth access token; folder optional.
  driveAccessToken: process.env.DRIVE_ACCESS_TOKEN ?? "",
  driveFolderId: process.env.DRIVE_FOLDER_ID ?? "",
  driveAuditFile: process.env.DRIVE_AUDIT_FILE ?? "data/drive-audit.jsonl",
  postToGroups: (process.env.POST_TO_GROUPS ?? "false").toLowerCase() === "true",
  // Gateway (separate AI-egress service). The bot calls this; only the Gateway holds the model key.
  gatewayPort: Number(process.env.GATEWAY_PORT ?? 3002),
  gatewayUrl: process.env.GATEWAY_URL ?? "http://localhost:3002",
  gatewayToken: process.env.GATEWAY_TOKEN ?? "",
  // MCP hub (company-data tools). Blank hubServiceToken disables the /projects skill.
  hubUrl: process.env.HUB_URL ?? "http://localhost:3003",
  hubServiceToken: process.env.HUB_SERVICE_TOKEN ?? "",
  // Default company (tenant) id for company-data skills; per-chat mapping later.
  defaultTenantId: process.env.DEFAULT_TENANT_ID ?? "",
  // Telegram fallback surface (optional). Token from @BotFather; the webhook secret must
  // match the secret_token passed to setWebhook (fail-closed when unset).
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
  telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET ?? "",
  // Store: Postgres when DATABASE_URL is set, else the local file store.
  databaseUrl: process.env.DATABASE_URL ?? "",
  // Schema DDL runs as the OWNER (bot_owner) via this DSN; runtime uses the restricted bot_app on
  // DATABASE_URL. Empty -> DDL falls back to DATABASE_URL (dev, where owner==runtime).
  migrateDatabaseUrl: process.env.MIGRATE_DATABASE_URL ?? "",
  // OpenBao (key custody, 5a.10). Both set -> transit engine; else LocalKms dev fallback.
  baoUrl: process.env.BAO_URL ?? "",
  baoToken: process.env.BAO_TOKEN ?? "",
  baoTransitMount: process.env.BAO_TRANSIT_MOUNT ?? "transit",
  // Tenant this bot instance writes/reads as (RLS authorized-tenant-set).
  tenantId: process.env.TENANT_ID ?? "trial",
  // Action kill-switch: master enable for all mutating actions. A runtime toggle
  // (setActionsEnabled) overrides this without a redeploy; env sets the boot default.
  actionsEnabledDefault: (process.env.ACTIONS_ENABLED ?? "true").toLowerCase() !== "false",
  // Action audit sink (Phase A): append-only JSONL of every mutating-action attempt.
  actionAuditFile: process.env.ACTION_AUDIT_FILE ?? "data/action-audit.jsonl",
  // LLM intent router (Phase E): natural-language → a proposed action (never auto-executed).
  intentRoutingEnabled: (process.env.INTENT_ROUTING ?? "true").toLowerCase() !== "false",
  // Minimum model confidence to propose an action; below this we ask a clarifying question.
  intentConfidenceThreshold: Number(process.env.INTENT_CONFIDENCE ?? 0.7),
  // Abuse/ban protection (2026-07-29 hardening). Per-(chatId,senderId) reply budget guarding
  // the plain reply path (mentions/commands/Q&A) — mirrors executor.ts's "medium" action risk
  // tier (capacity 8, refill 0.1/s = 6/min sustained) so a single sender's burst is bounded to
  // 8 instant replies then throttled, without affecting other people mentioning the bot in the
  // same busy group (budget is per-sender, not per-chat).
  replyBudgetCapacity: Number(process.env.REPLY_BUDGET_CAPACITY ?? 8),
  replyBudgetRefillPerSec: Number(process.env.REPLY_BUDGET_REFILL_PER_SEC ?? 0.1),
  // Loop guard: minimum normalized-text length considered for burst/echo detection (short
  // common phrases like "ok"/"yes" are extremely common between real humans and must never
  // trip a loop heuristic). Burst = N-or-more identical-text inbound messages in one chat
  // within the window; echo = inbound text matching one of the bot's own recent replies.
  loopGuardMinTextLen: Number(process.env.LOOP_GUARD_MIN_TEXT_LEN ?? 24),
  loopGuardBurstWindowMs: Number(process.env.LOOP_GUARD_BURST_WINDOW_MS ?? 15_000),
  loopGuardBurstCount: Number(process.env.LOOP_GUARD_BURST_COUNT ?? 3),
  loopGuardEchoWindowMs: Number(process.env.LOOP_GUARD_ECHO_WINDOW_MS ?? 120_000),
  // Global outbound ceiling: last-resort brake across ALL chats/surfaces combined (distinct
  // from the per-sender reply budget above). Generous enough for real daily volume (digests
  // to ~a dozen groups twice a day + organic Q&A/action traffic) but bounded well below
  // anything that could look like bulk/spam behavior to WhatsApp.
  outboundCeilingPerMinCapacity: Number(process.env.OUTBOUND_CEILING_PER_MIN ?? 30),
  outboundCeilingPerHourCapacity: Number(process.env.OUTBOUND_CEILING_PER_HOUR ?? 300),
  // Global outbound halt: manual operator emergency-stop for ALL outbound sends (separate from
  // the actions-only kill-switch above). Default off; an admin route to flip it at runtime is
  // a follow-up for server.ts (Agent A) — see the hardening report.
  outboundHaltDefault: (process.env.OUTBOUND_HALT ?? "false").toLowerCase() === "true",
  // Durable inbound intake (WA operability hardening, Agent A): every normalized webhook
  // event is written here BEFORE the webhook ACKs, so a crash after the ACK can never lose
  // a message — a reconciler (boot + periodic) replays anything left "pending". FileStore
  // fallback when DATABASE_URL is unset (same convention as messagesFile).
  inboundEventsFile: process.env.INBOUND_EVENTS_FILE ?? "data/inbound-events.json",
  // Periodic reconciler sweep interval (seconds) — mirrors mediaReconcileSeconds. Runs
  // regardless of Redis (this path has no optional-queue mode; the store IS the durability
  // guarantee, so it must never depend on Redis being up).
  intakeReconcileSeconds: Number(process.env.INTAKE_RECONCILE_SECONDS ?? 120),
  // A "pending" row must be at least this old before the periodic sweep retries it — avoids
  // racing the normal inline processing of a row that is still legitimately in flight
  // (e.g. an AI-gateway reply taking a few seconds). The boot reconciler ignores this (a
  // fresh process start has no in-flight rows of its own to race against).
  intakeReconcileMinAgeMs: Number(process.env.INTAKE_RECONCILE_MIN_AGE_MS ?? 60_000),
  // TR-11: how long a check-in reminder's "awaiting reply" state survives before it's abandoned
  // (checkin-reminder.ts). Default 12h comfortably covers 17:30 reminder -> any reply that evening
  // or early the next morning, while expiring well before the NEXT day's 17:30 reminder — so a
  // stale, unanswered reminder can never be mistaken for a reply to a newer one.
  checkinReminderTtlMs: Number(process.env.CHECKIN_REMINDER_TTL_MS ?? 12 * 60 * 60 * 1000),
};

export const aiEnabled = config.geminiApiKey.length > 0;
