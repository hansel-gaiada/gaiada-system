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
| platform-nest | `0.5.0` | PROTOTYPED | WS1 | 2026-07 |
| platform-ui | `0.5.0` | PROTOTYPED | WS5 | 2026-07 |
| ai-gateway-go | `0.9.0` | PROTOTYPED | WS3 | 2026-07 |
| mcp-hub | `0.8.0` | PROTOTYPED | WS2 | 2026-07 |
| sync-engine-go | `0.7.0` | PROTOTYPED | WS1 | 2026-07 |
| automation (n8n) | `0.4.0` | DEV-VERIFIED | WS4 | 2026-07 |
| observability | `0.6.0` | DEV-VERIFIED | WS9 | 2026-07 |
| infra | `0.4.0` | PROTOTYPED | WS10 | 2026-07 |
| wa-chat-bot | `0.6.0` | PROTOTYPED | WS5 | 2026-07 |
| ai-agents | `0.3.0` | IN PROGRESS | WS8 | 2026-07 |
| hermes-gateway | `0.2.0` | PROTOTYPED | WS3 | 2026-07 |
| capture-helper | `0.2.0` | IN PROGRESS | WS11 | 2026-07 |
| webdesk | `0.0.0` | PLANNED | Web Dev | 2026-07-23 |

---

## platform-nest — Platform Core · `0.5.0` · PROTOTYPED

**What exists (dev):** modular multi-tenant NestJS core with FORCE-RLS schema, `ModuleContract`
framework + custom fields, Cerbos RBAC (scope cascade, decision audit, revocation, PlanResources),
OBO + dual-proof identity links, cross-company rollups, the agency vertical (clients/deliverables/
time, campaigns/briefs/creative review, comments, notifications, files), and the transactional-outbox
event backbone. ~92 dev tests pass against live PG + Cerbos.
**Known gaps:** the admin/systems API layer (`/api/admin/*`, identity writes, org-structure endpoints)
is not implemented — top frontend-blocking gap. Not deployed to production.
**Future plans:** admin/systems API → backbone/ORG-CORE holding-OS build-out → additional verticals
(resort/marine/print) → hardening to production.

## platform-ui — ERP Suite · `0.5.0` · PROTOTYPED

**What exists (dev):** Next.js ERP UI, BFF to platform-nest, RBAC-gated nav + company switcher; My Work,
Approvals inbox, Companies/Projects/Tasks, Agency, Rollups, Systems/Intelligence/Admin consoles, People
360, org-structure builder, Repsona-style PM + AI tracker, IT device console, per-department consoles
(Web Dev reference), OIDC PKCE login. Runs backend-free in `DEMO_MODE`; Playwright e2e in dev.
**Known gaps:** Systems/Intelligence/Admin write paths degrade gracefully pending the backend admin API;
not deployed to production.
**Future plans:** wire to the backend admin API as it lands → dept-console integrations program → prod hardening.

## ai-gateway-go — AI Gateway · `0.9.0` · PROTOTYPED

**What exists (dev):** Go gateway (the `ai-gateway` service on `:3002`), HTTP-parity with the retired Node
gateway; provider chain + failover + circuit breaker, DLP, daily cost cap, egress audit + allowlist,
internal CA + mTLS, site/central topology, DR-burst budget. go build/vet/test green.
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

## infra — Platform Engineering & Delivery · `0.4.0` · PROTOTYPED

**What exists (dev):** full VPS Docker Compose stack, per-component Dockerfiles, local CI (`test-all.sh`),
GH Actions (inert until the repo is standalone), crypto-shred-safe backups, supply-chain pipeline
(SBOM + cosign + SLSA).
**Known gaps:** not deployed; K8s/GitOps + SPIFFE/SPIRE are target-state (hiring-gated).
**Future plans:** first production deploy → GitOps → K8s/SPIFFE at target-state.

## wa-chat-bot — Messaging Surface · `0.6.0` · PROTOTYPED

**What exists (dev):** WA (WAHA) + Telegram work-summary/assistant bot; scrub → crypto-shred store →
skills/Q&A, digests, media enrichment via gateway. Telegram live in dev; P5a production-grade features.
**Known gaps:** trial-lite; blocked on infra (OpenBao VPS, Gemini key, WAHA number) and legal Gate 1
before real ingestion; not in production.
**Future plans:** WAHA primary once number scanned → hardening backlog → prod after gates.

## ai-agents — Agent Brigade · `0.3.0` · IN PROGRESS

**What exists (dev):** specialist framework (status-reporter, approvals-chaser) + supervisor orchestrator
(blackboard, cycle guard, per-goal budget, fan-out cap, approval suspension) + pgvector RAG; D14 safety in code.
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
