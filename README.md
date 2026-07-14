# Gaiada System

Head folder for the company AI-platform program. **Each component is its own standalone
project** (own `package.json`, own deploy) — deliberately **not** a shared-package monorepo.

## Layout

| Folder | Component | Workstream | Status |
|---|---|---|---|
| `docs/` | Specs, plans, blueprint, adversarial review | — | Living |
| `legal/` | Gate-1 legal pack (DPIA / LIA / notices) | Compliance | Drafts (lawyer review) |
| `wa-chat-bot/` | Work-summary bot — Telegram live now, WhatsApp via WAHA | WS5 | **Built — trial (Phases 0–3), P5a production-grade** |
| `ai-gateway-go/` | AI provider egress + routing + DLP (Go) — mTLS, topology, DLP classifier, streaming | WS3 | **Built — THE gateway (`ai-gateway` service on :3002); replaced+retired the Node `ai-gateway/` 2026-07-14** |
| `mcp-hub/` | Company tools/data access layer | WS2 | **Skeleton — OBO/policy spine built, fronts platform-nest** |
| `platform/` | *(deleted — ported to `platform-nest/`)* | WS1 | *Retired* |
| `platform-nest/` | Custom modular platform (NestJS, source of truth) | WS1 | **Built — P5c core+RBAC+agency (92 tests) + event backbone** |
| `platform-ui/` | ERP Suite web UI (Next.js BFF) | WS5 | **Built — plans 1–4 (shell, business modules, systems consoles, admin); admin/systems pages await backend admin API** |
| `automation/` | N8N + Temporal orchestration | WS4 | **v1 glue — N8N + MCP-calling template** |
| `ai-agents/` | Agent brigade + ML trainer | WS8 | **Built — specialist framework + supervisor + D9 knowledge/memory (D14 safety)** |
| `sync-engine-go/` | Go cross-site sync engine (T2) | WS1 | **Not started — design approved (`2026-07-06-ws1-sync-engine-*`)** |
| `infra/` | IaC + GitOps + delivery + observability | WS10 / WS9 | **v1 slice — VPS compose stack, CI, backups** |

## Where to start

- **Architecture:** `docs/superpowers/specs/2026-07-04-INDEX-overview.md`
- **Master blueprint (C-level):** rendered artifact (see docs)
- **Build plan + checklist:** `docs/superpowers/plans/2026-07-05-IMPLEMENTATION-INDEX.md`
- **Current status (source of truth):** `CLAUDE.md` "Current status" + the gap register
  `docs/superpowers/plans/2026-07-05-phase-5-full-fidelity.md`. (The `2026-07-05-CHECKLIST.md`
  covers Phases 0–5 but predates the NestJS port / event backbone / Go gateway — see its footer.)
- **Running today:** `wa-chat-bot/` — see its README.

## Principle

**Solo-Viable v1** (managed-first, cloud-AI-first, single-region) underneath a preserved,
hiring-gated all-local **Target-State** (roadmap §3c). Components stay separate deployables so
they can be built, run, and scaled independently.
