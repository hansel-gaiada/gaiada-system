# Web Dev Department — Integrations & Work-Detection Plan

**Status:** DRAFT for approval · **Date:** 2026-07-22 · **Owner:** hansel@gaiada.com

## Goal

Make the Web Dev department console the real daily workspace for the web team, and
make the ERP the *central hub* that detects the team's actual work and lets AI
automate/share info on top of it. Web Dev is the first consumer; the foundation
must generalize to every department (SEO, SMM, Video, Design, GM).

## What already exists (do NOT rebuild)

- **Repsona-style PM is built end-to-end** — board, progress, poly-assignee,
  subtasks, milestones, project docs, gantt, dependencies, time tracking, AI
  Tracker; UI in `platform-ui/src/components/pm/*` and backend `platform-nest`
  `pm.controller.ts` (`/api/:t/pm/*`). Treat as the daily-work substrate.
- **Web Dev department console** — `(app)/departments/[deptId]/` with Overview,
  Projects & Workflow (Kanban), PRD Studio (record→transcribe→pipeline), Build
  Tools. Toolkit registry `platform-ui/src/lib/deptToolkits.ts`. The Build-Tools
  buttons (Claude Code, Claude, Claude Design, GitHub, Figma, VS Code) are today
  **plain external links — no integration behind them.**
- **Plumbing to build on:** AI Gateway (Go, provider chain incl. Claude), MCP Hub
  (Cerbos-authoritative tool access), n8n automation backbone, event outbox,
  WS8 agent platform, capture-helper's Google refresh-token upload pattern.

## What's missing (the actual work)

1. No per-user / per-org **external account linking** subsystem (OAuth, token
   vault). This is the foundation everything else hangs off.
2. No **work-activity / deliverable-evidence** model to receive signals and link
   them to PM tasks/projects/people.
3. No GitHub org integration, no per-user Google Drive, no Claude seat registry.

---

## Decisions (locked with user 2026-07-22)

- **Sequencing:** build **everything doable in code first** (redesign + F1/F2 data
  model + APIs + full UI with mocked/empty connection states); wire the **external
  OAuth/keys LAST** (GitHub App reg, Drive tokens, Anthropic Admin key). The UI and
  data model must be fully usable before a single external credential exists.
- **Redesign is the headline:** the Web Dev console gets a full redesign — must be
  professional, visual, light, and easy; it should *reduce* complication, not add
  it. Improve teamwork + project tracking, as visual as possible.
- **Console IA — Hybrid command-center + my-work rail:** landing = team command
  center (KPI strip, project-health rings, live activity feed) with a **persistent
  "My work today / Waiting on me" rail** always visible. Tabs drill into Projects →
  Board → Timeline → Activity → (later) Repositories/Deliverables/Connections.
- **Work signals (all four):** GitHub activity→tasks · Claude usage metrics ·
  Google Drive deliverables · Manual + AI summary digests.
- **GitHub:** single **Org GitHub App** (repos + webhooks + automation), per-person
  mapped by GitHub login.
- **Claude:** **seat registry first**, then Anthropic **Admin usage API** for
  per-seat usage/cost. No programmatic Claude Code driving in v1.
- **Google Drive:** per-user OAuth, **two-way** (list + attach as deliverables +
  per-project folder create/push).

## Redesign spec (the code-first headline)

**Feel:** calm, spacious, luxury design-system aligned; progress shown as rings/bars
not dense tables; colour used only for signal (health, due, blocked); one primary
action per view; zero-config empty states that teach.

**Landing (Home tab) — command center + rail:**
- KPI strip: active tasks · due soon · in review · overall progress %.
- Project-health cards with progress rings, open count, next milestone/due, at-risk flag.
- Live activity feed (fed by F2 work-activity; pre-integration it shows PM events).
- Persistent right rail: **My work today** (my tasks, sorted) + **Waiting on me**
  (reviews/approvals). Rail is present on every console view.

**Tabs:** Home · Projects · Board · Timeline · Activity, then Repositories ·
Deliverables · Connections appear as their tracks land. Each connection-backed tab
ships first with a clear **"Connect GitHub / Drive / Claude"** empty state so the UI
is complete before external wiring exists.

**Reusability:** the redesigned shell + KPI/health/feed/rail components become the
generic department-console template, so SEO/SMM/etc. inherit it.

---

## Foundation (generalizable — build first)

### F1 — Connections subsystem (per-user & per-org account linking)
- New core table `integration_connections`: `owner_kind (user|company)`, `owner_id`,
  `provider (github|google_drive|claude)`, encrypted tokens/refresh, scopes,
  status, `external_account` (github login / google email / claude seat), audit.
- OAuth callback flows in `platform-nest`; tokens encrypted at rest (reuse/extend
  gateway secret handling). Cerbos policies: a person manages their own
  connections; company/org connections gated to elevated roles.
- UI: a **"Connections"** surface — global (per-user in profile/settings) and a
  Web-Dev-console tab showing team connection status.
- *Why foundation:* this is the missing per-user OAuth linking; every provider and
  every future department reuses it.

### F2 — Work-activity & deliverable-evidence model
- New table(s) `work_activity` (normalized event: source, actor person, repo/file/
  seat ref, verb, timestamp, payload) + link edges to `pm_tasks` / `projects` /
  `people`. `deliverable_evidence` view for "proof of work done".
- Ingestion API + auto-linking rule engine (task-ID references in branches/commits/
  PR titles → link to task; Drive file in a project folder → link to project).
- Surfaced as an **Activity feed** in the Web Dev console and per-person profile.

---

## Track A — GitHub Org App
- Register GitHub App on the company org; store install + webhook secret.
- Webhook receiver (`/api/webhooks/github`) → push / PR / deployment events →
  `work_activity`, auto-link to tasks (F2).
- Repo list service; per-person github-login mapping on the user profile.
- UI: **"Repositories"** tab in the Web Dev console (org repo list, recent PRs/
  commits, per-repo activity) + "my repos" on the person profile.

## Track B — Google Drive (per-user, two-way)
- Per-user OAuth connection (F1); Drive service in `platform-nest` generalizing
  capture-helper's token pattern to per-user.
- List files/folders; **attach file → task/project as deliverable evidence** (F2).
- Two-way: create per-project folder, push/organize files.
- Change detection (poll or push channel) → `work_activity` deliverable signal.
- UI: **"Deliverables"** tab + Drive picker in the task attach flow.

## Track C — Claude Team
- **C1 seat registry:** map each ERP person → Claude Code seat + Claude Design
  login (`integration_connections` provider=claude, or a light seat table). Wire
  the existing launcher buttons to the person's seat. ERP now knows who has access.
- **C2 Admin usage API:** pull per-seat usage/cost from Anthropic Admin API →
  `work_activity` metrics; show Claude activity per person/team.

## Track D — Console surfacing + AI automation
- Extend `deptToolkits.ts` Web Dev toolkit with new tabs: **Repositories,
  Deliverables, Connections, Activity**. Person profile: connections + repos +
  Drive + Claude seat + activity.
- AI automation via existing backbone: n8n flow + WS8 agent to (a) summarize each
  person's/project's daily+weekly activity into digests (Manual+AI signal),
  (b) auto-link stray activity, (c) nag stale tasks with no recent activity.
- Reuse MCP Hub for tool access; AI Gateway for the LLM calls.

## PM carry-overs to fold in (small)
- `projects.department_id` returned/accepted by `/api/:t/projects` (needed for the
  console owned-projects list — already flagged in the BFF contract).
- Confirm PM UI is repointed off the in-memory demo store to the real backend.

---

## Build order (code-first, external last)

**Phase 1 — Code-only (no external credentials needed):**
1. **PM carry-overs**: `projects.department_id` + confirm UI is off the demo store
   (unblocks the console showing real owned projects).
2. **F2 Activity model** (tables + ingestion API + auto-link engine) — seeded from
   existing PM events so the feed is live before any integration.
3. **F1 Connections** *data model + API + Cerbos policies* (tables, status,
   encrypted-token columns) — but NOT the external OAuth handshakes yet.
4. **Redesign build**: the command-center + my-work-rail shell, KPI/health/feed/rail
   components, Home/Projects/Board/Timeline/Activity tabs, and the empty-state
   "Connect …" tabs for Repositories/Deliverables/Connections. Fully usable on mock/
   empty connection data.
5. **Claude C1 seat registry** (pure data — map person→seat, wire launchers).

**Phase 2 — External wiring (needs credentials/keys, do LAST):**
6. **Track A GitHub** Org App registration + webhook receiver + repo/activity feed.
7. **Track B Google Drive** per-user OAuth handshake + two-way file service.
8. **Track C2** Anthropic Admin usage API pull.
9. **Track D** AI automation (n8n + WS8 agent digests) once real signals flow.

## Open risks / to confirm at build time
- Token encryption/secret storage standard (reuse gateway KMS pattern vs new).
- Anthropic Admin API availability requires an **org admin API key** — confirm access.
- Two-way Drive write scopes = higher risk; gate behind Cerbos + explicit consent.
- GitHub App private-key handling in the VPS compose/secrets.
