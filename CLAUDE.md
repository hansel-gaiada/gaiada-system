# Gaiada System — Project Guide (read this first)

This is the **Gaiada AI-platform program**. Start here when opening a new session.

## What this is
An AI-native, multi-business platform. Delivered as a **Solo-Viable v1** (managed-first,
cloud-AI-first, single-region) underneath a preserved, **hiring-gated all-local target-state**.
Components are **separate standalone projects — not a shared-package monorepo.**

## Orientation (read in this order)
1. `README.md` — folder layout + component→workstream map.
2. `docs/superpowers/plans/2026-07-05-IMPLEMENTATION-INDEX.md` — the build plan (WA-bot-first).
3. `docs/superpowers/plans/2026-07-05-CHECKLIST.md` — **current status / what's done vs next**.
4. `docs/superpowers/specs/2026-07-04-INDEX-overview.md` — full architecture (21 specs).
5. `docs/superpowers/specs/2026-07-05-adversarial-weakness-review.md` — the 63 verified findings (all resolved/parked).
6. `docs/superpowers/plans/2026-07-05-phase-5-full-fidelity.md` — the **gap register** (spec→current→close-by); the live list of what remains, kept current.

## Current status (2026-07-09)
> **The backend moved fast after 07-05; this section + the full-fidelity register are the
> source of truth. Older docs that call the NestJS port / event backbone / Go gateway
> "deferred" are stale — verify against code.** Since 07-05: the **NestJS port** replaced the
> Fastify core (`platform-nest/` is the platform now; `platform/` deleted), the **event
> backbone** shipped, and the **Go gateway rewrite** (`ai-gateway-go/`) replaced and retired
> the Node `ai-gateway/` (2026-07-14) — it is now THE gateway (the `ai-gateway` service on :3002).
- **wa-chat-bot/** — Phases 0–3 code-complete, trial-lite (84 tests). Pipeline: webhook
  (fail-closed) → group registry (`config/groups.yaml`, hot-reload) → PAN/KTP scrub →
  crypto-shred store (file or Postgres w/ FORCE RLS) → skills/Q&A reply. 12:00/18:00 digests
  (opt-in groups + categorized management). Media: pending-queue → worker → Gateway `/media`
  (Gemini multimodal) → scrubbed `media_text` → digests (live files need WAHA Plus). Assistant
  skills (`/capture`, `/actions`, step-up ceiling), D9-isolated RAG module, Telegram fallback,
  discovery telemetry (PII-free). Runbooks: erasure-divestiture, wa-ban-recovery. Postgres via
  `docker compose --profile db up -d` (app role NOBYPASSRLS); WAHA in the same compose file.
- **Blocked on user/infra:** OpenBao VPS (0.4); Gemini key; WAHA QR scan (+ Plus for media);
  warm-standby number; Telegram token (optional); legal Gate 1 before real ingestion.
  Hardening backlog in the checklist (map-reduce, docx/xlsx, pgvector RAG, TG media).
- **ai-gateway/** (Node, WS3) — **RETIRED 2026-07-14.** Directory deleted; replaced by the Go
  rewrite below after code-complete parity + green build/tests. History note only.
- **ai-gateway-go/** (Go, WS3) — **THE gateway.** Deployed as the `ai-gateway` compose service on
  port 3002 (config default), so bot/hub/knowledge/media-worker reach it unchanged at
  `http://ai-gateway:3002`. Byte-for-byte HTTP contract parity with the old Node gateway
  (`/health`, `/complete`, `/media`, `/embed`) plus `POST /complete/stream` (SSE). Provider chain
  w/ failover + circuit breaker (ollama/gemini/claude/echo), fail-closed auth + DLP, daily cost
  cap, egress audit. Adds egress allowlist (DialContext-enforced), self-signed internal CA + mTLS
  peer allowlist, site/central topology (central-forward provider), a fail-closed local-Ollama DLP
  classifier (opt-in via `DLP_CLASSIFIER_ENABLED`). go1.26.4 build/vet/test green. Compose runs it
  with `GATEWAY_TLS_MODE: off` (callers speak plain HTTP); enroll client certs to move to
  permissive/enforced. Plan + report: `2026-07-06-ws3-go-gateway-rewrite-plan.md`,
  `2026-07-09-ws3-go-gateway-completion-report.md`. **Not verified locally: docker build (no
  Docker in the dev env) — validate on a Docker host before deploy.** Still deferred per spec §9:
  OpenBao-issued provider creds, media DLP classification, native per-provider token streaming,
  DNS control / SIEM rule, automated cert rotation.
- **mcp-hub/** — WS2 **COMPLETE to spec incl. target-state (2026-07-15).** MCP server (official
  SDK, Streamable HTTP, stateless) with OBO principal minting (clients can't assert roles) and
  deny-by-default policy. Full primitive surface: **Tools** (core + platform read/write +
  AI-backed `llm.summarize`/`ocr`/`vision`/`transcribe` + module-contributed), **Resources**
  (`gaiada://…`), **Prompts**. Tools are aggregated from the platform's `ModuleContract.mcpTools`
  via `GET /mcp/tool-defs` (not hardcoded). **Cerbos-authoritative** policy (versioned
  `mcp_tool` policy; in-code engine kept as fail-closed fallback + reason source). Rate limiting
  (§8), **D11 revocation** (platform `POST /principal/resolve` gained a `revoked` flag),
  **mTLS/zero-trust floor** (`HUB_TLS_MODE`, CA reuse via synccert, peer-CN allowlist), and
  **site/central topology** (`HUB_TOPOLOGY`; real `rollup.metrics` over D12 on central). JSONL
  audit on every decision. 59 hub tests (+ platform `/mcp/tool-defs`). Report:
  `docs/superpowers/plans/2026-07-15-ws2-mcp-hub-completion-report.md`. Still deferred: OpenBao-
  minted short-lived service creds (target-state), Magnific `image.enhance` (no Gateway capability
  yet), Redis-backed multi-instance rate limiting.
- **Telegram is the live surface for now** (long-polling, no public URL needed — see the bot
  README quickstart); WAHA becomes primary + Telegram fallback once its number is scanned.
- **infra/** — v1 slice BUILT: full-stack VPS compose (`infra/compose/docker-compose.vps.yml`:
  postgres + redis + waha + ai-gateway (the Go `ai-gateway-go/` service) + keycloak +
  cerbos + platform-nest + platform-ui + whisper + knowledge + mcp-hub + bot + bot-media-worker),
  Dockerfiles in each component, crypto-shred-safe nightly backup script,
  `infra/scripts/test-all.sh` local CI, GH Actions workflow (inert until gaiada-system gets its
  own repo — current git root/remote are unrelated). Runbook: `infra/runbooks/deploy-vps.md`.
- **observability/ (WS9)** — **BUILT 2026-07-15, code-complete.** All 7 services instrumented with
  OpenTelemetry (traces+metrics+trace-correlated JSON logs, W3C propagation, fail-soft — no-op unless
  `OTEL_ENABLED`); per-service telemetry bootstrap (Go `internal/telemetry`, TS `src/telemetry.ts`)
  wrapping existing sources (gateway budget/egress-audit, sync anomaly path, event-backbone
  dead-letters, hub tool-audit, bot discovery/media, and the WS8 collector→OTel bridge). Self-hosted
  stack as an **opt-in** second compose file (`infra/compose/docker-compose.observability.yml`):
  OTel Collector → Prometheus/Tempo/Loki + Grafana (provisioned datasources+dashboards) +
  Alertmanager + exporters (pg×2/redis×2/node/cadvisor/blackbox) + ntfy. Multi-burn-rate SLOs,
  exec + per-workstream dashboards, blackbox synthetics. **D15 carry-overs closed:** ≥2 independent
  alert transports + external dead-man's-switch (Alertmanager + upgraded out-of-band `healthcheck.sh`);
  measured restore drill (`infra/scripts/restore-drill.sh`); DR-burst AI budget (gateway `DR_MODE` /
  `POST /admin/dr-mode`). Config-linted with the real tools (promtool/amtool/otelcol validate) +
  a CI `observability-lint` job. **VERIFIED END-TO-END on a live Docker stack (2026-07-15):** real
  traffic → metrics in Prometheus (exact counts), traces in Tempo from Go + TS services, DR-burst
  gauge flip, 4 functional synthetic journeys green, SLO/operational alerts firing + routed to the
  correct D15 receivers, and a restore drill (RTO=2s). Running it caught + fixed 3 runtime bugs
  builds/tests missed (Go resource schema-URL conflict; Alertmanager envsubst render; restore-drill
  role bootstrap). Only filelog→Loki is env-limited on Docker Desktop (works on the Linux VPS).
  Configs `infra/observability/`;
  runbooks `infra/runbooks/observability{,-slo}.md`, `restore-drill.md`; plan+report
  `docs/superpowers/plans/2026-07-15-ws9-observability-*.md`.
- **automation/** — v1 glue BUILT: n8n compose + `summarize-via-mcp` template (backbone rule:
  n8n orchestrates, MCP accesses, no logic in workflows). Temporal deferred until a durable
  flow exists.
- **platform-nest/** (WS1) — **THE platform** (NestJS + Fastify-adapter). The Phase-5c Fastify
  `platform/` was **ported to NestJS and DELETED** (2026-07-05); this dir is the only backend.
  92 tests pass on NestJS against live PG + Cerbos. Carries everything P5c delivered: core schema
  (FORCE RLS on authorized-tenant-set, D5), ModuleContract framework w/ per-tenant enable gate,
  **Cerbos** RBAC (scope cascade, decision audit, D11 revocation, D16 PlanResources), D4
  identity_links + OBO + dual-proof enrollment, D12 rollups (only cross-company read path).
  **First-deploy agency vertical is genuinely operable:** clients / deliverables / time_entries
  (core client-work, D17 custom fields), agency campaigns / briefs / creative-asset review,
  threaded comments + per-user notifications, files/attachments (local storage, day-one scrub,
  XSS/IDOR/header-injection hardened), management rollups. Core write paths (task/project PATCH,
  custom-field defs GET, agency briefs) are ALL built — the stale checklist wrongly lists them
  "pending". Seed `npm run seed:agency`. Plans: `2026-07-05-nestjs-port-subspec.md`,
  `2026-07-05-phase-5c-platform-to-spec.md`.
  **Event backbone DONE** (`src/events/`, migration `0010_outbox_events.sql`): transactional
  outbox → Redis Streams relay → consumer w/ dead-letter, started in `main.ts` (Redis-gated);
  `outbox_events` is also the sync-engine `sync_outbox`. Plan: `2026-07-06-ws1-event-backbone-plan.md`.
  **Still deferred (backend gaps to pick up next):** (1) the **admin/systems API layer** —
  `/api/admin/{bot,gateway,hub,automation}/{status,config}` + plan-4 identity endpoints
  (users-with-roles, role assign/revoke, identity-links CRUD, module enable/disable,
  custom-field PATCH/DELETE, compliance-gates, filtered audit); no AdminController exists yet —
  this is what blocks the built-but-placeholder UI Systems/Intelligence/Admin sections. (2) other
  verticals. **The sync engine is now BUILT** — see the `sync-engine-go/` bullet below.
  **Dev infra note:** Cerbos must run with published ports (`-p 3592:3592 -p 3593:3593`) — a
  portless container fails all authz.
- **sync-engine-go/** (WS1 T2) — **BUILT 2026-07-14.** Cross-site reconciliation: one Go binary
  runs central (serves push/pull over mTLS) or site (push→pull→GC ticker), reconciling the shared
  `outbox_events` log with HLC ordering, declarative per-field conflict resolution (status/money →
  conflict-queue, else lww), per-tenant RLS on every op (Go port of `withTenants`), a
  central-authoritative `site_subscriptions` ACL (D5), new-node bootstrap (snapshot + atomic
  watermark + merkle gate + anti-entropy sweep), and watermark-gated tombstone GC (delete-wins,
  no resurrection). HLC is stamped by platform-nest on every emit (`0012_outbox_hlc.sql` +
  `src/events/hlc.ts`); sync tables are `0013_sync_tables.sql` (incl. a `sync_applied_events`
  dedup ledger — the sync path NEVER touches the relay's `relayed_at`, D7). mTLS reuses the
  gateway's persisted internal CA (`cmd/synccert` issues node certs). Full suite green incl.
  property-based convergence + partition/chaos on a local 2-Postgres harness
  (`docker-compose.chaos.yml`); CI job `sync-engine-go` provisions Postgres + migrations + a
  NOBYPASSRLS role and runs it all. Deployed as the idle `sync-central` compose service (waits on a
  real second site). Plan/spec: `2026-07-06-ws1-sync-engine-plan.md`,
  `2026-07-06-ws1-sync-engine-revision.md`; report: `2026-07-14-ws1-sync-engine-completion-report.md`.
- **ai-agents/** — WS8 steps 1+2 BUILT (13 tests): specialist framework (status-reporter,
  approvals-chaser) + **supervisor orchestrator** (blackboard, cycle guard, per-goal budget
  across the tree, fan-out cap, approval suspension bubbles up) — Gateway for models, hub
  tools w/ OBO envelope, D14 enforced in code. Bot's `/projects` skill completes the D4 loop.
  Next per spec §8: memory/RAG (D9 owner) → local-model registry → eval-gated trainer.
- **platform-ui/** — Next.js ERP Suite UI BUILT (plan 1: foundation): plain-CSS luxury design
  system, BFF to `platform/` (no direct DB access), shell + RBAC-gated nav + My Work dashboard +
  cross-company Approvals inbox. HMAC session/dev-login pending IdP swap. Spec + plan:
  `docs/superpowers/specs/2026-07-05-gaiada-erp-ui-design.md` and
  `docs/superpowers/plans/2026-07-05-erp-ui-plan-1-foundation.md`.
  **Plan 2 (business modules) UI BUILT:** Companies (list+detail), Projects (full CRUD w/ D17
  custom-field forms), Tasks (list/detail/create), Agency (campaigns list/detail/create),
  Rollups (exec cross-company view + recompute). Its backend deps have since **landed** (task/
  project PATCH, custom-field-defs GET, agency briefs); only single-resource company-detail /
  campaign-detail GETs are absent and the UI already falls back to list-derivation — so Plan 2
  is effectively unblocked.
  **Plan 3 (Systems & Intelligence consoles) UI BUILT:** Bot/Automation/AI-Gateway/MCP-Hub
  (Systems), AI-Agents/Knowledge (Intelligence) — all consume the `lib/admin.ts` / `adminData.ts`
  admin-API contract and degrade gracefully (ConnectionState/EmptyNote) because **the backend
  admin layer is not built yet** (`/api/admin/:system/status|config`, agents/knowledge admin
  reads, plan-4 identity write endpoints — see platform-nest "still deferred" above, the top
  frontend-blocking backend gap).
  **Plan 4 (Admin + account/identity) UI DONE (2026-07-14):** `/admin/{users,identity,modules,
  compliance,audit}`, `/account` + real Sign out (sidebar `UserMenu`), `/step-up` (D4) + middleware
  allowlist w/ validated `?return=`. Write paths degrade gracefully pending the backend.
  **Plan 5 (polish) DONE (2026-07-14):** loading/error/not-found states, global search
  (TopBar → `/search`, `lib/search.ts`), notifications (bell + `/notifications`), layout/density
  prefs (`lib/prefs.ts`), responsive icon-rail, a11y (skip link, reduced-motion, aria), and a
  **Playwright e2e suite** (`DEMO_MODE`).
  **People / Employee view DONE (2026-07-14):** `/people` directory (elevated-only) + `/people/[userId]`
  employee 360 — profile/roles, KPIs, assigned tasks, projects owned, time, WA/TG identity links,
  recent activity (`lib/people.ts`). Access = **self OR superadmin (`platform_admin`) OR owner
  (`group_executive`)** via `canViewEmployee`; data sliced from existing tenant lists (no new backend
  endpoints). Reached from Account ("My employee page") and the People directory.
  **Org structure builder DONE (2026-07-14):** per-company `/companies/[companyId]/org` — drag-to-reparent
  editor + live CSS org-chart preview (`components/org/OrgBuilder.tsx`, `lib/org.ts`); agency seeded with
  departments Web Dev/SEO/SMM/Video Editor/Design Graphic; edit gated to superadmin/owner, others read-only.
  Backend-ready via a `GET/PUT /api/:t/org-structure` BFF contract (cookie + seeded fallback until built) —
  **backend TODO in memory `org-structure-contract`**.
  **UI is feature-complete (Plans 1–5 + People view + org builder)** — every nav route is a real page;
  `tsc` clean, 63 unit + 14 e2e pass, `next build` green. Browse it all backend-free with
  `DEMO_MODE=1 npm run dev` (`lib/demoFixtures.ts`). Remaining work is backend-only (admin/systems API +
  identity writes + the org-structure endpoints; the UI lights up automatically once they land).
- **Local-first (dev + VPS, no cloud required):** ai-gateway chain defaults to
  `ollama,gemini,claude` — with Ollama running (`ollama pull llama3.2`) the entire stack
  works offline; cloud keys are optional failover. Echo mode remains the keyless terminator.
- **legal/** — Gate-1 drafts (DPIA/LIA/notices) pending lawyer review; do NOT ingest real employee
  data until Gate 1 (legal) + the day-one gate (technical) are both green.

## Non-negotiable decisions (don't relitigate without cause)
- **P5a COMPLETE (bot production-grade):** OpenBao transit custody + envelope v2; BullMQ
  media queue + dedicated worker; faster-whisper local transcription; local doc/video
  extraction (docx/xlsx/pdf/OCR/ffmpeg); fuller day-one scrubber; map-reduce digests;
  Telegram media; PG scheduler idempotency; /know via WS8 knowledge; governed Drive
  connector. 118 bot tests. Next: P5b (IdP + Cerbos).
- **P5b COMPLETE (identity+authz to spec):** OIDC verification (JWKS, auto-provision,
  email-verified takeover guard), Keycloak service+runbook, **Cerbos** authz replacing the
  in-code engine (versioned policy repo, scope-cascade derived roles, PlanResources, team
  scope) — 13-case parity + all suites live-verified against Cerbos+PG; dual-proof enrollment
  (D4.4), authoritative revocation (D11). Platform tests now require Cerbos running (docs in
  `platform/.env.example` + `test-all.sh`).
- **P5c COMPLETE (platform to spec / agency first-deploy):** the digital-agency vertical is
  genuinely operable at first deploy. Core client-work (clients/deliverables/time_entries wired
  to the shared 0001 tables — NOT agency dupes), agency campaigns/briefs/creative-asset review,
  threaded comments + per-user notifications, files/attachments (local-first storage, day-one
  scrub, XSS/IDOR/header hardened), D17 custom-field registry, agency management rollups.
  first-deploy e2e + idempotent seed (`npm run seed:agency`) + readiness checklist.
  **NestJS port DONE (2026-07-05)** — `platform-nest/` replaced and deleted the Fastify `platform/`
  (92 tests); **event backbone DONE (2026-07-06)**; **sync engine DONE (2026-07-14,
  `sync-engine-go/`)**. Still deferred: further
  verticals, and the admin/systems API layer (see the platform-nest status bullet above).
- **Go gateway is THE gateway (cutover done 2026-07-14):** `ai-gateway-go/` runs as the
  `ai-gateway` compose service on :3002; the Node `ai-gateway/` was retired and its directory
  deleted. See the ai-gateway-go status bullet + `2026-07-09-ws3-go-gateway-completion-report.md`.
- **AGENCY IS A FIRST-DEPLOY CHILD COMPANY (2026-07-05):** the digital-agency vertical +
  the core entities it needs (clients, deliverables, time, briefs, creative assets, approvals)
  are genuinely operable at first deploy (see P5c COMPLETE above). Web UI (`platform-ui`,
  Next.js) built in parallel on the Fastify core; backend contracts + typed BFF helpers all in.
- **FULL-FIDELITY MANDATE (2026-07-05):** no more solo-dev corner-cutting. Every "lite"
  deviation must be closed to the original specs per
  `docs/superpowers/plans/2026-07-05-phase-5-full-fidelity.md` (the gap register). New work
  must not introduce new shortcuts without an explicit user decision. Time is not a constraint.
- **WAHA is fully free since 2026.6.1** (all former Plus features in core): media pipeline and
  multi-session warm standby are exercisable at no cost.
- Bot never holds provider keys (only the Gateway) and never asserts identity.
- Scrub PAN/national-IDs before persist; encrypt PII at rest (crypto-shred, two-axis subject×entity).
- Managed-first for v1; all-local is target-state, hiring-gated.
- Keep components as separate projects, not a monorepo.

## Running the bot
See `wa-chat-bot/README.md` (needs WAHA + a WhatsApp number; free Gemini key optional for echo mode).
