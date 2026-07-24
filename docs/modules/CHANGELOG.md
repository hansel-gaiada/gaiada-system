# Gaiada — Module Changelog

Per-module change history. Format follows [Keep a Changelog](https://keepachangelog.com) +
[SemVer](https://semver.org) (all `0.x` — nothing is in production yet). **Append an entry on every
notable module change or commit; bump the version in [`MODULES.md`](./MODULES.md) to match.**

Status vocabulary: `PLANNED` · `IN PROGRESS` · `PROTOTYPED` (dev-only) · `DEV-VERIFIED` (e2e on the
local stack). None of these mean "production-done".

---

## Program log — module additions

| Date | Event |
|---|---|
| 2026-07-24 | **D1: WhatsApp + Agent runtime verified and documented** (`erp-whatsapp-and-agent-runtime-e2e.md`). wa-chat-bot 0.8.0 (session-lifecycle admin plane + writable group registry), platform-nest 0.6.0 (bot+agent proxies), platform-ui 0.6.0 (Connect-WhatsApp + Group Registry + agents-live surfaces), ai-agents 0.4.0 → PROTOTYPED (agent-runner service + goal/run store + queue), ai-gateway-go 0.11.0 (provider timeout + 429/RateLimitError breaker + error taxonomy), infra 0.5.0 (agent-runner + bot writable volumes + .env updates). Agent runtime DEV-VERIFIED end-to-end (pipeline+gateway+D13 forced_read_only persisted); bot session e2e (start→SCAN_QR_CODE→QR). UI-through path PROTOTYPED (not yet deployed — pending search-marketing build blocker). |
| 2026-07-23 | **Baseline versions assigned** to all modules for tracking-forward; this registry + changelog created. |
| 2026-07-23 | `creative` registered `PROTOTYPED` (Image Studio + `creative_assets` already in dev) with a v1.0 expansion design; new `render-gateway-go` added `PLANNED`. Foundation + design + PDF authored; 4 owner decisions locked; 27 tickets CR-00–CR-26. |
| 2026-07-23 | `social-media` added as `PLANNED` (foundation + v1.0 design; Postiz AGPL-contained; 3 decisions locked — scope, publisher, drop Chatwoot). |
| 2026-07-23 | `search-marketing` added as `PLANNED` (foundation + v1.1 design ratified; 4 owner decisions locked). |
| 2026-07-23 | `webdesk` added as `PLANNED` (blueprint approved). |
| 2026-07-15 | `observability` + `automation` reached DEV-VERIFIED (e2e on live Docker stack). |
| 2026-07-14 | `sync-engine-go` first prototyped; Node `ai-gateway` retired in favor of `ai-gateway-go`. |

> Older "Built/Complete" wording in `README.md` / `CLAUDE.md` predates this vocabulary — read it as
> `PROTOTYPED` / `DEV-VERIFIED` unless a production deploy is explicitly stated.

---

## platform-nest
### [0.6.0] — 2026-07-24 · PROTOTYPED (bot-admin + agents intelligence proxies)
- **Workstream A+B admin proxy layer (design §2.4 + §3.3):** NEW `admin/bot-admin.controller.ts` (`@Controller("api/admin/bot")`), isElevated-gated,
  proxies wa-chat-bot's `/admin/*` routes with fail-soft (bot unreachable → 502, unconfigured → 404). Routes: POST session/start, GET session/status,
  GET session/qr (Cache-Control: no-store), POST session/{stop,logout,restart}, GET/PUT groups (validates `{groups:[…]}` before forwarding),
  PUT config (`{key,value}` allow-list `{postToGroups,managementGroupId}` → 400 otherwise). Extracted `isElevated` helper to shared `admin/elevated.ts`.
- **Real agent-runner proxy (vs. old hardcoded stubs):** `intelligence.controller.ts` now makes live HTTP calls to agent-runner service. Config: `services.agents
  = {url: AGENTS_URL, token: AGENT_RUNNER_TOKEN}`. Routes: `GET /api/:t/agents/goals` (tenant-filtered, `authorize(activity read)`), `POST /api/:t/agents/goals`
  (isElevated, idempotently upserts platform self-link `identity_links(provider='platform', external_id=userId)`, calls runner `POST /goals` with envelope),
  `GET /api/:t/agents/goals/:goalId` (detail + blackboard + run summaries, tenant-pinned), `GET /api/:t/agents/runs/:runId` (full run + steps, isElevated only —
  transcript can carry user-triggered tool output). `probeStatus("agents")` now hits `/health` real-time; `connectionConfig("agents")` no longer says "CLI/library".
- **Not deployed yet:** nest endpoints verified against running agent-runner (pipeline+gateway working end-to-end per design spec §3.2).

### [0.5.0] — 2026-07-23 · PROTOTYPED
- Baseline. Core schema (FORCE RLS), ModuleContract + custom fields, Cerbos RBAC, OBO/identity links,
  rollups, agency vertical, event backbone (outbox→Redis Streams). ~92 dev tests.
- **Unreleased / next:** identity writes, org-structure endpoints.

## platform-ui
### [0.6.0] — 2026-07-24 · PROTOTYPED (Connect-WhatsApp + Group Registry + agents-live surfaces)
- **Workstream A WhatsApp self-service UI (design §2.5, not yet deployed):** PROTOTYPED `src/components/systems/WhatsAppConnect.tsx` (client-side).
  Status pill (status + engine + paired number when WORKING), buttons Connect/Show-QR/Restart/Stop/Logout (confirm on logout). QR `<img>` from data URL.
  Poll status+qr every 3s while panel open and status ∈ {STARTING, SCAN_QR_CODE}; stop on WORKING (success) or FAILED (error + hint). Show `lastEvent` (reconnect/ban trail).
  Mutations = server actions in `systems/bot/actions.ts`; poll read via route handler `src/app/api/admin/bot/session/route.ts` (GET, no-store, server-side platformFetch).
- **Group Registry UI:** PROTOTYPED `src/components/systems/GroupRegistry.tsx` (client-side). Monitored-groups table (name/category/optIn/remove), discovered list
  with one-click add, management-group radio, single Save → PUT groups. Server action `updateBotGroups`. `updateBotConfig` action kept (degrades if backend 404).
  StatusCard now renders `detail.session` as a badge.
- **Workstream B agents-live surfaces (design §3.4):** agents UI extended with trigger card (goal textarea + agent select from status probe's `agents` list, elevated-only).
  Goals table now links to detail; status card consumes real `/health` probe. NEW `/agents/goals/[goalId]` page: status/budget/fan-out header, blackboard entries
  (specialist/task/status), run summaries linking to transcripts, `approval_id` deep-link to approvals inbox when suspended. NEW `/agents/runs/[runId]` or expandable
  detail panel: step list as text chips (model/tool kind + detail only, never HTML/markdown, never raw JSON). Poll every 4s while goal queued|running, stop otherwise.
- **NOT deployed yet:** UI-through path PROTOTYPED; backend for `/systems/bot` and `/agents` surfaces now answering (but not yet deployed container).

### [0.5.0] — 2026-07-23 · PROTOTYPED
- Baseline. ERP UI Plans 1–5 + People 360 + org builder + dept consoles + PM/AI-tracker + IT console;
  OIDC PKCE; `DEMO_MODE`; Playwright e2e.
- **Unreleased / next:** deploy once backend admin API is live.

## ai-gateway-go
### [0.11.0] — 2026-07-24 · PROTOTYPED (provider timeout + 429/RateLimitError breaker + error taxonomy)
- **Provider timeouts (§3.5 Workstream B reliability):** NEW `PROVIDER_TIMEOUT_MS` env (default 60000). Every capability handler (Complete/Media/Embed) wraps
  provider calls with `context.WithTimeout(r.Context(), timeout)` — hung provider → clean failover + client disconnect cancels upstream (no hanging goroutines).
  Stream path (`/complete/stream`) handled separately (keeps its own flush loop, retains timeout safety).
- **429 taxonomy & breaker:** providers return typed `providers.RateLimitError{RetryAfter}` on HTTP 429. Chain.Run() parses Retry-After seconds, caps at 5m,
  opens provider's circuit breaker immediately for min(RetryAfter, cap) — one 429 stops hammering for exactly the advertised window without poisoning the
  "dying provider" consecutive-fail signal. No more treating 429 as a generic failure on the failover path.
- **Error taxonomy in audit + 502 body:** attempted-provider errors tagged `timeout|rate_limit|provider_error` in egress audit + 502 response (ERP console can
  distinguish causes). `Blocked: "rate_limit"` when all providers in chain are rate-limited (not a generic error). Audit trail now surfaceable for SLA/alerting.
- **Per-tenant call cap:** already EXISTS (`budget.perTenantCap` via x-tenant-id header) — runner NOW sends `x-tenant-id` on `/complete` calls (1-line change in
  gateway init) so agent load is tenant-attributed for daily cap enforcement.
- **Not yet live:** WhatsApp transport (WAHA up but no paired session).

### [0.10.0] — 2026-07-24 · DEV-VERIFIED (openai provider path, full stack)
- New `openai` provider (`internal/providers/openai.go`): OpenAI-compatible `/v1/chat/completions`
  with Bearer auth, fronting any compatible endpoint (Ollama Cloud, OpenRouter, vLLM …). Registered in
  the chain, excluded in `site` topology like other cloud-key providers.
- **Vision media:** `Media()` handles `image/*` via a configurable vision model (`OPENAI_VISION_MODEL`,
  default `qwen3.5:397b`) using the OpenAI `image_url` content part; audio/PDF/video decline → fail over
  to whisper/gemini. Embeddings decline (Ollama Cloud has no `/v1/embeddings`).
- Config: `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_MODEL` (default `deepseek-v4-flash`) /
  `OPENAI_VISION_MODEL` / `OPENAI_MAX_TOKENS`. Compose `LLM_CHAIN` defaults `openai,ollama,gemini,claude`,
  `MEDIA_CHAIN` defaults `openai,whisper,gemini`; `ollama.com` added to `EGRESS_ALLOWLIST`. 11 provider
  tests; `go vet` + full suite green.
- **e2e (full local stack):** rebuilt+restarted `gaiada-ai-gateway-1`; verified from inside the running
  containers — bot→`ai-gateway:3002`/complete and mcp-hub→gateway both returned `{"provider":"openai",…}`;
  gateway egress-audit shows every LLM call `provider:openai, ok:true`. `/health` reports `openai:ok` on
  both llm + media chains.
- **Trial:** shared Ollama Cloud key wired into dev `.env` as the stack brain (bot, MCP `llm.*`, n8n, WS8
  agents inherit it). Shared + weekly-rate-limited — dev/test only, not a prod dependency.
  **Capability:** NO image/video *generation* (that's the GPU render-gateway's job) and NO embeddings on
  Ollama Cloud; image *understanding* works (qwen3.5). `glm-5.2`/`kimi-k2.7-code` are reasoning models
  that reply empty unless `OPENAI_MAX_TOKENS` is large — `deepseek-v4-flash` returns clean content.
- **Not yet live:** WhatsApp transport (WAHA up but no paired session — needs a QR scan).

### [0.9.0] — 2026-07-23 · PROTOTYPED
- Baseline. THE gateway (`:3002`), provider chain + failover + DLP + cost cap + egress audit + mTLS +
  site/central + DR-burst. go build/vet/test green.
- **Known risk:** docker build unverified. **Next:** verify container build, OpenBao creds, media DLP.

## mcp-hub
### [0.8.0] — 2026-07-23 · PROTOTYPED
- Baseline. MCP server fronting platform-nest; OBO, Cerbos policy, Tools/Resources/Prompts, rate limit,
  revocation, mTLS, site/central. 59 dev tests.
- **Next:** OpenBao creds, Redis-backed multi-instance rate limiting.

## sync-engine-go
### [0.7.0] — 2026-07-23 · PROTOTYPED
- Baseline. Central/site reconciliation, HLC, conflict rules, RLS, bootstrap, GC; property-based + chaos
  tests on a 2-Postgres harness. Runs idle (`sync-central`).
- **Next:** activate against a real second site.

## automation (n8n)
### [0.4.0] — 2026-07-23 · DEV-VERIFIED
- Baseline. n8n + MCP templates, scoped accounts, impact gate, event bridge, approvals suspension.
  3 flows verified e2e on the live dev stack (2026-07-15).
- **Next:** more flows; Temporal for durable orchestration.

## observability
### [0.6.0] — 2026-07-23 · DEV-VERIFIED
- Baseline. OTel across all services; opt-in Grafana stack; SLOs; alerting; restore drill. Verified e2e
  on a live Docker stack (2026-07-15).
- **Next:** deploy to a real host; tune SLOs on prod traffic.

## infra
### [0.5.0] — 2026-07-24 · PROTOTYPED (agent-runner service + bot writable volumes + .env updates)
- **Workstream A+B compose changes:** NEW `agent-runner` service in `docker-compose.vps.yml` (build: ../../ai-agents, command: ["npx", "tsx", "src/runner/service.ts"],
  port 3006, restart unless-stopped). Env: AGENT_RUNNER_TOKEN, AGENTS_DATABASE_URL (knowledge_app role), MIGRATE_DATABASE_URL (knowledge_owner role),
  GATEWAY_URL/TOKEN, HUB_URL/HUB_SERVICE_TOKEN. Depends on postgres/ai-gateway/mcp-hub.
- **Bot writable group registry:** `wa-chat-bot` service: `GROUPS_FILE=/app/data/groups.yaml` (writable, points to bot-data volume), `GROUPS_SEED_FILE=/app/config/groups.seed.yaml`
  (read-only seed). Volumes: bot-data:/app/data (NEW), ./groups.yaml:/app/config/groups.seed.yaml:ro (updated mount path from was :/app/config/groups.yaml:ro).
  Old groups.yaml file stays as the first-boot seed (boot copy logic if file absent).
- **platform service updates:** AGENTS_URL: http://agent-runner:3006, AGENT_RUNNER_TOKEN env (reuses AGENT_RUNNER_TOKEN secret).
- **`.env.example` updates:** added AGENT_RUNNER_TOKEN secret placeholder; noted that bot groups.yaml is now the first-boot seed only (registry lives in the volume).
- **Not deployed yet:** compose stack verified locally; container builds not verified on a Docker host (same caveat as ai-gateway-go).

### [0.4.0] — 2026-07-23 · PROTOTYPED
- Baseline. VPS Compose stack, Dockerfiles, local CI, backups, supply-chain pipeline (SBOM/cosign/SLSA).
- **Next:** first production deploy; GitOps; K8s/SPIFFE (target-state).

## wa-chat-bot
### [0.8.0] — 2026-07-24 · PROTOTYPED (session-lifecycle admin plane + writable group registry)
- **Workstream A (WhatsApp go-live self-service, design §2):** new `waha-admin.ts` client + ADMIN_TOKEN-gated Fastify routes for session lifecycle
  (POST start, GET status, GET qr with data-URL base64, POST stop/logout/restart); all engine-tolerant (NOWEB status strings pass verbatim).
  Routes: `/admin/session/{start,status,qr,stop,logout,restart}` with responses per design spec §2.1.
- **Writable group registry:** moved from read-only compose bind mount to writable bot-data volume (`/app/data/groups.yaml`); YAML + mtime
  hot-reload unchanged; NEW `writeGroups()` validates (id regex, name/category lengths, ≤1 isManagement, ≤500 groups, atomic write);
  `discoveredGroups()` returns in-memory map of auto-discovered groups with firstSeenAt. Routes: `GET /admin/groups` (registry snapshot + discovered
  + managementGroupId), `PUT /admin/groups` (full-replace, idempotent, field-level validation 400).
- **Safe config write:** `GET /admin/config` (read-only snapshot + editable values), `PUT /admin/config {postToGroups?, managementGroupId?}` rewrites registry
  isManagement flag when managementGroupId changes (empty string clears to env fallback). **No editing of other env-backed config from ERP** (design 2.3 §2.6).
- **Session-state tracker (NEW `session-state.ts`):** extends InboundEvent with `{kind:"session", session, status, ts}`; normalizeWahaEvent maps webhook
  `session.status` events (tolerates both payload.status + payload.body.status shapes); ring buffer of last 20 transitions `{status,ts}` + WARN logs on
  FAILED|STOPPED transitions; `/health` gains `session` field (status string only, no identifiers).
- **Bot environment updates:** `GROUPS_FILE=/app/data/groups.yaml` (writable), `GROUPS_SEED_FILE=/app/config/groups.seed.yaml` (read-only seed);
  boot logic: if `groupsFile` absent and seed exists → copy seed → log one line. Existing `WHATSAPP_HOOK_EVENTS` already subscribed `message,session.status`.
- **NOT deployed yet:** bot session e2e tested (start→SCAN_QR_CODE→QR); UI surfaces pending (WS5 scope, not yet built).

### [0.7.1] — 2026-07-24 · NOWEB engine + aire-lesson hardening
- WAHA switched to the **NOWEB (Baileys) engine**, image pinned `devlikeapro/waha:noweb-2026.6.2`
  (no more `:latest` — aire hit floating-tag drift). Added `WHATSAPP_DEFAULT_ENGINE=NOWEB`,
  `WHATSAPP_DOWNLOAD_MEDIA=True` (feeds media enrichment), `WHATSAPP_HOOK_EVENTS="message,session.status"`
  (see reconnect/ban state, not just messages). Kept `RESTART_ALL_SESSIONS` + persisted `.sessions`
  volume (relink survives restart w/o re-QR).
- Bot persona renamed **Gaia → Rhea** (`BOT_NAME` default); persona still playful/professional by stakes.
- `normalize()` hardened engine-tolerant (aire lessons): `replyToBot` now also reads NOWEB-normalized
  `replyTo.fromMe`; `senderName` falls back to `_data.pushName`; **system-chat guard** drops
  `status@broadcast`/`@broadcast`/`@newsletter` (never reply there). Webhook already ACKs 200 before
  detached processing (dup-reply lesson already satisfied). +4 normalize tests; suite green.
- **NOWEB caveat:** the store must be enabled at SESSION CREATION (`config.noweb.store.enabled`), not
  via env, and final NOWEB payload shape can only be validated once a number is paired (needs the phone).

### [0.7.0] — 2026-07-24 · DEV-VERIFIED (persona + prompt-safety)
- New `src/persona.ts`: agency persona (voice adapts to stakes — playful/low-stakes, direct/work,
  firm/at-risk), scope limits, graceful decline, and an injection guard. `fence()` wraps untrusted
  content and neutralizes fence-breakout attempts; `dataNote()` marks fenced data as non-instructions.
- Wired into every chat-facing prompt: `answerQuestion` (persona + scope-narrowed — no open-ended
  general knowledge), `/know` + `/actions` skills, digest map/reduce (injection guard only, stays a
  neutral report), intent router (message fenced + "classify only, ignore embedded instructions").
- Reply gating hardened: `@bot` match changed from loose `includes()` to a standalone-token regex
  (`mentionsBot`) so "@bottom"/"x@bot.com" no longer trigger the bot. Gating unchanged otherwise:
  groups reply only on command/@mention/reply-to-bot; DMs always; non-triggered messages stored
  silently for digests. Digests remain management-only unless a group opts in / `POST_TO_GROUPS=true`.
- Config: `BOT_NAME` (default "Gaia"), `AGENCY_NAME` (default "Gaiada").
- Tests: new `persona.test.ts` + mention-hardening cases; 194 pass (3 pre-existing e2e fails are
  Postgres-auth env issues, unrelated). **Live e2e** against Ollama Cloud via the rebuilt gateway:
  in-scope Q&A answers naturally & grounded; jailbreak/prompt-leak declined w/o leaking; off-topic
  declined + redirected; at-risk prompt drew a firm, accountable reply. Bot container rebuilt + live.
- Baseline. WA + Telegram bot; scrub → crypto-shred → skills/Q&A; digests; media enrichment. Telegram live
  in dev; P5a features.
- **Blocked:** infra (OpenBao/Gemini/WAHA) + legal Gate 1 before real ingestion.

## ai-agents
### [0.4.0] — 2026-07-24 · PROTOTYPED (agent-runner service + goal/run store + queue)
- **Workstream B agent runtime e2e (design §3):** NEW `src/runner/service.ts` Fastify microservice (port 3006, AGENT_RUNNER_TOKEN auth, mirroring knowledge/service.ts patterns).
  `buildRunnerApp(deps)` factory for tests. Env: `GATEWAY_URL/GATEWAY_TOKEN`, `HUB_URL/HUB_SERVICE_TOKEN`, `AGENTS_DATABASE_URL` (runtime role), `MIGRATE_DATABASE_URL`
  (owner role), `AGENT_MAX_CONCURRENT_GOALS` (default 1), `AGENT_MAX_QUEUE` (default 10), `AGENT_SERVING_PROVIDER` (optional override for D13 gate).
- **Data model (gaiada_knowledge):** NEW tables created by owner-DSN DDL (zero infra/DB-role changes needed, auto-grant to knowledge_app per existing pattern).
  `agent_goals` (queued|running|ok|suspended|budget_exhausted|failed|interrupted|cancelled, outcome, error_kind, approval_id, model_calls, tool_calls, budget caps,
  fan_out, blackboard jsonb for supervisor goals), `agent_runs` (full traced run per direct-specialist goal, TraceStatus, steps transcript, tools_called array).
  Indexes on (tenant_id, created_at DESC) for both.
- **Execution semantics:** supervisor → `runOrchestrator` → approval suspension → `suspended` + `approval_id`; write-specialist → `runWriteAgent` → `forced_read_only`
  (outcome notes the gate); read-specialist → `traceRun` → `agent_runs` row. Boot-recovery sweep: `UPDATE agent_goals SET status='interrupted'` for orphaned (queued|running)
  goals — deterministic, human re-triggers. In-process FIFO queue, workers unref'd, max-concurrent + max-queue gates. Typed error mapping:
  Budget → `budget_exhausted`, Approval/Suspended → `suspended`, Unknown/Planner/Model/ToolNotAllowed → `failed` + `error_kind`.
- **HTTP endpoints:** `GET /health` (agents/writeAgents/queue list), `POST /goals` (token, 202 queued), `GET /goals?tenant=uuid&limit=50` (list, newest first),
  `GET /goals/:id?tenant=uuid` (goal + blackboard + run summaries), `GET /runs/:id?tenant=uuid` (full run + steps), `POST /goals/:id/cancel?tenant=uuid` (queued→cancelled),
  `GET /metrics/agents` (collector summary + alerts). All reads tenant-pinned (no cross-tenant id probing).
- **Existing integrations preserved:** episodic store (PgEpisodicStore) auto-records every finished goal/run, D9 RAG, D11 revocation, D13 forced_read_only, D14 approvals.
  `evaledProviders` enrollment via eval suite + tool-contract check (runbook: `docs/runbooks/agent-evaled-providers-enrollment.md`).
- **DEV-VERIFIED end-to-end** (2026-07-24): agent-runner container lives; goal/run store persists on gaiada_knowledge; goal execution follows approval-suspension
  path (D14 gates untouched); D13 forced_read_only surfaces in status + UI; gateway timeout + 429 breaker work with runner calls (x-tenant-id propagated).
- **NOT deployed yet:** agent-runner container exists but not deployed; pending search-marketing build blocker for full UI-through.

### [0.3.0] — 2026-07-23 · IN PROGRESS
- Baseline. Specialist framework + supervisor + pgvector RAG; D14 safety.
- **Next:** eval harness (root gate) → memory/RAG → local-model registry → trainer.

## hermes-gateway
### [0.2.0] — 2026-07-23 · PROTOTYPED
- Baseline. Local Hermes brain via the Gateway contract; verified headless.

## capture-helper
### [0.2.0] — 2026-07-23 · IN PROGRESS
- Baseline. Capture edge: record → local Whisper → ingest → Shared Drive.
- **Next:** complete the MOM→PRD delivery pipeline tails.

## webdesk
### [0.0.0] — 2026-07-23 · PLANNED
- Blueprint approved; no code. Phased plan P1–P6 (see BLUEPRINTS.md).

## search-marketing
### [0.1.0] — 2026-07-23 · IN PROGRESS
- **SM-01 landed** (migrations `0034_module_search.sql` + `0035_integration_connections_search_providers.sql`
  + `module-search-rls.test.ts`): 18 `search_*` tenant tables under third-wall FORCE-RLS + the no-RLS
  `search_data_cache` (D-4), dual-mode embedding col (float8[] fallback — pgvector absent, OQ-8),
  additive `integration_connections` widen. Merge gate cleared: QA PASS (45/45 db tests, adversarial
  RLS matrix on a second DB) + architect APPROVE-WITH-NOTES (full §04/§11 conformance).
- **SM-02 landed** (`src/modules/search/` — ModuleContract, controller `api/:t/modules/search`, 18
  `search.*` mcpTools, property/engagement/kpi CRUD, `engagements/:id/scope` + preset seeding,
  service-layer same-tenant FK validation). Full repo suite 512/512 green; tsc + withTenants lint clean.
  Module is fail-closed until SM-03 adds Cerbos policy (by design).
- **In progress:** SM-03 Cerbos ∥ SM-04 provider layer + cost ledger.

### [0.0.0] — 2026-07-23 · PLANNED
- Foundation research + v1.1 architect design ratified; no code. See
  `blueprints/seo-sem-foundation.md` + `blueprints/seo-sem-design.md`.
- Owner decisions locked: dept name SEO (3-craft-group Web-Dev console), dual-mode SEM execution,
  no-RLS shared market-data cache, per-engagement tool-scope config.
- 26 tickets P0–P3 + 2 committed P4 (design §12).

## social-media
### [0.0.0] — 2026-07-23 · PLANNED
- Foundation research + v1.0 architect design; no code. See `blueprints/smm-foundation.md` +
  `blueprints/smm-design.md` (+ print `GAIADA-Social-Media-Engineering-Blueprint.pdf`).
- Decisions locked: scope v1 = organic publish + engagement + copy + assets (paid/listening/influencer
  parked); publisher = Postiz (AGPL-3.0) run AGPL-CONTAINED (Mixpost Pro paid fallback); Chatwoot dropped
  (engagement uses Postiz's comment/collab surface). Module key `social`, tables `social_*`; mandatory
  human-in-the-loop (one-shot payload-hash approvalId, no auto-publish); one usage ledger (X fees + gen
  credits); no shared no-RLS cache.
- **Next:** P0 contracts + AGPL-containment spike (SMM-01 migrations/RLS → SMM-02 module/contract →
  SMM-03 Cerbos → SMM-04 Postiz adapter/containment → SMM-05 tenant mapping → SMM-09 approve-execute).
  27 tickets P0–P4 + 2 decision-gated (design §12).

## creative
### [0.1.0] — 2026-07-23 · PROTOTYPED
- Baseline (pre-existing dev code): **Image Studio** client-side grading engine (WebGL2 LUT + Canvas2D
  fallback, pure imaging lib, 35 UI tests, visually verified) + `creative_assets` persistence (migrations
  `0031`/`0032`, `/api/:t/creative/assets`) + grading-trainer ONNX scaffold. See memory `creative-image-studio`.
- **Expansion designed (no code yet):** v1.0 architect design authored — `blueprints/creative-foundation.md`
  (research + Magnific head-to-head) + `blueprints/creative-design.md` (§00–§14) + print
  `GAIADA-Creative-Engineering-Blueprint.pdf`. Module key `creative`, tables `creative_*`, third-wall RLS,
  migration `0036`; `creative_assets` extended in place + versions/collections/brand-kits/render-jobs/
  usage-ledger/scopes. Build-light DAM (RLS store + Shared Drive + pgvector CLIP search + BLIP tags +
  imgproxy renditions). Default model stack commercial-license-CLEAN; SUPIR/FLUX-dev/RMBG/IC-Light-V2/SVD
  quarantined behind license gates.
- Owner decisions locked (2026-07-23): serverless-GPU-first · hybrid image licensing (clean default + FLUX
  paid opt-in) · hybrid video (Wan 2.2 OSS + Veo/Kling API budget) · build-light DAM.
- **Next:** Phase 0 clarity-upscaler Replicate spike (kill Magnific now) → P0 contracts → P1 upscale via
  the Render Gateway → P2 gen/edit → P3 DAM → P4 video. 27 tickets CR-00–CR-26 (design §12); Opus-flagged
  CR-01/06/13; QA gates CR-01/06/12/13/20.

## render-gateway-go
### [0.0.0] — 2026-07-23 · PLANNED
- Design only — the centerpiece of `blueprints/creative-design.md` §05; no code. Separate Go service
  (mirror of `ai-gateway-go`): typed render job-queue, `RenderBackend` abstraction (serverless GPU /
  self-host ComfyUI / commercial API) routed per capability+license+cost+health, ComfyUI-workflow-as-JSON,
  signed per-job I/O URLs, idempotent render-callback, fail-closed stop-loss (image $200 / video $300),
  structural license wall, egress audit. Outputs land in the `creative` DAM; job state on platform-nest rows.
- **Next:** built under the `creative` P1–P4 tickets; container-build verification before deploy.
