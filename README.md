# Gaiada System

Head folder for the company AI-platform program. **Each component is its own standalone
project** (own `package.json`, own deploy) — deliberately **not** a shared-package monorepo.

## Layout

| Folder | Component | Workstream | Status |
|---|---|---|---|
| `docs/` | Specs, plans, blueprint, adversarial review | — | Living |
| `legal/` | Gate-1 legal pack (DPIA / LIA / notices) | Compliance | Drafts (lawyer review) |
| `wa-chat-bot/` | Work-summary bot — Telegram live now, WhatsApp via WAHA | WS5 | **Built — trial (Phases 0–3)** |
| `ai-gateway/` | AI provider egress + routing + DLP | WS3 | **Built — standalone service** |
| `mcp-hub/` | Company tools/data access layer | WS2 | **Skeleton — OBO/policy spine built** |
| `platform/` | Custom modular platform (source of truth) | WS1 | **Built — Phase 4 thin slice (core+RBAC+agency)** |
| `platform-ui/` | ERP Suite web UI (Next.js BFF) | WS5 | **Built — plan 1 (shell + My Work + Approvals) + plan 2 (Companies/Projects/Tasks/Agency/Rollups)** |
| `automation/` | N8N + Temporal orchestration | WS4 | **v1 glue — N8N + MCP-calling template** |
| `ai-agents/` | Agent brigade + ML trainer | WS8 | **Built — specialist framework (D14 safety)** |
| `infra/` | IaC + GitOps + delivery + observability | WS10 / WS9 | **v1 slice — VPS compose stack, CI, backups** |

## Where to start

- **Architecture:** `docs/superpowers/specs/2026-07-04-INDEX-overview.md`
- **Master blueprint (C-level):** rendered artifact (see docs)
- **Build plan + checklist:** `docs/superpowers/plans/2026-07-05-IMPLEMENTATION-INDEX.md`
- **Running today:** `wa-chat-bot/` — see its README.

## Principle

**Solo-Viable v1** (managed-first, cloud-AI-first, single-region) underneath a preserved,
hiring-gated all-local **Target-State** (roadmap §3c). Components stay separate deployables so
they can be built, run, and scaled independently.
