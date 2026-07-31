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
>    rollup-persisted (§0057 custom semantics, §5.4, §6.2).
>
> **📌 ARCHITECT DECISIONS in this doc (flag to owner if disputed):**
> - **Migration range is `0054–0059`** (REBASED 2026-07-30, see §15) — the doc originally said 0048+, then 0050–0055; both were overtaken by concurrent work
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
| Governed metric substrate: `metric_definitions` + `rollup_metrics(module, metric_key, period, numerator, denominator, currency, dimensions jsonb, as_of)`, idempotent upsert, `ratio_of_sums`, per-module `RollupProvider` under its own module scope | `platform-nest/src/rollups/engine.ts` | ALL rollup numbers live here. The `reports` module registers a RollupProvider + 21 metric seeds (§5; a 22nd metric is read-time derived — §5.4). D12: this stays the ONLY cross-company read path — the shared-service provider view rides it |
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

**New (this program only):** relational task assignees (0054) · as-of org-unit memberships (0055) ·
work calendar + check-ins + daily facts (0056) · period seals + report documents (0057) · appraisal
tables (0058) · metric seeds (0059) · fact job + attribution engine · `ReportDocument` contract +
viewer + chart kit · exports (XLSX/CSV + PDF sidecar) · check-in flow (UI/WA/MCP) · appraisal
engine + UI · AI narrative · 6 MCP tools · 5 n8n flows.

---

## 3. The three blockers — solved first (they gate every downstream number)

### 3.1 Blocker 1 — `pm_tasks.assignee` is a single unindexed JSONB blob

Today: `{kind: person|department|division, refId, refName, responsibleId, responsibleName}`
(FE type `Assignee`, `platform-ui/src/lib/pm.ts:130`). No multi-assignee; a dept-assigned task has
no person; person-grain SQL over JSONB is not trustworthy. **Fix: relational `pm_task_assignees`
(migration 0054) with strict dual-write and read-through compatibility.**

**Roles (closed set):**
- `owner` — exactly ONE per task (partial unique index). The outcome-credit target. May be a
  person **or** a unit (department/division) — mirrors the blob's `kind/refId`.
- `responsible` — at most one, always a **person** — mirrors the blob's `responsibleId` ("the
  person in charge; AI delivers here"). Present even when owner is a unit.
- `contributor` — zero or more persons. NEW capability; listed with logged hours, never
  outcome-credited.

**Migration + compatibility strategy (explicit):**
1. **0054 creates the table and backfills** from the JSONB in one pass: for each `pm_tasks` row
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

**Fix: server-side, as-of-date resolution off a new `org_unit_memberships` table (0055).**

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

> **⚠ CORRECTED 2026-07-30 when TR-05 was implemented — this section's premise was WRONG.** The
> consumer was **not** unbuilt: a real one shipped earlier as `WSUX-15` (ex-P1-05) in
> `src/events/work-activity-consumer.ts`, covering the `pm_task` / `pm_project` /
> `meeting_recording` / `pipeline_run` streams with a dedicated consumer group, working idempotency
> and a dead-letter path — plus a historical backfill utility (`src/core/work-activity-backfill.ts`).
> TR-05's real scope turned out to be closing its *gaps*: no comment or doc coverage, and verbs were
> a naive `eventType`-tail split that never distinguished completed / reopened / status_changed by
> the `is_done` flag. Those are now closed. **Consequence for §13 risk 2: the history gap is
> narrower than stated** — pm_task/pm_project activity has been accruing already and the backfill
> utility can reconstruct more, so "the first sealed month is the first appraisal-grade month" is
> pessimistic rather than strictly true. Re-measure actual `work_activity` coverage before telling
> anyone their history starts now.
>
> **⛔ NEW BLOCKER this uncovered (ticket TR-31, gates the collaboration + evidence axes):**
> `work-activity-consumer.ts:215` sets **`actorUserId: null` on every consumer-derived row** —
> outbox payloads simply do not carry the acting user's id (it is captured separately in the flat
> `activities` audit table via `writeActivity()`). So activity-derived **person**-grain measures
> (`comments_authored` #16, `docs_updated` #17, `link_rate` #21, `source_diversity` #22, and
> `activity_events` at person grain) would compute as **empty/zero — silently, with no error**, and
> the auto-linker cannot mint `target_kind='person'` links either. Delivery and effort metrics are
> unaffected (they come from `pm_task_assignees` + `time_entries.user_id`), but **collaboration is
> one of the four appraisal axes**, so this is not cosmetic. Fix = propagate the acting user id into
> the pm/meeting/pipeline outbox payloads and map it in the consumer (TR-31, P0/P1 boundary,
> **blocks TR-07**). Do NOT build the fact job on the assumption that person attribution works.

Activity ingest was believed to be **synchronous-API only** with the outbox→`work_activity` consumer
never built. Verdict at design time: **required (ticket TR-05).** Person-grain delivery facts (completed,
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

## 4. Schema — new tables, full DDL (migrations 0054–0059)

> **The numbers below are INDICATIVE, not reservations.** `0054`–`0056` are landed and fixed. For
> everything after, **claim the next free number at implementation time** (§15 process rule) — tickets
> are not executing in the doc's original order, and another session is adding migrations concurrently.
> The runner (`src/db/migrate.ts`) tracks applied files by name and applies any unapplied file in
> sorted order, so a lower number added later still applies correctly — but keep numbering aligned with
> *execution* order anyway, so the ledger reads chronologically. Record every deviation in
> `platform-nest/migrations/README.md`.

Conventions applied to every table: `tenant_id uuid NOT NULL REFERENCES companies(id)` · FORCE RLS
· policy composed from `app_current_tenants()` (+ `app_module_allowed('reports')` for `report_*`
tables, byte-identical DO-loop per 0028) · `origin_site text NOT NULL` with NO default (0055-0059; see the §15 ruling — a default silently mislabels site-originated rows as central) ·
`*_node_id text` columns carry org-node ids with **no FK** (0029) · timestamps · runtime DML
grants via the owner's `ALTER DEFAULT PRIVILEGES` + external `RUNTIME_GRANTS_SQL` pass (0028
header) — no in-migration GRANTs. Every table has a literal `tenant_id`, so the `rls.test.ts`
FORCE-RLS sweep covers all of them; the third wall additionally gets its own dedicated
scope-declaration test per the 0028 precedent (right-tenant WITHOUT `reports` scope → zero rows).

### 0054 — `pm_task_assignees` (PM substrate; plain tenant policy like other `pm_*` tables)

```sql
-- 0054_pm_task_assignees.sql — Blocker 1: relational assignees beside the JSONB blob (dual-write).
CREATE TABLE pm_task_assignees (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES companies(id),
  task_id       uuid NOT NULL REFERENCES pm_tasks(id) ON DELETE CASCADE,
  role          text NOT NULL CHECK (role IN ('owner','responsible','contributor')),
  assignee_kind text NOT NULL CHECK (assignee_kind IN ('person','department','division')),
  assignee_ref  text NOT NULL,                 -- user_id when person; org-node id when unit (NO FK)
  user_id       uuid REFERENCES users(id),     -- resolved person (NULL for unit rows)
  created_by    uuid REFERENCES users(id),
  origin_site   text NOT NULL,                    -- NO default (§15 ruling)
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

### 0055 — `org_unit_memberships` (org core; plain tenant policy like `org_units`)

```sql
-- 0055_org_unit_memberships.sql — Blocker 2: time-aware person↔unit membership (as-of resolution).
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
  origin_site  text NOT NULL,                    -- NO default (§15 ruling)
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

### 0056 — `report_work_calendars`, `report_checkins`, `report_work_facts` (third wall `'reports'`)

```sql
-- 0056_module_reports_core.sql — calendar, mandatory check-ins, the atomic fact grain.
CREATE TABLE report_work_calendars (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES companies(id),
  working_days int[] NOT NULL DEFAULT '{1,2,3,4,5}',   -- ISO dow, Mon=1
  holidays     jsonb NOT NULL DEFAULT '[]',            -- [{date:'2026-08-17', label:'Independence Day'}]
  workday_minutes int NOT NULL DEFAULT 480,            -- matches hr leave day=480 convention
  updated_by   uuid REFERENCES users(id),
  origin_site  text NOT NULL,                    -- NO default (§15 ruling)
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
  origin_site  text NOT NULL,                    -- NO default (§15 ruling)
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
  origin_site  text NOT NULL,                    -- NO default (§15 ruling)
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

### 0057 — `report_periods`, `report_documents` (third wall)

```sql
-- 0057_report_periods_documents.sql — sealing + the stored ReportDocument.
CREATE TABLE report_periods (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES companies(id),
  period_kind  text NOT NULL CHECK (period_kind IN ('day','week','month','custom')),
  label        text,                           -- human label; REQUIRED for pinned 'custom' rows
  period_start date NOT NULL,
  period_end   date NOT NULL CHECK (period_end >= period_start),
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open','sealed','amended')),
  revision     int  NOT NULL DEFAULT 0,        -- bumps on every re-seal after amend
  sealed_at    timestamptz,
  sealed_by    uuid REFERENCES users(id),      -- NULL when sealed by the n8n schedule (system)
  amend_reason text,                           -- last amendment reason (full trail in audit events)
  seal_hash    text,                           -- sha256 over the period's document set (tamper check)
  origin_site  text NOT NULL,                    -- NO default (§15 ruling)
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  -- Calendar periods keep the exact one-row-per-start guarantee. A PARTIAL unique index is required
  -- rather than a plain UNIQUE: two different user-chosen custom ranges may legitimately share a
  -- start date (Jan 1–Jan 31 and Jan 1–Mar 31 are different reports), which a plain
  -- UNIQUE(tenant, kind, start) would reject.
  CONSTRAINT report_periods_custom_needs_label CHECK (period_kind <> 'custom' OR label IS NOT NULL)
);
CREATE UNIQUE INDEX report_periods_calendar_uq ON report_periods (tenant_id, period_kind, period_start)
  WHERE period_kind <> 'custom';
-- Pinned customs dedupe on the EXACT range instead, so re-pinning the same window is idempotent.
CREATE UNIQUE INDEX report_periods_custom_uq ON report_periods (tenant_id, period_start, period_end)
  WHERE period_kind = 'custom';

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
  origin_site  text NOT NULL,                    -- NO default (§15 ruling)
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, period_id, revision, grain, scope_ref)
);
CREATE INDEX ix_report_documents_scope ON report_documents (tenant_id, grain, scope_ref, created_at DESC);
-- Same third-wall DO-loop as 0056. Sealed rows are IMMUTABLE by convention: no UPDATE path exists
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

**Custom-range semantics (2026-07-30 amendment) — four rules, all load-bearing:**

1. **Transient by default, no row.** A user-chosen range is computed from `report_work_facts` on
   read, returned, and forgotten. It creates **no** `report_periods` row — otherwise the table fills
   with throwaway rows from every date-picker fiddle. The only writer of `period_kind='custom'` rows
   is the explicit **pin** endpoint (§6.2).
2. **Never sealed, never appraisal-admissible.** `POST …/periods/:id/seal` and
   `POST …/appraisals/cycles/:id/generate` **reject `period_kind='custom'` with a 422** and an
   explicit message ("custom ranges are ad-hoc reads; appraisal requires a sealed calendar period").
   A silent skip is forbidden — it would let an appraisal quietly rest on unsealed numbers, which is
   exactly what the sealing invariant exists to prevent. This is a required acceptance criterion on
   TR-13 (seal) and TR-24 (appraisal generate), and a ⚡QA assertion.
3. **Never persisted to `rollup_metrics`.** That table's key is
   `(tenant, module, metric_key, period, dimensions)`; an unbounded set of user-chosen ranges would
   bloat the governed registry with rows nobody can aggregate. Only calendar periods (day/week/month)
   upsert there. Custom ranges read the fact table directly — which is safe precisely because the
   atomic grain is per-day and additive.
4. **Pinning is the archive path.** `POST /api/:t/reports/periods/pin {start, end, label}` (exec/lead,
   `reports.seal`) creates a labelled `period_kind='custom'` row that CAN be snapshotted into
   `report_documents` and exported as a stable, re-openable artifact — for the cases that genuinely
   need archiving (a board pack for a campaign window; a quarter, before quarterly seals exist).
   A pinned custom is still **barred from appraisal** by rule 2. Recommended: pinning is deliberately
   a privileged, labelled, low-volume act — if pinned customs ever start being used as the routine
   read path, that is the signal to add a real quarterly/annual calendar kind instead.

### 0058 — appraisal tables (third wall)

```sql
-- 0058_report_appraisals.sql — blended, manager-weighted appraisal + acknowledgement trail.
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
  origin_site  text NOT NULL,                    -- NO default (§15 ruling)
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
  origin_site     text NOT NULL,                    -- NO default (§15 ruling)
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
  origin_site  text NOT NULL,                    -- NO default (§15 ruling)
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_appraisal_acks ON report_appraisal_acks (tenant_id, appraisal_id, created_at);
-- Same third-wall DO-loop.
```

### 0059 — metric seeds

`INSERT ... ON CONFLICT DO NOTHING` into `metric_definitions` for the §5 registry — **21 rows**
(module `reports`), `aggregation_rule` per row drawn ONLY from the existing CHECK vocabulary
`('sum','ratio_of_sums','max','last')` (`0001_core.sql:83`): mostly `sum` / `ratio_of_sums`, plus
`'last'` for #20 (point-in-time). Metric #22 is **not seeded** (read-time derived — §5.4). This
migration does **not** widen that CHECK; every other module's rollup consumers read the same column.
Appraisal-safety is likewise **not** a `metric_definitions` column
(no altering shared substrate): it lives in the module's TS catalog
(`src/modules/reports/metrics.ts`), the single source that both seeds 0059 and drives
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
4. **Ops reads recompute live; management + appraisal reads are sealed** (§ 0057 above). Sealing,
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

## 5. The metric registry (22 metrics — 21 seeded + 1 read-time derived)

All seeded as `metric_definitions` rows (module `reports`), computed by the module's
`RollupProvider` from `report_work_facts` (+ snapshots + check-ins), upserted idempotently into
`rollup_metrics` with `dimensions` per grain. Grains: **P**erson `{userId}` · **J** project
`{projectId}` · **D** department `{unit}` (+ `{unit, servedTenant}` provider view) · **C** company
`{}`. Periods: day/week/month **persist** to `rollup_metrics`; user-chosen **custom ranges compute
live from `report_work_facts` and never persist** (§0057 custom semantics rule 3). Either way the
arithmetic is identical — see **§5.4** for the per-metric additivity class that makes an arbitrary
range correct.

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
| 20 | `discipline.overdue_open` | discipline | count | **`last`** (NOT `sum` — see §5.4) | open tasks past due, evaluated at range END / — | P J D C | ⚠ unsafe raw (load-dependent); pack shows trend only |
| 21 | `evidence.link_rate` | evidence | percent | ratio_of_sums | Σ `activity_linked_exact` / Σ `activity_events` | P D C | ⚠ unsafe (measures the linker, not the person) |
| 22 | `evidence.source_diversity` | evidence | count | **NOT SEEDED — document-derived** (see §5.4) | COUNT(DISTINCT source) unioned over the range / — | P D C | ⚠ unsafe (context: where evidence comes from) |

Nine appraisal-safe metrics feed the four appraisal axes; the other thirteen exist for ops truth
and report richness. `currency` is unused (no money metrics — payroll is a non-goal).

### 5.4 Range additivity — every metric classified (2026-07-30 amendment)

An arbitrary user-chosen range has an arbitrary day count and arbitrary partial weeks/months, so it
is where the average-of-averages failure (invariant 2) actually bites. Every metric is therefore
classified into exactly one of three classes, and **the class dictates the range query**:

| Class | Rule over ANY range (calendar or custom) | Metrics |
|---|---|---|
| **A · additive** | `Σ` the daily measure over `[start, end]`. Range length is irrelevant. | 1, 2, 6, 11, 15, 16, 17 |
| **R · ratio** | Recompute `Σ numerator / Σ denominator` over the range. **Never** the mean of the daily ratios. Where the denominator is *days* (7, 8, 10, 14, 19), it is **days-in-range** — computed from the range, not assumed to be 7 or 30. | 3, 4, 5, 7, 8, 9, 10, 12, 13, 14, 18, 19, 21 |
| **N · non-additive** | Cannot be derived from daily aggregates at all. Must recompute from underlying rows, or be refused for the range. | **20, 22** |

**Two defects this audit surfaced — they affect week and month too, not only custom ranges:**

**⚠ Substrate constraint that bounds the fix (verified 2026-07-30):**
`metric_definitions.aggregation_rule` carries `CHECK (aggregation_rule IN ('sum','ratio_of_sums',
'max','last'))` — [`0001_core.sql:83`](../../platform-nest/migrations/0001_core.sql). That vocabulary
is fixed, shared across every module, and this program does **not** alter it (same principle that
keeps `appraisalSafe` out of the shared table). So each non-additive metric must either map onto an
existing rule or not be seeded at all:

- **#20 `discipline.overdue_open` is point-in-time, not additive.** It counts open tasks past due
  *at an instant*. Summing it across a 30-day period counts the same still-overdue task 30 times and
  reports a wildly inflated number. Correct behaviour: evaluate it **as of the range's end date** and
  render it as a trend line over the range rather than a single summed KPI. Its `aggregation_rule` is
  therefore **`'last'`** — an exact fit within the existing vocabulary, no substrate change needed
  (was mistakenly written as an invented `point_in_time` rule, which would have failed the CHECK and
  broken migration 0059). TR-08 asserts a multi-day range does not multiply it.
- **#22 `evidence.source_diversity` is a distinct-count, not a sum.** `COUNT(DISTINCT source)` over a
  range is not the sum of daily distinct counts (a person using `pm` every day for 30 days is
  diversity 1, not 30). No existing `aggregation_rule` expresses a distinct-union — and `'max'` is
  wrong, not merely imprecise (Mon `{pm}`, Tue `{github}` → max daily distinct = 1, true distinct = 2).
  Resolution: **#22 is NOT seeded into `metric_definitions`.** It is computed at document-build time
  as a key-union over `report_work_facts.activity_by_source` (the JSONB column supports it directly)
  and carried as a `ReportKpi` with `distinctOver: true`. **0059 therefore seeds 21 metrics, not 22**,
  and the module's TS catalog marks #22 `seeded: false`. Rationale: a derived read-time stat is a far
  smaller change than widening an enum that every other module's rollup consumers switch on.

Both are cheap to get right and expensive to notice later, because each fails *upward* — a bigger,
more flattering-looking number that no one questions. `ReportKpi` for class **N** metrics carries an
explicit `pointInTime: true` / `distinctOver: true` marker so the viewer and the XLSX exporter label
them rather than letting a reader assume they are period totals.

**Percentiles stay deferred, with a constraint attached.** `report_work_facts` deliberately stores
additive counters only, so cycle-time p50/p85 genuinely cannot be computed from it at any range —
which is why §13 defers that metric wave. The constraint for whoever picks it up: percentiles must
be computed from a **per-completion row store** (one row per completed task with its duration), never
from daily aggregates and never by averaging daily percentiles. A "p85 of the daily p85s" is not a
p85 of anything.

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
   after the period cannot move an appraisal number (§0057).

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
export type ReportPeriodKind = "day" | "week" | "month" | "custom";
export type ReportUnit = "count" | "minutes" | "percent" | "score" | "text";

export interface ReportHeader {
  tenantId: string;
  grain: ReportGrain;
  scopeRef: string;            // userId | projectId | dept node id | tenantId
  scopeName: string;           // display name resolved at build time
  periodKind: ReportPeriodKind;
  periodStart: string;         // ISO date (inclusive)
  periodEnd: string;           // ISO date (inclusive)
  dayCount: number;            // inclusive days in range — the denominator for every per-day ratio (§5.4)
  periodLabel: string;         // display: "16 Jul 2026" | "Week 29 2026" | "July 2026" | "16 Jul – 3 Aug 2026"
  customLabel?: string;        // pinned custom ranges only (report_periods.label)
  generatedAt: string;         // ISO datetime
  sealed: boolean;
  periodId?: string;           // present when sealed OR pinned
  revision?: number;           // present when sealed
  // Comparison baseline. For a custom range this is the IMMEDIATELY PRECEDING EQUAL-LENGTH window
  // ([start − dayCount, start − 1]) — "previous period" is otherwise ambiguous for an arbitrary span.
  comparison?: { periodStart: string; periodEnd: string; dayCount: number };
  providerView?: { servedTenantId: string; servedTenantName: string }; // shared-service slice
  // Honesty flags — set at build time, rendered by the viewer AND carried onto every export (§6.3).
  // A user-chosen range will straddle these constantly; silence here would be a lie of omission.
  warnings?: {
    adHoc?: boolean;           // custom range: unsealed, not the authoritative record
    partialPeriod?: boolean;   // range cuts across an incomplete week/month
    endsInFuture?: boolean;    // periodEnd > today — trailing days have no data yet
    precedesFactHistory?: {    // range starts before TR-05 consumer go-live (§13 risk 2)
      firstFactDate: string;   // person-grain facts do not exist before this date
      affectedDays: number;
    };
    spansMembershipChange?: boolean; // a subject moved unit mid-range (§3.2) — dept totals split
  };
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
  // §5.4 class markers for the two non-additive metrics. The viewer and the XLSX exporter MUST
  // label these — without it a reader assumes any KPI on a 30-day report is a 30-day total.
  pointInTime?: boolean;       // #20: evaluated at range end, not summed across it
  distinctOver?: boolean;      // #22: distinct union across the range, not summed
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
| `GET /api/:t/reports/document?grain&scopeRef&periodKind&start[&end]` | THE read. Sealed period → stored document (latest revision, `?revision=` to pin); open period → live compute (lazy-backstop pattern). `periodKind=custom` **requires `end`** and always computes live | per-grain matrix |
| `GET /api/:t/reports/overview?grain&periodKind&start[&end]` | list of scopes + headline KPIs for the grain (console landing) | per-grain matrix |
| `POST /api/:t/reports/periods/pin {start, end, label}` | archive a user-chosen range as a labelled, snapshottable `period_kind='custom'` row (idempotent on the exact range). Still barred from appraisal | `reports.seal` (exec/lead) |
| `GET /api/:t/reports/periods?kind&from&to` · `GET …/periods/:id` | seal states + revisions | view |
| `POST /api/:t/reports/periods/:id/seal` | explicit seal (idempotent; 409 if sealed). **422 if `period_kind='custom'`** — ad-hoc ranges are never sealed (§0057 rule 2) | `reports.seal` (exec/lead) |
| `POST /api/:t/reports/periods/:id/amend {reason}` | flag amended + audit + notify; re-seal via `/seal` → revision+1 | `reports.seal` |
| `POST /api/:t/reports/export {grain, scopeRef, periodKind, start, end?, format: "pdf"\|"xlsx"\|"csv"}` | creates export job → `{jobId}`; `GET …/exports/:jobId` → status + download. PDF via sidecar (§6.3). An unsealed/custom range is exported with the `AD HOC · UNSEALED` mark (§6.3) | same as document read |
| `POST /api/:t/reports/facts/recompute {from, to}` | idempotent backfill window (admin/ops) | `reports.admin` |
| `GET /api/:t/reports/metrics?metricKey&grain&from&to` | raw series (power users/MCP). Calendar periods read `rollup_metrics`; an arbitrary `from`/`to` reads `report_work_facts` directly (§0057 rule 3) | per-grain matrix |

**Range validation (applies to every endpoint above that accepts `start`/`end`):** `end >= start`
(else 400); `end` required when `periodKind=custom` (else 400); `periodKind=custom` with a span
**> 400 days → 422** with `{error:"range_too_large", maxDays:400}` — an unbounded user-chosen range
is a trivial DoS on the fact scan, and 400 days covers "a year plus a comparison tail" which is the
real ceiling of a management pack. For non-custom kinds, `end` is ignored and derived from `start`.
`start`/`end` are interpreted in `REPORTS_TZ` (OQ-1), never in the caller's local zone.

**Check-ins — `checkins.controller.ts`:**

| Method + path | Purpose | Authz |
|---|---|---|
| `GET /api/:t/checkins/today` | `{expected, alreadySubmitted, draft}` — draft prefilled live from today's activity/time (<30s flow) | self |
| `POST /api/:t/checkins {date?, summary, blockers?}` | submit/confirm (today or yesterday-until-cutoff); records `edited`, `source` | self |
| `GET /api/:t/checkins?userId&from&to` | history (self; manager for own unit; HR) | matrix |
| `GET /api/:t/checkins/compliance?unit&periodKind&start[&end]` | compliance grid (expected/submitted/missed/excused); `custom` ranges supported on the same validation rules | lead/exec/HR |
| `POST /api/:t/checkins/:id/excuse {reason}` | manager/HR excuse (audited) | lead/HR |
| `GET /api/:t/checkins/pending-reminders?date` | internal for n8n: expected-but-missing list (+ WA identity link presence) | service/admin |

**Appraisals — `appraisals.controller.ts`:**

| Method + path | Purpose | Authz |
|---|---|---|
| `GET/POST /api/:t/appraisals/cycles` · `GET/PATCH …/:id` | cycle CRUD (weights, role weights, open/close) | HR-appraisal |
| `POST /api/:t/appraisals/cycles/:id/generate` | generate per-subject appraisals: freeze weights + `auto_inputs` from SEALED **calendar** periods covering the cycle range (409 if unsealed; **422 if any covering period is `period_kind='custom'`** — never a silent skip, §0057 rule 2) | HR-appraisal |
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
  export n/d columns — a spreadsheet user can re-aggregate without average-of-averages. The `KPIs`
  sheet carries a **class column** (`additive` / `ratio` / `point-in-time` / `distinct`) per §5.4, so
  a spreadsheet user re-summing a point-in-time metric across rows is warned in the artifact itself.
- **Ad-hoc marking (required, 2026-07-30 amendment):** any export of an **unsealed** period — which
  every transient custom range is by definition — is marked **on the artifact**: `AD HOC · UNSEALED ·
  as of <timestamp>` in the PDF `headerTemplate`/`footerTemplate` and in an `A1` banner cell plus a
  `Provenance` sheet in the XLSX, alongside the range and any `header.warnings` from §6.1. Rationale:
  this pack's whole audience is higher management, and a printed ad-hoc range is indistinguishable
  from the sealed record once it leaves the screen. Sealed exports instead carry
  `SEALED · rev N · <seal_hash prefix>`. ⚡ QA asserts the mark cannot be absent on an unsealed export.
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
| **Person** (any period kind) | KPI tiles (safe metrics + denominators) · activity trend line (events by day) · time-by-project donut · on-time vs completed grouped bars · check-in `CalendarHeatmap` · contributions table (contributor minutes on others' tasks) · evidence-by-source stacked bars |
| **Project** | Burndown + CFD (reused pm shapes) · throughput weighted bars · workload-by-person stacked bars · status/tag distribution donut · milestone table (due vs done) · reopen-rate trend · overdue table w/ task refs |
| **Department** | throughput + on-time trend lines · capacity vs logged area (utilization, ops-only) · per-person table with sparkline column (small multiples) · project portfolio table (health = on-time × reopen) · **served-companies split** (stacked bars per `servedTenant` — the shared-service view) · compliance heatmap |
| **Company** | dept-comparison grouped bars (throughput weighted, on-time, compliance) · cross-dept stacked area over time · unattributed-bucket tile (kept visible on purpose — it measures fabric health) · top risks/anomalies table (highlights) · exec KPI wall with deltas |

**Period selector + arbitrary ranges (2026-07-30 amendment).** Every grain's report surface carries
one shared control: **Daily · Weekly · Monthly · Custom range**, where Custom opens a date-range
picker (`start`/`end`, inclusive, `REPORTS_TZ`). The same chart set serves all four kinds — nothing
is period-specific, because the document contract is period-agnostic. Requirements the kit must meet:

- **X-axis bucketing scales to `header.dayCount`** — daily ticks up to ~45 days, weekly buckets to
  ~26 weeks, monthly beyond. A 400-day range must NOT render 400 points: it renders ~13 monthly
  buckets. Bucketing is a *display* transform over the daily series; the underlying numbers are never
  re-aggregated in the browser (that is the server's job, per §5.4).
- **Honesty chrome is not optional.** `header.warnings` renders as a banner above the charts —
  ad-hoc/unsealed, partial period, ends-in-future (trailing null gap, never zero-faked),
  pre-fact-history (with the affected day count), mid-range unit change. The `TrendLine` null-gap
  discipline already covers future days; the banner explains *why* the gap is there.
- **Comparison chip** shows the preceding equal-length window explicitly (`vs 16 Jun – 4 Jul`), not a
  bare "vs previous period" — for an arbitrary span the label must state what it compared against.
- **Preset shortcuts** on the picker (Last 7 / 30 / 90 days · This quarter · Last quarter · Year to
  date) — these are ordinary custom ranges, not new period kinds, which is what keeps quarterly and
  YTD reporting available without adding calendar machinery. If quarterly seals are later required
  for appraisal, that is a new calendar kind, not a preset (§0057 rule 4).

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
    description: "Fetch a person/project/department/company work report (ReportDocument JSON) for a day, week, month, or an arbitrary custom date range. For periodKind='custom', 'end' is REQUIRED and the range is computed live (unsealed, not appraisal-admissible); max span 400 days.",
    minAssurance: "low", method: "GET",
    pathTemplate: "/api/:tenantId/reports/document",
    inputSchema: { type: "object",
      properties: { tenantId: {type:"string"}, grain: {enum:["person","project","department","company"]},
                    scopeRef: {type:"string"}, periodKind: {enum:["day","week","month","custom"]},
                    start: {type:"string", description:"ISO date, inclusive"},
                    end: {type:"string", description:"ISO date, inclusive — REQUIRED when periodKind='custom', ignored otherwise"} },
      required: ["tenantId","grain","scopeRef","periodKind","start"] } },
  { name: "reports.listPeriods",
    description: "List report periods and their seal status/revisions (kind: day|week|month|custom — 'custom' rows are pinned ad-hoc ranges and are never appraisal-admissible)",
    minAssurance: "low", method: "GET", pathTemplate: "/api/:tenantId/reports/periods",
    inputSchema: { type: "object", properties: { tenantId: {type:"string"}, kind: {enum:["day","week","month","custom"]} }, required: ["tenantId"] } },
  { name: "reports.getMetrics",
    description: "Query a governed metric series (numerator/denominator) by metric key and grain over an arbitrary from/to window. Ratios must be read as numerator/denominator — never average the returned ratios across points (see the metric's additivity class).",
    minAssurance: "low", method: "GET", pathTemplate: "/api/:tenantId/reports/metrics",
    inputSchema: { type: "object", properties: { tenantId:{type:"string"}, metricKey:{type:"string"},
                    grain:{type:"string"}, from:{type:"string"}, to:{type:"string"} }, required: ["tenantId","metricKey"] } },
  { name: "reports.getCompliance",
    description: "Check-in compliance grid for a unit over a day/week/month period or a custom date range (expected/submitted/missed/excused)",
    minAssurance: "verified", method: "GET", pathTemplate: "/api/:tenantId/checkins/compliance",
    inputSchema: { type: "object", properties: { tenantId:{type:"string"}, unit:{type:"string"},
                    periodKind:{enum:["day","week","month","custom"]}, start:{type:"string"}, end:{type:"string"} }, required: ["tenantId"] } },
  { name: "checkin.getToday",
    description: "Get today's end-of-day check-in draft for the acting user (prefilled from their derived activity)",
    minAssurance: "low", method: "GET", pathTemplate: "/api/:tenantId/checkins/today",
    inputSchema: { type: "object", properties: { tenantId: {type:"string"} }, required: ["tenantId"] } },
  { name: "checkin.submit",
    description: "Submit the acting user's end-of-day check-in (summary + optional blockers). Acts only as the OBO user.",
    // CORRECTED 2026-07-31 (TR-11): was `"verified"` — which is UNREACHABLE for this exact flow.
    // mcp-hub's mintPrincipal() can never mint "verified" from a chat envelope (see
    // mcp-hub/src/principal.ts:23 — "verified principals will come from the platform IdP, never from
    // an envelope"), so the literal spec would have silently broken the WhatsApp check-in loop this
    // same section describes three lines later. The real bar is unchanged and is enforced where it
    // belongs — self-only + a D4-verified identity link, in the platform, proven by forgery-denial
    // tests. Matches the convention every other module tool here already uses.
    minAssurance: "low", method: "POST", pathTemplate: "/api/:tenantId/checkins",
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
**Scheduled seals are calendar-only.** No flow ever seals or pins a custom range — a user-chosen
range exists only as a live read (or a deliberate human pin, §0057 rule 4), so there is nothing for
a schedule to close. The nightly fact job is what makes every arbitrary range answerable: it keeps
the daily grain complete, and any range is then a query, not a job.
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

### P0 — substrate blockers (8 tickets) — ✅ **ALL 7 ORIGINAL TICKETS LANDED 2026-07-30** (TR-33 added at the end of the phase; see §15)

- **TR-01 · 0054 relational assignees + backfill** — `senior-db` · **opus·medium** (migration with
  real data-integrity risk: live-JSONB→relational backfill, partial-unique owner/responsible
  invariants; a wrong backfill silently corrupts every downstream attribution — cheap-then-escalate
  would waste a full re-run). Files: `platform-nest/migrations/0054_pm_task_assignees.sql`,
  `platform-nest/test/` RLS + backfill tests. Deps: none. ⚡
  Done when: table + constraints exist; backfill is idempotent (run twice → identical rows);
  every seeded task's blob round-trips to owner/responsible rows; FORCE-RLS sweep green.
- **TR-02 · PM dual-write + contributors API** — `senior-be`. Files:
  `platform-nest/src/modules/pm/pm.controller.ts` (+service), `platform-ui/src/lib/pm.ts`
  (additive `contributors` type only). Deps: TR-01. ⚡ (contract-touching)
  Done when: every assignee-writing path writes blob+rows in one tx; task GET carries
  `contributors[]`; PATCH add/removeContributor ops work; existing pm suite green byte-unchanged
  on old fields; drift-guard hook emits on mismatch.
- **TR-03 · 0055 org_unit_memberships** — `senior-db`. Files:
  `platform-nest/migrations/0055_org_unit_memberships.sql`, tests. Deps: none. ⚡
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

- **TR-31 · outbox actor propagation** — `senior-be`. **NEW 2026-07-30, uncovered by TR-05.** Files:
  the outbox `emitEvent` call sites in `pm.controller.ts` / `collab.controller.ts` /
  `meetings.controller.ts` / `pipeline.controller.ts` (payload gains the acting user id),
  `src/events/work-activity-consumer.ts` (map it to `actorUserId` instead of hardcoded `null`),
  `src/core/work-activity-linker.ts` (verify the `hint:actorId` rule then mints
  `target_kind='person'` links). Deps: TR-05. **BLOCKS TR-07.** ⚡
  Done when: a consumer-derived `work_activity` row carries the real `actor_user_id` for task, comment
  and doc events; the linker produces a `person` link with `confidence='exact'` from the hint (not a
  uuid-scan inference); a person-grain count of comments/docs over a seeded day is NON-ZERO and equals
  the number of actions that person actually took (the failure mode is a silent zero, so the test must
  assert a specific positive number, never just "no error"); events whose actor genuinely is a system
  or service still write `actor_user_id IS NULL` + `actor_external` and are excluded from person
  attribution rather than misattributed.

- **TR-32 · contributors FE wiring (PM console)** — `medior`. **NEW 2026-07-30, disclosed by TR-02.**
  TR-02 shipped the backend contributors surface (`contributors[]` on task reads,
  `addContributor`/`removeContributor` PATCH ops) and the additive `Contributor` type in
  `platform-ui/src/lib/pm.ts`, but deliberately stopped at the type — there is **no fetch wrapper and
  no UI**, so the capability is invisible to users today. Files: `platform-ui/src/lib/pmActions.ts`
  (the two action wrappers), the task-detail surface in the PM console (contributor list + add/remove),
  DEMO_MODE equivalents in `lib/demoPm.ts`. Deps: TR-02.
  Done when: a task-detail view lists contributors and can add/remove one; the `update`-gated (not
  `manage`-gated) permission boundary is respected in the UI; DEMO_MODE renders it backend-free; owner
  vs contributor is visually distinct, since owner-takes-all attribution means the distinction is
  load-bearing, not decorative.

- **TR-33 · exact person links on BACKFILLED activity** — `junior`. **NEW 2026-07-30, disclosed by
  TR-31.** `src/core/work-activity-backfill.ts` (the historical `activities`-table backfill tool)
  already sets `actorUserId` correctly from `activities.actor_id` — that was never broken — but its
  `hintPayload()` does not put `actorId` into the ingest payload, so backfilled rows get the right
  `actor_user_id` COLUMN while the linker can only reach them by uuid-scan (`confidence='inferred'`)
  or not at all. Consequence: historical person-grain **evidence/collaboration** links are weaker than
  live ones, which matters because this backfill is exactly what narrows the §13 risk-2 history gap.
  Files: `src/core/work-activity-backfill.ts` (+ its test). Deps: TR-31.
  Done when: a backfilled row whose `activities.actor_id` is known mints a `target_kind='person'` link
  with `confidence='exact'` and `rule='hint:actorId'`, matching the live consumer path; rows with a
  genuinely unknown actor still produce no person link rather than a guessed one.

### P1 — fact fabric + metrics (5 tickets, incl. TR-34/TR-35) — TR-06 + TR-07 ✅ **LANDED 2026-07-30** (see §15); TR-08 next

- **TR-06 · 0056 calendars/check-ins/facts + third wall** — `senior-db`. Files:
  `0056_module_reports_core.sql`, dedicated third-wall test (right tenant WITHOUT `reports` scope
  → zero rows). Deps: none. ⚡
- **TR-07 · nightly fact job + attribution engine** — `senior-be` · **opus·medium** (the
  correctness heart: owner-takes-all attribution with the unit/person split, no-double-count
  identities, idempotent DELETE+INSERT slices, cross-module `{reports,pm,hr}` scopes — a subtle
  join bug here silently corrupts company totals and only the reconciliation test would catch it
  months later). Files: `platform-nest/src/modules/reports/fact-job.ts`, `recompute` endpoint.
  Deps: TR-01..06. ⚡ ✅ **LANDED 2026-07-30** — `fact-job.ts` + the endpoint + a new Cerbos kind
  `report_admin`; 31 pure + 26 live-PG/Cerbos tests. Two substrate findings TR-08 must absorb (metric
  #3's missing denominator counter, §6.2's 422 body shape) are recorded in §15.
  Done when: recompute any (tenant, date) twice → byte-identical rows; §3.1 attribution table
  cases each pinned by a test (person-owner / unit-owner+responsible / unit-only / none);
  Σperson ≤ Σunit = company on seeded data; backfill over 60 historical days completes and
  converges.
- **TR-08 · 0059 metric seeds + RollupProvider** — `senior-be`. Files:
  `0059_report_metric_seeds.sql`, `src/modules/reports/metrics.ts` (catalog incl. appraisalSafe),
  provider registration in the module contract. Deps: TR-07.
  Done when: all 21 SEEDED §5 metrics upsert idempotently into `rollup_metrics` with correct n/d and
  dimensions per grain; `ratio_of_sums` verified against a hand-computed week.
  **+ Range additivity (§5.4) — the TS catalog carries an explicit class (`additive` / `ratio` /
  `point_in_time` / `distinct_over_range`) per metric. NOTE the split: that class is a *catalog* field
  only; the SEEDED `metric_definitions.aggregation_rule` must stay inside the existing
  `('sum','ratio_of_sums','max','last')` CHECK (0001_core.sql:83) — #20 seeds as `'last'`, and #22 is
  `seeded: false` (read-time derived, §5.4). Seeding an invented rule value fails the CHECK and breaks
  the migration. The two non-additive metrics are proven
  correct over a multi-day range: `discipline.overdue_open` (#20) evaluates at range END and a
  30-day range does NOT multiply it by ~30 (regression test — it fails upward, so it needs an
  explicit assertion), and `evidence.source_diversity` (#22) is a distinct union over the range, not
  a sum of daily distincts. Every day-denominated ratio divides by actual days-in-range, asserted on
  a deliberately awkward span (e.g. 11 days crossing a month boundary).**

- **TR-34 · as-of TASK OWNERSHIP (`pm_task_assignees` validity intervals)** — `senior-db` + `senior-be`
  · **NEW 2026-07-30, escalated by TR-07 — a real design gap, see §15 ①.** Today `pm_task_assignees`
  has no validity interval, so recomputing any past slice credits whoever owns the task **today**:
  reassign in September and August's numbers move. This is the same history-rewrite that
  `org_unit_memberships` closed for the *unit* axis, left open on the *ownership* axis. Files:
  a migration adding `valid_from`/`valid_to` (+ the `EXCLUDE`/partial-unique treatment TR-03 used for
  the one-open-row invariant), the dual-write in `pm.controller.ts` (close the old row, open the new
  one, rather than DELETE+INSERT), and as-of owner resolution in
  `src/modules/reports/fact-job.ts`. Deps: TR-01, TR-02, TR-07. **Sequence BEFORE P5 (appraisal).** ⚡
  Done when: reassigning a task does NOT change a recomputed prior-day fact row; the as-of resolver
  mirrors `resolveMembershipAsOf`'s semantics; the one-open-owner invariant is DB-enforced, not
  code-enforced; a backfill opens one interval per existing row dated from the task's creation.

- **TR-35 · per-day department for the discipline/effort metrics** — `senior-be`. **NEW 2026-07-31,
  disclosed by TR-08 (§15).** #14 `capacity_utilization`, #18 `checkin_compliance` and #19
  `time_logging_coverage` resolve the department ONCE as-of range-end, because their sources
  (calendars, check-ins) carry no department — while every fact-sourced metric splits per-day. A
  mid-month transfer therefore makes two metric families on the SAME report disagree about where
  someone worked. Files: `src/modules/reports/report-rollups.ts` (resolve per-day via the existing pure
  `resolveMembershipAsOf`). Deps: TR-08. ✅ **DEV-VERIFIED 2026-07-31** — `computeCalendarMetrics`'s
  department-grain bucketing (checkin_compliance/time_logging_coverage/capacity_utilization) now
  resolves via `resolveMembershipAsOf` per (user, day) instead of once at range-end; person/company
  grain untouched (never depended on department). New DB suite (`report-rollups.db.test.ts`, "TR-35"
  describe block) seeds a mid-week transfer and asserts the fact-sourced `effort.minutes_logged`
  (department grain) and the calendar-sourced `discipline.time_logging_coverage` land on the SAME
  per-department day counts, with the two departments' day-shares summing to the full range. Full
  `src/modules/reports/` suite green (84 tests incl. the 5 new TR-35 cases) except
  `fact-job.db.test.ts` (7 failing) — confirmed pre-existing/unrelated: fails identically in
  isolation, caused by TR-34's in-flight `pm_task_assignees` interval migration
  (`0063_pm_task_assignee_intervals.sql`, untracked) landing concurrently in the same working tree,
  not by this ticket's diff (scoped to `report-rollups.ts` + its test file only).
  Done when: a person transferring mid-range has their check-in compliance and utilization SPLIT across
  both departments in the same proportion as their fact-sourced metrics; a test asserts the two families
  agree on the split date.

### P2 — check-ins (5 tickets, incl. TR-38/TR-39)

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

- **TR-39 · self may read their OWN compliance row** — `senior-be`. **NEW 2026-07-31, disclosed by TR-10
  (§15).** `GET /checkins/compliance` is structurally self-⛔, so a person cannot see the official
  compliance number that feeds their appraisal (metric #18 is appraisal-SAFE). TR-10 had to compute a
  second, divergent self-formula in `platform-ui/src/lib/checkins.ts`. Files:
  `src/modules/reports/checkins.controller.ts` (+ the Cerbos `checkin` policy: self ⊆ compliance scope for
  own row only), then DELETE the divergent FE formula and repoint `CheckinCard`/`PersonCharts` at the
  official grid. Deps: TR-09, TR-10. Fold into **TR-25**'s authz pass.
  Done when: a person reads their own compliance row and it is **numerically identical** to what their lead
  sees for them (assert equality, not merely that both return a number); a person still cannot read anyone
  else's row; the FE has exactly ONE compliance formula.

### P3 — report documents + viewer + charts (6 tickets)

- **TR-13 · ReportDocument builder (live path)** — `senior-be`. Files:
  `src/modules/reports/document-builder.ts`, `reports.controller.ts` (document/overview/metrics).
  Deps: TR-07, TR-08.
  Done when: all four grains × **four** period kinds (day/week/month/**custom**) build from facts/
  rollups/snapshots; ratios carry n/d; comparison deltas correct across month boundaries; provider
  view slices by servedTenant.
  **+ Custom ranges (2026-07-30 amendment): `periodKind=custom` requires `end`, computes live from
  `report_work_facts` (never touches `rollup_metrics`, §0057 rule 3), sets `header.dayCount` +
  `periodLabel` + every applicable `header.warnings` flag, and compares against the immediately
  preceding equal-length window. Range validation per §6.2 (`end >= start` → 400; > 400 days → 422
  `range_too_large`). Asserted: a custom range exactly equal to a calendar month yields numbers
  IDENTICAL to that month's sealed document (the additivity proof), and a range with zero facts
  returns an empty-but-valid document rather than an error.**
- **TR-14 · 0057 periods/documents** — `senior-db`. Files: `0057_report_periods_documents.sql` +
  third-wall test. Deps: TR-06. ⚡
- **TR-15 · sealing / amend / audit** — `senior-be`. Files: seal service + endpoints + outbox
  events. Deps: TR-13, TR-14. ⚡
  Done when: seal → stored docs at revision N; post-seal task edit changes live view but NOT the
  sealed document (pinned test); amend requires reason, notifies, re-seal writes N+1 keeping N;
  seal_hash verifies; double-seal → 409.
  **+ Custom-range bars (§0057 rule 2): sealing a `period_kind='custom'` row → 422 with the explicit
  message, never a silent skip (⚡QA asserts this specific bypass). Also owns the `periods/pin`
  endpoint (rule 4): labelled, idempotent on the exact range, snapshottable, still appraisal-barred.**
- **TR-16 · chart kit + viewer design** — `senior-uiux` (load the `dataviz` skill first —
  binding). Files: `platform-ui/src/components/reports/charts/*`, viewer layout. Deps: TR-13
  shapes (can start from the §6.1 contract).
  Done when: all §7 components render from document JSON alone; light/dark + print CSS verified;
  aria/data-table fallback present; zero external deps (CSP holds).
  **+ The Daily/Weekly/Monthly/Custom period selector with a date-range picker + presets (Last 7/30/
  90 · This & last quarter · YTD), x-axis bucketing that scales to `header.dayCount` (a 400-day range
  renders ~13 monthly buckets, NOT 400 points), the `header.warnings` banner, and a comparison chip
  naming the actual baseline window ("vs 16 Jun – 4 Jul"), plus the `pointInTime`/`distinctOver` KPI
  labels from §5.4.**
- **TR-17 · grain report pages + wiring** — `senior-fe`. Files: report routes per grain,
  `lib/reports.ts`. Deps: TR-13, TR-16.
  Done when: person/project/department/company pages render live + sealed states, revision picker,
  403 limited-access branch (rollups precedent), `BackendPending` for absent periods.
  **+ The period selector is wired on all four grain pages with the range in the URL (shareable/
  bookmarkable `?periodKind=custom&start=&end=`), and the 422 `range_too_large` renders as a usable
  message ("narrow the range — max 400 days"), not a crash.**
- **TR-18 · XLSX/CSV export service** — `medior`. Files: export service (`exceljs`), export
  endpoints. Deps: TR-13; OQ-2 ratified.
  Done when: XLSX sheets match §6.3; n/d columns present; 10k-row table exports under 5s;
  CSV matches DataTable conventions.
  **+ The §5.4 class column on the `KPIs` sheet, and the `AD HOC · UNSEALED · as of <ts>` A1 banner +
  `Provenance` sheet on any unsealed/custom-range export (⚡ asserted present — an unsealed export
  that looks sealed is the failure mode that matters, since these packs get printed and circulated).**

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

- **TR-23 · 0058 appraisal tables** — `senior-db`. Files: `0058_report_appraisals.sql` +
  third-wall test + ack-append-only test. Deps: TR-14. ⚡
- **TR-24 · appraisal engine + endpoints** — `senior-be`. Files:
  `src/modules/reports/appraisals.controller.ts` + engine (cohort percentile bands, weight
  resolution, deviation-justification + commentary enforcement, evidence pinning, stale flag).
  Deps: TR-15, TR-23.
  Done when: generate freezes weights+auto_inputs from sealed periods only (unsealed → 409);
  submit rejects commentary <50 chars and unjustified >±1-band deviations; ack trail append-only;
  amend of a pinned revision flips `evidence.stale` and blocks finalize until re-confirm.
  **+ Generate rejects a `period_kind='custom'` covering period with 422 (§0057 rule 2) — an
  appraisal must never rest on an ad-hoc range, and a silent skip would be worse than a hard failure
  because it would produce a plausible-looking pack from the wrong evidence (⚡QA asserts it).**
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
  **+ The range params are in the tool schemas (`periodKind` incl. `custom`, `end`) so an agent can
  ask for an arbitrary window, and the `reports.getMetrics` description states the ratio rule — an
  agent averaging returned ratios is the same average-of-averages defect at the far end of the pipe.
  The `periods/pin` write is deliberately NOT exposed over MCP (an agent should not be minting
  archived management artifacts).**
- **TR-29 · program reconciliation gate** — `qa`. Deps: all. ⚡ (the merge gate for the program)
  Done when: on a seeded multi-dept + shared-service dataset: Σperson ≤ Σdept == company with the
  unattributed bucket explicit; transfer mid-month attributes each half correctly; sealed-number
  immutability under post-hoc edits; PDF/XLSX/web/MCP all serve identical numbers for one document.
  **+ Range equivalence proof: a custom range spanning exactly one calendar month returns numbers
  identical to that month's sealed document, and a custom range spanning exactly 7 days matches the
  corresponding weekly document — across all four grains. If those don't match, the additivity
  invariant is broken somewhere and every arbitrary range in the product is quietly wrong.**
- **TR-30 · docs + seed + registry sweep** — `junior` (Haiku). Files: `docs/modules/MODULES.md` +
  `CHANGELOG.md` bumps as phases land, `FRONTEND-BFF-CONTRACT.md` §15 status flips, demo seed
  extension (`npm run seed:agency` gains check-ins/facts). Deps: trailing each phase.

**Totals:** P0=**8** · P1=**5** · P2=**6** · P3=6 · P4=4 · P5=4 · P6=4 → **39 tickets** (TR-31/32/33 added during P0, TR-34/TR-35 during P1, TR-36/37 fixed inline during P1/P3, TR-38/39 during P2/P3 — every one uncovered by a landed ticket rather than by design review; see §15), 3 Opus-tagged
(TR-01 opus·medium, TR-07 opus·medium, TR-25 opus·high), 12 ⚡ QA-gated.

---

## 13. Open risks + deliberate deferrals

**Risks:**
1. **Docker builds unverified in this dev env** (no Docker): `report-renderer` follows
   ai-gateway-go's caveat — validate on a Docker host before deploy (TR-19 runbook note).
2. **Pre-TR-05 history gap:** person-grain completion facts start at consumer go-live; project
   grain backfills from 0040/0042 snapshots. First sealed month = first appraisal-grade month.
   Communicated in-product on any pre-go-live period.
3. **A custom range straddles the honesty edges more often than a calendar period does** — partial
   weeks/months, future end dates, pre-TR-05 start dates, and mid-range unit transfers. Mitigated by
   the mandatory `header.warnings` flags (§6.1) rendered as viewer chrome AND carried onto exports;
   the residual risk is a user ignoring the banner. Accepted: the alternative (refusing such ranges)
   would make the feature useless for exactly the exploratory questions it exists to answer.
4. **Membership backfill approximation:** pre-adoption facts resolve to the person's *current*
   unit (§3.2). Amendable via manual membership rows; disclosed on affected sealed documents.
5. **Dual-write drift** (blob vs rows): mitigated by same-tx writes + the nightly drift guard;
   the authority flip is deferred until a zero-drift period is observed.
6. **`UNIQUE NULLS NOT DISTINCT`** requires PG15+ — assert the Postgres version in migration 0056
   (fail loud, not subtle).
7. **On-time flag uses due date at compute time** — a due-date edit before the seal shifts it;
   after the seal it cannot. Accepted and documented; per-completion due-date snapshots would need
   event payload enrichment (deferred).
8. **Suite cost:** schema-per-file harness (~7 min full run) grows with the new suites — keep the
   module's suites lean; the reconciliation gate (TR-29) is one file, not many.
9. **Unbounded range scans:** the 400-day cap (§6.2) bounds the worst case, but a 400-day
   company-grain read still scans every person×project row for that window. Mitigation is the
   existing `ix_rwf_*` index set plus bucketed aggregation in SQL; if it proves slow in practice the
   answer is a materialized monthly pre-aggregate, NOT raising the cap.

**Deliberately deferred (out of v1):**
- Per-unit / per-person calendars and per-tenant timezones (one tenant calendar + one deployment
  TZ v1 — OQ-1).
- Assignee authority flip (rows → source of truth, blob derived).
- Appraisal calibration across managers (cross-cohort normalization meetings) — process, then
  maybe tooling.
- Cycle-time / blocked-dwell metrics needing full status-history reconstruction (needs TR-05 data
  accumulated first; add in a later metric wave). **Constraint for whoever picks this up (§5.4):
  percentiles MUST be computed from a per-completion row store — one row per completed task with its
  duration — never from `report_work_facts` daily aggregates and never by averaging daily
  percentiles. "p85 of the daily p85s" is not a p85 of anything.**
- **Quarterly / annual as real calendar kinds.** Covered for v1 by custom-range presets (This
  quarter / YTD), which are live and exportable but never sealed. If quarterly *appraisal* cycles are
  wanted (OQ-3 currently recommends monthly), a `'quarter'` `period_kind` + a quarterly seal flow is
  the correct addition — not a pinned custom (§0057 rule 4).
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

---

## 15. Amendment log

**2026-07-30 · custom date ranges (owner requirement).** The period model was `day|week|month`
only; the owner requires **daily / weekly / monthly AND a user-chosen arbitrary date range** as a
first-class read across all four grains, including export. Changed:

- **§0057 DDL** — `period_kind` gains `'custom'` + a `label` column (required for custom rows). The
  plain `UNIQUE(tenant, kind, start)` is replaced by **two partial unique indexes**, because two
  different custom ranges may legitimately share a start date (`Jan 1–Jan 31` vs `Jan 1–Mar 31`),
  which the old key would have rejected: calendar rows keep exact one-row-per-start, pinned customs
  dedupe on the exact range.
- **§0057 semantics** — four rules added: transient customs create no row; customs are never sealed
  and never appraisal-admissible (422, never a silent skip); customs never persist to
  `rollup_metrics` (an unbounded range set would bloat the governed registry); pinning is the
  deliberate, privileged archive path.
- **§5.4 NEW · range additivity** — every metric classified additive / ratio / non-additive. **This
  audit found two real defects that affect week and month too, not just custom ranges:** #20
  `discipline.overdue_open` is point-in-time and would have been multiplied by the day count when
  summed over a period (a 30-day report showing ~30× the true overdue count), and #22
  `evidence.source_diversity` is a distinct-count that is not the sum of daily distinct counts. Both
  fail *upward* — a bigger, more flattering number nobody questions — so both now carry explicit
  aggregation rules, `ReportKpi` markers, and regression assertions on TR-08.
- **§6.1 contract** — `periodKind` gains `'custom'`; header gains `dayCount`, `periodLabel`,
  `customLabel`, an equal-length-preceding-window `comparison`, and a `warnings` block
  (ad-hoc / partial-period / ends-in-future / precedes-fact-history / spans-membership-change).
  `ReportKpi` gains `pointInTime` / `distinctOver`.
- **§6.2 endpoints** — `end` param across document/overview/export/compliance; new
  `POST /reports/periods/pin`; explicit validation block (400 on bad range, **422 `range_too_large`
  past 400 days** — an unbounded user-chosen range is a trivial DoS on the fact scan); seal and
  appraisal-generate documented as rejecting customs.
- **§6.3 exports** — an unsealed/custom export is marked **on the artifact** (`AD HOC · UNSEALED ·
  as of <ts>` in the PDF header/footer, A1 banner + `Provenance` sheet in XLSX), because this pack's
  audience is management and a printed ad-hoc range is otherwise indistinguishable from the sealed
  record. XLSX `KPIs` sheet gains the §5.4 class column.
- **§7 charts** — the Daily/Weekly/Monthly/Custom selector + range picker with presets (Last 7/30/90,
  this & last quarter, YTD), `dayCount`-scaled x-axis bucketing (400 days → ~13 monthly buckets, not
  400 points), warnings banner, and a comparison chip naming the actual baseline window.
- **§9.2 MCP** — range params in the tool schemas so agents can query arbitrary windows; the ratio
  rule stated in `reports.getMetrics`'s description; `periods/pin` deliberately not exposed.
- **§10 scheduling** — scheduled seals are calendar-only; the nightly fact job is what makes any
  arbitrary range answerable as a query rather than a job.
- **§12 tickets** — folded into existing tickets (TR-08, TR-13, TR-15, TR-16, TR-17, TR-18, TR-24,
  TR-28, TR-29) rather than adding a phase. **Ticket count unchanged at 30**; TR-13 and TR-16 gain
  the most scope. Quarterly/annual as real calendar kinds noted as deferred (presets cover v1).

**2026-07-30 (TR-01 landed) · migration range REBASED +4, and three DDL defects fixed in flight.**

`0050`–`0053` were consumed by concurrent work (`pm_short_codes`, its backfill fix,
`pipeline_stage_idempotency`, `search_provider_incurred_cost`) while this doc was being written, so
the block rebased: **TR-01 shipped as `0054_pm_task_assignees.sql`** and the range is now
**0054–0059** (TR-03 → `0055`, TR-06 → `0056`, TR-14 → `0057`, TR-23 → `0058`, TR-08 → `0059`).
Every §4 heading, DDL comment and ticket reference in this doc was renumbered accordingly.

> **⚠ PROCESS RULE for every remaining migration ticket:** another session is adding migrations to
> this repo concurrently. **Claim your number at implementation time** (`ls platform-nest/migrations
> | tail -1`), do NOT trust the number written in this doc — it was already overtaken twice. If it
> has moved again, take the next free number, ship, and record the rebase in
> `platform-nest/migrations/README.md` as TR-01 did.

Defects TR-01 found in this doc's own §4 DDL, all fixed in the shipped migration:

1. **The backfill as specified would ABORT the migration on live data.** `validAssignee()`
   (`pm.controller.ts:297`) only checks that `refId`/`responsibleId` are non-empty *strings* — never
   that they are UUIDs or reference a real user. A person-kind blob with a non-UUID `refId` raises
   invalid-input-syntax; a UUID absent from `users` raises an FK violation; either kills the whole
   transaction. The shipped backfill resolves person refs defensively (UUID-shaped **and** present in
   `users`), skips what it cannot represent, and reports the skip count — never inventing a person.
2. **Missing tenant guard on the FK.** The doc specified `task_id uuid REFERENCES pm_tasks(id)`.
   FK checks bypass row security on the referenced table, so that form accepts a row whose
   `tenant_id` is tenant A while its `task_id` belongs to tenant B — and no RLS-scoped SELECT could
   ever surface it. On the substrate every outcome credit and appraisal number derives from, that is
   cross-tenant attribution smuggling. Replaced with a composite FK
   `(task_id, tenant_id) → pm_tasks(id, tenant_id)`, exactly as `0027` closed this class on
   `service_assignments.unit_id`, which required an additive `UNIQUE (id, tenant_id)` on `pm_tasks`
   (cannot fail on existing data — `id` is already the PK). **Apply this same composite-FK form to
   every remaining table in this program that references a tenant-scoped parent.**
3. **Dual-representation drift was unconstrained** — a person row's `assignee_ref` and `user_id`
   could disagree, the exact failure the table exists to eliminate. Now a CHECK.

**`origin_site` inconsistency — settled here (TR-01 asked).** The pm_* precedent
(0036/0038/0040/0041/0043/0044) declares `origin_site text NOT NULL` with **no default**, forcing the
app to pass `config.originSite`; this doc had written `DEFAULT 'central'` on all six of its tables. A
default is wrong under the sync engine's site/central topology — a site-originated row silently
mislabels itself as central. **Ruling: `0055`–`0059` declare `origin_site text NOT NULL` with NO
default.** `0054` keeps its default harmlessly (its only writer, the backfill, inherits `origin_site`
from the parent task), but **TR-02's dual-write MUST pass `config.originSite` explicitly** rather than
relying on it.

**A harness trap TR-01 proved, which every later migration ticket must respect.** `initTestDb()` runs
`migrate()` as the **superuser**, which bypasses RLS — so a backfill that silently no-ops in
production still passes a normal test run. TR-01 verified this by mutating its own migration into the
0050 failure mode: **11 of 12 tests still passed**, including the round-trip and idempotency tests.
Only a test that re-executes the migration's own SQL through the app's NOSUPERUSER/NOBYPASSRLS role
with no tenant GUC set catches it. `lint:migration-rls` does **not** catch this file either — its
`createdHere` carve-out skips DML whose *target* is created in the same migration, but the risk here
is on the *source* side (`pm_tasks`). **Every migration in this program that backfills must ship that
NOBYPASSRLS-role test.** Also settled by TR-01: soft-deleted tasks ARE backfilled (attribution history
should survive archiving), so **reporting queries must filter `pm_tasks.deleted_at` themselves**.

**2026-07-31 (TR-19 landed — `report-renderer` 0.1.0 DEV-VERIFIED) · and an ESTATE-WIDE assumption was
overturned: DOCKER IS AVAILABLE in this dev environment.**
New standalone component `report-renderer/` (Node+Express+Playwright, ~85 lines of service + an auth/SSRF
guard), on `mcr.microsoft.com/playwright:v1.61.1-noble` with `playwright` pinned to **exact** `1.61.1`
(no caret — it must match the browser build baked into the base image), running as non-root `pwuser`.
Wired into all three compose files (internal-only in vps, dev port 3007 in local), the CI unit-test matrix,
the release image build/sign/SBOM/SLSA matrix, and `deploy.yml`'s cosign-verify list. Print technique lifted
from `docs/blueprints/render-pdf.js` as instructed.

- **⚡ THE FINDING THAT MATTERS BEYOND THIS TICKET: Docker Desktop *was* available, contradicting both my
  brief and this estate's standing "no Docker in the dev env" caveat.** So TR-19 did not stop at unit
  tests — it **built the image, ran the container, and produced a genuine PDF** (`PDF document, version
  1.4, 1 page(s)`, 12,348 bytes) via real `chromium.launch()` → `page.pdf()`, then verified the full
  auth/SSRF matrix **through the compose-managed container**: 401 no token · 401 wrong token · **403
  disallowed origin** · 200+PDF allowed origin. Compose config validated across all three files (20
  services). Containers and the dummy `.env` torn down afterward.
  **Estate-wide consequence:** `ai-gateway-go`, `render-gateway-go` and others carry an unverified-
  docker-build caveat premised on Docker being unavailable here. **That premise is stale — those caveats
  can now be closed by actually building.** This belongs to whoever owns infra, not to this program, but
  it is the single most reusable thing this ticket produced.
- **The SSRF guard is the right shape.** This service renders whatever URL it is handed, so
  `isAllowedRenderUrl` enforces same-origin against `PLATFORM_UI_INTERNAL_URL` — a leaked `RENDERER_TOKEN`
  therefore cannot turn it into an arbitrary-URL fetcher on the internal network. Verified live (403), not
  merely unit-tested.
- **Honest gap, correctly stated:** only Docker Desktop was exercised, never the real Linux VPS, so both
  the runbook and `MODULES.md` flag "re-confirm health on the actual VPS" as outstanding. `0.1.0
  DEV-VERIFIED` is the correct status per the house vocabulary — exercised end-to-end on the local stack,
  explicitly **not** production-verified.

**2026-07-31 (TR-18 + TR-11 landed) · export + the WA check-in loop; ONE blueprint contract corrected.**
TR-18: `report-export.ts` + the export/status/download endpoints, `exceljs` ratified (MIT, server-only,
zero attributable advisories) — **272 reports-module tests**. TR-11: the two check-in MCP tools, a minimal
`POST /admin/notify` on the bot, three n8n flows, and a new `GET /checkins/missed-yesterday` —
**274 reports-module tests · wa-chat-bot 480/480 · mcp-hub 106/106**, `tsc` clean across all three.

- **⚠ BLUEPRINT BUG CORRECTED · §9.2's `checkin.submit: minAssurance: "verified"` was UNREACHABLE.**
  Verified at source: `mcp-hub/src/principal.ts:23` — *"verified principals will come from the platform
  IdP — never from an envelope."* So the literal spec would have **silently broken the exact WhatsApp
  check-in loop §9.2 describes three lines later**: every chat-originated submit would have failed the
  rank check. Shipped as `"low"`, matching the convention every other module tool here uses, with the real
  bar enforced where it belongs — **self-only + a D4-verified identity link, in the platform**. Not a
  security relaxation: TR-11 proved it with forgery-denial tests (a body-supplied `userId`/`subjectUserId`
  is ignored; an unverified link gets 400; two identities never cross-attribute). §9.2 is corrected inline.
  **The lesson: an assurance tier written into a contract without checking what the minting layer can
  actually produce is a spec that fails closed on its own happy path.**
- **TR-18's security improvement beyond spec:** it re-authorizes on **status and download**, not only at
  create, using the identical `authorizeReportDocumentRead` a document read uses — so access revoked
  *after* generation is caught at download. Also: percent values export **0–100 uniformly** (stated in the
  `Provenance` sheet, so a spreadsheet user doing arithmetic knows which they hold), PDF returns an
  explicit 400 rather than silently downgrading, and 10k rows export in **316ms** against a 5s bar.
- **TR-18 workarounds to revisit if the export surface grows** (both disclosed, neither hidden): generation
  is **synchronous** because no job table exists and migrations were off-limits — `status` is typed as a
  literal union so PDF can add `queued`/`processing`/`failed` without reshaping; and `grain`/`scopeRef` are
  **encoded into the storage key** because `files` has no metadata column and department scopeRefs
  (`'d-hr'`) aren't UUIDs. Round-trip tested, but it is a workaround, not a design.
- **TR-11's disclosed limits:** the bot's pending-reminder state is **in-memory**, so a restart drops
  in-flight reminders (a late "ok" falls through to normal Q&A rather than erroring); `missed-yesterday`
  assumes a lead is a member of the unit they lead — a lead placed outside their unit is **skipped rather
  than broadcast**, which is the correct failure direction. The literal WA round trip was **NOT** driven
  (the live containers run pre-built GHCR images, so source changes need a rebuild) and the n8n flows are
  **structure-validated but not fired** — stated plainly, matching this repo's own `mtg-dispatcher.json`
  precedent. **TR-12 should close the "authored but unexercised" gap where it can.**
- The other four §9.2 MCP tools (`reports.getDocument`/`listPeriods`/`getMetrics`/`getCompliance`) remain
  unregistered — that is **TR-28**'s surface, correctly out of TR-11's scope.

**2026-07-31 (TR-15 landed — ⚡ gate PASSED) · SEALING WORKS. P3 substantially complete.**
`report-seal.ts` + `report-periods.ts` + the §6.2 period/seal/amend/pin routes + the sealed-read branch
inserted **before** TR-13's live path (builder not forked). **214 reports-module tests green**, `tsc` clean
under `modules/reports`, `lint:withtenants` clean (185 files) — verified independently by the architect
after the agent hit a usage cap on its final check.

Every acceptance bar is pinned by a *named* test, and it closed two bypasses that were not specified:
- **`?revision=` to a NONEXISTENT revision → 404, never a silent fallback to another revision.** A silent
  fallback would have let an appraisal cite "revision 3" while reading revision 1's numbers.
- **`amend` on a non-sealed period → 409**, so "amended" can never describe a period that was never sealed.
Also pinned: seal → docs at revision 0 across all four grains · **post-seal task completion changes the
LIVE view but NOT the sealed document** (the ticket's whole point) · double-seal → 409 · `seal_hash`
recomputes and matches · amend → re-seal writes revision 1 **keeping revision 0's rows** · `?revision=0`
returns the pre-edit numbers · **rule 2: sealing a `period_kind='custom'` row → 422 with the exact
message, never a silent skip** · rule 4: pin idempotent on the exact range · a plain member is DENIED
seal/amend/pin (403) but CAN view periods.

**Consequence: the two accepted limitations are now contained.** `overdue_open` reading today's state, and
any post-hoc drift, can no longer reach a sealed period. **Sealing is available before the first appraisal
period, which is what TR-14's warning required.**

**2026-07-31 (TR-10 + TR-38 landed) · check-ins are usable; ONE fairness gap found (TR-39).**
`CheckinCard` on My Work with four distinct branches (excused / submitted / not-expected / confirm-and-edit),
the compliance heatmap wired onto the person report via TR-16's existing `CalendarHeatmap`, stateful
DEMO_MODE fixtures seeding all four states. **836/836 platform-ui tests**, `next build` clean, Playwright
light+dark across both a manager and an IC identity.
- **Interaction count MEASURED, not estimated:** accept the draft as-is = **1** interaction; edit then
  submit = **2**; with the optional blockers field = **3** ceiling. Asserted directly in tests, so the
  ≤30s requirement is defended by the test suite rather than by intent.
- **⚠ TR-39 (NEW — fairness, not plumbing): a person cannot see their own official compliance number.**
  `GET /checkins/compliance` is structurally self-⛔ (TR-09's own comment says so), so TR-10 had to compute
  self-compliance from the history endpoint with a **deliberately different formula**, documented at length
  in `lib/checkins.ts`. That divergence is the honest workaround, but the underlying policy is wrong for
  this program: **metric #18 `checkin_compliance` is appraisal-SAFE and feeds an appraisal axis.** A subject
  who will be judged on a number must be able to see *that* number, not a second computation of it — the
  same principle as §11's transparency stance and the appraisal acknowledgement trail. **Fix: permit self
  to read their OWN row from `/checkins/compliance` (self ⊆ scope), then delete the divergent FE formula.**
  Route through TR-25's authz pass. Until then, two different compliance numbers for one person can exist.
- Caught before shipping: a demo seed whose fixed calendar offsets could land missed/excused days on a
  weekend depending on the real wall-clock date, silently skipping the state it meant to seed — fixed to
  assign by position among *working* days. Also found a live environment trap: `.env.local` had
  `DEMO_MODE=` blank while a real backend was up on :3004, silently defeating DEMO_MODE; it set it for the
  run and **restored the original value byte-for-byte** after.

**2026-07-31 (TR-17 landed) · THE REPORTS ARE VISIBLE.** Four grain routes under
`platform-ui/src/app/(app)/reports/{person,project,department,company}`, a typed BFF client
(`lib/reports-data.ts`), per-grain chart compositions over TR-16's kit, DEMO_MODE fixtures for all four
grains, and a gated "Reports" nav group. **806/806 platform-ui tests** (up from 768), `tsc` clean,
`next build` clean, and a **Playwright light+dark pass** across every state: sealed-vs-live, all five
warning flags, the comparison chip, `pointInTime`/`distinctOver` badges, the 403 branch per grain, the
422 range-too-large, and a custom range with week-bucketed axis.

- **Ruling 1 (screenshot, don't just build clean) paid for itself immediately — three real bugs a green
  build passed:**
  1. **A percent-unit bug in TR-16's `ReportTableView` that affects the REAL backend, not just demo:**
     percent columns rendered the raw fraction (`0.86`) while `KpiTiles` a few rows above rendered `86%`.
     Two different numbers for the same value on one page. Fixed with a unit-aware `formatCell`.
  2. **Demo calendar-range bug:** `periodKind=month|week` with only `start` (the default request shape)
     resolved to a **1-day** range, so every chart read "not enough history". Fixed by mirroring the real
     backend's `resolveCalendarRange`, with a regression test. Worth noting the shape of this one — the
     demo layer diverging from the backend's range resolution is the same class as the org-blob fixture
     bug (TR-37): **a stand-in for another module's behaviour, written from assumption rather than from
     that module's code.**
  3. Demo narrative embedded a lowercased company name mid-sentence, unlike the real backend's shape.
- **Tooling gotcha recorded for TR-20's print work:** the app shell scrolls inside `main.erp-main`, not
  `document.body`, so a naive Playwright full-page screenshot **silently truncates**. Strip the inner
  overflow before shooting.
- **Honest omissions (each degraded, none stubbed as an empty frame):** the person-grain check-in
  `CalendarHeatmap` is unwired because compliance lives behind `GET /checkins/compliance` — which **TR-09
  has since shipped**, so this is now a small closable gap (logged as **TR-38**), not a blocker. The
  revision picker renders `BackendPending` because `GET /reports/periods` has no controller route yet —
  **that is TR-15's**, landing next. Burndown/CFD, workload-by-person, status/tag donut, milestone table,
  capacity-vs-logged, cross-dept area and the unattributed-bucket tile are all absent from the live
  document (TR-13's disclosed subset) and were correctly omitted rather than framed empty.

**2026-07-31 (TR-13 + TR-14 landed) · reports are readable; ONE live-data defect fixed inline (TR-37).**
TR-13 shipped `report-document.ts` (the backend mirror of TR-16's FE contract, field-for-field),
`document-builder.ts`, the three §6.2 read endpoints, `resource_report_document.yaml` + an `hr_people_ops`
derived role — **184 reports-module tests green**. TR-14 shipped `0067_report_periods_documents.sql`
(23/23) — note the number: the doc said `0057`, the README guessed `0058`; the real head had moved to
`0066` via concurrent search-marketing work. **The additivity proof HOLDS:** a custom range equal to a
calendar month, and to a calendar week, returns byte-identical KPI values/numerators/denominators.

- **⚠ TR-37 (fixed inline by the architect): `deriveUnitDepartments()` was reading the org blob at the
  WRONG NESTING LEVEL, so department roll-up silently returned an EMPTY map against all real data.**
  `company_org_structure.structure` is stored **wrapped** as `{root: OrgNode}` —
  `sanitizeStructure()` (`admin/company-admin.controller.ts`) is its only writer and always wraps. But
  `fact-job.ts:872` and `report-rollups.ts:363` passed the **wrapper** into a function expecting a root
  node, so `node.kind`/`node.children` were `undefined`, the walk terminated immediately, and
  **division → parent-department rolling no-op'd entirely: anyone placed under a DIVISION got no
  department attribution at all.** Since the estate's org charts are departments-containing-divisions,
  that is most of the workforce. **It passed every test because the fixtures were written in the
  bare-root shape — they encoded the bug.** Fixed by unwrapping inside `deriveUnitDepartments` (tolerating
  both shapes, so legacy/seeded bare-root rows still work) rather than at the two call sites, which makes
  reintroduction structurally impossible; plus a test using the **real stored shape** that fails loudly on
  regression. Verified: 184/184 module tests, `tsc` clean.
  **The lesson is the important part: a fixture written from the same misreading as the code cannot
  catch that misreading.** Where a test fixture stands in for data written by another module, derive its
  shape from that module's WRITER, not from the reader under test. Applies to TR-17/TR-24 next.
- **TR-13's two disclosed limitations, both accepted:** §7's per-grain chart table is a **useful subset**,
  not exhaustive (burndown/CFD reuse and task-level contribution detail deferred, documented in-file) —
  **TR-17 should close the gap it needs rather than assume every named chart exists**; and Cerbos
  department/project "own unit" scoping is **approximate** for the same reason TR-09 hit (no per-org-node
  grant scope exists), so `manager`/`team_lead` read every unit in their company-scoped grant. Never a
  cross-tenant leak, but broader than §8's literal text — **this is now the SECOND ticket to hit it, which
  makes it a pattern, not an exception. TR-25 must settle it.**
- TR-13 also fixed a narration honesty bug in its own work: an empty period narrated "Completed 0 tasks,
  0 minutes logged" instead of "No activity recorded" — it gated on KPI *presence* rather than *value*.

**2026-07-31 (TR-09 landed) · check-ins live; ONE architectural gap to route to TR-25.**
Six §6.2 endpoints + a live-derived prefill (from today's `time_entries` + `work_activity`, so the flow
is confirm-and-edit) + the `checkin` Cerbos kind. **163 tests green** across the reports module.

- **⚠ ARCHITECTURAL GAP · there is no unit-scoped authz primitive anywhere in this codebase.** Cerbos's
  `manager` is company/project-scoped only; "manager of *this specific org unit*" does not exist as a
  grant. TR-09 therefore grants the **coarse** tier in `resource_checkin.yaml` and **narrows it in-app**
  to the caller's own current `org_unit_memberships` unit — server-computed, never trusting a
  client-supplied `unit`/`userId` (tested: a dept lead reads/excuses same-unit colleagues, is denied
  outside their unit **even when passing a wider `unit` query param**). This is the honest available
  answer, but note what it costs: **for the unit boundary, Cerbos is no longer the sole authority — the
  application is.** That is a deviation from this estate's "Cerbos is authoritative" principle and it
  will recur on every unit-scoped read in P3/P5 (department-grain documents, appraisal packs). **TR-25
  must decide deliberately:** either accept in-app narrowing as the pattern and test it as a first-class
  boundary, or introduce a real unit-scoped derived role. Do not let it be settled by accident, one
  controller at a time.
- **Correctly declined:** the §8 "served-dept (provider lead, company A→B)" tier for check-ins is **not
  implemented**. Every other cross-company view in this program goes through the D12 aggregate/rollup
  path, and no such path exists for check-ins yet — approximating it risked a real cross-tenant
  person-grain leak. Left unimplemented and documented rather than faked. Revisit when TR-13's document
  path can carry it.
- **My ticket scoping was stale:** the `auto_missed` fact-job hook (`expectedCheckinUsers`,
  `writeAutoMissedCheckins`, `DEFAULT_WORK_CALENDAR`) **was already shipped by TR-07** under a
  "TR-09's substrate" header, including the pinned leave-never-missed / holiday-and-weekend-produce-
  nothing / today-never-missed / re-run-doesn't-clobber-a-submitted-row tests. TR-09 reused it and only
  factored out its calendar parser so the live endpoints and the nightly job share one implementation —
  the right call. Lesson for the remaining tickets: **check what the previous ticket actually shipped
  before rebuilding from the ticket text.**

**2026-07-31 (TR-16 landed) · the chart kit + viewer exist; three rulings.** `platform-ui/src/lib/reports.ts`
(the canonical `ReportDocument` contract + pure bucketing), the full §7 chart kit, and `ReportViewer` +
`PeriodSelector` (Daily/Weekly/Monthly/Custom + presets) — **768 platform-ui tests green, `next build`
clean (59 routes)**. §6.1 transcribed verbatim; it was internally consistent as written.

- **RULING · `ReportUnit`'s `"text"` member is valid for `ReportTable` COLUMNS ONLY, never for a
  `ReportKpi` or `ReportSeries`.** TR-16 flagged that `ReportKpi.value: number` is unconditional even
  when `unit === "text"` — underspecified rather than wrong, since no registry metric uses `text`. This
  is the resolution: a KPI and a series are numeric by definition (they carry n/d and get charted); only
  a table cell may be textual. **TR-13 must not emit a `text`-united KPI.**
- **`CohortBand`'s prop shape is PROVISIONAL** — no §6.1 type exists for appraisal cohort data because
  that is **TR-24's contract to define**. TR-24/TR-26 must confirm or replace it rather than assume it.
- **Two real browser bugs its own visual QA caught, which no unit test would have:** (1) percentage
  heights on flex items silently collapsed bars to ~2px in a real browser; (2) print's
  `overflow: visible` let wide charts draw outside their card. Both fixed. **Generalise this:** the chart
  kit needs a rendered-pixel check, not only a DOM assertion — TR-17 and TR-20 must screenshot, not just
  build clean.
- **Pre-existing defect found, outside this program's scope:** the shared `HairlineTable` in
  `platform-ui/src/components/ui.tsx` is **not dark-safe** — it would render invisible in dark mode. TR-16
  correctly built a local `ReportTableView` rather than propagate the bug. This affects every surface
  using `HairlineTable`, so it belongs to the UI-polish/dark-theme work split, not here.
- **Small known gap:** honest `n/d` ratio tooltips are wired on `TrendLine` but not `GroupedBars`/
  `StackedBars`. No §7 per-grain chart needs it today, but §7 states the rule generally — **TR-17 closes
  it** if it puts a ratio series on a bar chart.

**2026-07-31 · P1 COMPLETE (5/5) — TR-34 closed the as-of-ownership gap; TR-36 closed the regression
it introduced.** TR-34 shipped `0063_pm_task_assignee_intervals.sql` (184/184 tests): `valid_from`/
`valid_to` on `pm_task_assignees`, the two partial-unique indexes replaced by ONE
`pm_task_assignees_no_overlap` EXCLUDE (btree_gist) scoped `(tenant, task, role)` — which yields both
"no overlap" and "at most one open row" from a single constraint — `syncTaskAssignees` rewritten from
DELETE+INSERT to a four-case close/open state machine, and the fact job's owner/`task_role` joins now
resolve **as-of the fact date**. Acceptance proven the hard way: complete a task on a past day,
reassign it through a **real PATCH**, recompute the past slice, assert byte-identical and still credited
to the ORIGINAL owner — with a companion test proving today's slice reflects the NEW owner.

- **TR-34's delegated design call, accepted:** intervals apply to **owner/responsible only**, not
  contributor. Contributor credit flows from `time_entries.entry_date` (already dated), and the one
  place the contributor role fed an as-of decision (`minutes_contributed`'s `task_role`) now resolves
  owner/responsible as-of the entry date and falls back to contributor by *existence*. Sound: adding
  intervals to a role whose credit is already date-carried would be ceremony.
- **Deliberate deviation from 0055's precedent, and it is the right one:** interval closes land on
  `today-1`, never `today`, so a task reassigned twice in one day cannot self-collide with the EXCLUDE
  constraint.
- **⚠ TR-36 (done inline by the architect, same day): the regression TR-34 flagged but could not fix.**
  `computeOverdueOpen` (metric #20) LEFT JOINed `pm_task_assignees` on `role` with **no date filter** —
  so once a task had multiple historical owner rows, the join emitted one output row per historical
  owner × responsible pair and **each was counted again**, silently inflating overdue counts upward.
  TR-34 correctly declined to touch the file (TR-35 held it) and flagged it instead. Fixed with
  **as-of-`end` joins** rather than the suggested `valid_to IS NULL`: #20 is *defined* as evaluated at
  range end, and the new EXCLUDE constraint guarantees at most one row per role matches any date, so
  as-of is both more correct and single-valued. Regression test added (reassign across the range end →
  count is 1, credited to the as-of-end owner, historical owner not credited).
- **A fixture trap this exposed, worth generalising:** `report-rollups.db.test.ts` inserted assignee
  rows relying on `valid_from`'s `DEFAULT CURRENT_DATE`. That default is the suite's real wall-clock
  date, which is **later than every fixed historical date these tests use** — so an as-of join matches
  nothing and attribution assertions silently read as "unattributed" rather than failing loudly. TR-34
  hit the identical trap in `fact-job.db.test.ts`. **Any test seeding an interval row MUST pass
  `valid_from` explicitly.**
- **A Postgres gotcha TR-34 documented, worth keeping:** a single statement using
  `CASE WHEN kind='person' THEN ref::uuid::text ELSE ref::text END` still fails
  `invalid input syntax for type uuid` on a department ref, because the extended protocol fixes **one
  type per parameter for the whole statement** regardless of which branch executes. Branch in
  TypeScript with two statement texts instead. Caught by a test, not by review.

**2026-07-31 (TR-08 landed, `0057_report_metric_seeds.sql`) · rulings + accepted limitations.**
21 metrics seeded (#20 as `'last'`, #22 `seeded:false`), the 3 additive counters added by `ALTER TABLE`
and populated by the fact job, provider registered, 79 reports-module tests green.

- **RULING · metric #12 `effort.billable_share` is `appraisalSafe: false`.** §5's table showed 10 ✅
  while the prose said "nine appraisal-safe" — my own inconsistency. TR-08 resolved it by marking #12
  unsafe because §5 qualified it "safe at D/C; caution at P" and **appraisal packs are person-grain**,
  which makes the count exactly 9. **Confirmed.** A person's billable share is a function of what work
  they were handed, not how well they did it — scoring someone on it rewards whoever assigns the
  billable work.
- **ACCEPTED LIMITATION · #20 `overdue_open` over a PAST range reads today's task state** (there is no
  task-state history table), so it is exact only when the range end is today. Combined with §15 ①'s
  as-of-ownership gap, this is a second reason **sealing (TR-14) is the mechanism that makes historical
  reports trustworthy** — an unsealed historical report is honest about *volume* but not about
  *point-in-time state*. TR-13 must not present #20 on a past unsealed range without the
  `header.warnings` chrome.
- **⚠ INCONSISTENCY TO CLOSE · #14/#18/#19 resolve department once as-of range-END, not per-day.**
  `report_work_facts` stores `department_node_id` **per day** (TR-07/TR-04), but these three metrics are
  sourced from calendars/check-ins, which carry no department, so TR-08 resolved the unit once at range
  end. Consequence: a person who transfers mid-month has their whole month's check-in compliance and
  utilization attributed to the NEW department, while their fact-sourced metrics split correctly at the
  transfer date — **two metric families on the same report disagreeing about where someone worked.**
  The fix is cheap and the machinery exists (`resolveMembershipAsOf`, already pure and tested): resolve
  per-day. Logged as **TR-35**; not a blocker for P2/P3, but it must land before any appraisal uses the
  discipline axis.
- Also accepted: #5 `milestone_hit_rate` reads "currently-done-and-due-in-range" (no `completed_at` on
  `pm_milestones`) so it is not provably *on-time*; #7/#8/#10 read `is_done`/`is_blocked` at compute
  time and apply them uniformly across a snapshot range. Both are documented in code.
- **Bug TR-08 caught in its own work, worth remembering:** its first `compute()` ran four functions
  concurrently over ONE shared `PoolClient` — the deprecated concurrent-`client.query()` pattern that
  `pg` warns about. Fixed by sequencing the shared-client calls. Any future provider that fans out must
  either sequence on a shared client or take its own connection.

**2026-07-30 (TR-07 landed) · ARCHITECT RULINGS on the five findings it escalated.**

**① The as-of OWNERSHIP hole — accepted as a real design gap, now ticket TR-34.** This design closed
history-rewriting for *department membership* (`org_unit_memberships` with `valid_from`/`valid_to`) but
left the identical hole open for *task ownership*: `pm_task_assignees` has no validity interval, so
recomputing a past slice credits whoever owns the task **today**. Reassign a task in September and
August's recomputed numbers move with it. That is precisely the failure the as-of membership table
exists to prevent, and I missed it — the two axes needed the same treatment and only one got it.
- **Mitigation that already exists:** sealing (§0057). A sealed period is frozen, so this can only
  affect *unsealed* history. **Consequence: TR-14 (sealing) must NOT slip past the first period the
  business intends to appraise on.** That reorders nothing today, but it removes TR-14's slack.
- **Real fix: TR-34** — `valid_from`/`valid_to` on `pm_task_assignees` + as-of owner resolution in the
  fact job, mirroring what TR-03/TR-04 did for units. Sequence it **before P5 (appraisal)**; it is not
  required to make P1–P4 correct for current-state reporting.
- **TR-29 must assert** a sealed document does not drift after a reassignment.

**② Metric #3's denominator is not computable from the landed grain — RULING: add the counters, do not
dilute the metric.** §5 defines `delivery.on_time_rate` as Σ on-time / Σ completed-**with-due-date**,
but `report_work_facts` has no such counter. Redefining the denominator as `tasks_completed` (the
tempting shortcut) would silently dilute the rate with tasks that never had a due date — a team that
sets few due dates would score *better*, which inverts the metric's meaning. **TR-08 adds the missing
additive counters** (`tasks_completed_with_due_date`, and the equivalent for #13
`effort.estimate_accuracy`) to `report_work_facts` via an additive `ALTER TABLE` in its own migration,
and the fact job populates them. They are additive counts, so this respects invariant 1 — this is the
grain being completed, not violated.

**③ §6.2's structured 422 body cannot ship as written — RULING: keep the flat shape.**
`src/http-error.filter.ts` flattens every error to `{error, field?}`. Do **not** widen that shared
filter for one endpoint — it is a global contract every controller depends on. Ship
`{error:"range_too_large", field:"to"}` (as TR-07 did) and **mirror `maxDays` as a frontend constant**.
TR-13 and TR-16 hit the same wall; this ruling covers them too.

**④ New Cerbos kind `report_admin`** — §8's recompute row named no resource kind, and an unlisted kind
is **denied by default**, so the endpoint would have 403'd for everyone. TR-07 added
`cerbos/policies/resource_report_admin.yaml`, correctly tighter than `rollup_recompute` (`manager`
excluded per §8). **TR-25 must fold it into the parity matrix.**

**⑤ Foreign units are only partially identifiable — constraint for TR-13.** A foreign unit's
`department_node_id` is carried **unrolled** (rolling it would need a cross-tenant org-blob read), and
`report_work_facts` has no `unit_tenant_id` — so a foreign unit is identifiable only while the provider
stamp is set, i.e. **not** when the service edge is suspended. **TR-13's department-grain reads must not
assume every `unit_node_id` is local.** Related documented boundary (pinned by test): a person in a
company with no service edge of any status is not discoverable and falls to precedence ③ — reading a
stranger tenant's org tree would be a D5 violation, so this is correct, not a bug.

**2026-07-30 · P0 COMPLETE (all 7 tickets landed and verified).** TR-01 (`0054` relational assignees
+ backfill) · TR-02 (dual-write + contributors API, 116/116 PM tests) · TR-03 (`0055` as-of
memberships, `btree_gist` proven against the real role split) · TR-04 (pure `dept-resolution.ts` +
org-PUT membership sweeper, full suite 114 files/1382 tests) · TR-05 (outbox consumer gaps: comments,
docs, `is_done`-flag verbs) · TR-31 (actor propagation, 148/148) · TR-32 (contributors FE, 654/654).
**Both blockers this program exists to close are closed:** person-grain attribution has a relational,
indexable home, and department membership is time-aware so a transfer cannot rewrite history.

**Three tickets were ADDED during P0, each uncovered by a landed ticket rather than by design review**
— TR-31 (null-actor silent zero), TR-32 (contributors had no UI), TR-33 (backfilled rows get no exact
person link). Worth noting as a pattern: every one is a *silent-wrong-answer* class defect, invisible
to typecheck and to green tests. Expect P1–P6 to surface more of the same, and keep budgeting for it.

**TR-31's deliberate non-attributions (do not "fix" these).** Not every event has a human actor, and
inventing one is worse than leaving it null: `pm.task.spawned` (recurrence auto-spawn) is tagged
`actorExternal: 'pm:recurrence-engine'`, `pm.tracker.run` (AI-authored comment) `'pm:ai-tracker'`, and
meetings' async post-transcription + admin relink-sweep emits stay actor-less. Attributing those to
whoever last clicked a button would credit a person for machine work — in an appraisal pack. The fact
job (TR-07) must therefore treat `actor_user_id IS NULL` as *excluded from person attribution*, never
as a row to guess an owner for.

**2026-07-30 (TR-04 landed) · RULING: cross-company placement vs the provider stamp.** TR-04 asked
whether precedence ② should resolve a person's unit when they are placed in another company's org blob
with **no ACTIVE `service_assignments` row** — §3.2 gated only the *stamp* on an active assignment, not
the base resolution. **Confirmed: TR-04's literal reading is correct and stands.** The two things
answer different questions. The org blob says where a person *actually sits* — that is their home unit
regardless of any commercial relationship, and their work must still roll up somewhere rather than
falling into the unattributed bucket. `service_assignments` governs whether one company's unit is
operating a module **for another company**, which is exactly what the provider *stamp*
(`provider_tenant_id` / `provider_unit_node_id`) represents — so that, and only that, requires an
ACTIVE edge. A suspended or revoked assignment must therefore stop the served-company provider view
without orphaning the person's own department numbers. Do not "fix" this later by falling through to
③/④ when an assignment is inactive; that would silently move a person's history between departments
when a commercial edge is suspended, which is precisely the history-rewriting the as-of membership
table exists to prevent.

**2026-07-30 (later, soundness pass) · substrate-constraint correction.** Verifying the amendment
against the code found that the two new aggregation rules it invented (`point_in_time`,
`distinct_over_range`) would have **violated `metric_definitions.aggregation_rule`'s CHECK**
(`0001_core.sql:83` allows only `sum | ratio_of_sums | max | last`) and thus **failed migration 0059
at apply time**. Corrected: #20 seeds as **`'last'`** (an exact semantic fit already in the
vocabulary) and #22 is **not seeded at all** — it becomes a read-time derived `ReportKpi`
(`distinctOver: true`), because no allowed rule expresses a distinct-union and `'max'` is wrong
rather than merely imprecise. The seeded count is therefore **21**, the range-class stays a TS-catalog
field, and the shared CHECK is left untouched. Also verified in the same pass: Postgres is
**17**-alpine (`UNIQUE NULLS NOT DISTINCT` and built-in `gen_random_uuid` both fine), HR migration
0028 genuinely has **no** working-calendar table (only `hr_leave_requests` / `hr_attendance`), and
migrations 0048/0049 are indeed consumed. **~~Open verification item~~ → CLOSED by TR-03 (2026-07-30):** `btree_gist` was untested ground (no
migration in this repo had ever run `CREATE EXTENSION`). TR-03 proved it against the **real role
split**, not the superuser harness which would have proven nothing: a fresh database owned by
`platform_owner` (NOSUPERUSER, NOBYPASSRLS), `migrate` run as that role → **all 55 migrations applied
clean, `btree_gist 1.7` installed, EXCLUDE constraint + FORCE RLS present, re-migrate a clean
no-op.** The extension's `trusted` flag (PG13+) plus `platform_owner` owning the database (hence
`public`, on PG17's `pg_database_owner` model) is sufficient. **No superuser escalation needed, no
design change.**

**2026-07-30 (TR-07 landed) · the fact fabric computes; two substrate findings TR-08 must absorb.**

`src/modules/reports/fact-job.ts` + `POST /api/:t/reports/facts/recompute` ship the atomic grain.
Decisions taken in flight, each recorded here because a later ticket would otherwise have to
re-litigate it:

1. **Fact row ids are DETERMINISTIC (uuid v5 over the row's own UNIQUE key), not `newId()`/uuid v7.**
   The acceptance bar is "recompute twice → byte-identical rows"; with a v7 id the id column changes
   on every nightly run, so "byte-identical" could only ever be asserted on a subset of columns and
   any downstream reference to a fact id would break nightly. `computed_at` and `job_run_id` are the
   two deliberate exceptions — invariant 5 requires `job_run_id` to identify the run that wrote the
   row, so a stable one would defeat its only purpose. The idempotency test asserts BOTH halves
   (everything else identical, those two moved), because a second run that silently no-op'ed would
   also have passed a plain equality check.
2. **⚠ METRIC #3 IS NOT COMPUTABLE FROM THE LANDED GRAIN — TR-08 decides.** §5 specifies
   `delivery.on_time_rate` = Σ on-time / Σ **completed-with-due-date**, but `report_work_facts` (0056)
   carries `tasks_completed` and `tasks_completed_on_time` and **no `tasks_completed_with_due_date`
   counter** — so the specified denominator does not exist, and it cannot be derived from the two
   that do. The job stores the honest numerator (completed with a due date, on or before it) and
   counts a due-date-less task in `tasks_completed` but in NEITHER on-time nor late. TR-08's options
   are exactly two: (a) add the missing additive counter in its own migration (0059) and have the job
   populate it — the correct fix, and cheap while nothing has been sealed yet; or (b) redefine the
   metric's denominator as Σ `tasks_completed`, which silently DILUTES the rate for any team that
   doesn't set due dates and therefore fails *downward* rather than upward. Do not seed #3 against
   `tasks_completed` without recording that choice here. The same shape of gap affects #13
   (`estimate_accuracy` wants Σ estimates of completed tasks that have BOTH an estimate and actual
   minutes; the grain has `estimate_minutes_completed` and `minutes_logged` on separate axes).
3. **§6.2's structured 422 body cannot ship as written.** `src/http-error.filter.ts` reshapes EVERY
   `HttpException` to `{error}` (+ an optional `field`) for Fastify-core contract parity, so
   `{error:"range_too_large", maxDays:400}` reaches the wire as `{error:"Unprocessable Entity
   Exception"}`. TR-07 ships `{error:"range_too_large", field:"to"}` — the machine-readable code is
   preserved verbatim and `field` names the offending input, both existing conventions. **TR-13/TR-16
   hit the identical wall** on the read endpoints' 422; either widen the shared filter (a
   cross-cutting contract change, needs the architect) or mirror `maxDays` as a FE constant. Not
   TR-07's call to make unilaterally.
4. **New Cerbos kind `report_admin` (action `recompute`).** §8's "facts recompute / calendars" row had
   no resource kind among the four the design names, and an unlisted kind is denied by default — the
   endpoint would have been 403 for everyone including a group executive. Modelled on
   `resource_rollup_recompute.yaml` but TIGHTENED to §8's matrix: `manager` (dept lead) is excluded,
   because a lead who can re-derive a window can move numbers feeding their own team's appraisal
   inputs. **TR-25 must fold this kind into the parity matrix.**
5. **Deliberate attribution axes, so no later ticket "fixes" them into a double-count.** Task OUTCOME
   measures (`tasks_completed*`, `estimate_minutes_completed`, `tasks_reopened`, `tasks_created`) use
   owner-takes-all off `pm_task_assignees`. EFFORT (`minutes_*`) resolves on the LOGGING person's own
   as-of unit — precedence ②, never ① — because using the owner-unit rule there would move a
   shared-service person's hours into the served company's department and erase the provider stamp
   §3.2 requires for exactly that case. EVIDENCE (`comments_authored`, `docs_updated`,
   `activity_*`) resolves on the ACTOR. A same-day complete→reopen→complete ping-pong counts as ONE
   completion and ONE reopen (per-day booleans, not event counts), so a status ping-pong cannot
   inflate throughput.
6. **Cross-company resolution has a BOUNDARY, and it is not a bug.** Provider tenants are discovered
   only through `service_assignments` read from the served side (0026's `sa_select` allows either
   side), unfiltered by status per the TR-04 ruling — so a suspended/revoked/proposed edge still
   resolves the person's own unit. A person sitting in a company with **no edge of any status** is
   not discoverable at all and falls to ③; reading a stranger company's org tree from this tenant's
   scope would be a D5 violation. Pinned by test.
7. **`department_node_id` is not rolled for a FOREIGN unit.** Rolling a division to its ancestor
   department needs that tenant's own `company_org_structure`, which this slice's single-tenant
   transaction cannot read. A cross-company unit is therefore carried through unrolled. Safe for the
   surfaces that read it (the provider view reads `{unit, servedTenant}` off the `provider_*` columns
   via the rollup engine, the D12-sanctioned path), but note the related gap: `report_work_facts` has
   **no `unit_tenant_id` column**, so a row whose `unit_node_id` belongs to another tenant is only
   identifiable as foreign when the provider stamp is set — i.e. not when the edge is suspended.
   TR-13's department-grain reads must not assume every `unit_node_id` is a node in the reading
   tenant's own tree.
8. **The job is n8n-driven, not timer-driven** (§10: platform-nest gains no scheduler). `main.ts` is
   untouched; `runNightlyFactJob()` exists as the ops/CLI entry point and gates each tenant on
   `isModuleEnabled(tenant,'reports')`.
9. **Dev-env note.** Cerbos runs with `watchForChanges: true`, but a NEW policy file added under a
   Windows Docker bind mount is not picked up by the watcher — `docker restart gaiada-cerbos-1` is
   required locally, or every check against the new kind silently returns `EFFECT_DENY`.
10. **⚠ ATTRIBUTION IS CURRENT-STATE, NOT AS-OF — the one history-rewrite this program has NOT closed.**
   `org_unit_memberships` made the DEPARTMENT axis time-aware, but `pm_task_assignees` has no
   validity interval: it is mutable current state. So recomputing a historical slice attributes that
   day's completions to whoever owns the task **today**, not whoever owned it when it completed.
   Reassign a finished task next month and a re-run of last month's slice silently moves that
   completion to the new owner — the exact class of defect the as-of membership table exists to
   prevent, on a different axis. Not fixable inside TR-07: the history does not exist in the
   substrate to read. Three things bound it, and whoever picks this up should know which: (a)
   **sealing is the real mitigation** — §0057 + §5.2 point 8 already rule that appraisal numbers come
   from a pinned `(period, revision)` snapshot, so a post-seal reassignment cannot move an appraisal
   score; (b) the exposure is therefore the window between the event and the period seal, plus any
   ops/live read of an unsealed past period; (c) closing it properly means giving
   `pm_task_assignees` `valid_from`/`valid_to` the way `org_unit_memberships` has them, and having
   the job resolve the owner as-of `fact_date` — a schema + dual-write change, i.e. its own ticket.
   **TR-14 must not be deferred past the first period the business intends to appraise on**, and
   TR-29's reconciliation should assert a sealed document does not drift when a task is reassigned
   afterwards.

**2026-07-31 (TR-15 landed) · the seal/amend/pin service + all five endpoints; 214 reports-module
tests green (184 pre-existing + 30 new), incl. the whole `report-seal.db.test.ts` acceptance
suite.** Files: `src/modules/reports/report-periods.ts` (list/get/pin + the calendar lazy-backstop
writer), `src/modules/reports/report-seal.ts` (the seal/amend orchestration + `computeSealHash` +
`fetchSealedDocument`), the five endpoints added to `reports.controller.ts` (`GET periods`,
`GET periods/:id`, `POST periods/pin`, `POST periods/:id/seal`, `POST periods/:id/amend`) + the
sealed-read branch in `getDocument`, `cerbos/policies/resource_report_period.yaml`, and `export`
added to `src/rollups/engine.ts`'s existing `upsertRows` (reused directly, no second writer of
`rollup_metrics`). Every acceptance criterion pinned: seal -> stored docs at revision N; a post-seal
task edit changes the LIVE view but NOT the sealed document (the ticket's whole point); amend
requires a reason + notifies exec/leads + a re-seal writes revision N+1 KEEPING N; seal_hash
verifies over the stored document set; double-seal -> 409; `?revision=` returns the pinned
revision, not the latest (and a nonexistent revision -> 404, never a silent fallback); custom-range
rule 2 (422, exact message, never a silent skip) and rule 4 (pin idempotent on the exact range,
still appraisal-barred).

- **Two real bugs this ticket's own test suite caught before they could ship, both worth
  generalising:**
  1. **A concurrency bug in the seal fan-out itself.** The first implementation built every
     in-scope (grain, scopeRef) document via `Promise.all`. When the sealed range includes TODAY
     (a live-stack "today" is 2026-07-31, which sits inside a July-2026 seal target — not an edge
     case, the ordinary one), EVERY parallel `buildReportDocument` call independently re-runs
     document-builder.ts's own `ensureTodayFresh` lazy-backstop against the SAME (tenant,
     fact_date) slice, and two overlapping transactions racing a DELETE+INSERT on that slice
     collide with `duplicate key value violates unique constraint "report_work_facts_pkey"`. Fixed
     by building the documents SEQUENTIALLY instead (a `for...of`, not `Promise.all`) — costs some
     wall-clock time (every call after the first re-derives an already-correct slice) but is
     correct for any period whose range reaches today, not only wholly-historical ones. **Any
     future caller that fans out multiple `buildReportDocument`/`ensureTodayFresh`-touching calls
     over the same tenant must sequence them, the same "sequence shared-state calls" discipline
     TR-08 already established for a single `PoolClient`, just one level up.**
  2. **`seal_hash` computed over JS object key-insertion order does not survive a jsonb round-trip.**
     `report_documents.document` is a `jsonb` column; Postgres's jsonb storage does not preserve
     the original key order, so re-`SELECT`ing a just-stored document and recomputing the hash
     over it (exactly what "seal_hash verifies" requires, and exactly what an auditor would do
     months later) produced a DIFFERENT hash than the one stored at seal time — a hash that could
     never actually verify anything, on the one feature whose entire job is tamper-evidence. Fixed
     with a deep-canonical stringify (object keys sorted at every level, array order preserved)
     before hashing. **Any hash/checksum computed over a value that will round-trip through
     Postgres `jsonb` (or any other key-reordering store) must canonicalize key order first —
     hashing the in-memory JS object's own insertion order is not sufficient**, and a test that
     only hashes the in-memory object right after building it (never re-reading it from storage)
     would not have caught this.
- **Design call this ticket had to make that the doc left open (not a schema/contract decision, so
  not escalated):** §6.2 has no `POST /periods` to create a calendar row ahead of sealing it, yet
  `POST /periods/:id/seal` acts on an existing `report_periods.id`. Resolved by making
  `GET /reports/periods?kind&from&to` the provisioning point — it auto-vivifies every candidate
  calendar period in range via an idempotent `INSERT ... ON CONFLICT DO NOTHING` against 0067's
  `report_periods_calendar_uq` partial index, so its returned ids are stable and ready for `/seal`.
  This is the SAME "lazy idempotent upsert-on-read" shape `ensureTodayFresh` already uses one file
  over — not a new house pattern, an application of the existing one. `period_kind='custom'` rows
  are never auto-vivified this way (rule 1's "only pin writes those" is honored exactly).
- **Scoping decisions recorded, not schema calls:** (1) in-scope (grain, scopeRef) enumeration for
  sealing reuses the EXACT rows `GET /reports/overview` already derives, never a second
  independently-written membership walk; (2) department-grain sealing covers the entity's OWN view
  only — a `servedTenant` provider slice (§3.2) is never separately sealed and a document read for
  one always falls through to live compute regardless of the period's seal state, exactly like
  TR-13 left its own chart subset deliberately not exhaustive.
- **`amended` is NOT treated as "still servable from storage."** Between `/amend` and the
  subsequent re-seal, a document read for that period degrades to LIVE compute (same as `open`),
  not the stale pre-amend `sealed` snapshot — presenting an amended (known-to-be-wrong) revision
  under `header.sealed:true` would claim an authority the record no longer has. Only `status ===
  'sealed'` serves stored storage; `open` and `amended` both fall through.
- **Standing approximation NOT solved here (flagged, not fixed):** `resource_report_period.yaml`'s
  `view` tier inherits the same `manager`/`team_lead` company-wide (not per-unit) scoping every
  other resource in this program has — TR-25's open item, not made worse, not resolved.
