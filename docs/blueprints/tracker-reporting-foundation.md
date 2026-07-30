# Work Tracker · Reports · Appraisal — Foundation & Design (multi-grain)

> **Status:** PLANNED — foundation + design blueprint (no code). Registration as module `reports`
> (`0.0.0 PLANNED`) in `docs/modules/MODULES.md` is **pending** — a separate ticket (TR-30) owns the
> registry files; verified absent as of 2026-07-30.
> **Date:** 2026-07-30 · **Author:** Claude (system architect pass)
> Sibling blueprints: `seo-sem-design.md`, `creative-design.md`, `smm-design.md` — same
> module-vertical playbook. This one is different in kind: **the tracker already exists** (the
> Repsona-parity PM module). This program builds a **grain fabric + report/appraisal layer over
> existing substrate** — reuse, never duplicate (§2).
>
> **📌 LOCKED OWNER DECISIONS (2026-07-29, user) — design to these, do not re-open:**
> 1. **Attribution = owner-takes-all** outcome credit; contributors listed with their logged hours.
>    Company totals must never double-count (§3.1, §5.0).
> 2. **Day-end check-in is MANDATORY** — a real entity with compliance tracking, not derived-only.
>    <30s to submit (pre-filled from the day's derived activity; person edits + confirms).
>    Compliance respects the HR working calendar / leave or it manufactures false negatives.
>    Reminders + next-morning manager escalation ride the existing wa-chat-bot + n8n rails (§4.3, §10).
> 3. **Appraisal = blended, manager-weighted** (delivery / quality / effort / collaboration),
>    per-role weights, MANDATORY human commentary, employee acknowledgement trail. Raw task counts
>    alone are rejected as hostile — they reward task-slicing (§5.2, §4.5).
> 4. **PDF = server-side render NOW** — a small `report-renderer` sidecar (Playwright base image,
>    shared-token auth, renders an internal print route → `page.pdf()`), following the
>    hermes-gateway / agent-runner sidecar pattern (§6.3, §12 TR-19..21).
> 5. **Period selector = daily / weekly / monthly AND a user-chosen arbitrary date range
>    (2026-07-30).** Custom ranges are a first-class read across all four grains including
>    export. They are LIVE-COMPUTED and never sealed / never appraisal-admissible / never
>    rollup-persisted (§0053 custom semantics, §5.4, §6.2).
>
> **📌 ARCHITECT DECISIONS in this doc (flag to owner if disputed):**
> - **Migration range is `0050–0055`**, not 0048+ — `0048`/`0049` were consumed by search/meeting
>   work after the briefing was written (verified against `platform-nest/migrations/`).
> - Module key **`reports`**, tables `report_*`, mounted at `/api/:t/reports|checkins|appraisals`
>   (pm-style paths, not `/modules/reports` — this is a platform-wide surface, not a dept vertical).
> - All `report_*` tables sit behind the **third RLS wall** (`app_module_allowed('reports')`),
>   byte-identical to the 0028 HR idiom — appraisal/check-in data is HR-grade sensitive.
> - **Reporting NEEDS the P1-05 outbox→work_activity consumer** (currently NOT built): person-grain
>   completion/reopen facts require dated, append-only evidence. It is ticket TR-05 (§3.4).
> - Server-side XLSX via **`exceljs`** (MIT) in platform-nest — the repo has no XLSX lib anywhere;
>   one new dependency, server-only (OQ-2 to ratify).
> - 0028 has **no working-calendar table** (only leave + attendance) — a new
>   `report_work_calendars` table supplies working-week + holidays; leave/absence still comes from
>   `hr_leave_requests` / `hr_attendance` (§4.1).
> - **Custom-range mechanics (2026-07-30 amendment):** transient custom reads create NO
>   `report_periods` row (computed, returned, forgotten); the explicit **pin** endpoint is the
>   only writer of `period_kind='custom'` rows. Calendar periods keep their exact
>   one-row-per-start uniqueness via a partial unique index (`WHERE period_kind <> 'custom'`);
>   pinned customs dedupe on the exact range instead (two ranges may share a start). Span cap
>   **400 days** → 422 past it — an unbounded user-chosen range is a trivial DoS on the fact scan.

The goal: one coherent **multi-grain work fabric** — individual → project → department → company —
with day-end / weekly / monthly / arbitrary-custom-range reports per person / project /
department / company that are rich,
statistically honest, chart-complete, exportable (PDF/XLSX/CSV), presentable to higher management,
usable for appraisal, and fully reachable by AI/MCP so nothing is redundant or siloed.

---

## 1. Purpose, acceptance bar, non-goals

**Purpose.** Every department and the holding exec get the same answer to "what did this person /
project / department / company actually do in this period?" — computed once, from one atomic fact
grain, rendered through one document contract, sealed for appraisal, exported for presentation, and
queryable by agents over MCP.

**Acceptance bar (program is DEV-VERIFIED when):**
1. The nightly fact job populates `report_work_facts` (person × project × day) idempotently and is
   backfillable over historical dates without duplication.
2. `sum(person-grain) ≤ department-grain == company-grain` holds on live data (unattributed bucket
   explicit; zero double-count) — proven by an automated reconciliation test (TR-29).
3. A department lead opens a weekly department report: KPIs, trends, per-person table, charts —
   all from one `ReportDocument`; the same document exports to PDF (sidecar) and XLSX byte-stable.
4. A person submits the day-end check-in in <30s from prefill; a missed day on an approved-leave or
   holiday date does **not** count against compliance; a genuinely missed day produces a WA
   reminder that evening and a manager escalation next morning.
5. A monthly period seals; a task back-edited after the seal does **not** change any sealed number;
   amendment produces a new revision with reason + audit + notification.
6. A manager completes an appraisal (auto-score inputs + manager scores + mandatory commentary),
   the employee acknowledges or disputes, and the trail is immutable.
7. `reports.getDocument` over MCP returns the identical JSON the web viewer renders.
8. Cross-company shared-service reality holds: a dept of company A serving company B sees its
   served-company work in its dept report via the sanctioned rollup path — and nowhere else.
9. Any grain renders over an arbitrary custom date range (≤400 days): every ratio recomputes as
   Σ numerator / Σ denominator over the range (never a mean of daily values), the artifact
   carries the `AD HOC · UNSEALED` mark on export, and seal / appraisal-generate reject `custom`
   periods with an explicit 422.

**Non-goals (explicit):**
- **Payroll / compensation math** — appraisal outputs a scored, acknowledged record; money is out.
- **Surveillance-grade tracking** — no keystrokes, screenshots, app/URL monitoring, idle timers,
  location, or message-content capture. §11 is binding.
- Leaderboards / public gamification — rejected as hostile for the same reason raw counts are.
- Client-facing report delivery (internal management surface v1; WS11/SM-22 own client reports).
- Real-time presence / live activity feeds beyond what `work_activity` already carries.
- Editing the PM tracker itself — the PM module is substrate; only additive columns/tables touch it.

---

## 2. What already exists vs what is new (the reuse table)

Nobody rebuilds the tracker. The left column is load-bearing, verified substrate; the right column
is the only genuinely new work.

| Substrate (exists — REUSE) | Where | What this program does with it |
|---|---|---|
| Repsona-parity tasks, milestones, custom statuses (`is_done`/`is_blocked` flags), tags, custom fields, burndown, CFD, templates, followers, docs+versions, AI-tracker | `platform-nest/src/modules/pm/pm.controller.ts` (migrations 0018, 0036–0044) | THE tracker. Facts derive from it; done-ness ALWAYS via the effective status set's `is_done` flag, never a literal status id (0040 discipline, everywhere in this design) |
| 4-grain evidence fabric: `work_activity` (source pm\|pipeline\|github\|google_drive\|claude\|manual\|system, `UNIQUE(tenant_id,source,source_ref)`), `work_activity_links` (`target_kind ∈ pm_task\|project\|person\|department`, confidence, rule), `deliverable_evidence` view, auto-linker | `migrations/0030_work_activity.sql`, `src/core/work-activity-linker.ts` | The evidence + collaboration + cross-source measures. Fact job consumes it; TR-05 closes the pm→activity gap (§3.4) |
| Governed metric substrate: `metric_definitions` + `rollup_metrics(module, metric_key, period, numerator, denominator, currency, dimensions jsonb, as_of)`, idempotent upsert, `ratio_of_sums`, per-module `RollupProvider` under its own module scope | `platform-nest/src/rollups/engine.ts` | ALL rollup numbers live here. The `reports` module registers a RollupProvider + ~22 metric seeds (§5). D12: this stays the ONLY cross-company read path — the shared-service provider view rides it |
| Project progress snapshots + status counts, nightly job + lazy upsert-on-read backstop | `0040`/`0042`, `pm/burndown-job.ts` | Project-grain flow/burndown series come straight from snapshots; the lazy-backstop pattern is copied for report reads |
| `time_entries` (user, task, project NOT NULL, minutes, billable, entry_date; `pm_task_id` since 0018) | 0001 + 0018 | Effort measures. Already day-grained — joins the fact grain directly |
| Org tree blob (`company_org_structure`, OrgNode {id, kind, assigneeId, children}) + lazily-anchored `org_units` + `service_assignments` (provider dept serving another company, `lead_user_id`) | 0011, 0026 | Unit identity + the cross-company dept reality. §3.2 adds the missing *time-aware membership*; the blob stays authoritative for structure |
| `projects.department_id text` — free-form org-node id, **NO FK** | 0029 | The convention every new `*_node_id` column follows |
| FE dept↔work routing (poly-assignee unit OR responsible person in subtree), `statusesByProject`, union-by-label board | `platform-ui/src/lib/departments.ts` | Stays for live boards. §3.2 ports the *resolution precedence* server-side + makes it as-of-date for facts |
| `ModuleContract` (+`mcpTools: McpToolDef[]` — name, description, minAssurance, method, pathTemplate, inputSchema, write, impact; hub aggregates via `/mcp/tool-defs`) | `src/modules/pm/index.ts` | New module registers here; MCP tools in §9.2 — never in mcp-hub |
| AI pattern: pure prompt-build + parse, zero I/O, gateway `/complete` via `providers/gateway-client.ts`, NEVER throws, deterministic fallback from grounding facts, AI never picks ids/status | `src/modules/search/ai-drafts.ts` | Report narratives copy it exactly (§9.1) |
| RLS idiom: FORCE RLS off `app_current_tenants()` (0025), third wall `app_module_allowed(<mod>)` (0028 DO-loop), `rls.test.ts` sweep (covers tables WITH a literal `tenant_id`; others need a dedicated test — 0026 header) | 0025/0026/0028 | Every new table follows it (§4); all new tables carry `tenant_id`, so the sweep covers them; dedicated third-wall tests added per 0028 precedent |
| Scheduling: n8n (DEV-VERIFIED, platform→n8n event bridge) + wa-chat-bot 12:00/18:00 digest rails w/ history + run/preview admin surface. platform-nest has NO cron/bullmq | automation/, wa-chat-bot/ | All schedules are n8n flows (§10); reminders/escalations ride bot + n8n. No scheduler dependency added to platform-nest |
| Export/chart reality: ONE client-side CSV export (`DataTable.tsx:78`), ONE hand-rolled inline-SVG chart (`ThroughputSparkline.tsx`). No chart lib, no XLSX, no PDF | platform-ui | Blocker 3. §6.3/§7 build the missing layer: inline-SVG chart kit, exceljs XLSX, Playwright-sidecar PDF |
| `@playwright/test ^1.61.1` (Chromium provisioned for e2e); platform-ui Docker image = Next standalone, NO browser | platform-ui | The sidecar uses the matching Playwright base image; the UI image stays browser-free |
| Cerbos authoritative + `lib/rbac.ts` UI mirror; exec-only-read precedent = rollups page 403 branch | platform | §8 policy matrix; UI capabilities mirrored |
| HR module: `hr_leave_requests` (approved leave), `hr_attendance` (present\|remote\|absent\|leave), third-wall `'hr'` scope | 0028 | Check-in compliance inputs. NOTE: 0028 has **no calendar table** → `report_work_calendars` is new (§4.1). Cross-module reads declare BOTH scopes: `withTenants(t, {modules:['reports','hr']})` |

**New (this program only):** relational task assignees (0050) · as-of org-unit memberships (0051) ·
work calendar + check-ins + daily facts (0052) · period seals + report documents (0053) · appraisal
tables (0054) · metric seeds (0055) · fact job + attribution engine · `ReportDocument` contract +
viewer + chart kit · exports (XLSX/CSV + PDF sidecar) · check-in flow (UI/WA/MCP) · appraisal
engine + UI · AI narrative · 6 MCP tools · 5 n8n flows.

---

## 3. The three blockers — solved first (they gate every downstream number)

### 3.1 Blocker 1 — `pm_tasks.assignee` is a single unindexed JSONB blob

Today: `{kind: person|department|division, refId, refName, responsibleId, responsibleName}`
(FE type `Assignee`, `platform-ui/src/lib/pm.ts:130`). No multi-assignee; a dept-assigned task has
no person; person-grain SQL over JSONB is not trustworthy. **Fix: relational `pm_task_assignees`
(migration 0050) with strict dual-write and read-through compatibility.**

**Roles (closed set):**
- `owner` — exactly ONE per task (partial unique index). The outcome-credit target. May be a
  person **or** a unit (department/division) — mirrors the blob's `kind/refId`.
- `responsible` — at most one, always a **person** — mirrors the blob's `responsibleId` ("the
  person in charge; AI delivers here"). Present even when owner is a unit.
- `contributor` — zero or more persons. NEW capability; listed with logged hours, never
  outcome-credited.

**Migration + compatibility strategy (explicit):**
1. **0050 creates the table and backfills** from the JSONB in one pass: for each `pm_tasks` row
   with a non-null blob → insert `owner` row (`assignee_kind`/`assignee_ref` from `kind`/`refId`)
   + `responsible` row when `responsibleId` differs from a person-owner's ref.
   `ON CONFLICT DO NOTHING` → the backfill is idempotent and re-runnable.
2. **Dual-write (phase A, code):** every PM write path that sets/updates the assignee blob
   (`POST/PATCH /api/:t/pm/tasks*`, duplicate, templates-apply) writes the blob **and** upserts the
   rows in the same transaction. The blob remains authoritative for FE reads — the FE `Assignee`
   type and every existing endpoint response are **byte-unchanged**.
3. **Read-through:** task GET responses keep serving the blob; a NEW additive optional field
   `contributors: {userId, name}[]` appears on task reads and is accepted on
   `PATCH` (`addContributor`/`removeContributor` ops, same op-style as `addSubtask`). Old FE
   builds ignore it; nothing breaks.
4. **Reporting reads ONLY the table.** No report SQL ever parses the blob.
5. **Drift guard:** the nightly fact job (TR-07) cross-checks blob↔rows per tenant (count +
   sampled field compare) and logs a `reports.assignee_drift` warning metric — dual-write bugs
   surface within a day, not at appraisal time.
6. **Authority flip (deferred, explicitly out of v1):** once drift is zero for a full period, a
   later program may derive the blob from the rows. Not in scope here.

**Attribution rules (locked decision applied — owner-takes-all, no double-count):**

Every completed task resolves, per fact date, to **at most one attributed person** and **exactly
one attributed unit** (or the explicit `unattributed` bucket):

| Case | Person credit (person grain) | Unit credit (dept grain) |
|---|---|---|
| Owner = person | the owner | owner's primary unit as-of the completion date; else `projects.department_id`; else unattributed |
| Owner = department/division, responsible set | the **responsible** person (they are "the person in charge" — a unit cannot ship work; crediting the responsible keeps person-grain truthful without inventing splits) | the owner unit itself (NOT the responsible's home unit — the dept owns the outcome) |
| Owner = unit, no responsible | none (person grain simply excludes it) | the owner unit |
| No assignee at all | none | `projects.department_id`; else unattributed |

- **Contributors never receive outcome credit** — they appear in reports as "contributed N h"
  (their `time_entries` minutes on the task) and feed the collaboration axis only.
- Company totals are computed at the **unit axis** (every task counted exactly once:
  Σ units + unattributed = company). Person-grain totals are a ≤-subset by construction — the
  reconciliation test (TR-29) pins both identities.
- Divisions roll up to their ancestor **department** via the org-blob path; facts store both
  `unit_node_id` (exact) and `department_node_id` (rolled) so both slices are additive.

### 3.2 Blocker 2 — no department on tasks/time; dept resolution is FE-only and not time-aware

**Fix: server-side, as-of-date resolution off a new `org_unit_memberships` table (0051).**

- One row per (person, unit) validity interval: `valid_from`/`valid_to date` (`NULL` = current),
  `is_primary` (exactly one open primary per person — a person who transfers departments gets the
  old row **closed** (`valid_to` set) and a new row **opened**; **history is never rewritten**, so
  July's facts keep resolving to July's department forever).
- `unit_node_id text` — free-form org-node id, **no FK** (0029 convention; org-node ids are not a
  table). `org_units` (0026) remains the lazy anchor for names/kinds.
- **Sweeper:** on every `PUT /api/:t/org-structure` and nightly (same n8n fact flow), diff the
  blob's person placements against open memberships → close/open rows dated **today**. The blob
  stays the structure authority; memberships are its time-aware shadow.
- **Initial backfill:** open a membership per currently-placed person with
  `valid_from = LEAST(company.created_at::date, first work_activity date)` — a documented one-time
  approximation (pre-adoption history resolves to the *current* unit). Amendable by manual rows;
  called out in §13.
- **Overlap guard:** btree_gist `EXCLUDE` on
  `(tenant_id =, user_id =, daterange(valid_from, coalesce(valid_to,'9999-12-31'),'[]') &&) WHERE is_primary`
  — DB-enforced non-overlap. Minimum fallback if the extension is refused: partial unique
  `(tenant_id, user_id) WHERE valid_to IS NULL AND is_primary` + app-side interval check +
  dedicated test. **Recommendation: install btree_gist (stock contrib); the fallback leaves
  historical overlaps app-guarded only.**
- **Server resolution precedence** (ports `lib/departments.ts`, adds the as-of axis) — for a task
  fact on date D: ① owner-unit assignee → that unit · ② else responsible/owner person's primary
  membership **as of D** · ③ else `projects.department_id` · ④ else `unattributed`.
  The FE library stays for live boards (today-grain); reports never call it.
- **Cross-company shared services:** facts are written in the **project's tenant** (data never
  re-homes — HR/0026 precedent). When the acting person's as-of primary membership lives in a
  *different* company with an **active `service_assignment`** covering the served tenant, the fact
  row is stamped `provider_tenant_id` + `provider_unit_node_id`. The provider dept's own report
  ("dept of company A incl. work done for B") reads through the **rollup engine** with dimensions
  `{unit, servedTenant}` — the D12-sanctioned, ONLY cross-company read path. No new cross-tenant
  read is introduced.

### 3.3 Blocker 3 — no chart layer, no XLSX, no PDF

Resolved by design in §6.3 (exports) + §7 (inline-SVG chart kit): zero-CDN charts as first-class
components; `exceljs` server-side XLSX; the locked `report-renderer` Playwright sidecar for PDF.
The existing client CSV export (`DataTable.tsx`) stays for ad-hoc grids; report exports are
server-side so PDF/XLSX/CSV all render from the same sealed `ReportDocument`.

### 3.4 The P1-05 outbox consumer — reporting NEEDS it (verdict)

Activity ingest is currently **synchronous-API only**; the outbox→`work_activity` consumer was
never built. Verdict: **required (ticket TR-05).** Person-grain delivery facts (completed,
reopened, status-entered/exited) need a **dated, append-only** record; deriving them from mutable
`pm_tasks` state cannot be recomputed or backfilled honestly. The consumer subscribes to the
existing event backbone (`src/events/`, the same relay the n8n bridge uses), maps pm domain events
(status change → `verb: completed|reopened|status_changed` keyed by the `is_done` flag, task
create/assign, doc update, comment) into `work_activity` via the existing ingest service —
`UNIQUE(tenant_id, source='pm', source_ref=event id)` makes delivery idempotent, exactly what the
at-least-once backbone requires. **Limitation stated plainly:** pm events emitted before TR-05
lands were relayed and gone — person-grain completion history starts at TR-05 go-live (project
grain has 0040/0042 snapshots for backfill). Appraisal cycles begin after go-live anyway; the
first sealed month is the first trustworthy month.

---

## 4. Schema — new tables, full DDL (migrations 0050–0055)

Conventions applied to every table: `tenant_id uuid NOT NULL REFERENCES companies(id)` · FORCE RLS
· policy composed from `app_current_tenants()` (+ `app_module_allowed('reports')` for `report_*`
tables, byte-identical DO-loop per 0028) · `origin_site text NOT NULL DEFAULT 'central'` ·
`*_node_id text` columns carry org-node ids with **no FK** (0029) · timestamps · runtime DML
grants via the owner's `ALTER DEFAULT PRIVILEGES` + external `RUNTIME_GRANTS_SQL` pass (0028
header) — no in-migration GRANTs. Every table has a literal `tenant_id`, so the `rls.test.ts`
FORCE-RLS sweep covers all of them; the third wall additionally gets its own dedicated
scope-declaration test per the 0028 precedent (right-tenant WITHOUT `reports` scope → zero rows).

### 0050 — `pm_task_assignees` (PM substrate; plain tenant policy like other `pm_*` tables)

```sql
-- 0050_pm_task_assignees.sql — Blocker 1: relational assignees beside the JSONB blob (dual-write).
CREATE TABLE pm_task_assignees (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES companies(id),
  task_id       uuid NOT NULL REFERENCES pm_tasks(id) ON DELETE CASCADE,
  role          text NOT NULL CHECK (role IN ('owner','responsible','contributor')),
  assignee_kind text NOT NULL CHECK (assignee_kind IN ('person','department','division')),
  assignee_ref  text NOT NULL,                 -- user_id when person; org-node id when unit (NO FK)
  user_id       uuid REFERENCES users(id),     -- resolved person (NULL for unit rows)
  created_by    uuid REFERENCES users(id),
  origin_site   text NOT NULL DEFAULT 'central',
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ( (assignee_kind = 'person') = (user_id IS NOT NULL) ),
  CHECK ( role IN ('responsible','contributor')  -- responsible/contributor are always persons
          IS NOT TRUE OR assignee_kind = 'person' ),
  UNIQUE (tenant_id, task_id, role, assignee_kind, assignee_ref)
);
CREATE UNIQUE INDEX ux_pm_task_assignees_one_owner
  ON pm_task_assignees (tenant_id, task_id) WHERE role = 'owner';
CREATE UNIQUE INDEX ux_pm_task_assignees_one_responsible
  ON pm_task_assignees (tenant_id, task_id) WHERE role = 'responsible';
CREATE INDEX ix_pm_task_assignees_person ON pm_task_assignees (tenant_id, user_id, role);
CREATE INDEX ix_pm_task_assignees_unit   ON pm_task_assignees (tenant_id, assignee_ref)
  WHERE assignee_kind <> 'person';
-- FORCE RLS + tenant_isolation policy off app_current_tenants() (0025 idiom, same as pm_* tables).
-- Backfill from pm_tasks.assignee JSONB (owner + responsible rows), ON CONFLICT DO NOTHING.
```

### 0051 — `org_unit_memberships` (org core; plain tenant policy like `org_units`)

```sql
-- 0051_org_unit_memberships.sql — Blocker 2: time-aware person↔unit membership (as-of resolution).
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE TABLE org_unit_memberships (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES companies(id),
  user_id      uuid NOT NULL REFERENCES users(id),
  unit_node_id text NOT NULL,                  -- org-node id (NO FK, 0029 convention)
  is_primary   boolean NOT NULL DEFAULT true,
  valid_from   date NOT NULL,
  valid_to     date,                            -- NULL = open/current
  source       text NOT NULL DEFAULT 'org_blob' CHECK (source IN ('org_blob','manual','backfill')),
  origin_site  text NOT NULL DEFAULT 'central',
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT org_unit_memberships_no_overlap EXCLUDE USING gist (
    tenant_id WITH =, user_id WITH =,
    daterange(valid_from, COALESCE(valid_to, '9999-12-31'::date), '[]') WITH &&
  ) WHERE (is_primary)
);
CREATE INDEX ix_oum_asof ON org_unit_memberships (tenant_id, user_id, valid_from, valid_to);
CREATE INDEX ix_oum_unit ON org_unit_memberships (tenant_id, unit_node_id) WHERE valid_to IS NULL;
-- FORCE RLS + tenant_isolation (app_current_tenants()). Backfill: one open primary row per person
-- currently placed in the org blob, valid_from = least(company.created_at::date, first evidence).
```

### 0052 — `report_work_calendars`, `report_checkins`, `report_work_facts` (third wall `'reports'`)

```sql
-- 0052_module_reports_core.sql — calendar, mandatory check-ins, the atomic fact grain.
CREATE TABLE report_work_calendars (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES companies(id),
  working_days int[] NOT NULL DEFAULT '{1,2,3,4,5}',   -- ISO dow, Mon=1
  holidays     jsonb NOT NULL DEFAULT '[]',            -- [{date:'2026-08-17', label:'Independence Day'}]
  workday_minutes int NOT NULL DEFAULT 480,            -- matches hr leave day=480 convention
  updated_by   uuid REFERENCES users(id),
  origin_site  text NOT NULL DEFAULT 'central',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id)                                   -- one per tenant v1; per-unit deferred (§13)
);

CREATE TABLE report_checkins (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES companies(id),
  user_id      uuid NOT NULL REFERENCES users(id),
  checkin_date date NOT NULL,
  status       text NOT NULL CHECK (status IN ('submitted','auto_missed','excused')),
  summary      text NOT NULL DEFAULT '',      -- person-edited; required non-empty when submitted
  blockers     text,
  prefill      jsonb NOT NULL DEFAULT '{}',   -- the derived draft shown (audit: what was prefilled)
  edited       boolean NOT NULL DEFAULT false,-- did the person change the prefill before submit
  source       text NOT NULL DEFAULT 'ui' CHECK (source IN ('ui','wa','mcp','system')),
  submitted_at timestamptz,
  excused_reason text,                        -- set by manager/HR on 'excused'
  excused_by   uuid REFERENCES users(id),
  origin_site  text NOT NULL DEFAULT 'central',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, checkin_date)
);
CREATE INDEX ix_report_checkins_day ON report_checkins (tenant_id, checkin_date, status);

CREATE TABLE report_work_facts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES companies(id),
  fact_date             date NOT NULL,
  user_id               uuid REFERENCES users(id),      -- NULL = unit-attributed only (§3.1)
  project_id            uuid REFERENCES projects(id),   -- NULL = non-project work
  unit_node_id          text,                           -- exact as-of unit (NO FK)
  department_node_id    text,                           -- division rolled to department (NO FK)
  provider_tenant_id    uuid REFERENCES companies(id),  -- shared-service stamp (§3.2)
  provider_unit_node_id text,
  -- additive measures ONLY; ratios are NEVER stored here (numerator/denominator live in rollups)
  tasks_completed            int NOT NULL DEFAULT 0,
  tasks_completed_on_time    int NOT NULL DEFAULT 0,
  tasks_completed_estimated  int NOT NULL DEFAULT 0,    -- completed tasks that carried an estimate
  estimate_minutes_completed int NOT NULL DEFAULT 0,    -- Σ estimates of completed (anti-slicing weight)
  tasks_reopened             int NOT NULL DEFAULT 0,
  tasks_created              int NOT NULL DEFAULT 0,
  minutes_logged             int NOT NULL DEFAULT 0,
  minutes_billable           int NOT NULL DEFAULT 0,
  minutes_contributed        int NOT NULL DEFAULT 0,    -- contributor-role minutes (collab axis)
  comments_authored          int NOT NULL DEFAULT 0,
  docs_updated               int NOT NULL DEFAULT 0,
  activity_events            int NOT NULL DEFAULT 0,
  activity_linked_exact      int NOT NULL DEFAULT 0,    -- work_activity_links confidence='exact'
  activity_by_source         jsonb NOT NULL DEFAULT '{}',-- {"pm":4,"github":7,...}
  computed_at  timestamptz NOT NULL DEFAULT now(),
  job_run_id   uuid,                                     -- which fact-job run wrote this row
  origin_site  text NOT NULL DEFAULT 'central',
  UNIQUE NULLS NOT DISTINCT (tenant_id, fact_date, user_id, project_id, unit_node_id)
);
CREATE INDEX ix_rwf_person ON report_work_facts (tenant_id, user_id, fact_date);
CREATE INDEX ix_rwf_project ON report_work_facts (tenant_id, project_id, fact_date);
CREATE INDEX ix_rwf_dept ON report_work_facts (tenant_id, department_node_id, fact_date);
CREATE INDEX ix_rwf_provider ON report_work_facts (provider_tenant_id, provider_unit_node_id, fact_date)
  WHERE provider_tenant_id IS NOT NULL;
-- DO-loop: FORCE RLS + composed policy tenant_id = ANY(app_current_tenants())
--          AND app_module_allowed('reports')  — byte-identical to 0028's wall.
```

`UNIQUE NULLS NOT DISTINCT` (PG15+; stack runs newer) makes the daily upsert idempotent even for
NULL user/project rows. The fact job recomputes a `(tenant, fact_date)` slice as
DELETE-then-INSERT in one transaction — deterministic re-derivation from append-only substrate
(`work_activity`, `time_entries`, `report_checkins`, snapshots), which is what makes **backfill
safe** over historical dates. On-time flags join `pm_tasks.due_date` at compute time (mutable —
acceptable for ops; the seal freezes it for appraisal).

### 0053 — `report_periods`, `report_documents` (third wall)

```sql
-- 0053_report_periods_documents.sql — sealing + the stored ReportDocument.
CREATE TABLE report_periods (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES companies(id),
  period_kind  text NOT NULL CHECK (period_kind IN ('day','week','month')),
  period_start date NOT NULL,
  period_end   date NOT NULL CHECK (period_end >= period_start),
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open','sealed','amended')),
  revision     int  NOT NULL DEFAULT 0,        -- bumps on every re-seal after amend
  sealed_at    timestamptz,
  sealed_by    uuid REFERENCES users(id),      -- NULL when sealed by the n8n schedule (system)
  amend_reason text,                           -- last amendment reason (full trail in audit events)
  seal_hash    text,                           -- sha256 over the period's document set (tamper check)
  origin_site  text NOT NULL DEFAULT 'central',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, period_kind, period_start)
);

CREATE TABLE report_documents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES companies(id),
  period_id    uuid NOT NULL REFERENCES report_periods(id) ON DELETE CASCADE,
  revision     int  NOT NULL,                  -- pins the seal revision it belongs to
  grain        text NOT NULL CHECK (grain IN ('person','project','department','company')),
  scope_ref    text NOT NULL,                  -- user_id | project_id | dept node id | tenant id
  document     jsonb NOT NULL,                 -- the full ReportDocument (§6.1)
  narrative_source text NOT NULL DEFAULT 'deterministic'
    CHECK (narrative_source IN ('ai','deterministic')),
  origin_site  text NOT NULL DEFAULT 'central',
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, period_id, revision, grain, scope_ref)
);
CREATE INDEX ix_report_documents_scope ON report_documents (tenant_id, grain, scope_ref, created_at DESC);
-- Same third-wall DO-loop as 0052. Sealed rows are IMMUTABLE by convention: no UPDATE path exists
-- in the service; amendment writes a NEW revision. (Enforcing immutability via a trigger is
-- deliberately skipped v1 — the service is the only writer; revisit if a second writer appears.)
```

**Seal semantics (§ invariant 3):** *ops reads recompute live; management + appraisal reads come
from the sealed snapshot.* Sealing a period = recompute facts for the range → build one
`ReportDocument` per in-scope (grain, scope) → insert `report_documents` rows at the current
revision → flip `report_periods.status='sealed'` + `seal_hash` → upsert the period's metrics into
`rollup_metrics` (idempotent on `(tenant, module, metric_key, period, dimensions)`) → emit
`reports.period.sealed` on the outbox. A task back-edited afterwards changes live/ops views only.
**Amend:** `POST …/amend {reason}` (elevated) → status `amended`, audit event + notification to
exec/leads → explicit re-seal writes revision+1 alongside the old rows (nothing deleted). Any
appraisal referencing the amended revision is flagged `evidence_stale` and requires manager
re-confirm (§4.5) — an appraisal number can never drift silently.

### 0054 — appraisal tables (third wall)

```sql
-- 0054_report_appraisals.sql — blended, manager-weighted appraisal + acknowledgement trail.
CREATE TABLE report_appraisal_cycles (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES companies(id),
  name         text NOT NULL,
  period_start date NOT NULL,
  period_end   date NOT NULL CHECK (period_end >= period_start),
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','open','in_review','closed')),
  default_weights jsonb NOT NULL DEFAULT
    '{"delivery":0.35,"quality":0.30,"effort":0.10,"collaboration":0.25}',
  role_weights jsonb NOT NULL DEFAULT '{}',    -- {"senior_dev":{"delivery":0.40,...}, ...}
  created_by   uuid NOT NULL REFERENCES users(id),
  origin_site  text NOT NULL DEFAULT 'central',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE report_appraisals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES companies(id),
  cycle_id        uuid NOT NULL REFERENCES report_appraisal_cycles(id) ON DELETE CASCADE,
  subject_user_id uuid NOT NULL REFERENCES users(id),
  manager_user_id uuid NOT NULL REFERENCES users(id),
  role_key        text,                        -- picks the weight set; NULL = cycle defaults
  weights         jsonb NOT NULL,              -- resolved weights frozen at pack generation
  auto_inputs     jsonb NOT NULL DEFAULT '{}', -- appraisal-safe metric values + cohort bands (frozen)
  scores          jsonb NOT NULL DEFAULT '{}', -- {delivery:{auto:3,manager:4,note:"..."}, ...}
  composite       numeric(4,2),                -- Σ weight·manager-score, computed at submit
  commentary      text,                        -- MANDATORY: non-empty enforced at submit (CHECK below)
  evidence        jsonb NOT NULL DEFAULT '{}', -- {periodIds:[...], revisions:{...}, stale:false}
  status          text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','submitted','acknowledged','disputed','finalized')),
  submitted_at    timestamptz,
  finalized_at    timestamptz,
  origin_site     text NOT NULL DEFAULT 'central',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (status = 'draft' OR (commentary IS NOT NULL AND length(btrim(commentary)) >= 50)),
  UNIQUE (tenant_id, cycle_id, subject_user_id)
);

CREATE TABLE report_appraisal_acks (      -- append-only employee trail; no UPDATE/DELETE path
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES companies(id),
  appraisal_id uuid NOT NULL REFERENCES report_appraisals(id) ON DELETE CASCADE,
  actor_user_id uuid NOT NULL REFERENCES users(id),
  action       text NOT NULL CHECK (action IN ('acknowledged','disputed','comment','reopened','finalized')),
  comment      text,
  origin_site  text NOT NULL DEFAULT 'central',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_appraisal_acks ON report_appraisal_acks (tenant_id, appraisal_id, created_at);
-- Same third-wall DO-loop.
```

### 0055 — metric seeds

`INSERT ... ON CONFLICT DO NOTHING` into `metric_definitions` for the §5 registry (module
`reports`, `aggregation_rule` per row — sums and `ratio_of_sums` only). Appraisal-safety is **not**
a `metric_definitions` column (no altering shared substrate): it lives in the module's TS catalog
(`src/modules/reports/metrics.ts`), the single source that both seeds 0055 and drives
`ReportKpi.appraisalSafe`.

---

## 4a. Architecture invariants (specify + defend)

1. **ONE atomic fact grain: `person × project × day`** (`report_work_facts`). Department, company,
   week, month are **additive rollups** of it — never separately computed. Anything that cannot be
   expressed as a sum over the atomic grain is either a ratio (below) or doesn't ship.
2. **Ratios are numerator/denominator, always.** Stored in `rollup_metrics(numerator, denominator)`
   with `ratio_of_sums`; carried in `ReportKpi{numerator, denominator}`; rendered as `n/d` at the
   last moment. Never average-of-averages, never a pre-divided percent in storage. A week's
   on-time rate = Σ on-time / Σ completed over 7 days — not the mean of 7 daily rates.
3. **ONE typed `ReportDocument`** (§6.1) consumed by the web viewer, the PDF print route, the XLSX
   exporter, the AI narrative prompt AND the MCP tools. There is no second rendering path — the PDF
   is the print route rendering the *same* React viewer components.
4. **Ops reads recompute live; management + appraisal reads are sealed** (§ 0053 above). Sealing,
   amendment, and audit are first-class; appraisals pin `(period_id, revision)`.
5. **Backfill + idempotency:** the fact job is `(tenant, date)`-sliced DELETE+INSERT in one
   transaction over append-only inputs; re-running any slice any number of times converges.
   `job_run_id` makes every row traceable to the run that wrote it.
6. **Done-ness is the `is_done` flag** of the project's effective status set — never a literal
   status id (0040 discipline). Blocked-ness likewise via `is_blocked`.
7. **Module scopes are declared, not assumed:** report computation runs under
   `withTenants(tenants, {modules:['reports','pm','hr']})` — the third wall stays fail-closed and
   every cross-module read is visible in code.

---

## 5. The metric registry (~22 metrics)

All seeded as `metric_definitions` rows (module `reports`), computed by the module's
`RollupProvider` from `report_work_facts` (+ snapshots + check-ins), upserted idempotently into
`rollup_metrics` with `dimensions` per grain. Grains: **P**erson `{userId}` · **J** project
`{projectId}` · **D** department `{unit}` (+ `{unit, servedTenant}` provider view) · **C** company
`{}`. Periods: day/week/month.

**⚠ appraisal-unsafe** = never appears in an appraisal pack or feeds an auto-score; ops/context
only. Rationale in §5.2.

| # | metric_key | Axis | Unit | Rule | Numerator / Denominator | Grains | Appraisal |
|---|---|---|---|---|---|---|---|
| 1 | `delivery.throughput_weighted` | delivery | minutes | sum | Σ `estimate_minutes_completed` / — | P J D C | ✅ safe (anti-slicing weight) |
| 2 | `delivery.tasks_completed` | delivery | count | sum | Σ `tasks_completed` / — | P J D C | ⚠ unsafe (raw count → rewards slicing) |
| 3 | `delivery.on_time_rate` | delivery | percent | ratio_of_sums | Σ on-time / Σ completed-with-due-date | P J D C | ✅ safe |
| 4 | `delivery.estimate_coverage` | delivery | percent | ratio_of_sums | Σ completed-estimated / Σ completed | P J D C | ✅ safe (hygiene: estimate your work) |
| 5 | `delivery.milestone_hit_rate` | delivery | percent | ratio_of_sums | milestones done ≤ due / milestones due | J D C | ✅ safe (project/lead level) |
| 6 | `delivery.backlog_delta` | delivery | count | sum | Σ (`tasks_created` − `tasks_completed`) / — | J D C | ⚠ unsafe (not person-attributable) |
| 7 | `flow.wip_open_avg` | flow | count | ratio_of_sums | Σ daily open (snapshots) / Σ days | J D C | ⚠ unsafe (context) |
| 8 | `flow.blocked_share` | flow | percent | ratio_of_sums | Σ daily blocked-status count / Σ daily open | J D C | ⚠ unsafe (blocked is often external) |
| 9 | `flow.reopen_rate` | quality | percent | ratio_of_sums | Σ `tasks_reopened` / Σ `tasks_completed` | P J D C | ✅ safe (quality proxy; owner-attributed) |
| 10 | `flow.avg_progress` | flow | percent | ratio_of_sums | Σ progress·open / Σ open (snapshots) | J | ⚠ unsafe (self-reported progress) |
| 11 | `effort.minutes_logged` | effort | minutes | sum | Σ `minutes_logged` / — | P J D C | ⚠ unsafe alone (hours ≠ value; §5.2) |
| 12 | `effort.billable_share` | effort | percent | ratio_of_sums | Σ billable / Σ logged | P J D C | ✅ safe at D/C; ⚠ caution at P |
| 13 | `effort.estimate_accuracy` | effort | percent | ratio_of_sums | Σ estimates (completed w/ both) / Σ actual minutes | P J D | ✅ safe w/ band display (±25% is "good", not 100%) |
| 14 | `effort.capacity_utilization` | effort | percent | ratio_of_sums | Σ logged / Σ expected calendar minutes | P D C | ⚠ unsafe (presence proxy — ops capacity planning only) |
| 15 | `collab.contributed_minutes` | collaboration | minutes | sum | Σ `minutes_contributed` / — | P D C | ✅ safe (credited help on others' tasks) |
| 16 | `collab.comments_authored` | collaboration | count | sum | Σ `comments_authored` / — | P J D | ⚠ unsafe (chatter is gameable) |
| 17 | `collab.docs_updated` | collaboration | count | sum | Σ `docs_updated` / — | P J D | ⚠ unsafe raw; pack shows cohort band only |
| 18 | `discipline.checkin_compliance` | discipline | percent | ratio_of_sums | Σ submitted / Σ expected (calendar+leave-aware) | P D C | ✅ safe (it measures the discipline itself) |
| 19 | `discipline.time_logging_coverage` | discipline | percent | ratio_of_sums | Σ days with ≥1 entry / Σ expected working days | P D C | ✅ safe (hygiene, not volume) |
| 20 | `discipline.overdue_open` | discipline | count | sum | Σ open tasks past due at as_of / — | P J D C | ⚠ unsafe raw (load-dependent); pack shows trend only |
| 21 | `evidence.link_rate` | evidence | percent | ratio_of_sums | Σ `activity_linked_exact` / Σ `activity_events` | P D C | ⚠ unsafe (measures the linker, not the person) |
| 22 | `evidence.source_diversity` | evidence | count | sum (max-agg in doc) | distinct active sources per period / — | P D C | ⚠ unsafe (context: where evidence comes from) |

Nine appraisal-safe metrics feed the four appraisal axes; the other thirteen exist for ops truth
and report richness. `currency` is unused (no money metrics — payroll is a non-goal).

### 5.2 Anti-gaming design (explicit, per locked decision 3)

The threat model: any single raw metric, once tied to appraisal, gets optimized *as a metric*.
Defenses, in order of load-bearing-ness:

1. **Estimate-weighted throughput, not task counts** (#1 vs #2). Slicing one 8h task into ten 48min
   tasks yields the same Σ estimate. Self-inflated estimates are counter-checked by
   `estimate_accuracy` (#13) — pad estimates and your accuracy band degrades visibly.
2. **Every appraisal-safe rate carries its denominator** in the pack (`ReportKpi.numerator/
   denominator`) — a 100% on-time rate over 2 tasks reads as what it is.
3. **Cohort banding, not absolute scores:** `auto_inputs` maps each safe metric to a 1–5 band by
   percentile *within the same role cohort and cycle* — cross-role comparison (designer vs backend)
   is structurally impossible, and inflating a metric only moves you within your cohort's
   distribution, which the whole cohort sees pressure on. **Small-cohort guard:** bands are
   computed only when the cohort has **≥5 members** in the cycle; below that, the pack shows the
   raw safe metrics with denominators and NO band — a percentile over three people is noise that
   reads as a ranking, which is exactly the hostile pattern the lock forbids. (TR-24 enforces this
   in the engine, not the UI.)
4. **Manager judgment is the score; auto is an input.** Manager sets each axis 1–5; deviating more
   than ±1 band from auto requires a written justification (enforced server-side). Mandatory
   commentary ≥50 chars total. This is the "blended, manager-weighted" lock — numbers inform,
   humans decide, and the decision is accountable in writing.
5. **Effort has the lowest default weight (0.10)** and `minutes_logged` alone is appraisal-unsafe:
   hours are the most gameable and most surveillance-adjacent number in the system. Effort's safe
   inputs are hygiene (logging coverage) and estimate honesty — not volume.
6. **Collaboration counts (comments/docs) are unsafe raw**; the collaboration axis is fed by
   credited contributor minutes (#15 — someone else's task, real logged time) + cohort bands.
7. **Acknowledgement trail:** the subject sees the SAME pack the manager sees (§11), and
   `disputed` is a first-class status routed to HR — gaming *by managers* has a counterparty.
8. **Sealing:** scores are computed against a pinned `(period, revision)` — retro-editing tasks
   after the period cannot move an appraisal number (§0053).

### 5.3 Check-in compliance — the false-negative guard (locked decision 2)

`expected(user, date) = working-day(tenant calendar) ∧ ¬holiday ∧ ¬approved-leave
(hr_leave_requests status='approved' covering date) ∧ ¬hr_attendance(status ∈ leave|absent) ∧
open membership exists (employment active)`. The nightly job writes `auto_missed` rows **only**
for expected days (so compliance is a real queryable entity, not derived-only) and never for
non-expected days. Managers/HR can flip a missed day to `excused` with a reason (audited). The
compliance metric (#18) divides by Σ expected — a person on approved leave for half the month
loses nothing. Computation declares `{modules:['reports','hr']}` — the HR third wall stays intact.

---

## 6. The `ReportDocument` contract + endpoint surface

### 6.1 The one typed document (canonical TS — will live in `platform-ui/src/lib/reports.ts` and mirror in `src/modules/reports/report-document.ts`)

```ts
export type ReportGrain = "person" | "project" | "department" | "company";
export type ReportPeriodKind = "day" | "week" | "month";
export type ReportUnit = "count" | "minutes" | "percent" | "score" | "text";

export interface ReportHeader {
  tenantId: string;
  grain: ReportGrain;
  scopeRef: string;            // userId | projectId | dept node id | tenantId
  scopeName: string;           // display name resolved at build time
  periodKind: ReportPeriodKind;
  periodStart: string;         // ISO date (inclusive)
  periodEnd: string;           // ISO date (inclusive)
  generatedAt: string;         // ISO datetime
  sealed: boolean;
  periodId?: string;           // present when sealed
  revision?: number;           // present when sealed
  comparison?: { periodStart: string; periodEnd: string }; // prior period for deltas
  providerView?: { servedTenantId: string; servedTenantName: string }; // shared-service slice
}

export interface ReportKpi {
  metricKey: string;           // registry key (§5)
  label: string;
  unit: ReportUnit;
  value: number;               // for ratios: numerator/denominator, computed at build
  numerator?: number;          // ALWAYS present for ratio metrics (invariant 2)
  denominator?: number;
  delta?: number;              // vs comparison period, same unit (percent-point for ratios)
  direction?: "up_good" | "down_good" | "neutral";
  appraisalSafe: boolean;
}

export interface ReportSeriesPoint { t: string; v: number | null } // t = ISO date; null = no data (never 0-faked)

export interface ReportSeries {
  key: string; label: string; unit: ReportUnit;
  kind: "line" | "bar" | "area";
  points: ReportSeriesPoint[];
  numeratorKey?: string;       // ratio series carry both raw series keys for honest tooltips
  denominatorKey?: string;
}

export interface ReportDistribution {
  key: string; label: string;
  kind: "donut" | "bar" | "stacked";
  slices: { label: string; value: number; ref?: { kind: "project" | "person" | "unit" | "tag" | "status"; id: string } }[];
}

export interface ReportTable {
  key: string; label: string;
  columns: { key: string; label: string; unit?: ReportUnit; align?: "left" | "right" }[];
  rows: Record<string, string | number | null>[];
  totalRow?: Record<string, string | number | null>;
}

export interface ReportHighlight {
  kind: "achievement" | "risk" | "anomaly" | "compliance";
  text: string;                // deterministic, template-built from facts (never AI)
  refs?: { kind: "task" | "project" | "person" | "unit"; id: string; label: string }[];
}

export interface ReportNarrative {
  source: "ai" | "deterministic";
  text: string;                // prose ABOUT the numbers; numbers themselves come from kpis/series
  model?: string;              // gateway model id when source="ai"
  groundingHash?: string;      // sha256 of the fact payload the prompt was built from
}

export interface ReportDocument {
  header: ReportHeader;
  kpis: ReportKpi[];
  series: ReportSeries[];
  distributions: ReportDistribution[];
  tables: ReportTable[];
  highlights: ReportHighlight[];
  narrative: ReportNarrative;
}
```

Consumers (all four, one document, no second path): web viewer (§7) · PDF print route (same React
components) · XLSX/CSV exporter (kpis + tables + series sheets, numerator/denominator columns
included) · AI narrative prompt (§9.1) · MCP `reports.getDocument` (returns this JSON verbatim).

### 6.2 Endpoint surface (NestJS route conventions: `@Controller("api/:tenantId/…")`)

**Reports — `reports.controller.ts`:**

| Method + path | Purpose | Authz (§8) |
|---|---|---|
| `GET /api/:t/reports/document?grain&scopeRef&periodKind&start` | THE read. Sealed period → stored document (latest revision, `?revision=` to pin); open period → live compute (lazy-backstop pattern) | per-grain matrix |
| `GET /api/:t/reports/overview?grain&periodKind` | list of scopes + headline KPIs for the grain (console landing) | per-grain matrix |
| `GET /api/:t/reports/periods?kind&from&to` · `GET …/periods/:id` | seal states + revisions | view |
| `POST /api/:t/reports/periods/:id/seal` | explicit seal (idempotent; 409 if sealed) | `reports.seal` (exec/lead) |
| `POST /api/:t/reports/periods/:id/amend {reason}` | flag amended + audit + notify; re-seal via `/seal` → revision+1 | `reports.seal` |
| `POST /api/:t/reports/export {grain, scopeRef, periodKind, start, format: "pdf"\|"xlsx"\|"csv"}` | creates export job → `{jobId}`; `GET …/exports/:jobId` → status + download. PDF via sidecar (§6.3) | same as document read |
| `POST /api/:t/reports/facts/recompute {from, to}` | idempotent backfill window (admin/ops) | `reports.admin` |
| `GET /api/:t/reports/metrics?metricKey&grain&from&to` | raw rollup series (power users/MCP) | per-grain matrix |

**Check-ins — `checkins.controller.ts`:**

| Method + path | Purpose | Authz |
|---|---|---|
| `GET /api/:t/checkins/today` | `{expected, alreadySubmitted, draft}` — draft prefilled live from today's activity/time (<30s flow) | self |
| `POST /api/:t/checkins {date?, summary, blockers?}` | submit/confirm (today or yesterday-until-cutoff); records `edited`, `source` | self |
| `GET /api/:t/checkins?userId&from&to` | history (self; manager for own unit; HR) | matrix |
| `GET /api/:t/checkins/compliance?unit&periodKind&start` | compliance grid (expected/submitted/missed/excused) | lead/exec/HR |
| `POST /api/:t/checkins/:id/excuse {reason}` | manager/HR excuse (audited) | lead/HR |
| `GET /api/:t/checkins/pending-reminders?date` | internal for n8n: expected-but-missing list (+ WA identity link presence) | service/admin |

**Appraisals — `appraisals.controller.ts`:**

| Method + path | Purpose | Authz |
|---|---|---|
| `GET/POST /api/:t/appraisals/cycles` · `GET/PATCH …/:id` | cycle CRUD (weights, role weights, open/close) | HR-appraisal |
| `POST /api/:t/appraisals/cycles/:id/generate` | generate per-subject appraisals: freeze weights + `auto_inputs` from SEALED periods covering the cycle range (409 if unsealed) | HR-appraisal |
| `GET /api/:t/appraisals?cycleId&subjectId` · `GET …/:id` | pack read: appraisal + pinned sealed person-doc(s) | matrix (self/manager/HR/exec) |
| `PATCH /api/:t/appraisals/:id` | manager scores + notes + commentary (draft only) | manager-of-subject |
| `POST /api/:t/appraisals/:id/submit` | validates: commentary ≥50, per-axis note when \|manager−auto\| > 1 band → status `submitted`, notify subject | manager-of-subject |
| `POST /api/:t/appraisals/:id/ack {action: "acknowledged"\|"disputed", comment?}` | subject's move; appends to the immutable ack trail | subject only |
| `POST /api/:t/appraisals/:id/finalize` | HR closes (post-ack or post-dispute-resolution); appends `finalized` ack row | HR-appraisal |
| `GET /api/:t/appraisals/mine` | subject's own history | self |

**Internal (non-tenant path, sidecar only):** `GET /internal/reports/print-payload/:jobToken` —
platform-nest hands the renderer a one-shot payload token; see §6.3. Follows the existing
non-`/api` app-level route precedent (session revoke).

### 6.3 Exports — XLSX server-side, PDF via the `report-renderer` sidecar (locked decision 4)

- **CSV/XLSX:** platform-nest export service; `exceljs` (OQ-2). Sheets: `KPIs` (metric, value,
  numerator, denominator, delta), one sheet per `ReportTable`, `Series` (long format). Ratios
  export n/d columns — a spreadsheet user can re-aggregate without average-of-averages.
- **PDF (the sidecar):** new compose service `report-renderer` — Node service on the
  `mcr.microsoft.com/playwright:v1.61.1-*` base image (pin to the repo's `@playwright/test
  ^1.61.1`), ~80 lines: `POST /render {url}` + `Authorization: Bearer RENDERER_TOKEN` →
  `chromium.launch()` → `page.goto(url, waitUntil:'networkidle')` → `page.pdf({format:'A4',
  printBackground:true, margins, headerTemplate/footerTemplate with page numbers})` → PDF bytes.
  Internal network only; no tenant credentials ever reach it.
- **Flow:** export endpoint → creates job + **one-shot, 5-min-TTL `jobToken`** bound to one
  document → calls sidecar with `url = PLATFORM_UI_INTERNAL_URL + /print/reports/{jobToken}` →
  the Next print route server-fetches the document payload from
  `/internal/reports/print-payload/:jobToken` (platform-nest validates + burns the token) and
  renders the SAME viewer components with `print.css` (light theme forced, exact colors, no
  animation) → sidecar returns PDF → platform-nest stores it via the existing files plumbing →
  download. The browser session cookie never leaves the user's browser; the sidecar holds only
  the shared token; the print route renders nothing without a valid one-shot token. ⚡ QA gate on
  this token path (TR-21) — it is an auth bypass by construction and must be single-use, scoped,
  and expiring.
- **Working precedent in-repo — read it before writing TR-18/TR-19:** `docs/blueprints/render-pdf.js`
  already renders this repo's HTML blueprints to print-grade PDF with Playwright's `chromium`
  (borrowed from `platform-ui/node_modules/playwright`). It has solved, in production-adjacent form,
  exactly the problems TR-18 will hit: forcing exact colors (`print-color-adjust:exact` on `*`),
  dropping the reading-measure width cap for print, page-fitting diagrams, a generated contents page,
  and `headerTemplate`/`footerTemplate` page numbering. Lift its print-CSS technique into
  `print.css` rather than rediscovering it; it also de-risks the "will Playwright PDF look right"
  question — it already does, here, today.
- **Risks accounted:** the platform-ui image stays browser-free (Next standalone); the sidecar is
  the only image with Chromium. **Docker build is unverified in this dev env** (no Docker) — same
  caveat as ai-gateway-go/render-gateway: validate on a Docker host before deploy; CI gets a
  `report-renderer` build target next to the existing image builds (TR-19).

---

## 7. Charts — per grain, and the inline-SVG chart kit

**Kit approach (Blocker 3):** extend the `ThroughputSparkline.tsx` precedent into
`platform-ui/src/components/reports/charts/` — hand-rolled inline SVG, **zero external deps**
(strict CSP/no-CDN stands), theme-aware via the existing plain-CSS design-system variables,
print-safe (print stylesheet pins light-theme ink + `printBackground` colors), accessible (every
chart has `role="img"` + `aria-label` and a `<ChartDataFallback>` rendering the same numbers as a
visually-hidden table — which the PDF also benefits from). **FE tickets MUST load the repo's
`dataviz` skill before writing chart code** — its form heuristic, palette/contrast formula and
mark/interaction specs are the governing discipline; the kit implements its rules once so every
report reads as one system.

Components (each takes `ReportSeries`/`ReportDistribution`/`ReportKpi[]` directly — the kit's
props ARE the document contract): `KpiTiles` · `TrendLine` (line/area, null-gap honest) ·
`GroupedBars` / `StackedBars` · `Donut` (≤6 slices + "other") · `CalendarHeatmap` (check-in
compliance) · `Burndown` + `CumulativeFlow` (REUSE the pm module's existing burndown/CFD data
shapes) · `CohortBand` (appraisal: subject marker on the role-cohort distribution strip) ·
`DeltaChip`. Wide charts scroll inside their own container; ratios always tooltip `n/d`.

| Grain | Charts (from the one document) |
|---|---|
| **Person** (day/week/month) | KPI tiles (safe metrics + denominators) · activity trend line (events by day) · time-by-project donut · on-time vs completed grouped bars · check-in `CalendarHeatmap` · contributions table (contributor minutes on others' tasks) · evidence-by-source stacked bars |
| **Project** | Burndown + CFD (reused pm shapes) · throughput weighted bars · workload-by-person stacked bars · status/tag distribution donut · milestone table (due vs done) · reopen-rate trend · overdue table w/ task refs |
| **Department** | throughput + on-time trend lines · capacity vs logged area (utilization, ops-only) · per-person table with sparkline column (small multiples) · project portfolio table (health = on-time × reopen) · **served-companies split** (stacked bars per `servedTenant` — the shared-service view) · compliance heatmap |
| **Company** | dept-comparison grouped bars (throughput weighted, on-time, compliance) · cross-dept stacked area over time · unattributed-bucket tile (kept visible on purpose — it measures fabric health) · top risks/anomalies table (highlights) · exec KPI wall with deltas |

---

## 8. Cerbos policy matrix (authoritative; `lib/rbac.ts` mirrors for UI gating)

New resources: `resource_report_document`, `resource_report_period`, `resource_checkin`,
`resource_appraisal`. Derived roles follow the hr/search precedent (owner/manager/member +
served-dept via active `service_assignments`, `lead_user_id`). Exec-only reads follow the rollups
403-branch precedent.

| Action | Self (member) | Dept lead (own unit) | Exec group | HR-appraisal role | Served-dept case (provider lead, company A→B) |
|---|---|---|---|---|---|
| person-grain document read | ✅ own only | ✅ own unit's members | ✅ all | ✅ all | ✅ ONLY persons acting under the active assignment, via the rollup/provider view — never arbitrary B persons |
| project-grain document read | ✅ member of project | ✅ unit's projects | ✅ | ✅ | ✅ projects under the assignment |
| department-grain document read | ⛔ | ✅ own unit | ✅ | ✅ | ✅ own provider unit incl. served slice |
| company-grain document read | ⛔ | ⛔ | ✅ | ⛔ (person data yes, company strategy no) | ⛔ |
| seal / amend period | ⛔ | ⛔ | ✅ | ⛔ | ⛔ |
| checkin submit | ✅ own only (subject == principal, enforced) | ⛔ for others | ⛔ | ⛔ | — |
| checkin read / compliance | ✅ own | ✅ own unit | ✅ | ✅ | ✅ assignment-scoped |
| checkin excuse | ⛔ | ✅ own unit | ✅ | ✅ | ✅ assignment-scoped |
| appraisal read | ✅ own (status ≥ submitted) | ✅ own subjects | ✅ read-only | ✅ | ⛔ v1 (served-company appraisals stay with the served company's chain — OQ-4) |
| appraisal write (scores/commentary) | ⛔ | ✅ own subjects, draft only | ⛔ | cycle admin, not scores | ⛔ |
| appraisal ack/dispute | ✅ own only | ⛔ | ⛔ | ⛔ | ⛔ |
| cycle admin / finalize | ⛔ | ⛔ | ⛔ | ✅ | ⛔ |
| facts recompute / calendars | ⛔ | ⛔ | ✅ | ⛔ | ⛔ |

**Hard rules:** (1) **MCP/agent OBO principals can never escalate past this matrix** — the hub
mints the principal from the real user (D4), Cerbos evaluates the same policies, and there are NO
agent-privileged actions; appraisal write/ack tools are **not exposed over MCP at all** (§9.2).
(2) An unauthorized read is **403, never 404** (BFF contract convention — the UI renders a
limited-access state). (3) Person-grain data for people outside your line is structurally
unreachable — RLS bounds tenant, the third wall bounds module scope, Cerbos bounds the person
axis. Parity tests mirror the SM-03 matrix style: owner/lead/member/served-lead/exec/HR ×
allow/deny including cross-tenant and low-assurance denials (⚡ TR-25).

---

## 9. AI + MCP (nothing redundant, nothing siloed)

### 9.1 AI narrative — the `ai-drafts.ts` pattern, copied exactly

`src/modules/reports/narrative.ts`: `buildNarrativePrompt(doc: ReportDocument): string` — pure,
zero I/O, embeds ONLY grounded facts (kpis with n/d, top series deltas, highlights) + house tone
rules; → ai-gateway-go `/complete` via `providers/gateway-client.ts` (local-Hermes-first chain);
**NEVER throws** — on any failure returns the **deterministic fallback**: a template composed
from the same grounding facts ("Completed Σ… (N of D on time)…"), `source:'deterministic'`.
Output guards: length cap, no numerals not present in the grounding set (regex-checked against the
fact payload — a hallucinated number downgrades the whole narrative to the deterministic
fallback), never names an id/status the document doesn't carry. `groundingHash` stored for audit.
Narratives are generated **at seal time** (n8n flow) and cached in the stored document; live/ops
reads default to deterministic (no per-page-view AI spend).

### 9.2 MCP tools — registered in the module's `ModuleContract.mcpTools` (never in mcp-hub)

```ts
mcpTools: [
  { name: "reports.getDocument",
    description: "Fetch a person/project/department/company work report (ReportDocument JSON) for a day/week/month period",
    minAssurance: "low", method: "GET",
    pathTemplate: "/api/:tenantId/reports/document",
    inputSchema: { type: "object",
      properties: { tenantId: {type:"string"}, grain: {enum:["person","project","department","company"]},
                    scopeRef: {type:"string"}, periodKind: {enum:["day","week","month"]}, start: {type:"string"} },
      required: ["tenantId","grain","scopeRef","periodKind","start"] } },
  { name: "reports.listPeriods",
    description: "List report periods and their seal status/revisions",
    minAssurance: "low", method: "GET", pathTemplate: "/api/:tenantId/reports/periods",
    inputSchema: { type: "object", properties: { tenantId: {type:"string"}, kind: {type:"string"} }, required: ["tenantId"] } },
  { name: "reports.getMetrics",
    description: "Query governed rollup metric series (numerator/denominator) by metric key and grain",
    minAssurance: "low", method: "GET", pathTemplate: "/api/:tenantId/reports/metrics",
    inputSchema: { type: "object", properties: { tenantId:{type:"string"}, metricKey:{type:"string"},
                    grain:{type:"string"}, from:{type:"string"}, to:{type:"string"} }, required: ["tenantId","metricKey"] } },
  { name: "reports.getCompliance",
    description: "Check-in compliance grid for a unit and period (expected/submitted/missed/excused)",
    minAssurance: "verified", method: "GET", pathTemplate: "/api/:tenantId/checkins/compliance",
    inputSchema: { type: "object", properties: { tenantId:{type:"string"}, unit:{type:"string"},
                    periodKind:{type:"string"}, start:{type:"string"} }, required: ["tenantId"] } },
  { name: "checkin.getToday",
    description: "Get today's end-of-day check-in draft for the acting user (prefilled from their derived activity)",
    minAssurance: "low", method: "GET", pathTemplate: "/api/:tenantId/checkins/today",
    inputSchema: { type: "object", properties: { tenantId: {type:"string"} }, required: ["tenantId"] } },
  { name: "checkin.submit",
    description: "Submit the acting user's end-of-day check-in (summary + optional blockers). Acts only as the OBO user.",
    minAssurance: "verified", method: "POST", pathTemplate: "/api/:tenantId/checkins",
    write: true, impact: "low",
    inputSchema: { type: "object", properties: { tenantId:{type:"string"}, summary:{type:"string"},
                    blockers:{type:"string"}, date:{type:"string"} }, required: ["tenantId","summary"] } },
]
```

Deliberately **not** exposed over MCP: `seal`/`amend` (exec ceremony, high impact — humans in the
ERP), all appraisal writes and acks (human-only surfaces per locked decision 3), `recompute`
(ops). Cerbos evaluates the OBO principal against §8 — the tool list grants nothing the user
couldn't do in the UI.

**The WA loop this enables (nothing siloed):** wa-chat-bot reminder → user replies with their
day-summary (or "ok" to accept the prefill) → bot calls `checkin.submit` through the MCP hub with
the D4-linked OBO principal → same table, same compliance, `source:'wa'`. Agents (WS8
status-reporter) consume `reports.getDocument` instead of re-deriving status from raw tables —
the report layer becomes the single truth agents quote.

---

## 10. Scheduling + delivery (n8n orchestrates, MCP/platform accesses; platform-nest gains NO scheduler)

Five flows (naming per existing automation conventions), all idempotent, all re-drivable:

| Flow | Schedule | Steps |
|---|---|---|
| `reports-nightly-facts` | daily 02:00 | per tenant: `POST facts/recompute {from: D-2, to: D-1}` (2-day window absorbs late entries) → membership sweeper → write `auto_missed` check-ins for D-1 → on failure: retry ×3 → dead-letter + ntfy (existing observability rails) |
| `reports-eod-reminder` | daily 17:30 | `GET checkins/pending-reminders?date=today` → for users with a WA identity link: bot delivers the prefill summary + "reply to confirm/edit" (TR-11's minimal bot notify route); others: in-app notification. Quiet on holidays/leave by construction (the endpoint already filters) |
| `reports-morning-escalation` | daily 09:00 | yesterday's `auto_missed` grouped by unit → manager WA/in-app: "N missed check-ins" + deep link to the compliance grid |
| `reports-weekly-seal` | Mon 06:00 | seal prior ISO week → generate documents (all grains/scopes) → AI narratives (fail-soft) → render dept+company PDFs via sidecar → notify leads/exec with links |
| `reports-monthly-seal` | 1st 06:00 | same for prior month + when an appraisal cycle covers the month: pre-generate `auto_inputs` refresh notice to HR |

Backstops (no cron in platform-nest, 0040 pattern): a document read for an unsealed past period
lazily computes on read; a seal is only ever explicit (n8n or human) — never implicit.
Timezone: all "day" boundaries use ONE deployment-level `REPORTS_TZ` (recommend `Asia/Jakarta`)
v1; per-tenant timezones are deferred (§13, OQ-1).

---

## 11. Privacy & ethics — why this is not a surveillance tool

**Collected (all of it already exists in the platform):** task lifecycle events, logged time
entries, comment/doc counts, activity *counts* by source from `work_activity`, self-authored
check-ins, manager appraisals. **Deliberately NOT collected — and the design has no seam for it:**
keystrokes, screenshots, screen/app/URL monitoring, idle/active timers, mouse telemetry, location,
calendar contents, message *contents* (the WA bot's scrub/crypto-shred pipeline is upstream and
unchanged — reports only ever see event counts), per-minute activity timelines. The atomic grain
is a **day** — the system is structurally incapable of answering "what was she doing at 14:32".

Principles enforced by design, not policy prose:
1. **Self-narration first:** the check-in is the person's own account, prefilled for convenience,
   editable before submit, `edited` flag honest about which. It is the only mandatory daily act.
2. **Transparency symmetric:** a subject sees their OWN full person-grain document and the exact
   appraisal pack their manager sees (§8) — nothing about you that you cannot read.
3. **Access is line-of-sight** (§8): person-grain data reaches self, own-unit lead, exec, HR —
   never peers, never other departments, never agents beyond the acting user's own rights.
4. **Appraisal-unsafe metrics can't leak into appraisal** — the flag is enforced at pack build,
   not by reviewer discipline (§5).
5. **Hours are context, not score** (effort weight 0.10; `minutes_logged` unsafe alone).
6. **No third-party egress:** narratives go through ai-gateway-go (local-Hermes-first, DLP,
   egress audit); person metrics never leave the platform boundary.
7. **Right to contest:** `disputed` is first-class with an immutable trail; amendments are
   audited and notified, never silent.
8. **Legal gate respected:** person-grain productivity data is employee personal data — rollout
   to real employee data rides the same Gate-1 legal review track as the bot (DPIA addendum
   listing exactly the §11 collected-set; OQ-5).

---

## 12. Ticket decomposition — P0–P6, `/army`-ready

Seat defaults per [[agent-army-standard]]: seniors/medior/qa/devops = Sonnet (seniors ·high),
junior = Haiku. **Opus is tagged case-by-case below (3 tickets) with justification** — everything
untagged runs on seat default. ⚡ = mandatory QA gate (RLS / Cerbos / migrations / auth-token
paths). Concurrency cap 1–2 per the standard; order within a phase is the dependency order.
File paths are repo-relative to `gaiada-system/`.

### P0 — substrate blockers (5 tickets)

- **TR-01 · 0050 relational assignees + backfill** — `senior-db` · **opus·medium** (migration with
  real data-integrity risk: live-JSONB→relational backfill, partial-unique owner/responsible
  invariants; a wrong backfill silently corrupts every downstream attribution — cheap-then-escalate
  would waste a full re-run). Files: `platform-nest/migrations/0050_pm_task_assignees.sql`,
  `platform-nest/test/` RLS + backfill tests. Deps: none. ⚡
  Done when: table + constraints exist; backfill is idempotent (run twice → identical rows);
  every seeded task's blob round-trips to owner/responsible rows; FORCE-RLS sweep green.
- **TR-02 · PM dual-write + contributors API** — `senior-be`. Files:
  `platform-nest/src/modules/pm/pm.controller.ts` (+service), `platform-ui/src/lib/pm.ts`
  (additive `contributors` type only). Deps: TR-01. ⚡ (contract-touching)
  Done when: every assignee-writing path writes blob+rows in one tx; task GET carries
  `contributors[]`; PATCH add/removeContributor ops work; existing pm suite green byte-unchanged
  on old fields; drift-guard hook emits on mismatch.
- **TR-03 · 0051 org_unit_memberships** — `senior-db`. Files:
  `platform-nest/migrations/0051_org_unit_memberships.sql`, tests. Deps: none. ⚡
  Done when: EXCLUDE non-overlap proven by test (insert overlapping primary → rejected); backfill
  creates one open primary per placed person; RLS sweep green.
- **TR-04 · server dept resolution + membership sweeper** — `senior-be`. Files:
  `platform-nest/src/core/dept-resolution.ts` (new), org-structure PUT hook. Deps: TR-03.
  Done when: precedence ①–④ (§3.2) unit-tested incl. as-of transfer case (person moves July 15 →
  July 10 fact resolves to old unit, July 20 to new); blob PUT closes/opens rows dated today;
  provider stamp set only with an ACTIVE service_assignment.
- **TR-05 · pm→work_activity outbox consumer (P1-05)** — `senior-be`. Files:
  `platform-nest/src/events/` (new consumer), work-activity ingest service reuse. Deps: none
  (parallel-safe with TR-01..04).
  Done when: task complete/reopen/status-change/comment/doc events land as `work_activity` rows
  (`source='pm'`, `source_ref=event id`); duplicate delivery inserts zero (idempotency key);
  done-ness derived from `is_done` flag; dead-letter path covered.

### P1 — fact fabric + metrics (3 tickets)

- **TR-06 · 0052 calendars/check-ins/facts + third wall** — `senior-db`. Files:
  `0052_module_reports_core.sql`, dedicated third-wall test (right tenant WITHOUT `reports` scope
  → zero rows). Deps: none. ⚡
- **TR-07 · nightly fact job + attribution engine** — `senior-be` · **opus·medium** (the
  correctness heart: owner-takes-all attribution with the unit/person split, no-double-count
  identities, idempotent DELETE+INSERT slices, cross-module `{reports,pm,hr}` scopes — a subtle
  join bug here silently corrupts company totals and only the reconciliation test would catch it
  months later). Files: `platform-nest/src/modules/reports/fact-job.ts`, `recompute` endpoint.
  Deps: TR-01..06. ⚡
  Done when: recompute any (tenant, date) twice → byte-identical rows; §3.1 attribution table
  cases each pinned by a test (person-owner / unit-owner+responsible / unit-only / none);
  Σperson ≤ Σunit = company on seeded data; backfill over 60 historical days completes and
  converges.
- **TR-08 · 0055 metric seeds + RollupProvider** — `senior-be`. Files:
  `0055_report_metric_seeds.sql`, `src/modules/reports/metrics.ts` (catalog incl. appraisalSafe),
  provider registration in the module contract. Deps: TR-07.
  Done when: all §5 metrics upsert idempotently into `rollup_metrics` with correct n/d and
  dimensions per grain; `ratio_of_sums` verified against a hand-computed week.

### P2 — check-ins (4 tickets)

- **TR-09 · check-in endpoints + prefill + auto-missed** — `senior-be`. Files:
  `src/modules/reports/checkins.controller.ts`, prefill composer (live same-day derive),
  fact-job hook for `auto_missed`. Deps: TR-06; TR-07 for auto-missed. 
  Done when: today-draft returns real derived prefill; submit enforces non-empty summary +
  one-per-day; expected() honors calendar+holidays+approved leave+attendance (§5.3) — a leave day
  never generates auto_missed (pinned test); excuse path audited.
- **TR-10 · check-in UI (<30s flow)** — `senior-fe`. Files: My Work surface +
  `platform-ui/src/lib/reports.ts` (client). Deps: TR-09.
  Done when: open → edit → submit in ≤3 interactions; prefill visibly editable; submitted state +
  streak/compliance visible to self; graceful `BackendPending` degradation.
- **TR-11 · WA reminder + MCP submit + n8n flows 1–3** — `senior-integrator`. Files: module
  `mcpTools` (checkin.*), minimal wa-chat-bot notify route (`POST /admin/notify`), n8n flow JSONs
  (`automation/`), pending-reminders endpoint wiring. Deps: TR-09; bot+hub running. 
  Done when: reminder → WA reply → `checkin.submit` (OBO, `source:'wa'`) lands the row;
  escalation message lists yesterday's misses to the right lead; holiday runs deliver nothing.
- **TR-12 · compliance adversarial QA** — `qa`. Deps: TR-09..11. ⚡
  Done when: false-negative hunt passes — leave/holiday/transfer/new-hire/offboarded cases all
  produce correct expected(); OBO cannot submit for another user (Cerbos denial pinned).

### P3 — report documents + viewer + charts (6 tickets)

- **TR-13 · ReportDocument builder (live path)** — `senior-be`. Files:
  `src/modules/reports/document-builder.ts`, `reports.controller.ts` (document/overview/metrics).
  Deps: TR-07, TR-08.
  Done when: all four grains × three period kinds build from facts/rollups/snapshots; ratios carry
  n/d; comparison deltas correct across month boundaries; provider view slices by servedTenant.
- **TR-14 · 0053 periods/documents** — `senior-db`. Files: `0053_report_periods_documents.sql` +
  third-wall test. Deps: TR-06. ⚡
- **TR-15 · sealing / amend / audit** — `senior-be`. Files: seal service + endpoints + outbox
  events. Deps: TR-13, TR-14. ⚡
  Done when: seal → stored docs at revision N; post-seal task edit changes live view but NOT the
  sealed document (pinned test); amend requires reason, notifies, re-seal writes N+1 keeping N;
  seal_hash verifies; double-seal → 409.
- **TR-16 · chart kit + viewer design** — `senior-uiux` (load the `dataviz` skill first —
  binding). Files: `platform-ui/src/components/reports/charts/*`, viewer layout. Deps: TR-13
  shapes (can start from the §6.1 contract).
  Done when: all §7 components render from document JSON alone; light/dark + print CSS verified;
  aria/data-table fallback present; zero external deps (CSP holds).
- **TR-17 · grain report pages + wiring** — `senior-fe`. Files: report routes per grain,
  `lib/reports.ts`. Deps: TR-13, TR-16.
  Done when: person/project/department/company pages render live + sealed states, revision picker,
  403 limited-access branch (rollups precedent), `BackendPending` for absent periods.
- **TR-18 · XLSX/CSV export service** — `medior`. Files: export service (`exceljs`), export
  endpoints. Deps: TR-13; OQ-2 ratified.
  Done when: XLSX sheets match §6.3; n/d columns present; 10k-row table exports under 5s;
  CSV matches DataTable conventions.

### P4 — PDF + delivery (4 tickets)

- **TR-19 · report-renderer sidecar + compose + CI** — `devops`. Files: `report-renderer/`
  (new small service + Dockerfile on the Playwright base image), `infra/compose/*.yml`, CI build
  target, `.env.example` (`RENDERER_TOKEN`, `PLATFORM_UI_INTERNAL_URL`). Deps: none (stub page ok).
  Done when: compose service healthy; token-less request → 401; CI builds the image; the
  "docker build unverified in this dev env" caveat documented in the runbook.
- **TR-20 · print route + print CSS** — `senior-fe`. Files:
  `platform-ui/src/app/print/reports/[jobToken]/`, `print.css`. Deps: TR-16, TR-17.
  Done when: renders the same viewer components server-side from the one-shot payload; no session
  required; page numbers/margins correct on A4.
- **TR-21 · export orchestration + one-shot tokens** — `senior-be`. Files: export job service,
  `/internal/reports/print-payload/:jobToken`. Deps: TR-15, TR-19, TR-20. ⚡ (auth-bypass-by-token
  path: single-use, 5-min TTL, doc-scoped, burned on read — adversarial QA mandatory)
  Done when: token replay → 401; expired → 401; token for doc X cannot fetch doc Y; PDF bytes
  stored via files plumbing and downloadable with normal authz.
- **TR-22 · n8n seal/generate/deliver flows (4–5)** — `senior-integrator`. Files: n8n flow JSONs,
  notification wiring. Deps: TR-15, TR-21, TR-11's rails.
  Done when: weekly flow seals last ISO week, generates all documents, renders dept+company PDFs,
  notifies leads/exec with working links; re-run of a completed flow is a no-op (idempotent).

### P5 — appraisal (4 tickets)

- **TR-23 · 0054 appraisal tables** — `senior-db`. Files: `0054_report_appraisals.sql` +
  third-wall test + ack-append-only test. Deps: TR-14. ⚡
- **TR-24 · appraisal engine + endpoints** — `senior-be`. Files:
  `src/modules/reports/appraisals.controller.ts` + engine (cohort percentile bands, weight
  resolution, deviation-justification + commentary enforcement, evidence pinning, stale flag).
  Deps: TR-15, TR-23.
  Done when: generate freezes weights+auto_inputs from sealed periods only (unsealed → 409);
  submit rejects commentary <50 chars and unjustified >±1-band deviations; ack trail append-only;
  amend of a pinned revision flips `evidence.stale` and blocks finalize until re-confirm.
- **TR-25 · Cerbos policy set + rbac mirror** — `senior-be` · **opus·high** (subtle
  authz/tenancy: four resources × the §8 matrix incl. the cross-company served-dept derived role
  over `service_assignments`, the self-vs-manager-vs-HR person-data boundaries, and the OBO
  no-escalation proof — a mistake here exposes appraisal/person data across lines; this is
  exactly the security-critical class the standard reserves opus·high for). Files:
  `cerbos/policies/resource_report_*.yaml` × 4, derived roles, `platform-ui/src/lib/rbac.ts`
  mirror. Deps: TR-13, TR-24 shapes. ⚡ (mandatory — SM-03-style parity matrix incl. cross-tenant
  + low-assurance + OBO denials)
- **TR-26 · appraisal UI** — `senior-fe`. Files: cycle admin, manager scoring pack (CohortBand
  charts), employee ack view (`/appraisals/mine`). Deps: TR-16, TR-24, TR-25.
  Done when: manager flow draft→submit with enforced justifications; subject sees the identical
  pack + ack/dispute; HR cycle console; all gated per rbac mirror.

### P6 — AI, MCP, program gate (4 tickets)

- **TR-27 · AI narrative** — `senior-be`. Files: `src/modules/reports/narrative.ts` (ai-drafts
  pattern), seal-flow hook. Deps: TR-13, TR-15.
  Done when: gateway outage → deterministic fallback, never throws; hallucinated-numeral guard
  downgrades to fallback (pinned test); groundingHash stored; zero AI calls on live/ops reads.
- **TR-28 · MCP tools registration** — `senior-be`. Files: `src/modules/reports/index.ts`
  (ModuleContract + §9.2 mcpTools), hub tool-defs test. Deps: TR-09, TR-13.
  Done when: hub aggregates the 6 tools; `checkin.submit` acts only as the OBO user; no appraisal
  or seal tool present; Cerbos parity on tool paths.
- **TR-29 · program reconciliation gate** — `qa`. Deps: all. ⚡ (the merge gate for the program)
  Done when: on a seeded multi-dept + shared-service dataset: Σperson ≤ Σdept == company with the
  unattributed bucket explicit; transfer mid-month attributes each half correctly; sealed-number
  immutability under post-hoc edits; PDF/XLSX/web/MCP all serve identical numbers for one document.
- **TR-30 · docs + seed + registry sweep** — `junior` (Haiku). Files: `docs/modules/MODULES.md` +
  `CHANGELOG.md` bumps as phases land, `FRONTEND-BFF-CONTRACT.md` §15 status flips, demo seed
  extension (`npm run seed:agency` gains check-ins/facts). Deps: trailing each phase.

**Totals:** P0=5 · P1=3 · P2=4 · P3=6 · P4=4 · P5=4 · P6=4 → **30 tickets**, 3 Opus-tagged
(TR-01 opus·medium, TR-07 opus·medium, TR-25 opus·high), 12 ⚡ QA-gated.

---

## 13. Open risks + deliberate deferrals

**Risks:**
1. **Docker builds unverified in this dev env** (no Docker): `report-renderer` follows
   ai-gateway-go's caveat — validate on a Docker host before deploy (TR-19 runbook note).
2. **Pre-TR-05 history gap:** person-grain completion facts start at consumer go-live; project
   grain backfills from 0040/0042 snapshots. First sealed month = first appraisal-grade month.
   Communicated in-product on any pre-go-live period.
3. **Membership backfill approximation:** pre-adoption facts resolve to the person's *current*
   unit (§3.2). Amendable via manual membership rows; disclosed on affected sealed documents.
4. **Dual-write drift** (blob vs rows): mitigated by same-tx writes + the nightly drift guard;
   the authority flip is deferred until a zero-drift period is observed.
5. **`UNIQUE NULLS NOT DISTINCT`** requires PG15+ — assert the Postgres version in migration 0052
   (fail loud, not subtle).
6. **On-time flag uses due date at compute time** — a due-date edit before the seal shifts it;
   after the seal it cannot. Accepted and documented; per-completion due-date snapshots would need
   event payload enrichment (deferred).
7. **Suite cost:** schema-per-file harness (~7 min full run) grows with the new suites — keep the
   module's suites lean; the reconciliation gate (TR-29) is one file, not many.

**Deliberately deferred (out of v1):**
- Per-unit / per-person calendars and per-tenant timezones (one tenant calendar + one deployment
  TZ v1 — OQ-1).
- Assignee authority flip (rows → source of truth, blob derived).
- Appraisal calibration across managers (cross-cohort normalization meetings) — process, then
  maybe tooling.
- Cycle-time / blocked-dwell metrics needing full status-history reconstruction (needs TR-05 data
  accumulated first; add in a later metric wave).
- Served-company appraisal visibility for provider leads (OQ-4).
- Client-facing report delivery + branding (WS11/SM-22 territory).
- Trigger-enforced immutability on sealed rows (service-only writer v1; revisit on second writer).
- Dark-theme PDF (print is light-theme by design).

**Open questions (owner decision needed):**
- **OQ-1 · Timezone:** confirm `REPORTS_TZ=Asia/Jakarta` deployment-wide v1 (recommended), or
  require per-tenant TZ now (adds a companies column + fact-job complexity).
- **OQ-2 · `exceljs` dependency:** ratify adding it to platform-nest (MIT, server-only). Fallback
  is CSV-only exports until ratified.
- **OQ-3 · Appraisal cadence default:** recommended monthly cycles fed by monthly seals, with
  quarterly as an HR-configured option (cycles support arbitrary ranges either way).
- **OQ-4 · Shared-service appraisals:** v1 keeps appraisal strictly within the employing company's
  chain (provider lead sees served *work*, not served-company *appraisals*). Confirm, or specify
  the cross-company appraisal input you want.
- **OQ-5 · Legal:** person-grain productivity data + mandatory check-ins are employee personal
  data — confirm the Gate-1 DPIA addendum path before real-employee rollout (mirrors the bot's
  gate; §11.8).

---

## 14. Register + build path

- **Registry registration is DONE (2026-07-30, by the main session, not by this doc's author):**
  `docs/modules/MODULES.md` now carries **`reports` · `0.0.0` · PLANNED** and **`report-renderer` ·
  `0.0.0` · PLANNED** (registry table + a specialized section each), and `docs/modules/CHANGELOG.md`
  has the program-log entry. **TR-30's remaining scope is therefore only the
  `docs/FRONTEND-BFF-CONTRACT.md` §15 endpoint-surface block (all ⛔ PENDING)** — plus the
  version/status bumps as each phase earns PROTOTYPED / DEV-VERIFIED. Status
  vocabulary discipline applies: nothing here is "built" until the tickets land and earn
  PROTOTYPED / DEV-VERIFIED per phase.
- Mobilize via `/army` per [[agent-army-standard]] (discussion-first; 1–2 concurrency; QA gates ⚡
  as marked). Build order: P0 → P1 → P2 ∥ P3 → P4 → P5 → P6, with TR-05 free to run parallel
  inside P0 and TR-16/TR-19 free to start early on contract stubs.
