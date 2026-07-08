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

## Current status (2026-07-05)
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
- **ai-gateway/** — standalone WS3 service BUILT (10 tests): provider chain w/ failover + circuit
  breaker (gemini/claude/echo), fail-closed auth + DLP, daily cost cap, egress audit. Same HTTP
  contract as the bot's embedded gateway (supersedes it — cutover = GATEWAY_URL).
- **mcp-hub/** — WS2 skeleton BUILT (7 tests): MCP server (official SDK, Streamable HTTP,
  stateless), OBO principal minting (clients can't assert roles), deny-by-default policy w/
  per-principal tool visibility, JSONL audit. Company tools await the platform (WS1).
- **Telegram is the live surface for now** (long-polling, no public URL needed — see the bot
  README quickstart); WAHA becomes primary + Telegram fallback once its number is scanned.
- **infra/** — v1 slice BUILT: full-stack VPS compose (`infra/compose/docker-compose.vps.yml`:
  postgres+waha+bot+gateway+hub), Dockerfiles in each component, crypto-shred-safe nightly
  backup script, `infra/scripts/test-all.sh` local CI, GH Actions workflow (inert until
  gaiada-system gets its own repo — current git root/remote are unrelated). Runbook:
  `infra/runbooks/deploy-vps.md`.
- **automation/** — v1 glue BUILT: n8n compose + `summarize-via-mcp` template (backbone rule:
  n8n orchestrates, MCP accesses, no logic in workflows). Temporal deferred until a durable
  flow exists.
- **platform/** — Phase 4 core + **Phase 5c COMPLETE (86 tests, live PG + Cerbos):** core
  schema (FORCE RLS on authorized-tenant-set, D5), ModuleContract framework w/ per-tenant
  enable gate, **Cerbos** RBAC (18 policies, scope cascade, decision audit, D11 revocation,
  D16 PlanResources), D4 identity_links + OBO + dual-proof enrollment, D12 rollups (only
  cross-company read path). **First-deploy agency vertical is genuinely operable:** clients /
  deliverables / time_entries (core client-work, D17 custom fields), agency campaigns / briefs /
  creative-asset review lifecycle, threaded comments + per-user notifications (assignment /
  mention / approval), files/attachments (local-first storage, day-one PII scrub, XSS/IDOR/
  header-injection hardened), management rollups (utilization num/den, deliverables-due). Seed
  `npm run seed:agency`; first-deploy e2e + readiness checklist
  (`docs/superpowers/plans/2026-07-05-agency-first-deploy-readiness.md`). mcp-hub fronts it.
  Plans: `2026-07-05-phase-5c-platform-to-spec.md`. Deferred (non-blocking): NestJS port,
  event backbone, sync engine, other verticals. **Dev infra note:** Cerbos must run with
  published ports (`-p 3592:3592 -p 3593:3593`) — a portless container fails all authz.
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
  Rollups (exec cross-company view + recompute) — all UI follows the backend contract; task
  edit and agency briefs degrade gracefully pending backend `PATCH`/custom-field-defs/
  company-detail/agency-briefs endpoints (owned by a concurrent backend session).
  **Plan 3 (Systems & Intelligence consoles) UI BUILT:** WhatsApp/Telegram Bot, Automation,
  AI Gateway, MCP Hub (Systems group) and AI Agents, Knowledge (Intelligence group) — all
  consume the `lib/admin.ts` admin-API contract (the UI follows/defines it) and degrade
  gracefully (ConnectionState/EmptyNote) until the concurrent backend session wires
  `/api/admin/:system/status|config` and the agents/knowledge admin endpoints. Next:
  Plan 4 (Admin section + step-up), Plan 5 (polish).
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
- **P5c COMPLETE (platform to spec / agency first-deploy, 2026-07-05):** the digital-agency
  vertical is genuinely operable at first deploy on the Fastify core. Core client-work
  (clients/deliverables/time_entries wired to the shared 0001 tables — NOT agency dupes),
  agency campaigns/briefs/creative-asset review, threaded comments + per-user notifications,
  files/attachments (local-first storage, day-one scrub, XSS/IDOR/header hardened), D17
  custom-field registry, agency management rollups (utilization num/den, deliverables-due).
  86 platform tests, first-deploy e2e + idempotent seed (`npm run seed:agency`) + readiness
  checklist. NestJS port + event backbone + sync engine deferred (non-blocking; ModuleContract
  keeps the port mechanical). Next: further verticals, or P5d per the full-fidelity register.
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
