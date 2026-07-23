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
| 2026-07-23 | **Baseline versions assigned** to all modules for tracking-forward; this registry + changelog created. |
| 2026-07-23 | `webdesk` added as `PLANNED` (blueprint approved). |
| 2026-07-15 | `observability` + `automation` reached DEV-VERIFIED (e2e on live Docker stack). |
| 2026-07-14 | `sync-engine-go` first prototyped; Node `ai-gateway` retired in favor of `ai-gateway-go`. |

> Older "Built/Complete" wording in `README.md` / `CLAUDE.md` predates this vocabulary — read it as
> `PROTOTYPED` / `DEV-VERIFIED` unless a production deploy is explicitly stated.

---

## platform-nest
### [0.5.0] — 2026-07-23 · PROTOTYPED
- Baseline. Core schema (FORCE RLS), ModuleContract + custom fields, Cerbos RBAC, OBO/identity links,
  rollups, agency vertical, event backbone (outbox→Redis Streams). ~92 dev tests.
- **Unreleased / next:** admin/systems API (`/api/admin/*`), identity writes, org-structure endpoints.

## platform-ui
### [0.5.0] — 2026-07-23 · PROTOTYPED
- Baseline. ERP UI Plans 1–5 + People 360 + org builder + dept consoles + PM/AI-tracker + IT console;
  OIDC PKCE; `DEMO_MODE`; Playwright e2e.
- **Unreleased / next:** wire Systems/Intelligence/Admin write paths once backend admin API lands.

## ai-gateway-go
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
### [0.4.0] — 2026-07-23 · PROTOTYPED
- Baseline. VPS Compose stack, Dockerfiles, local CI, backups, supply-chain pipeline (SBOM/cosign/SLSA).
- **Next:** first production deploy; GitOps; K8s/SPIFFE (target-state).

## wa-chat-bot
### [0.6.0] — 2026-07-23 · PROTOTYPED
- Baseline. WA + Telegram bot; scrub → crypto-shred → skills/Q&A; digests; media enrichment. Telegram live
  in dev; P5a features.
- **Blocked:** infra (OpenBao/Gemini/WAHA) + legal Gate 1 before real ingestion.

## ai-agents
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
