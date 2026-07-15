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
  botMention: (process.env.BOT_MENTION ?? "@bot").toLowerCase(),
  retentionDays: Number(process.env.RETENTION_DAYS ?? 90),
  host: process.env.HOST ?? "0.0.0.0",
  // Shared secret WAHA must include when calling the webhook (append ?token=... to the hook URL).
  // If empty, the webhook rejects everything (fail-closed).
  webhookSecret: process.env.WEBHOOK_SECRET ?? "",
  // Bearer token for admin routes (e.g. /digest). If empty, admin routes are disabled.
  adminToken: process.env.ADMIN_TOKEN ?? "",
  // Scheduler
  scheduleTimezone: process.env.SCHEDULE_TZ ?? "Asia/Singapore",
  managementGroupId: process.env.MANAGEMENT_GROUP_ID ?? "",
  // Group registry file. If it exists, ONLY listed groups are monitored; if absent,
  // the bot falls back to trial behavior (all groups) and logs discovered groups.
  groupsFile: process.env.GROUPS_FILE ?? "config/groups.yaml",
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
};

export const aiEnabled = config.geminiApiKey.length > 0;
