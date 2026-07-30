# WhatsApp path — stability & operability hardening (2026-07-29)

Frozen contract for a 4-agent parallel build. Scope is deliberately **item 4 only**: making the
WhatsApp path reliable and operable. The auth blockers (passwordless login, role self-escalation)
and the legal gate are **explicitly deferred by the owner** — do NOT touch auth, login, roles, or
ingestion consent. Do not re-litigate them.

## What today proved (the motivating incidents, all real)

1. Docker Desktop stopped. The whole stack went down, the WhatsApp session died, and **nothing
   alerted** — it was found by accident hours later. Prometheus/Alertmanager/ntfy all run *inside*
   the same Docker Desktop they are supposed to watch. `healthcheck.sh` exists but is not scheduled
   on the host. `OTEL_ENABLED` is unset, so the apps emit no telemetry into the stack anyway.
2. The session did not recover. WAHA sat in a **login → `Connection Failure` → retry loop every
   ~2-3 seconds**, which is itself a ban vector on the one real number in production.
3. `POST /webhook` ACKs 200 **before** persisting (`server.ts:63-75`, `handleEvent` is
   fire-and-forget). A crash between ACK and `saveMessage` loses the message permanently — WAHA
   will never redeliver. Real client messages are flowing through this path today.
4. Dedup is an in-memory map wiped on restart, and there is **no unique index** on
   `wa_message_id` — so a redelivery after a restart inserts a duplicate row.
5. The reply path (`isTriggered`/`respond`) has **no rate limit** — only mutating actions do.
6. Retention purge only runs as a side effect of `saveMessage`, so a quiet chat keeps its PII forever.

## Non-negotiables (all agents)

- **The bot is connected to a REAL WhatsApp number with real client chats.** Never send a WhatsApp
  message. Never trigger a digest. Never start/stop/logout the session. Never write to the bot DB
  outside a migration. Read-only `docker exec`/`docker logs`/psql SELECTs are fine.
- **Never widen the PII surface.** No message text or sender identifiers into logs, metrics labels,
  alert payloads, or new files. Metrics/alerts carry counts and statuses only.
- Bot `/admin/*` routes keep the `ADMIN_TOKEN` preamble verbatim (503 unset, 401 mismatch,
  `timingSafeEqual`). Nest routes keep `requireElevated`.
- Persistence follows the existing pattern: atomic write (tmp + `rename`), path from `config` with
  an env override, defaulting under `data/`. DDL runs as the OWNER via `MIGRATE_DATABASE_URL`
  (see `PgStore.init()` / `schedule-state.ts` — a runtime-role DDL bug already bit us today).
- Fail-soft: a new subsystem being unavailable must never break message intake or replies.
- Tests are part of done. `wa-chat-bot`: `npm test` (408 passing now — keep every one) +
  `npm run typecheck`. `platform-nest`: `npx vitest run src/admin/bot-admin.test.ts` for your lane
  (the full suite takes ~7min; run it once at the end if you touched shared files).
  `platform-ui`: `npx vitest run src/components/systems/` + `npx tsc --noEmit`.
- Use ABSOLUTE paths for Write/Edit. Run commands with the PowerShell tool from the project dir.

## File ownership — do not write outside your lane

| Agent | Owns (exclusive) |
|---|---|
| **A — durable intake** | `wa-chat-bot/src/server.ts`, `wa-chat-bot/src/intake*.ts` (new), `wa-chat-bot/src/store/**`, `infra/db/**` if a migration is needed |
| **B — abuse & ban protection** | `wa-chat-bot/src/bot.ts`, `wa-chat-bot/src/safety/**` |
| **C — session & scheduler resilience** | `wa-chat-bot/src/waha-admin.ts`, `wa-chat-bot/src/session-state.ts`, `wa-chat-bot/src/schedule.ts`, `wa-chat-bot/src/digest-history.ts` |
| **D — monitoring that outlives the box** | `infra/**` (scripts, observability configs, compose), `platform-nest/src/admin/**` + `platform-ui/src/components/systems/**` ONLY if you surface health in the console |

Shared-file rules: only **A** edits `server.ts` — B and C must expose functions for A to wire, and
say so in their report. Only **A** edits `store/**`; if C needs a purge entry point, A provides
`purgeExpired(): Promise<number>` (contract below) and C calls it. `config.ts` is touched by
whoever needs it — APPEND new keys only, never reorder or change existing defaults.

---

## Agent A — durable inbound intake (no message may be lost)

1. **Persist-then-ACK.** `POST /webhook` must not return 200 until the event is durably recorded.
   Options, your call — justify it: (a) write a durable `inbound_events` row (raw-but-scrubbed
   envelope + status) inside the request, then process asynchronously; (b) enqueue to the Redis/
   BullMQ machinery already used for media (`media-queue.ts` is the reference), then ACK. Either way
   a process death after the ACK must leave the event **recoverable**, and a reconciler must pick up
   anything left `pending` at boot — mirror the media worker's reconciler pattern.
   Keep the existing behaviour that a webhook is ACKed fast (WAHA retries aggressively on non-200);
   the goal is durable-then-fast, not slow.
2. **DB-enforced dedup.** Add a unique index on `(tenant_id, wa_message_id)` (nullable-safe — some
   rows legitimately have no id) and `ON CONFLICT DO NOTHING` in `saveMessage`, so a redelivery
   after a restart cannot double-insert. The in-memory dedup stays as a fast path.
   The migration must run as the OWNER. **8,254 rows exist — check for and report existing
   duplicates before adding a unique index, and make the migration safe if any exist.**
3. **`purgeExpired(): Promise<number>`** — export from the store (both FileStore and PgStore),
   deleting everything older than `config.retentionDays` across ALL chats regardless of activity,
   returning the row count. Do not wire a schedule (that is C's).
4. Tests: message survives a simulated crash between ACK and persist; redelivery after a dedup
   reset inserts exactly one row; `purgeExpired` deletes only what it should and returns a count.

## Agent B — abuse & ban protection (protect the number)

1. **Rate-limit the reply path.** `checkRate` (`safety/rate-limit.ts`) currently guards only
   mutating actions. Apply a per-`(chatId, senderId)` budget to the reply path so a mention flood or
   a message loop cannot produce rapid-fire outbound sends. Pick sane defaults for a business bot,
   make them env-tunable, and when the budget is exhausted **stay silent** rather than replying with
   an error (a rate-limit reply is itself outbound traffic).
2. **Loop guard.** The only current protection is `fromMe`. Detect and refuse to engage in bot↔bot
   loops: repeated near-identical inbound text from the same chat, or a chat where our own replies
   are being echoed back. Log once per chat when a loop is suppressed (no message text in the log).
3. **A global outbound ceiling** across all chats (per minute/hour) as a last-resort brake, so no
   single incident can produce a burst that gets the number banned. Exhausting it must be visible
   (counter + a warn), not silent.
4. Verify the kill switch truly stops **every** outbound path, including digests, Q&A replies and
   media/reaction sends. If any path bypasses it, close it and say so.
5. Tests: flood → bounded sends; identical-text loop → suppressed; kill switch off → zero outbound
   on every path; normal conversation unaffected (no regression in the 408 existing tests).

## Agent C — session & scheduler resilience

1. **Bounded reconnect with backoff.** Today a failed session retries every ~2-3s indefinitely —
   the ban vector we observed. Add exponential backoff with a cap and a maximum attempt budget,
   after which the session is left in a terminal state that clearly says "operator action needed:
   re-scan QR". This is about OUR calls to WAHA (`waha-admin.ts`) and how `session-state.ts` models
   it; you cannot change Baileys' internal loop, so if WAHA itself is looping, detect it (repeated
   FAILED/STARTING transitions in a window) and surface that instead of adding to it.
2. **Auto-recovery, carefully.** A session that dies from a transient network blip should recover
   without a human. One that dies because credentials were invalidated must NOT be retried into a
   ban — distinguish them by transition history and stop. Document the rule you implement.
3. **Ingestion-stall detection.** Expose `GET /admin/ingest/health` →
   `{lastMessageAt: number|null, staleSeconds: number, sessionStatus: string, ok: boolean}`.
   "No messages for N minutes while the session claims WORKING" is the signal that the bot is
   silently deaf — the failure mode nobody noticed today. Counts and timestamps only, no content.
4. **Scheduled retention purge** on a cron (alongside the digest scheduler), calling A's
   `purgeExpired()`, logging the count. Timezone-aware, once daily, idempotent.
5. **Per-group digest watermark.** A crash mid-sweep currently leaves `lastRun` unadvanced, so a
   manual re-run re-posts to groups that already received a digest. Record completion per group so a
   re-run resumes rather than duplicating.
6. Tests: backoff sequence and terminal state; transient-vs-credential distinction; stall health
   shape; purge cron invocation; mid-sweep crash then re-run does not re-post to completed groups.

## Agent D — monitoring that outlives the box

The whole point: **if the WhatsApp path breaks, a human must find out without looking.**

1. **Out-of-band watchdog.** `infra/scripts/healthcheck.sh` exists but nothing runs it. Make it
   actually scheduled on THIS host (Windows — a Scheduled Task via `schtasks`, or a documented
   equivalent) so it runs even when Docker is down, and have it alert through a path that does not
   depend on the stack (the in-stack ntfy is useless when the stack is the thing that died). Ask
   nothing of the user that needs an external account; if a truly external transport (ntfy.sh topic,
   email, webhook) is required, implement it behind config and document what the user must set,
   defaulting to a local log + Windows notification/event-log entry so it works out of the box.
   It must detect and report: Docker engine down, any gaiada container not running, bot `/health`
   unreachable, session not WORKING, and ingestion stalled (C's endpoint — degrade gracefully if
   absent).
2. **Turn telemetry on.** `OTEL_ENABLED` is unset for bot and platform, so the running
   Grafana/Prometheus/Tempo stack observes nothing. Wire it in compose (fail-soft is already built
   into the services) and confirm metrics actually arrive.
3. **WhatsApp-specific alert rules + a dashboard panel row**: session not WORKING for N minutes,
   ingestion stalled, digest run failed or skipped, media queue backlog growing, outbound ceiling
   hit (B's counter). Route them to the receivers that exist, and verify a rule fires by querying
   Prometheus — do not just write YAML and declare victory.
4. **Runbook** `infra/runbooks/wa-operations.md`: session re-pair (QR) procedure, what each alert
   means and the first three things to check, how to confirm ingestion resumed, and how to verify no
   messages were lost across an outage.
5. Validate configs with the real tools (`promtool check rules`, `amtool check-config`) as the
   existing `observability-lint` CI job does.

---

## Integration (orchestrator)

A wires B's and C's entry points into `server.ts`/the boot path. Then: all three suites, a live
deploy of `bot` + `platform` with **both** compose files
(`-f docker-compose.vps.yml -f docker-compose.local.yml` — the VPS file alone unpublishes
`platform:3004`), a real end-to-end check of the durable-intake and stall-health paths, and a
deliberate container kill to prove (a) no message loss and (b) the watchdog actually fires.
Docs: bump `wa-chat-bot`, `infra` (+ any other touched module) in
`docs/modules/MODULES.md` + `CHANGELOG.md`.

**Known-broken, out of scope, do not "fix":** passwordless dev-login, role self-escalation,
`AUTH_MODE=hybrid`, ingesting real data before the legal gate, `keys.json` custody (OpenBao is
blocked on infra the owner does not have yet).
