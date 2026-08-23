# Gaiada System — root guide

The **Gaiada AI-platform program**: an AI-native, multi-business ERP ("holding OS") for a group
of companies. Delivered as a **Solo-Viable v1** (managed-first, cloud-AI-first, single-region)
underneath a preserved, **hiring-gated all-local target-state**.

**This file holds only what does not rot.** Status claims are deliberately absent — they went
stale here twice and misled real tickets. Each component owns a `CLAUDE.md` with its own rules,
commands and traps; read that one when you work there.

## Layout — not a monorepo

Components are **separate standalone projects** (own `package.json`/`go.mod`, own image, own
deploy). Nothing is shared through packages; contracts are shared through HTTP + docs.

| Dir | What | Own guide |
|---|---|---|
| `platform-nest/` | **THE platform** — NestJS-on-Fastify backend, :3004. Schema, RLS, Cerbos, modules, events | ✅ |
| `platform-ui/` | ERP Suite web surface — Next.js, :3005, BFF-only egress | ✅ |
| `ai-gateway-go/` | **THE** AI gateway — Go, runs as compose service `ai-gateway` :3002 | ✅ |
| `mcp-hub/` | MCP server — the tool surface agents/automation reach the platform through | ✅ |
| `sync-engine-go/` | Cross-site reconciliation over the shared `outbox_events` log | ✅ |
| `wa-chat-bot/` | WhatsApp/Telegram bot surface | ✅ |
| `ai-agents/` | WS8 specialist + supervisor agent framework | ✅ |
| `automation/` | n8n compose + versioned workflow JSON | ✅ |
| `infra/` | compose files, nginx, observability, backup/restore, runbooks | ✅ |
| `search-crawl-go/` | owned crawler for the SEO/SEM department | — |
| `report-renderer/` | Playwright PDF sidecar for the reporting program | — |
| `hermes-gateway/`, `meeting-bot/`, `capture-helper/`, `creative-grading-trainer/` | edge/side services | — |
| `docs/`, `design/`, `legal/`, `data/`, `scripts/` | contracts, blueprints, gate drafts, helpers | — |

## Where truth lives (check here, never assert from memory)

- **Structure** — `docs/MAP.md`, **generated** from the filesystem by `node scripts/gen-map.mjs`
  and gated by the CI `docs-map` job, so it cannot drift: components, every compose service with
  its profile/ports, the module registry, the migration head + next free number, the whole
  `@Controller` surface, every UI route, and the n8n workflow ids. Start there instead of
  grepping. If it disagrees with the repo, regenerate it — never hand-patch it.
- **Version** — `/VERSION` (`Alpha MM.mmm.bbbba`); the deploy workflow enforces tag ↔ VERSION.
- **Module status** — `docs/modules/MODULES.md` + `docs/modules/CHANGELOG.md`. Bump the module
  and append an entry on any notable change.
- **Frozen contracts** — `docs/FRONTEND-BFF-CONTRACT.md` (§-numbered, the BFF surface),
  `docs/PERMISSION-CONTRACT.md` (IAM Phase 1). Update the relevant § in the same change; a
  stale row here has caused real defects.
- **Blueprints** — `docs/BLUEPRINTS.md` indexes the per-department engineering blueprints.
- **Live estate** — `erp.gaiada.online` on the `gda-aicenter` box. The local 16-container stack
  is **OFF by owner decision**; verify against the server or against test containers from
  source, not a local full stack.
- **Historic narrative** — `docs/history/PROJECT-GUIDE-2026-07-09.md` (the former version of
  this file). Provenance only.

## Status language (binding)

Never write "built", "done", "complete", or "production-ready". The vocabulary is
**PLANNED · IN PROGRESS · PROTOTYPED · DEV-VERIFIED**. Nothing in this program is production.
"DEV-VERIFIED" means *you drove it and observed the result* — a green unit suite is not that.

## Non-negotiable decisions (don't relitigate without cause)

- **Components stay separate projects.** No monorepo, no shared package layer.
- **Full-fidelity mandate.** No solo-dev corner-cutting; every "lite" deviation is a tracked gap
  to be closed. New shortcuts require an explicit owner decision. Time is not the constraint.
- **Only the Gateway holds provider keys.** No other service ever does, and the bot never
  asserts identity.
- **Cerbos + Postgres RLS are the authorization authority.** Every other layer (UI `lib/rbac.ts`,
  the hub's in-code engine) is a mirror or a fail-closed fallback, never the source.
- **Scrub PAN/national-IDs before persist**; PII encrypted at rest (crypto-shred, two-axis
  subject × entity).
- **Managed-first for v1**; all-local is target-state and hiring-gated.
- **Agency is a first-deploy child company** — the digital-agency vertical must be genuinely
  operable, not a demo.
- **Agentic-native bar** (`docs/superpowers/plans/2026-08-03-agentic-native-erp-plan.md`, OPEN,
  must close before staging): every department capability must work identically under a human,
  under n8n, and under an agent. Read it *before* adding a capability — retrofitting costs more.
- **Legal Gate 1 + the day-one technical gate** must both be green before ingesting real
  employee data (`legal/`).

## Traps that have burned real tickets, program-wide

- **This checkout is shared by concurrent agent sessions.** Another session's `git checkout`
  moves HEAD under you and your files look mysteriously wrong. Re-read before assuming a
  regression; never `git checkout` a branch someone else may be on.
- **cwd ≠ repo root.** Always pass absolute paths to Write/Edit.
- **Generated files must be generated from a CLEAN worktree, never from this checkout.**
  `docs/MAP.md` is derived from the FILESYSTEM, and this shared checkout routinely carries a dozen
  untracked files from other sessions (in-flight migrations, scratch dirs, built binaries). Running
  `node scripts/gen-map.mjs` here produces a MAP for *your filesystem*, not for the repository, and
  CI — which checks out tracked files only — then fails `docs-map`. Use
  `git worktree add --detach <tmp> HEAD`, generate there, copy the file back.
  Corollary: a generated file has **no meaningful three-way merge**. Two sessions regenerating MAP
  concurrently produced a merge that matched neither side and silently dropped a route. On any
  conflict in a generated file, regenerate from the merged tree rather than resolving hunks.
- **A missing field reads exactly like NULL.** An omitted column in a SELECT is
  indistinguishable from a NULL value — this produced two wrong conclusions. Check the select
  list before concluding "the data is empty".
- **Cerbos does not hot-reload policy** — restart it, then prove the new decision with a probe.
  A *healthy* Cerbos container has served two-day-stale policy. Health ≠ current.
- **A var in `.env` does nothing unless the service's compose `environment:` block lists it.**
- **`up -d` with a stale `.env` silently rolls the release back** (`GAIADA_TAG`/`APP_VERSION`).
- **`--remove-orphans` deletes any `gaiada`-project container whose profile isn't in the command.**
- **Frontend-first drift** is the recurring bug class: a console reads fields the backend never
  sends, renders a confident wrong answer, and nothing throws. Verify new reads against a live
  response.
- **Scripted/cross-process verification ≠ real-input verification.** Drive the actual surface.

## Working here

- **CI** (`.github/workflows/ci.yml`) jobs: `test`, `platform-nest`, `gateway-go`,
  `sync-engine-go`, `platform-ui`, `observability-lint`. `infra/scripts/test-all.sh` is the
  local equivalent.
- **Deploy** is one point: `git push --tags` → `release.yml` builds + cosign-signs GHCR images →
  `deploy.yml` rolls the VPS. Runbook `infra/runbooks/deploy-vps.md`.
- **Credentials** live in the gitignored `CREDENTIALS.local.md`. Never paste a secret into a
  file, a log, or chat.
