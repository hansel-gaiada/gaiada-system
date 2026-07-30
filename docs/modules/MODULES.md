# Gaiada — Module Registry

Single source of truth for **module status, versions, and future plans**. Each module has a
specialized section below. Change history lives in [`CHANGELOG.md`](./CHANGELOG.md).

> **Read the status honestly.** Nothing here is production-finished. See the vocabulary below —
> "prototyped" means *works in the dev stack*, not *done*.

## Status vocabulary

| Status | Meaning |
|---|---|
| `PLANNED` | Design/blueprint only — no code yet. |
| `IN PROGRESS` | Actively being built; partial. |
| `PROTOTYPED` | Code exists and runs in the **dev** stack; **NOT** production-verified or feature-complete. |
| `DEV-VERIFIED` | Prototyped **and** exercised end-to-end on the local stack (still not production). |

**Versioning:** semver-style, all `0.x` because nothing is in production. Baseline versions were
assigned **2026-07-23** for tracking-forward — they are not pre-existing release tags. Bump the
version and add a `CHANGELOG.md` entry on every notable module change.

---

## Registry (at a glance)

| Module | Ver | Status | Workstream | Since |
|---|---|---|---|---|
| platform-nest | `0.6.3` | PROTOTYPED | WS1 | 2026-07 |
| platform-ui | `0.6.5` | PROTOTYPED | WS5 | 2026-07 |
| ai-gateway-go | `0.13.0` | PROTOTYPED | WS3 | 2026-07 |
| mcp-hub | `0.9.0` | PROTOTYPED | WS2 | 2026-07 |
| sync-engine-go | `0.7.0` | PROTOTYPED | WS1 | 2026-07 |
| automation (n8n) | `0.4.0` | DEV-VERIFIED | WS4 | 2026-07 |
| observability | `0.6.0` | DEV-VERIFIED | WS9 | 2026-07 |
| infra | `0.5.2` | PROTOTYPED | WS10 | 2026-07 |
| wa-chat-bot | `0.9.1` | PROTOTYPED | WS5 | 2026-07 |
| ai-agents | `0.4.0` | PROTOTYPED | WS8 | 2026-07 |
| hermes-gateway | `0.2.0` | PROTOTYPED | WS3 | 2026-07 |
| capture-helper | `0.2.0` | IN PROGRESS | WS11 | 2026-07 |
| webdev | `0.8.0` | IN PROGRESS | Web Dev | 2026-07-30 |
| webdesk | `0.0.0` | PLANNED | Web Dev | 2026-07-23 |
| search-marketing | `0.2.0` | IN PROGRESS | SEO | 2026-07-28 |
| social-media | `0.0.0` | PLANNED | Social Media | 2026-07-23 |
| creative | `0.1.0` | PROTOTYPED | Creative | 2026-07 |
| render-gateway-go | `0.0.0` | PLANNED | Creative | 2026-07-23 |
| reports | `0.0.0` | PLANNED | Cross-cutting | 2026-07-30 |
| report-renderer | `0.0.0` | PLANNED | Cross-cutting | 2026-07-30 |

---

## platform-nest — Platform Core · `0.6.3` · PROTOTYPED

**What exists (dev):** modular multi-tenant NestJS core with FORCE-RLS schema, `ModuleContract`
framework + custom fields, Cerbos RBAC (scope cascade, decision audit, revocation, PlanResources),
OBO + dual-proof identity links, cross-company rollups, the agency vertical (clients/deliverables/
time, campaigns/briefs/creative review, comments, notifications, files), and the transactional-outbox
event backbone. ~92 dev tests pass against live PG + Cerbos.
**0.6.0 (Workstream A+B admin proxies):** `@Controller("api/admin/bot")` (isElevated-gated) proxies wa-chat-bot's
session lifecycle, writable group registry, and safe config write (fail-soft: bot unreachable → 502, not configured → 404);
`admin/intelligence.controller.ts` now makes real HTTP calls to the agent-runner service (`GET /health` for status,
`GET/POST /goals`, `GET /runs` tenant-pinned and elevated-only); platform self-link idempotent upsert (`identity_links`
row on trigger); probeStatus/connectionConfig for both bot and agents now hit real services instead of stubs.
**0.6.2 (bot console proxies):** nine new elevated-gated proxies (kill switch, digest run + history, skills,
media status, ignore list, cross-chat search) with field-level 400s and a 60s budget for the digest run, plus
`optionItems` (value/label) carried through the ConfigField contract for the management-group dropdown.
**0.6.1 (bot-proxy honesty fixes):** `botCall` now surfaces the bot's **404** verbatim (was collapsing every
non-400 into `502 bot admin unreachable`, so a chat with no stored transcript reported the bot as down);
the bot status probe treats a `session: "unknown"` health field as MISSING and falls back to the
authoritative `/admin/session/status`, instead of showing "unknown" as if it were a real session state.
**Known gaps:** not deployed to production.
**Future plans:** additional verticals (resort/marine/print) → hardening to production.

## platform-ui — ERP Suite · `0.6.5` · PROTOTYPED

**What exists (dev):** Next.js ERP UI, BFF to platform-nest, RBAC-gated nav + company switcher; My Work,
Approvals inbox, Companies/Projects/Tasks, Agency, Rollups, Systems/Intelligence/Admin consoles, People
360, org-structure builder, Repsona-style PM + AI tracker, IT device console, per-department consoles
(Web Dev reference), OIDC PKCE login. Runs backend-free in `DEMO_MODE`; Playwright e2e in dev.
**0.7.1 (digest controls):** "Run now" reports STARTED then polls the history to completion (no more false
"unreachable" on a ~90s run), plus a group picker + "Preview (sends nothing)" rendering the digest text inert.
**0.7.0 (console depth + pagination):** new Controls tab (actions kill switch with off-immediate/on-confirm,
digest run + history, media queue, capabilities); Groups tab ignore/un-ignore; Chats search, cross-chat message
search and load-older paging; shared `Paginator`/`usePagination` + 300ms debounce applied at 30 rows/page across
the Bot, Automation, MCP Hub and AI Gateway consoles (client-side only — no new endpoints). Page resets to 1 on a
filter change but NOT on a poll tick, so a refresh can't yank an operator off their page.
**0.6.3 (bot page correctness):** registry rows regained the **optIn** (digest-back) column — the bot's PUT
is a full replace, so saving from the ERP silently turned per-group digest post-back OFF for every group;
Groups tab now warns before the FIRST save that it switches the bot out of trial mode (unlisted groups stop
being ingested); Chats/Logs panels no longer sit on "Loading…" forever when a fetch fails.
**0.6.2 (bot Logs/Groups panels):** discovered-group rows fall back to the JID when the subject is still
unresolved (blank rows before); the empty action-audit note now explains what populates it instead of
reading as a broken panel.
**0.6.0 (Workstream A+B admin surfaces):** Connect-WhatsApp UI (status pill + QR scanner, Connect/Show-QR/Restart/Stop/Logout buttons,
session event trail); Group Registry UI (monitored-groups table with category/optIn, discovered-list one-click-add, management-group radio);
agents UI extended with trigger card (goal text + agent select, elevated-only), goals list/detail pages with blackboard + run transcripts,
run detail page showing step-chip transcript (text-only, never HTML or raw JSON).
**Known gaps:** not deployed to production.
**Future plans:** dept-console integrations program → prod hardening.

## ai-gateway-go — AI Gateway · `0.13.0` · PROTOTYPED

**What exists (dev):** Go gateway (the `ai-gateway` service on `:3002`), HTTP-parity with the retired Node
gateway; provider chain + failover + circuit breaker, DLP, daily cost cap, egress audit + allowlist,
internal CA + mTLS, site/central topology, DR-burst budget. go build/vet/test green.
**0.11.0 (Workstream B gateway reliability):** NEW `PROVIDER_TIMEOUT_MS` (default 60000) with context timeout
enforcement in every capability handler (Complete/Media/Embed) — hung provider becomes clean failover, client disconnect
cancels upstream; **429 taxonomy** — providers return typed `RateLimitError{RetryAfter}` (parse Retry-After, cap at 5m),
breaker opens immediately for min(RetryAfter, cap) instead of counting toward consecutiveFails — one 429 stops hammering
exactly as advertised, doesn't poison "dying" signal; **error taxonomy in audit + 502 body** — attempted-provider errors
tagged `timeout|rate_limit|provider_error` (egress audit + ERP console can distinguish, `Blocked: "rate_limit"` when all
providers rate-limited); per-tenant call cap already EXISTS (x-tenant-id header propagated from runner on `/complete` calls
for tenant-attributed load).
**Known gaps:** **docker build not verified** (no Docker in the dev env) — validate on a Docker host before
deploy. Deferred: OpenBao-issued creds, media DLP classification, native per-provider streaming, cert rotation.
**Future plans:** verify container build → OpenBao creds → media DLP → prod.

## mcp-hub — Access Layer · `0.9.0` · PROTOTYPED

**What exists (dev):** MCP server (official SDK, Streamable HTTP, stateless) fronting platform-nest; OBO
principal minting, Cerbos-authoritative policy, full Tools/Resources/Prompts surface, module-aggregated
tool defs, rate limiting, revocation, mTLS floor, site/central topology, JSONL audit. 59 dev tests.
**Known gaps:** OpenBao-minted short-lived creds and Redis-backed multi-instance rate limiting deferred.
**Future plans:** OpenBao creds → multi-instance rate limiting → prod.

## sync-engine-go — Cross-Site Sync · `0.7.0` · PROTOTYPED

**What exists (dev):** one Go binary (central/site modes) reconciling the shared outbox with HLC ordering,
per-field conflict resolution, per-tenant RLS, subscription ACL, new-node bootstrap, watermark-gated GC.
Property-based convergence + partition/chaos passing on a local 2-Postgres harness.
**Known gaps:** runs **idle** (`sync-central`) — never exercised against a real second site; not in production.
**Future plans:** activate when a second site exists → prod hardening.

## automation (n8n) — Orchestration · `0.4.0` · DEV-VERIFIED

**What exists (dev):** n8n + MCP-calling templates, scoped n8n accounts, impact gate, platform→n8n event
bridge, approvals-suspension surface. **3 flows verified end-to-end** on the live dev stack (2026-07-15).
**Known gaps:** Temporal (durable workflows) deferred until a durable flow exists; not in production.
**Future plans:** more flows → Temporal for durable orchestration → prod.

## observability — Telemetry · `0.6.0` · DEV-VERIFIED

**What exists (dev):** OTel across all services (fail-soft), opt-in Grafana/Prometheus/Tempo/Loki stack,
multi-burn-rate SLOs, alerting (≥2 transports + dead-man's-switch), synthetics, restore drill. **Verified
end-to-end on a live Docker stack** (2026-07-15).
**Known gaps:** filelog→Loki env-limited on Docker Desktop (works on Linux VPS); not deployed to prod.
**Future plans:** deploy the stack to a real host → tune SLOs against prod traffic.

## infra — Platform Engineering & Delivery · `0.5.2` · PROTOTYPED

**What exists (dev):** full VPS Docker Compose stack, per-component Dockerfiles, local CI (`test-all.sh`),
GH Actions (inert until the repo is standalone), crypto-shred-safe backups, supply-chain pipeline
(SBOM + cosign + SLSA).
**0.5.0 (Workstream A+B compose):** agent-runner service added to compose stack (`build: ../../ai-agents`, Fastify :3006,
AGENT_RUNNER_TOKEN auth, gaiada_knowledge owner/app roles); wa-chat-bot environment wired for writable group registry
(GROUPS_FILE: /app/data/groups.yaml, GROUPS_SEED_FILE: /app/config/groups.seed.yaml); bot-data volume added for registry + session state;
old groups.yaml bind mount moved to seed path (read-only); .env.example updated with AGENT_RUNNER_TOKEN secret.
**0.5.2 (platform-nest test harness made deterministic):** every test FILE now gets its own physical Postgres
database (`pgtest_f_<sha1(testPath)>`), created and migrated in its own `beforeAll`. Replaces a shared-schema
harness whose `DROP SCHEMA` raced across workers and whose advisory lock, released only in teardown, let one
failed `beforeAll` block every later file (observed: 19 then 57 files failing, from zero real defects).
**Verified green on 4 consecutive full runs** (74 files / 734 tests / 0 skipped). Costs ~7min and ~730MB of
throwaway databases per run — correctness over speed; schema-per-file is the lighter follow-up if that bites.
**0.5.1 (local test-infra in the dev override):** `docker-compose.local.yml` now also publishes
**cerbos** (3592/3593 — a portless Cerbos fails every authz check, so the platform suites could not
run), **pg-bot** (55434, for wa-chat-bot's DB-backed suites against a dedicated `gaiada_bot_test`
database) and a **disposable `redis-test`** (56380) that MUST stay separate from the live event-backbone
Redis because `n8n-bridge.integration.test.ts` calls `FLUSHALL`. Nothing was added to the VPS compose —
it stays internal-only by design. **Bring the stack up with BOTH files**: recreating a container with
the VPS file alone strips the override's published ports (it silently unpublished `platform:3004`, which
the host-run UI depends on).
**Known gaps:** not deployed; K8s/GitOps + SPIFFE/SPIRE are target-state (hiring-gated).
**Future plans:** first production deploy → GitOps → K8s/SPIFFE at target-state.

## wa-chat-bot — Messaging Surface · `0.9.1` · PROTOTYPED

**What exists (dev):** WA (WAHA) + Telegram work-summary/assistant bot; scrub → crypto-shred store →
skills/Q&A, digests, media enrichment via gateway. Telegram live in dev; P5a production-grade features.
**0.8.0 (Workstream A WhatsApp admin plane):** session lifecycle admin routes (`POST /admin/session/start|status|qr|stop|logout|restart`),
writable group registry (moved to bot-data volume, YAML + hot-reload + discovered-groups tracking),
safe config write (`PUT /admin/config {postToGroups,managementGroupId}`); session-state tracker records webhook
events into a ring buffer + `/health` session field; webhook already ACKs 200 then processes detached (aire lesson).
Gated by Bearer ADMIN_TOKEN; all engine-tolerant (NOWEB status strings pass verbatim, never enumerated-rejected).
**0.9.1 (digest delivery + async run) — DEV-VERIFIED:** the digest DELIVERY TARGET may now be a direct chat
(e.g. the operator's own number via WhatsApp "message yourself"), not just a group, and it is persisted in its
OWN file — writing it into the group registry used to activate registry mode with zero monitored groups and
silently stop ALL ingestion. Manual runs are async (202 + poll) and there is a send-nothing digest PREVIEW.
Also fixed: scheduled digests had been failing since the DB role split (`schedule-state` ran DDL as the
restricted runtime role → `permission denied for schema public`), and legacy hyphenated group ids were
rejected by the chat-id validator.
**0.9.0 (bot console depth — 4-agent build, DEV-VERIFIED):** ignore list (a group on it is dropped in BOTH
registry modes, so "monitor everything except these" is finally expressible), digest history + next-run times,
skills catalog, media-queue health, chat search + backwards paging (`searchMessages`/`getMessagesPage` on both
FileStore and PgStore), and `managementGroupId` served as a labelled dropdown (registry + discovered groups).
Integration caught three real defects: chat q/kind filters ran AFTER the store limit (a search could answer
"no results" while matches existed), `@lid` DM ids were rejected by a duplicated chat-id regex (every DM 400'd
on click), and an empty registry fell back to a JID text box.
**0.8.3 (group naming everywhere):** `groupName()` falls back to the auto-discovered subject before the
bare JID, so the ERP Chats tab and digest headers stop showing `1203…@g.us` for groups the Groups tab
already names (the registry is empty in trial mode, and it was the only source consulted).
**0.8.2 (session timeline: seeded + durable) — DEV-VERIFIED on the live stack:** the status timeline is
persisted (`SESSION_EVENTS_FILE`, default `data/session-events.json`) and restored at boot, and the current
status is now SEEDED from WAHA (`observeStatus`, de-duplicated) on boot and on every `/admin/session/status`
read — WAHA only pushes `session.status` on a CHANGE, so a session already WORKING before the bot started
left the Logs tab blank and `/health` reporting "unknown" after every restart.
**0.8.1 (discovery: named + durable) — DEV-VERIFIED on the live stack:** discovered groups now persist to
`discovered-groups.json` beside the groups file (survives restart, atomic write, 500-entry cap) and carry a real
subject — resolved out-of-band from WAHA (`group-names.ts`, shape-tolerant across the JID-keyed `/groups` map,
array `/chats`, NOWEB `subject` and WEBJS `name`) on the next message and on every `GET /admin/groups` read.
**Known gaps:** trial-lite; blocked on infra (OpenBao VPS, Gemini key, WAHA number) and legal Gate 1
before real ingestion; not in production.
**Future plans:** WAHA primary once number scanned → hardening backlog → prod after gates.

## ai-agents — Agent Brigade · `0.4.0` · PROTOTYPED

**What exists (dev):** specialist framework (status-reporter, approvals-chaser) + supervisor orchestrator
(blackboard, cycle guard, per-goal budget, fan-out cap, approval suspension) + pgvector RAG; D14 safety in code.
**0.4.0 (Workstream B agent runtime e2e):** agent-runner Fastify service (`:3006`, AGENT_RUNNER_TOKEN auth);
goal queue + store (IN-PROCESS FIFO, max-concurrent/max-queue gates, boot-recovery sweep interrupting orphaned goals);
typed goal/run persistence (`gaiada_knowledge` DB, owner-DSN DDL auto-grants to runtime role, zero infra changes needed);
`agent_goals` table (queued|running|ok|suspended|budget_exhausted|failed|interrupted|cancelled), `agent_runs` full-traced rows;
approval suspension surfaces `approval_id` for deep-link to WS4 inbox; D13 forced_read_only path surfaced honestly in status + UI;
`evaledProviders` enrollment gated by eval suite + tool-contract check (runbook: `docs/runbooks/agent-evaled-providers-enrollment.md`);
all existing gates preserved (D9 scope, D11 revocation, D13/D14 per-principal). **DEV-VERIFIED end-to-end (pipeline+gateway+D13):**
agent-runner service lives, goal/run store persists, goal execution follows approval suspension path, forced_read_only surfaces.
**Known gaps:** steps 4–6 (memory/RAG ownership, local-model registry, eval-gated trainer) not built; the
eval harness is the root gate for more autonomy.
**Future plans:** eval harness → memory/RAG → local-model registry → trainer.

## hermes-gateway — Local-Model Shim · `0.2.0` · PROTOTYPED

**What exists (dev):** a shim making a local Hermes model the bot's brain via the Gateway contract; verified
headless. **Known gaps:** dev-only convenience; not in production.
**Future plans:** fold into the local-model registry (WS8) when it lands.

## capture-helper — Capture Edge · `0.2.0` · IN PROGRESS

**What exists (dev):** WS11 capture edge — in-ERP record → local Whisper `.txt` → ingest → Shared Drive;
feeds the meeting→MOM→PRD delivery pipeline. **Known gaps:** pipeline tails in progress; not in production.
**Future plans:** complete the delivery pipeline (MOM→PRD/report/scope) → prod.

## webdev — Delivery Rail · Cockpit · `0.8.0` · IN PROGRESS

**Design:** [`../blueprints/webdev-design.md`](../blueprints/webdev-design.md) (§12 has the ticket
ledger); Phase-3 ticket plan:
[`../superpowers/plans/2026-07-30-webdev-phase3-tickets.md`](../superpowers/plans/2026-07-30-webdev-phase3-tickets.md).
Registered `0.0.0 PLANNED` on design approval (2026-07-24); flipped `IN PROGRESS` on WD-01 (first
merged ticket, 2026-07-29) per the status-language rule; bumped `0.8.0` on WD-28 (first Phase-3
ticket to land, 2026-07-30, per the Phase-3 plan's own instruction to bump the minor on first
merge).

**Phase 3 (external wiring) — 1 of 10 tickets landed:** WD-28 (PM per-project short-codes, OQ-7
default) — **DEV-VERIFIED**: `projects.short_code` (unique per tenant) + `projects.task_seq`
(atomic per-project counter) + `pm_tasks.seq`; atomicity proven under 30 genuinely concurrent live
HTTP requests (zero duplicate/missing seq); backfill migration for pre-existing rows required a
same-day follow-up (`0051`) after live verification caught the first pass (`0050`) silently
backfilling zero rows — migrations run as `platform_owner` (no `BYPASSRLS` per the 2026-07-15
DB-topology split) against FORCE-RLS tables with no tenant GUC set, so the owner-run backfill saw
zero rows under RLS with no error; fixed by wrapping the same logic per-tenant. See
`FRONTEND-BFF-CONTRACT.md` §5 for the full shape + verification detail. WD-21 (GitHub App +
webhook receiver) is the next dependent ticket (short-code resolution for the commit/branch
linker), gated on OQ-2 (GitHub org + App registration).

**What exists (dev), Phase 1 — ENTRY (audio→PRD, from the ERP), 7 of 8 tickets landed:**
WD-01 (live-stack refresh + Ollama Cloud brain + WS11 re-drive, **DEV-VERIFIED** — real PRD
extraction, `prdConfidence 0.9`, non-echo); WD-02 (`/pipeline/[runId]` run workspace — three
tracks, stage chips, gate history, artifact rendering via `ArtifactMarkdown`, deep links from
`/meetings` + PRD Studio); WD-03 (artifact signature lock — stage-artifact edits refused 409 once
the client sign gate decides, enforced in `pipeline.controller.ts`, not convention); WD-04
(in-ERP audio upload → server-side whisper transcription, backend: `POST
/api/:t/meetings/recordings/:id/audio` + `/audio/retry`, `meeting_recordings.audio_ref` additive
column, migration `0049`); WD-05 (delivery-workflow tails — bounded revise loop + prod chain on
live n8n); WD-06 (report sink v1 — `pm.createDoc`/`pm.createTask` hub tools, `wf:report`-scoped,
fanout report branch). **WD-07 (this ticket, 2026-07-30)** closes two gaps WD-04 left open and
adds the Phase-1 UX/docs polish pass:
- **The WD-04 frontend** (its AC needed a browser upload, only ever curl-verified): an
  `AudioUploadForm` (poll-until-terminal, same pattern as `WhatsAppConnect.tsx`) on
  `/meetings/[id]`'s workbench + a combined register-and-upload path inside `RecordControls`
  (for the no-existing-recording case) — surfaces `transcribing` progress and a retry action on
  `failed`, with a DEMO_MODE-equivalent (`demoUploadAudio`/`demoRetryAudio` in `demoMeetings.ts`,
  filename-triggered failure simulation since there's no whisper container in demo mode).
- **Client/project context plumbing verified end-to-end from the UI:** `RecordControls` now takes
  optional `clientId`/`projectId` props (hidden fields into the existing `/start` contract); wired
  into the project workspace (`ProjectWorkspaceView.tsx`, new "Meetings" card) and the client
  detail page, each pre-filled and each showing its own scoped recordings list. The dispatcher's
  client-context drop (WD-01 finding F-1) was fixed by another agent before this ticket started —
  this ticket's job was to verify the full chain (UI → `meeting_recordings.client_id`/`project_id`
  → ingested `pipeline_runs.client_id`), not to re-fix it.
- Run-status chips on `/meetings` (a new "Run" column resolving the linked pipeline run's own
  status, not just the recording's) and PRD Studio (source-meeting now links back to
  `/meetings/[id]` when resolvable).
- Helper-offline teach state inside `RecordControls` ("No capture helper installed? Upload an
  audio file" — `dept-teach` styling, reused from `TeachState.tsx`'s convention).
- `FRONTEND-BFF-CONTRACT.md` §8 meetings/pipeline/portal rows de-staled (they had "no UI
  consumer yet" annotations that were wrong — `/meetings`, `/pipeline`, `/portal` all have real
  routes + `lib/*.ts` consumers today).

**Known-live defect, NOT this ticket's to fix (queued for WD-08):** the ingest proxy
(`POST .../ingest`) times out against real dispatcher latency — `N8N_BRIDGE_TIMEOUT_MS` defaults
5000ms in `platform-nest/src/config.ts`, dispatcher round-trips run 15–23s in practice, so
`{ok:false,reason:"dispatcher_unreachable"}` comes back and the recording never flips to
`ingested` even though the n8n run completes fine server-side. The UI's existing `ingestAction`
already surfaces `reason` verbatim rather than claiming false success — confirmed still honest
under this ticket's own live-stack pass.

**Not yet DEV-VERIFIED at the module level:** WD-08 (the Phase-1 QA gate: full live walk incl.
RLS/portal-isolation/artifact-lock probes) has not run — Phase 1 is feature-complete, not yet
gated. Phase 2 (WD-20, the webdev-*integrations*-console close-out — a sibling program riding the
same tenant, not this delivery-rail one) already ran its own QA gate separately; see its evidence
doc for that program's DEV-VERIFIED status, which does not carry over to this one.

**Future plans:** WD-08 (Phase-1 QA gate) closes Phase 1; Phase 3 (external wiring — GitHub App,
Drive OAuth, Claude Admin usage) is gated on owner decisions OQ-2/OQ-3; Phase 4 (webdesk + the
one-rail contract-snapshot scaffolder) activates once webdesk's own P3 codegen lands; Phase 5
(design/code specialists v2, QA harness, estimates, maintenance intake) is design-level only.

## webdesk — Website Platform · `0.0.0` · PLANNED

**What exists:** blueprint only (approved 2026-07-23) — see [`../BLUEPRINTS.md`](../BLUEPRINTS.md). No code.
**Future plans:** phased build P1 Foundation → P2 Forms+Mail → P3 Contract/codegen → P4 ERP control+envs →
P5 AI+approvals → P6 WordPress headless.

## search-marketing — SEO · SEM · GEO · `0.2.0` · IN PROGRESS

**State at 0.2.0 (2026-07-28).** P0 is closed (**M1**): schema + RLS, module contract + Cerbos policy,
the provider/dispatch money path, the DataForSEO driver and its config/kill-switches all landed behind
one ⚡ gate. That gate found and closed a **fail-OPEN** — the platform-wide spend ceiling silently
disabled itself when its month-to-date aggregate threw, which on default config was the only
platform-wide cap. The `seo` department console (SM-11) is IN FLIGHT: 12 routes, real data on the
engagement surfaces, honest "backend pending" states elsewhere; its architect review rejected a first
pass for backend/frontend contract drift (money field typed as a number but delivered as a string;
cost-projection field names wrong) — fixed and re-verified. **Not yet DEV-VERIFIED:** P1 data work
(crawlers, keywords, briefs) is not built, so the console has little to show yet; the metered provider
path is proven only against a mock and a driver-level HTTP fake, never a real paid pull (deposit gated,
OQ-2). Running state + ticket ledger: [`../blueprints/seo-sem-execution-tracker.md`](../blueprints/seo-sem-execution-tracker.md).

**Design (unchanged):** [`../blueprints/seo-sem-foundation.md`](../blueprints/seo-sem-foundation.md)
(research + locked cost model) and [`../blueprints/seo-sem-design.md`](../blueprints/seo-sem-design.md)
(v1.1 design, §00–§14). A platform-nest module vertical (key `search`, tables `search_*`, third-wall RLS)
+ a `SearchDataProvider` abstraction (DataForSEO Standard primary, Semrush premium) with a Postgres
market-data cache and a per-client cost ledger + budget stop-loss, plus a `seo` department console
(Web-Dev pattern, 3 craft groups). Self-hosted crawlers (SEONaut/open-seo-crawler/Unlighthouse) do
$0-API audit work; AI is local-Hermes-first via the gateway; live-site/live-spend actions are dual-mode
(manual export twin + WS4-gated API twin) and approval-gated. Cost ~$8–10/client/mo blended
(~Rp 20M/mo for 100 clients @ 22k).
**Owner-ratified 2026-07-23:** dept name SEO; dual-mode SEM; no-RLS shared cache; per-engagement tool-scope config.

**What exists (dev):** P0 partially landed — SM-01 (migrations `0034`/`0035`: 18 `search_*` tenant tables
under third-wall FORCE-RLS + the no-RLS `search_data_cache`, dual-mode embedding column, additive
`integration_connections` widen), SM-02 (`src/modules/search/` ModuleContract, `api/:t/modules/search`,
18 `search.*` mcpTools, property/engagement/kpi CRUD, tool-scope endpoints + presets), and SM-03
(7 `resource_search_*` Cerbos policies + derived-roles wiring + `platform-ui/src/lib/rbac.ts` capability
mirror). **Verified 2026-07-27:** the four search suites run 60/60 green against live Postgres + live
Cerbos (49 executable policies), including the full SM-03 parity matrix — owner/manager/member/served-dept
with the `launch`/`apply_manual`/`apply_negatives`/`set_budget`/`approve`/`deliver`/`set_scope`/`admin`
denials and the cross-tenant and low-assurance cases.

**SM-04, SM-05 and SM-06 discharged their ACs on 2026-07-27 and await the ⚡ QA + architect gate.**
SM-04: the `SearchDataProvider` abstraction, capability registry + per-engagement selection cascade,
shared no-RLS cache with advisory-lock single-flight, metering ledger with true-up, the ordered
scope→engagement→tenant→global stop-loss, **37 dispatch tests**, and the `GET
engagements/:id/cost-projection` endpoint (what-if pricing + over-budget flag). SM-05: the real
DataForSEO driver (Standard-queue post/poll, keyword metrics, backlinks, AI visibility, §8a rate
table) with **25 mock-server tests** — no network or credentials required. SM-06: credentials +
per-pillar kill switches + keyless bootstrap + env docs in three places. Search suites **125/125**;
`tsc` and `lint:withtenants` clean.

**Keyless is a first-class mode:** with no DataForSEO credentials the paid driver is never
registered, every paid capability fails closed, and the $0 pillars (crawler audits, keyword
clustering, AI drafts) are unaffected — which is what makes the P1-before-P2 order real.

**Known gaps:** SM-04's `lint:withtenants` allowlist entry for the platform-wide spend ceiling is
**pending architect ratification**. SM-05's real-data pull is gated on the $50 DataForSEO deposit.
No crawlers (SM-07), no `seo` console in platform-ui (SM-11). Unrelated pre-existing failure
elsewhere in the repo suite: `admin/bot-admin.test.ts` chat-thread proxy.

**Running state + sequenced plan:** [`../blueprints/seo-sem-execution-tracker.md`](../blueprints/seo-sem-execution-tracker.md)
(SM-00…SM-30 ledger, 12-step order, M1–M5 milestones, blocker table).
**Next:** SM-04 close-out → SM-06 ∥ SM-05 (M1) → P1 crawlers/keywords/AI/console (M2 — the whole
department demos at $0 provider spend, no external gate). Then P2 paid data (gated on the $50 DataForSEO
deposit) → P3 SEM + reports + manual-apply → P4 live-ads OAuth writes. Decision-gated extras: Umami
(OQ-5), Semrush premium driver (OQ-3).

## social-media — SMM · Organic Publishing · `0.0.0` · PLANNED

**What exists:** foundation research + architect design, no code. See
[`../blueprints/smm-foundation.md`](../blueprints/smm-foundation.md) (research + locked decisions) and
[`../blueprints/smm-design.md`](../blueprints/smm-design.md) (v1.0 design, §00–§14) + the print blueprint
[`../blueprints/GAIADA-Social-Media-Engineering-Blueprint.pdf`](../blueprints/GAIADA-Social-Media-Engineering-Blueprint.pdf).
A platform-nest module vertical (`ModuleContract` key `social`, tables `social_*`) + the reserved **Publish**
department console (Calendar · Composer · Inbox · Analytics). **Postiz** (AGPL-3.0) is the publishing engine
run **AGPL-CONTAINED** — an isolated container reached only over its REST API (mere aggregation; the ERP
stays uninfected); all domain state/tenancy/RBAC/approvals live outside Postiz, which sees a post only after
WS4 approval. No universal post object (master `social_posts` + per-network `social_post_variants`, quota/
media-rule validated pre-queue); a first-class connector registry (`social_accounts` + platform-app fleet,
OpenBao-custodied creds); AI local-Hermes-first via the gateway with brand-voice RAG (copy) + Creative Image
Studio (assets); **human-in-the-loop mandatory and stricter than SEO** — every public action is a WS4
high-impact suspension consuming a one-shot payload-hash-matched approvalId (no auto-publish, humans or
agents). One `social_usage_ledger` meters X per-post fees + generative credits (stop-loss chain); no shared
no-RLS cache (all social data client-private). Mixpost Pro is the documented paid fallback if containment
proves impractical; Chatwoot dropped (engagement uses Postiz's comment/collab surface, no second inbox stack).
**Scope v1 = organic publish + engagement + copywriting + digital assets; paid social ads, listening, and
influencer/UGC are parked as future service lines.**
**Future plans (27 tickets P0–P4 + 2 decision-gated, /army-ready — design §12):** P0 contracts + containment
spike → P1 organic publish/calendar/composer (own accounts, $0) → P2 engagement inbox → P3 AI copy/assets +
reporting → P4 agent-proposed drafts. Decision-gated: SMM-28 Mixpost fallback, SMM-29 ClipsAI video.

## creative — Creative Studio · `0.1.0` · PROTOTYPED

**What exists (dev):** the **Image Studio** — client-side auto-correct + hand-LUT colour-grading engine
(WebGL2 LUT shader + Canvas2D fallback, pure/unit-tested imaging lib, 35 UI tests, visually verified) —
plus **`creative_assets` persistence** (migrations `0031`/`0032`, `/api/:t/creative/assets` GET/POST/
content/DELETE + training-set curation) and a phase-2 grading-trainer scaffold (`creative-grading-trainer/`,
ONNX seam). Wired as the Creatives dept "Image Studio" tab. See [[creative-image-studio]].
**Known gaps:** the entire expansion below is **PLANNED — no code**: image/video generation + editing,
Magnific-replacement upscaling, and the shared DAM (collections/brand-kits/rights/CLIP visual search/
imgproxy renditions). Not in production.
**Foundation + design:** [`../blueprints/creative-foundation.md`](../blueprints/creative-foundation.md)
(research + 4 locked owner decisions + Magnific head-to-head) and
[`../blueprints/creative-design.md`](../blueprints/creative-design.md) (v1.0 design, §00–§14) + the print
blueprint `../blueprints/GAIADA-Creative-Engineering-Blueprint.pdf`.
A platform-nest module vertical (`ModuleContract` key `creative`, tables `creative_*`, third-wall RLS,
migration `0036`): `creative_assets` extended in place (kind/source/rights/license_class/reuse_status/
provenance/checksum/phash/CLIP embedding/caption) + versions, collections/brand-kits, `creative_render_jobs`,
`creative_usage_ledger`, per-client `creative_scopes`. **Build-light DAM on our own stack** (RLS store +
Shared Drive + pgvector CLIP visual/semantic search + BLIP auto-tag + imgproxy renditions) — no external DAM.
**Locked owner decisions (2026-07-23):** serverless/rent-by-second GPU first · hybrid image licensing
(commercial-clean default Qwen/SDXL/Z-Image, FLUX quarantined behind a paid opt-in) · hybrid video
(Wan 2.2 OSS + ~$100–300/mo Veo/Kling API budget) · build-light DAM. Default model stack is
commercial-license-CLEAN; SUPIR/FLUX-dev/RMBG/IC-Light-V2/SVD quarantined.
**Future plans (27 tickets CR-00–CR-26, /army-ready — design §12):** Phase 0 clarity-upscaler Replicate
spike (kill Magnific now, run inline) → P0 contracts → P1 upscale/Magnific-replacement via the Render
Gateway → P2 image gen/edit → P3 DAM search + cross-dept consumption → P4 video + I2V. Opus-flagged:
CR-01, CR-06, CR-13; QA gates on CR-01/06/12/13/20. Open: OQ-1 FLUX procurement, OQ-2 owned-GPU tripwire,
OQ-3 video-vendor pick, OQ-8 AGPL/GPL counsel sign-off before P2 client volume.

## render-gateway-go — Creative Render Gateway · `0.0.0` · PLANNED

**What exists:** design only — the centerpiece of [`../blueprints/creative-design.md`](../blueprints/creative-design.md)
(§05). No code.
A separate Go service (mirror of `ai-gateway-go`): a **render job-queue** accepting typed jobs (upscale/
generate/edit/t2v/i2v/analyze), a **`RenderBackend` abstraction** (serverless GPU / self-host ComfyUI /
commercial API) routed per capability + license-class + cost + health, ComfyUI-workflow-as-versioned-JSON
with model manifests, short-lived signed per-job I/O URLs (backends never hold storage creds), an idempotent
`/api/internal/creative/render-callback`, a fail-closed **stop-loss** choke point (per-cost-class envelopes:
image $200 / video $300), a structural **license wall** (non-commercial models can never reach a client
deliverable), and egress audit. Outputs land in the `creative` DAM. Job state machine lives on platform-nest
rows; the gateway is Zone A egress-only.
**Future plans:** built under the `creative` P1–P4 tickets (CR-* — design §12); container-build verification
on a Docker host before deploy (same caveat as ai-gateway-go).

## reports — Work Tracker · Reports · Appraisal · `0.0.0` · PLANNED

**What exists:** design only — [`../blueprints/tracker-reporting-foundation.md`](../blueprints/tracker-reporting-foundation.md).
No code, no migrations.
A **multi-grain reporting layer over the existing tracker** — the PM module (`0018`, `0036`–`0044`) already
IS the task tracker; this program adds the grain fabric and the report/appraisal layer it lacks. One atomic
fact grain (`person × project × day`); department / company / week / month are additive rollups, ratios always
stored numerator+denominator (never average-of-averages). Consumes the substrate that already exists rather
than duplicating it: `work_activity` + `work_activity_links` (`0030` — already 4-grain: pm_task/project/person/
department), `metric_definitions` + `rollup_metrics` (the governed metric registry), `pm_progress_snapshots`
(`0040`), `time_entries`. Closes three verified substrate blockers first: `pm_tasks.assignee` becomes a
relational `pm_task_assignees` (the single unindexed JSONB blob cannot carry trustworthy person-grain SQL),
department membership becomes **time-aware** (`org_unit_memberships`, as-of-date — a dept transfer must never
rewrite history), and the estate gains its first chart/XLSX/PDF layer. One typed **`ReportDocument`** contract
feeds the web viewer, the exporters, the AI narrative and the MCP tools — no second rendering path. Ops reads
recompute live; management + appraisal reads come from a **sealed** period-close snapshot. Mandatory per-person
EOD check-ins (compliance measured against the HR working calendar so leave is not a false negative);
manager-weighted blended appraisals with mandatory human commentary and an append-only acknowledgement trail.
Migrations `0050`–`0055`. Owner-takes-all outcome attribution + listed contributors, so company totals never
double-count.
**Future plans:** built under the P0–P6 `TR-*` tickets (design §12, 30 tickets, 12 QA-gated); P0 gates
everything downstream.

## report-renderer — Print/PDF Sidecar · `0.0.0` · PLANNED

**What exists:** design only — [`../blueprints/tracker-reporting-foundation.md`](../blueprints/tracker-reporting-foundation.md) §6.3.
No code.
A small Node + Playwright sidecar (the only image in the estate carrying Chromium — platform-ui's Next
standalone image stays browser-free) that renders a sealed `ReportDocument` to print-grade PDF:
`POST /render` behind a shared `RENDERER_TOKEN`, driving the platform-ui print route via a **one-shot,
5-min-TTL, single-document `jobToken`** so no tenant credential ever reaches the renderer. Internal network
only. `docs/blueprints/render-pdf.js` is the working in-repo precedent for the print-CSS technique.
**Future plans:** built under `TR-18`/`TR-19`; ⚡ QA gate on the one-shot token path (auth bypass by
construction); container build unverified in this dev env — validate on a Docker host before deploy (same
caveat as ai-gateway-go / render-gateway-go).
