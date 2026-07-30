# Web Dev Integrations — Phase 1 Ticket Plan (code-only)

**Status:** READY for /army · **Date:** 2026-07-22 · **Architect:** system-architect (Fable·max)
**Source plan:** `docs/superpowers/plans/web-dev-integrations-plan.md` (Phase 1 scope) ·
**Contract:** `docs/FRONTEND-BFF-CONTRACT.md` (update it in every BE ticket)

Phase 1 = everything doable with zero external credentials: PM carry-overs, F2 work-activity
model (live from PM events), F1 connections data model + API + Cerbos (no OAuth handshakes),
the console redesign as the reusable department template, and the Claude C1 seat registry.

---

## Owner decisions — RESOLVED 2026-07-22 (implementers follow these verbatim)

- **Connection link scope = PER-COMPANY** (RLS-consistent; a person re-links per
  company). P1-08 `integration_connections` is tenant-scoped like every other row —
  do NOT build a cross-tenant/holding-wide path.
- **Q1 PM short-codes** → deferred to the START of Phase 2 (Phase 1 unaffected).
- **Q3 Claude launcher wiring** = seat-identity display + mapped/unmapped CTA
  (claude.ai has no login-hint URL) — this satisfies C1.
- **Q4 Build Tools tab** → merged into the Home launcher row; old route redirects.

## Locked design decisions (implementers do NOT re-derive these)

1. **`projects.department_id` is `text NULL`, no FK.** Org-node ids are free-form strings inside
   the JSONB org structure (`lib/org.ts`), so no referential constraint is possible. Soft data;
   GET returns `department_id`, POST/PATCH accept `departmentId`. UI is already built for this
   (`lib/entities.ts:18`, ProjectForm).
2. **F2 lives in core, not a gated module:** `platform-nest/src/core/work-activity.*`. It is a NEW
   normalized model — the existing flat `activities` audit table stays untouched. API path is
   **`/api/:t/work-activity`** (avoids collision with the `/api/:t/audit` reader over `activities`).
3. **F2 tables (migration `0030_work_activity.sql`, FORCE RLS like 0018):**
   - `work_activity(id, tenant_id, source CHECK IN ('pm','pipeline','github','google_drive','claude','manual','system'), source_ref text, actor_user_id uuid NULL REFERENCES users, actor_external text NULL, verb text, object_kind text, object_ref text, title text, payload jsonb, occurred_at timestamptz, origin_site, created_at, UNIQUE(tenant_id, source, source_ref))` — the UNIQUE is the idempotency key (outbox event id for seeded rows).
   - `work_activity_links(id, tenant_id, activity_id FK CASCADE, target_kind CHECK IN ('pm_task','project','person','department'), target_id text, confidence CHECK IN ('exact','inferred'), rule text, UNIQUE(activity_id, target_kind, target_id))`.
   - `deliverable_evidence` = SQL VIEW over `work_activity` (object_kind in file/doc/deliverable) + links.
4. **Auto-link engine = pure function** (unit-testable, no I/O): input `{source, payload hints, text}` →
   link set. Rule order: (a) structured hints first — `payload.taskId/projectId/actorId` → exact links;
   (b) uuid scan in text → `pm_tasks` lookup → exact; (c) derived: task→its project, project→its
   `department_id` (tolerate NULL), actor→person. GitHub/Drive rules are Phase 2 slots in the same engine.
5. **F2 goes live via an outbox consumer** mirroring `src/events/reconcile-consumer.ts`: dedicated
   group `work-activity`, streams `pm_task`, `pm_project`, `meeting_recording`, `pipeline_run`;
   plus a one-shot backfill from the existing `activities` table (verbs created/updated on
   task/project) so the feed is populated on day one. Redis-gated start in `main.ts`.
6. **F1 lives in core too:** `src/core/integrations.controller.ts|service.ts` + `src/core/secret-box.ts`.
   Migration `0031_integration_connections.sql` **[RECONCILED 2026-07-30, WD-20: landed as
   `0033_integration_connections.sql` — a concurrent program (creative assets) claimed `0031`/`0032`
   first at merge time; this is the actual disk/DB state, not a defect]**:
   - `integration_connections(id, tenant_id, owner_kind CHECK IN ('user','company'), owner_id uuid, provider CHECK IN ('github','google_drive','claude'), external_account text, scopes text[] DEFAULT '{}', status CHECK IN ('unconfigured','pending','linked','error','revoked') DEFAULT 'unconfigured', access_token_enc text, refresh_token_enc text, token_expires_at timestamptz, token_key_version text, meta jsonb DEFAULT '{}', created_by uuid, created_at, updated_at, deleted_at, origin_site, UNIQUE(tenant_id, owner_kind, owner_id, provider))`, FORCE RLS.
   - Rows are **tenant-scoped** (RLS-consistent); a person re-links per company in v1 (flagged below).
7. **Token crypto (new — platform-nest has NO crypto util today):** app-layer **AES-256-GCM** in
   `secret-box.ts`; key from env `INTEGRATION_TOKEN_KEY` (base64, 32 bytes); ciphertext format
   `enc:v1:<iv>:<tag>:<data>`; `token_key_version='v1'` column so OpenBao/KMS can swap in later.
   Fail-closed: token writes 503 when the key is unset. **Token columns are NEVER serialized** —
   API returns `hasToken:boolean` only (tests must assert this).
8. **Connections API:** `GET /api/:t/integrations/connections?owner=me|company|user:<id>&provider=`,
   `POST` (create mapping row — no tokens in Phase 1), `PATCH /:id` (externalAccount/meta/status),
   `DELETE /:id` = **soft revoke** (status='revoked', tokens nulled, row kept — mirrors
   service-assignment revoke). Cerbos `integration_connection`: own user-rows full CRUD; company
   rows + reading OTHERS' rows = `company.manage`/manager+; emit `integration_connection.*` events.
9. **Claude C1 = connection rows, no extra table:** provider='claude', `external_account` = Claude
   Code seat email, `meta.designLogin` = Claude Design login. Launchers render seat identity
   ("opens as …") — claude.ai has no login-hint deep link, so wiring = identity display + mapped
   CTA state, not URL magic.
10. **Console IA:** tabs **Home · Projects · Board · Timeline · Activity · PRD Studio · Repositories ·
    Deliverables · Connections**. Build Tools tab MERGES into Home as a compact launcher row
    (`/departments/[deptId]/tools` redirects to Home); PRD Studio stays (WS11 edge, do not orphan).
    The persistent **My-work rail renders in `[deptId]/layout.tsx`** so every tab gets it.
    Refactor in place — `(app)/departments/[deptId]/` + `lib/deptToolkits.ts`; **no fork**.
11. **Template rule:** new components (`components/departments/`: `KpiStrip`, `HealthRingCard`,
    `ActivityFeed`, `MyWorkRail`, `LauncherRow`, console shell CSS) take data via **props only** —
    zero Web-Dev-specific fetching inside. The generic toolkit's Overview upgrades to the new Home
    for ALL departments; Web Dev additionally gets the full tab set via its toolkit entry.
12. **KPI semantics (no new task status invented):** Active = todo+in_progress · Due soon = due ≤7d
    not done · Blocked · Progress = avg project progress. Health ring per owned project
    (`department_id = dept`): ring = projectProgress, open count, next milestone due, at-risk =
    overdue>0 or blocked>0. Rail: My work today = my dept tasks sorted (due, priority); Waiting on
    me = pending agency approvals + `/api/:t/automation-approvals` (new tiny lib read, degrades) +
    my blocked tasks.
13. **Canonical response shapes = the exported TS types** the FE tickets add (`lib/activity.ts`
    `WorkActivityRow`, `lib/connections.ts` `ConnectionRow`) — contract-doc convention. BE tickets
    add §11 (work-activity) and §12 (integrations) rows to `docs/FRONTEND-BFF-CONTRACT.md`.

---

## Execution waves (1–2 agents in flight, serial-preferred)

```
W1: P1-01 (junior BE: projects.department_id)        ∥  P1-02 (senior-uiux: console design system — BLOCKS all FE pages)
W2: P1-03 (medior: PM repoint verify, live stack)    ∥  P1-04 (senior-be: F2 schema + ingest API + linker)   [QA gate]
W3: P1-06 (senior-fe: console shell + tabs skeleton) ∥  P1-05 (medior BE: F2 outbox consumer + backfill)     [QA gate]
W4: P1-07 (senior-fe: command-center data wiring)    ∥  P1-08 (senior-be: F1 connections + crypto + Cerbos)  [QA gate, opus·medium]
W5: P1-09 (medior FE: Connections + empty-state tabs)∥  P1-10 (medior: C1 seat registry + launcher wiring)
W6: P1-11 (qa: Phase-1 gate — tenancy/authz/idempotency/e2e evidence)
```

Graph: P1-01 → {P1-03, P1-04(link rule), P1-07} · P1-02 → {P1-06} → {P1-07, P1-09} ·
P1-04 → {P1-05, P1-07 feed} · P1-08 → {P1-09, P1-10} · all → P1-11.

---

## Tickets

| ID | Title | Tier | Model·Effort | Files / areas | Deps | Acceptance (done when) | QA gate |
|---|---|---|---|---|---|---|---|
| P1-01 | `projects.department_id` end-to-end | junior | Haiku·medium (seat default) | `platform-nest/migrations/0029_projects_department.sql` (`ALTER TABLE projects ADD COLUMN department_id text`); `src/core/core.controller.ts` projects GET list (~L96), detail (~L215), POST (~L106, accept `departmentId`), PATCH (~L231, COALESCE update); test; contract §4 row | — | GET list+detail return `department_id`; POST/PATCH round-trip `departmentId` (nullable); existing + 1 new test green; contract doc updated. | inline-verify |
| P1-02 | Dept-console design system: tokens + component contracts | senior-uiux | Sonnet·high (seat default) | New spec `docs/superpowers/specs/2026-07-22-dept-console-design.md`; `components/departments/departments.css` tokens; prop contracts + static skeletons for `KpiStrip`/`HealthRingCard`/`ActivityFeed`/`MyWorkRail`/`LauncherRow`; tab IA + empty-state pattern ("Connect X" teach-state). Extends the existing luxury system (`ui.css`), light/visual/calm per plan. May invoke `frontend-design` skill. | — | Spec doc + components compile & render with mock props (DEMO_MODE scratch render); prop APIs are dept-agnostic (props-only data); tab IA per decision #10; tsc green. | inline-verify |
| P1-03 | PM repoint verification against live backend | medior | Sonnet·medium (seat default) | Run full local stack (see memory `full-local-stack-runbook`) with migrations ≥0029; walk PM UI (board/task/subtasks/milestones/docs/time/tracker) on :3004; fix stale header comment in `platform-ui/src/lib/pm.ts` (backend EXISTS); fix any shape drift; verify ProjectForm departmentId persists | P1-01 | Every PM surface verified against real `/api/:t/pm/*` (not demo store — `demoPm` reachable only via DEMO_MODE `demoFixtures`); drift fixed or ticketed; evidence list in ticket close. | inline-verify |
| P1-04 | F2 work-activity: schema + ingest API + auto-link engine | senior-be | Sonnet·high (seat default) | `migrations/0030_work_activity.sql` (decision #3); `src/core/work-activity.controller.ts` (`GET /api/:t/work-activity?deptId&projectId&personId&since&limit`, `POST /api/:t/work-activity` ingest); `src/core/work-activity-linker.ts` (pure, decision #4); `cerbos/policies/resource_work_activity.yaml` (read=member; ingest=admin/service); emit `work_activity.created`; tests; contract §11 | P1-01 (dept link rule) | DDL + FORCE RLS + dedupe UNIQUE live; POST idempotent on `(tenant,source,source_ref)`; GET filters work incl. `deptId` via links; linker unit-tested (hints, uuid-scan, task→project→department derivation, NULL-tolerant); Cerbos policy tests pass. | **YES** (tenancy/RLS) |
| P1-05 | F2 live seed: outbox consumer + backfill | medior | Sonnet·medium (seat default) | `src/events/work-activity-consumer.ts` (mirror `reconcile-consumer.ts`; group `work-activity`; streams `pm_task`,`pm_project`,`meeting_recording`,`pipeline_run`; map event→activity row via linker); backfill script from `activities` (task/project created/updated); `main.ts` Redis-gated start; tests | P1-04 | Live `pm.task.created/updated` → feed row + links within seconds on the dev stack; redelivery produces no duplicates (dedupe by outbox id); backfill fills the feed from seeded data; dead-letter path covered by test. | **YES** (idempotency) |
| P1-06 | Console shell redesign: tabs + persistent rail (the template) | senior-fe | Sonnet·high (seat default) | `(app)/departments/[deptId]/layout.tsx` (rail slot, 2-col, responsive); `page.tsx` → Home skeleton; NEW routes `board/ timeline/ activity/ repositories/ deliverables/ connections/page.tsx`; `workflow/` becomes Board (kanban) + new Projects tab (owned list); `tools/` → redirect to Home; `lib/deptToolkits.ts` tab set; `SectionTabs` reuse; CSS per P1-02 | P1-02 | All tabs route + render skeletons/empty-states per P1-02; rail on EVERY view; generic (non-webdev) dept renders the same new Home shell (template proof); no console fork; tsc + unit + e2e (DEMO_MODE) green. | inline-verify |
| P1-07 | Command-center data wiring: KPIs, rings, feed, rail, launcher row | senior-fe | Sonnet·high (seat default) | `lib/activity.ts` (NEW, `WorkActivityRow`, degrades on 404/403); `lib/automationApprovals.ts` (tiny read); KPI/ring math per decision #12 reusing `lib/departments.ts` + `lib/entities.ts` owned-projects (`department_id`); Home + Activity tab live; rail data; `LauncherRow` on Home; `demoFixtures.ts` entries for `/work-activity` | P1-06, P1-01, P1-04 (P1-05 for real rows) | Home shows live KPIs/rings/feed/rail against the dev stack; every reader degrades cleanly without backend; Activity tab filters (person/project); e2e covers Home + Activity; tsc green. | inline-verify |
| P1-08 | F1 connections: table + crypto + CRUD API + Cerbos | senior-be | **opus·medium** — encrypted-credential vault + own-vs-company authz that Phase-2 real tokens ride on; a wrong foundation forces a full re-run | `migrations/0031_integration_connections.sql` (decision #6); `src/core/secret-box.ts` (decision #7); `src/core/integrations.controller.ts|service.ts` (decision #8); `cerbos/policies/resource_integration_connection.yaml`; events; tests; contract §12 | — (scheduled W4 for concurrency) | CRUD live per decision #8; own-row self-service vs company-row `company.manage` enforced in Cerbos tests; token fields never in any response (asserted); secret-box round-trip + fail-closed-without-key tests; soft revoke keeps row + audit. | **YES** (authz + secrets) |
| P1-09 | Connections UI + Repositories/Deliverables empty states + profile card | medior | Sonnet·medium (seat default) | `lib/connections.ts` (NEW, `ConnectionRow`); Connections tab (my connections + team status grid + admin mapping, RBAC-gated via `lib/rbac.ts`); Repositories/Deliverables teach empty-states w/ "Connect" CTA → Connections; connections card on `people/[userId]`; `demoFixtures.ts` | P1-06, P1-08 | Create/edit/revoke own connection works live; team grid shows per-member × provider status; empty states render pre-connection exactly per P1-02; non-admin cannot see admin mapping; e2e. | inline-verify |
| P1-10 | C1 Claude seat registry + launcher wiring | medior | Sonnet·medium (seat default) | Seat mapping UI (inside Connections tab admin surface: person → Code seat email + Design login, decision #9); `LauncherRow` renders "opens as <seat>" for Claude Code/Claude/Claude Design when mapped, "Map your seat" CTA when not; optional seed script for the current team | P1-08, P1-09 (P1-06 for LauncherRow) | Person→seat mapping persists as provider='claude' rows and survives reload; launchers show the signed-in person's seat identity; unmapped state teaches; ERP can list who holds seats (team grid shows it). | inline-verify |
| P1-11 | Phase-1 QA gate | qa | Sonnet·medium (seat default) | Evidence-driven pass: cross-tenant RLS probes on `work_activity`/`work_activity_links`/`integration_connections`; token non-exposure sweep (every integrations response); Cerbos matrix (member/manager/company_admin/exec × own/other/company rows); consumer redelivery idempotency; full console e2e walk (all tabs + rail, DEMO_MODE and live); contract-doc conformance (§4 dept_id, §11, §12) | all | Written evidence per check attached; zero critical findings open; regressions filed as tickets, not fixed ad-hoc. | — (is the gate) |

**P1-11 status — DEV-VERIFIED 2026-07-30 as WD-20.** Full evidence trail:
`docs/superpowers/plans/2026-07-30-wd20-evidence.md`. One regression filed and left open (not
fixed, per QA doctrine): `work_activity` has no `group_executive`/exec Cerbos carve-out (unlike
`integration_connection`, which explicitly grants exec full CRUD) — an exec cannot read the
work-activity feed for any company. Everything else in the gate is green; see the evidence doc for
the full per-check verdict table.

**Model discipline check:** 1 Opus tag out of 11 tickets (P1-08 opus·medium); everything else seat
default per the agent-army-standard. Escalate any ticket to the architect ONLY if it must deviate
from a locked decision or a contract shape above — otherwise proceed.

---

## Open questions for the owner (decide before/during Phase 2, none block Phase 1)

1. **PM human task codes** (e.g. `WEB-142`): pm_tasks are bare uuids, so Phase-2 GitHub auto-linking
   from branch/commit text has nothing readable to match. Recommend adding a per-project short code
   + sequence at the START of Phase 2 (Track A) — confirm, or pull into Phase 1 if you want it now.
2. **Per-user connections are tenant-scoped in v1** (re-link per company; RLS-consistent). Accept for
   v1, revisit if shared-service people serving N companies need one link everywhere (holding-OS bar).
3. **Claude launcher wiring = seat-identity display** (no login-hint deep link exists on claude.ai).
   Confirm this satisfies "wire launcher buttons to the person's seat" for C1.
4. **Build Tools tab merges into Home** (launcher row) to cut tab count per the "reduce complication"
   directive — confirm the tab's retirement (route redirects, nothing lost).
