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
| platform-nest | `0.6.0` | PROTOTYPED | WS1 | 2026-07 |
| platform-ui | `0.6.0` | PROTOTYPED | WS5 | 2026-07 |
| ai-gateway-go | `0.11.0` | PROTOTYPED | WS3 | 2026-07 |
| mcp-hub | `0.8.0` | PROTOTYPED | WS2 | 2026-07 |
| sync-engine-go | `0.7.0` | PROTOTYPED | WS1 | 2026-07 |
| automation (n8n) | `0.4.0` | DEV-VERIFIED | WS4 | 2026-07 |
| observability | `0.6.0` | DEV-VERIFIED | WS9 | 2026-07 |
| infra | `0.5.0` | PROTOTYPED | WS10 | 2026-07 |
| wa-chat-bot | `0.8.0` | PROTOTYPED | WS5 | 2026-07 |
| ai-agents | `0.4.0` | PROTOTYPED | WS8 | 2026-07 |
| hermes-gateway | `0.2.0` | PROTOTYPED | WS3 | 2026-07 |
| capture-helper | `0.2.0` | IN PROGRESS | WS11 | 2026-07 |
| webdesk | `0.0.0` | PLANNED | Web Dev | 2026-07-23 |
| search-marketing | `0.1.0` | IN PROGRESS | SEO | 2026-07-23 |
| social-media | `0.0.0` | PLANNED | Social Media | 2026-07-23 |
| creative | `0.1.0` | PROTOTYPED | Creative | 2026-07 |
| render-gateway-go | `0.0.0` | PLANNED | Creative | 2026-07-23 |

---

## platform-nest — Platform Core · `0.6.0` · PROTOTYPED

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
**Known gaps:** not deployed to production.
**Future plans:** additional verticals (resort/marine/print) → hardening to production.

## platform-ui — ERP Suite · `0.6.0` · PROTOTYPED

**What exists (dev):** Next.js ERP UI, BFF to platform-nest, RBAC-gated nav + company switcher; My Work,
Approvals inbox, Companies/Projects/Tasks, Agency, Rollups, Systems/Intelligence/Admin consoles, People
360, org-structure builder, Repsona-style PM + AI tracker, IT device console, per-department consoles
(Web Dev reference), OIDC PKCE login. Runs backend-free in `DEMO_MODE`; Playwright e2e in dev.
**0.6.0 (Workstream A+B admin surfaces):** Connect-WhatsApp UI (status pill + QR scanner, Connect/Show-QR/Restart/Stop/Logout buttons,
session event trail); Group Registry UI (monitored-groups table with category/optIn, discovered-list one-click-add, management-group radio);
agents UI extended with trigger card (goal text + agent select, elevated-only), goals list/detail pages with blackboard + run transcripts,
run detail page showing step-chip transcript (text-only, never HTML or raw JSON).
**Known gaps:** not deployed to production.
**Future plans:** dept-console integrations program → prod hardening.

## ai-gateway-go — AI Gateway · `0.11.0` · PROTOTYPED

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

## mcp-hub — Access Layer · `0.8.0` · PROTOTYPED

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

## infra — Platform Engineering & Delivery · `0.5.0` · PROTOTYPED

**What exists (dev):** full VPS Docker Compose stack, per-component Dockerfiles, local CI (`test-all.sh`),
GH Actions (inert until the repo is standalone), crypto-shred-safe backups, supply-chain pipeline
(SBOM + cosign + SLSA).
**0.5.0 (Workstream A+B compose):** agent-runner service added to compose stack (`build: ../../ai-agents`, Fastify :3006,
AGENT_RUNNER_TOKEN auth, gaiada_knowledge owner/app roles); wa-chat-bot environment wired for writable group registry
(GROUPS_FILE: /app/data/groups.yaml, GROUPS_SEED_FILE: /app/config/groups.seed.yaml); bot-data volume added for registry + session state;
old groups.yaml bind mount moved to seed path (read-only); .env.example updated with AGENT_RUNNER_TOKEN secret.
**Known gaps:** not deployed; K8s/GitOps + SPIFFE/SPIRE are target-state (hiring-gated).
**Future plans:** first production deploy → GitOps → K8s/SPIFFE at target-state.

## wa-chat-bot — Messaging Surface · `0.8.0` · PROTOTYPED

**What exists (dev):** WA (WAHA) + Telegram work-summary/assistant bot; scrub → crypto-shred store →
skills/Q&A, digests, media enrichment via gateway. Telegram live in dev; P5a production-grade features.
**0.8.0 (Workstream A WhatsApp admin plane):** session lifecycle admin routes (`POST /admin/session/start|status|qr|stop|logout|restart`),
writable group registry (moved to bot-data volume, YAML + hot-reload + discovered-groups tracking),
safe config write (`PUT /admin/config {postToGroups,managementGroupId}`); session-state tracker records webhook
events into a ring buffer + `/health` session field; webhook already ACKs 200 then processes detached (aire lesson).
Gated by Bearer ADMIN_TOKEN; all engine-tolerant (NOWEB status strings pass verbatim, never enumerated-rejected).
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

## webdesk — Website Platform · `0.0.0` · PLANNED

**What exists:** blueprint only (approved 2026-07-23) — see [`../BLUEPRINTS.md`](../BLUEPRINTS.md). No code.
**Future plans:** phased build P1 Foundation → P2 Forms+Mail → P3 Contract/codegen → P4 ERP control+envs →
P5 AI+approvals → P6 WordPress headless.

## search-marketing — SEO · SEM · GEO · `0.0.0` · PLANNED

**What exists:** foundation research + ratified architect design, no code. See
[`../blueprints/seo-sem-foundation.md`](../blueprints/seo-sem-foundation.md) (research + locked cost
model) and [`../blueprints/seo-sem-design.md`](../blueprints/seo-sem-design.md) (v1.1 design, §00–§14).
A platform-nest module vertical (key `search`, tables `search_*`, third-wall RLS) + a `SearchDataProvider`
abstraction (DataForSEO Standard primary, Semrush premium) with a Postgres market-data cache and a
per-client cost ledger + budget stop-loss, plus a `seo` department console (Web-Dev pattern, 3 craft
groups). Self-hosted crawlers (SEONaut/open-seo-crawler/Unlighthouse) do $0-API audit work; AI is
local-Hermes-first via the gateway; live-site/live-spend actions are dual-mode (manual export twin +
WS4-gated API twin) and approval-gated. Cost ~$8–10/client/mo blended (~Rp 20M/mo for 100 clients @ 22k).
**Owner-ratified 2026-07-23:** dept name SEO; dual-mode SEM; no-RLS shared cache; per-engagement tool-scope config.
**Future plans (26 tickets P0–P3 + 2 committed P4, /army-ready — design §12):** P0 contracts → P1 $0-value
(crawls + AI on own data) → P2 paid data (gated on the $50 DataForSEO deposit) → P3 SEM + reports +
manual-apply → P4 live-ads OAuth writes. Decision-gated extras: Umami (OQ-5), Semrush premium driver (OQ-3).

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
