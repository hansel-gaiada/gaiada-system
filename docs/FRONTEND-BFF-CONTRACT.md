# Frontend ⇄ Backend BFF Contract (platform-ui → platform-nest)

**Purpose.** platform-ui is built **frontend-first**: every screen talks only to the BFF endpoints
listed here (via `platform-ui/src/lib/*.ts` → `platformFetch`). Many endpoints **do not exist on the
backend yet** — the UI degrades gracefully (empty/`BackendPending`) so it can ship ahead. This document
is the single checklist for building the backend so the built UI "lights up" automatically.

**How to use this doc (backend sessions):** implement the `PENDING` rows below. The exact request/
response **shapes are the exported TypeScript types in `platform-ui/src/lib/*.ts`** — treat those as
canonical; this doc gives method, path, scope, and status. When an endpoint lands, the UI needs **no
change**.

## Live wiring status — verified 2026-07-16 against running platform-nest (:3004)
Walked the whole contract with real seeded users. **The UI wires cleanly and degrades gracefully — no
UI crashes, real data renders everywhere an endpoint exists.** One UI fix applied: the timesheet log
form now **requires `projectId`** (backend `POST /api/:t/time-entries` returns 400 without it).

**Verified working on the running instance:** `/api/me`, `/api/companies` (list), `/api/:t/members`,
`/users` (list), `/roles`, `/identity-links`, `/custom-fields`, `/compliance-gates`, `/audit`,
`/projects` (+detail+tasks), `/tasks`, `/clients` (list+**POST**), `/deliverables`, `/time-entries`
(GET + POST w/ projectId), `/modules/agency/campaigns`, `/approvals/pending`, `/notifications`,
`/agents/goals`, `/knowledge/sources`, **`GET/PUT /api/:t/org-structure` (persists!)**, and the
`/api/admin/:system/*` consoles (registered; 403 unless platform_admin).

**⚠ MISSING on the running :3004 process** (route not registered → 404) — the "0018–0020 buildout"
(company/user CRUD, PM, IT, invoices, client DELETE, decided-approvals, n8n workflows) is **not
deployed on the running backend**, even though the backend session reports it built. **ACTION: restart /
redeploy platform-nest with the latest build + run migrations 0018–0020.** Specifically 404 today:
`POST/PATCH /api/companies`, `GET /api/companies/:id`, `POST/PATCH /api/:t/users`,
`DELETE /api/:t/clients/:id`, all `/api/:t/pm/*`, all `/api/:t/it/*`, `/api/:t/invoices*`,
`/api/:t/modules/agency/approvals/decided`, `/api/admin/automation/workflows`. The UI already handles
all of these (degrades now, lights up on deploy — no UI change needed).

**Note:** a `group_executive` has **no company memberships** (`me.companies:[]`) by design → the app
shows "select a company" everywhere except cross-company `/rollups`. Real operators log in as company
members (owner/manager/member). Consider seeding execs into companies or a dedicated exec landing.

**2026-07-17 contract-doc truth sweep (WS0-3):** the section above is a snapshot of the *running*
:3004 process from 2026-07-16 and is now known-stale — that process was missing the 0018–0020
buildout. The tables below have been reconciled directly against **code** (a 108-route inventory
enumerated from the `platform-nest` controller sources on 2026-07-17), which is the source of
truth regardless of what any particular running container has deployed. Where the two disagree,
trust the tables below, not the paragraph above.

## Conventions
- **Base:** `PLATFORM_URL` (default `http://localhost:3004`). All app data under `/api`. A few
  app-level routes (session revoke) are not tenant-scoped and sit outside `/api`.
- **Auth:** every request carries `Authorization: Bearer <service token>` + `x-user-id: <userId>`.
  The backend resolves the principal from `x-user-id`; **RLS/Cerbos is the real authority**. The UI
  also gates via `lib/rbac.ts` (defence-in-depth) — mirror those capabilities in Cerbos.
- **Tenant scoping:** `:t` = active company id. Everything under `/api/:t/**` MUST be scoped to that
  company. The UI sends the active tenant from the top-bar company switcher.
- **Status semantics the UI relies on:** `404`/`405` → "not built yet" (readers fall back to empty;
  writers report "pending"). `403` → "not authorized" (readers surface a limited-access state — do
  **not** 404 an unauthorized read). `2xx` → success.
- **Error body shape:** `{ error, field?, code? }`. `code` (SM-53/SM-57) is a machine-readable
  discriminator some error bodies now carry alongside the human-readable `error` string — e.g. the
  search module's typed refusals (`scope_disabled`, `budget_exceeded`, `pillar_disabled`,
  `no_capable_provider`, `gateway_not_configured`, …) on 409/503 responses. **Additive and optional:**
  existing callers that only read `.error` are unaffected; a caller may branch on `code` instead of
  string-matching `error` once an area is known to send it, but must not assume every error body has
  one. Search's single-subject dispatch/gateway refusals: `scope_disabled`/`budget_exceeded` → 409
  (well-formed request, engagement config forbids it — the operator changes the config); everything
  else in that family (`pillar_disabled`, ceiling/provider unavailability, `gateway_not_configured`)
  → 503 (a deployment state, not a caller error, not a crash).
- **Events (audit + notifications):** writes SHOULD emit domain events onto the existing outbox/event
  backbone so they appear in `/admin/audit` and the notifications bell. Event names are noted per area.
- **Legend:** ✅ BUILT (endpoint exists) · 🟡 PARTIAL · ⛔ PENDING (UI ready, backend TODO).

---

## 1. Identity & session  — `lib/platform.ts`, `lib/adminData.ts`, `lib/session*.ts`
| Status | Method | Path | Notes |
|---|---|---|---|
| ✅ | GET | `/api/me` | `Me` {userId,name,email,title,assurance,companies[],roles[]}. `roles[].{role,scopeType,scopeId}` drive RBAC — see roles list below. |
| ✅ | POST | `/admin/users/:id/revoke` | D11 session revocation (app-level, not `/api`). |
| — | — | dev login | UI uses `GET /dev/user-by-email?email=` today. **Replace with real OIDC/IdP**; wire `/step-up` to a real dual-proof ceremony (currently a static page). |

**Roles the UI understands** (`lib/rbac.ts`): `platform_admin`, `group_executive` (both global/elevated),
`company_admin`, `manager`, `member`, `it_admin`/`it_manager`/`it`. **Capabilities** the backend should
enforce per role/scope: `admin.access, company.manage, org.edit, people.directory, rollups.view,
pm.manage, it.manage, approvals.decide, knowledge.review`.

## 2. Organization: companies & org structure — `lib/entities.ts`, `lib/organization.ts`, `lib/org.ts`
| Status | Method | Path | Body → Response | Notes |
|---|---|---|---|---|
| ✅ | GET | `/api/companies` | → `Company[]` | Now returns `parent_company_id` on each row (holding hierarchy active). `settings` on the detail endpoint. |
| ✅ | POST | `/api/companies` | `{name,type,parentCompanyId?,modules?}` → `{id}` | BUILT (0018-era; `company-crud.controller`). Elevated only; creator auto-added as member; emits `company.created`. |
| ✅ | PATCH | `/api/companies/:id` | partial `{name?,type?,parentCompanyId?,status?,modules?}` → `{ok}` | BUILT. `company.manage`; self-parent rejected; emits `company.updated`. |
| ✅ | GET | `/api/companies/:id` | → `CompanyDetail` | BUILT (incl. `settings`). |
| ✅ | GET | `/api/:t/members` | → `Member[]` | Company membership. |
| ✅ | GET/PUT | `/api/:t/org-structure` | `OrgStructure` | BUILT (`company-admin.controller.ts`). **See [`memory/org-structure-contract`].** JSONB blob per company; kinds `holding\|company\|department\|division\|role\|person` (migrate legacy `team`→`division`). PUT elevated/`org.edit`. Emit `org_structure.updated`. |
| ✅ | POST | `/api/:t/org-structure/units/:nodeId/assignments` | `{targets:string[], module, leadUserId?}` → `201 {assignments:[{id,target,status}]}` | ORG-3 (`service-assignments.controller.ts`). Provider-admin/global only (Cerbos `service_assignment:propose`). Global actor → `active` immediately; provider `company_admin` → `proposed` (target must accept). Same-holding enforced (A5, 422 on cross-holding target); module key validated against the in-process registry once populated (format-only until WSA-2 registers real modules — see the completion report). Writes only the `service_assignments` row itself — **materialization of the target's membership/grants now happens out-of-band** via the ORG-6 reconciler, driven off the `service_assignment.proposed`/`.activated` outbox event ORG-7 wired a dedicated consumer group onto (`events/reconcile-consumer.ts`), gated behind `SERVICE_ASSIGNMENTS_ENABLED` (default off). |
| ✅ | POST | `/api/:t/org-structure/assignments/:id/accept` | → `200 {ok,status:'active'}` | ORG-3. Target-side only (`service_assignment:accept`); `proposed`→`active`. Triggers reconciliation via the same event path once the flag is on. |
| ✅ | DELETE | `/api/:t/org-structure/assignments/:id` | → `200 {ok,status:'revoked'}` | ORG-3. Either side (`service_assignment:revoke`). **UPDATE to `status='revoked'`, never a DELETE** — row and audit trail persist. 409 if already revoked. Triggers the reconciler's teardown (deletion-guard-respecting) diff via the event path. |
| ✅ | PATCH | `/api/:t/org-structure/assignments/:id/suspend` `/resume` | → `200 {ok,status}` | ORG-3. Either side. `active`⇄`suspended` only (409 otherwise). ORG-7 verified end-to-end (live PG+Redis+Cerbos): suspend strips the reconciler-managed grants but the membership row is only deactivated, never deleted (A16 grants-off-edge-kept); resume RE-materializes onto the SAME membership row (resume-not-recreate), not a fresh one. |
| ✅ | PATCH | `/api/:t/org-structure/assignments/:id` | `{nodeId}` → `200 {ok,status,reconsentRequired}` | ORG-3 re-link. Provider-admin/global only (403 from the target side). Non-global re-link on a non-orphaned assignment flips `status`→`proposed` and clears `accepted_by/at` (target must re-accept); orphan-repair re-links (current `unit_status='orphaned'`) and global-actor re-links skip re-consent. DB-enforced: `unit_id` can only reference an `org_units` row owned by the same `provider_tenant_id` (composite FK, migration `0027_service_assignment_unit_guard.sql`). ORG-7 verified: a re-consent-flip re-link empties the target's grants (desired-empty while `proposed`) via the event path until the target re-accepts. |
| ✅ | POST | `/api/:t/org-structure/assignments/:id/reconcile` | → `200 ReconcileResult` (`{assignmentId,status,granted,revoked,orphaned,skipped,affectedUsers}`) | **ORG-7, NEW.** Manual re-materialization trigger — calls `reconcileAssignment` synchronously instead of waiting on the event loop. **Admin/global-ONLY** (Cerbos `service_assignment:reconcile` — deliberately excludes `company_admin`, unlike every other lifecycle action on this resource, since it bypasses the propose/accept consent pacing and forces an immediate cross-tenant write). 404 if the assignment isn't visible from `:tenantId` (either side); 409 if `SERVICE_ASSIGNMENTS_ENABLED` is off. |
| ✅ | POST | `/api/:t/org-structure/reconcile` | → `200 {results: ReconcileResult[]}` | **ORG-7, NEW.** Provider-level fan-out — the same re-diff `org_structure.updated` drives (`reconcileProvider`), callable on demand. Same admin/global gate + flag-off 409 as the single-assignment route above. |
| ✅ | POST | `/api/:t/org-structure/units/:nodeId/assignments?dryRun=1` | same body as propose → `201 {dryRun:true, unit:{nodeId,name,kind}, items:StaffPreviewRow[], companies:EnvelopeCompany[]}` | **ORG-7b, NEW.** Read-only preview: who WOULD be materialized for this unit/module, without writing a `service_assignments` row. Reuses the reconciler's own `collectSubtreePersons` (never re-implemented) so it can't drift from a real reconcile. `companies[]` reports each requested target's legality (cross-holding/nonexistent → `included:false, reason:"no_access"`); `items` (`{userId,name,email,role:"staff"\|"manager"}`) is the same regardless of target legality — placement is a property of the provider unit alone. Same `propose` authz gate. 409 if `SERVICE_ASSIGNMENTS_ENABLED` is off. |
| ✅ | GET | `/api/:t/org-structure/assignments?direction=provided\|served&companyIds=&status=` | → `200 Envelope<AssignmentSummary>` | **ORG-7b, NEW.** Lists `service_assignments` rows from `:t`'s side (`direction` picks provider vs. target column). `:t` itself is authorized the normal way (a real 403 propagates, matching every other endpoint — contract convention, not an envelope concern); `companyIds` OPTIONALLY widens the fan-out (e.g. an hr_staff wanting "all served companies" in one call, UX-2 §3's ServicedBlock pill) — each extra id is independently probed and a denial there becomes `{included:false, reason:"no_access"}` in `companies[]`, never a blanket 403, never a silent drop. 409 if the flag is off. |
| ✅ | GET | `/api/:t/org-structure/service-units?companyIds=` | → `200 Envelope<ServiceUnitRow>` (`{unitId,nodeId,name,kind,status,servedCompanyCount,modules[],providerTenantId}`) | **ORG-7b, NEW.** Provider-side only (A8: `org_units` never leaves the provider) — units of `:t` (+ optional `companyIds` widen, same envelope semantics as the row above) that currently have ≥1 live-ish (`active\|suspended\|proposed`) assignment. No raw provider userIds leave this endpoint (A6) — just unit identity + served-company count + module keys. 409 if the flag is off. |
| ✅ | GET | `/api/me` `serviceScopes` | `Me.serviceScopes: {companyId,companyName,assignmentId,module,unitName,role:"staff"\|"manager"}[]` | **ORG-7b, NEW, additive to `Me`.** Companies the caller has ACTIVE service (reconciler-materialized) access into — backs the UX-2 company-selector's "served companies" badging. Derives from `service_grant_claims` joined to `service_assignments.status='active'` (the reconciler's own liveness source, A2) — never trusts the `managed_by` marker alone. `[]` whenever `SERVICE_ASSIGNMENTS_ENABLED` is off (default) or the caller has none. |
| ✅ | GET | `/api/:t/members?includeService=1` | → `Member[]` (+`kind`, `isService` when the flag is on) | **ORG-7b, NEW.** Gated behind `SERVICE_ASSIGNMENTS_ENABLED` end-to-end: while off, this endpoint is byte-for-byte the pre-existing behavior (no `kind` filter, no `isService` field) — every current deployed consumer is unaffected. Once on: default response filters to `kind='employee'` (hides reconciler-materialized service rows from the ordinary directory); `?includeService=1` includes both kinds and marks each row `isService:boolean` so the UI can badge service members (feeds ORG-12/WSD-4's served-company badging). |
| ✅ | POST | `/api/:t/users` | (A14, membership-side) | **ORG-7b, NEW.** `inviteUser` now mirrors the existing `assignRole` A14 hook on `company_memberships`: if the invite lands on (re-activates, or simply hits) an existing membership row that is reconciler-managed (`kind='service' AND managed_by IS NOT NULL`), the explicit invite ADOPTS it as manual (`adoptManagedGrantAsManual` — `kind→'employee'`, `managed_by→NULL`, drops its `service_grant_claims`) so a later revoke of the OWNING service assignment cannot decrement this now-doubly-intended membership into deletion. Behind `SERVICE_ASSIGNMENTS_ENABLED`; inert (byte-for-byte prior behavior) while off. |

## 3. People / employees & admin — `lib/adminData.ts`, `lib/people.ts`
| Status | Method | Path | Body → Response | Notes |
|---|---|---|---|---|
| ✅ | GET | `/api/:t/users` | → `UserRow[]` (incl. real `status` + `roles`) | BUILT (`admin-identity.controller.ts`). |
| ✅ | POST | `/api/:t/users` | `{name,email,title?,roleId?}` → `{id}` | BUILT. Invite/onboard. `admin.access`. Emit `user.invited`. |
| ✅ | PATCH | `/api/:t/users/:id` | `{title?,status?,name?}` → `{ok}` | BUILT. Edit profile / deactivate. `admin.access`. |
| ✅ | GET | `/api/roles` | → `RoleRow[]` | BUILT. Assignable roles (drives the invite + role pickers). |
| ✅ | POST | `/api/:t/users/:id/roles` | `{roleId,scopeType,scopeId?}` → `{ok}` | BUILT. Assign role. Emit `role.assigned`. **ORG-7 A14 hook (NEW, behind `SERVICE_ASSIGNMENTS_ENABLED`):** if `scopeType='company'` and the (user,role,scope) row already exists reconciler-managed (`managed_by IS NOT NULL`), this admin grant ADOPTS it as manual (`adoptManagedGrantAsManual` — clears `managed_by`, drops its `service_grant_claims`) so a later revoke of the OWNING service assignment cannot decrement this now-doubly-intended row into deletion. |
| ✅ | DELETE | `/api/:t/users/:id/roles/:grantId` | → `{ok}` | BUILT. Revoke role. |
| ✅ | GET / POST(verify) / DELETE | `/api/:t/identity-links[/:id[/verify]]` | → `IdentityLink[]` | BUILT. WA/TG identity links. |
| ✅ | GET/POST/PATCH/DELETE | `/api/:t/custom-fields[?entityType][/:id]` | → `FieldDef[]` | BUILT — all four methods present (`custom-fields.controller.ts`). |
| ✅ | GET/PATCH | `/api/:t/compliance-gates[/:id]` | → `ComplianceGate[]` | BUILT (`company-admin.controller.ts`). PATCH persists status/evidence. |
| ✅ | PATCH | `/api/:t/company/modules` | `{module,enabled}` → `{ok}` | BUILT. Enable/disable modules. |
| ✅ | GET | `/api/:t/audit?verb&actorId&entityType&since&until&limit` | → `AuditEntry[]` | BUILT (`admin-identity.controller.ts`). Filter/pagination richness of query params not verified from route inventory alone — confirm before closing the gap register. |

## 4. Work management — `lib/entities.ts`, `lib/data.ts`
| Status | Method | Path | Notes |
|---|---|---|---|
| ✅ | GET/POST/PATCH | `/api/:t/projects`, `/api/:t/projects/:id` | list + detail + create + PATCH exist. Projects gain an owning `department_id` (org-node id, nullable) — GET/detail returns it; POST/PATCH accept `departmentId` (optional, camelCase in body). Migration `0029_projects_department.sql` adds the column. Drives the Projects "Department" column + each department console's owned-projects list. Cross-department work still flows via task assignment. **No delete/archive endpoint — add one.** |
| ✅ | GET | `/api/:t/tasks?assignee=me` | base task list. |
| ✅ | GET/POST | `/api/:t/projects/:pid/tasks` | list + create. |
| ✅ | PATCH | `/api/:t/tasks/:id` | BUILT (`core.controller.ts`). Base task update. |
| ✅ | Agency | `/api/:t/modules/agency/campaigns[/:cid/briefs]`, `/approvals/pending`, `/approvals/:id/decide` | campaigns + approvals ✅; **briefs GET+POST ✅** (`agency.controller.ts`); assets GET+POST ✅, submit ✅. **Still no campaign detail/edit/delete endpoints** (not in route inventory). |
| ✅ (UI built) | GET/POST/DELETE | `/api/:t/clients[/:id]` | BUILT (`client-work.controller.ts`: GET, GET/:id, POST, PATCH, DELETE). UI: `/clients` list + `/clients/new` + `/clients/[id]` detail. Create/delete gated `pm.manage`. |
| ✅ (UI built) | GET/POST/PATCH | `/api/:t/deliverables[?projectId][/:id]` | BUILT (`client-work.controller.ts`). UI: `/deliverables` list + `/deliverables/new`. |
| ✅ (UI built) | GET/POST | `/api/:t/time-entries` | BUILT (incl. PATCH). UI: `/timesheets` (totals + billable rollup + log). POST body `{minutes,projectId?,taskId?,billable,entryDate,notes}`. |
| ✅ (UI built) | GET/POST | `/api/:t/invoices[/:id]` (+`PATCH` status) | BUILT (`billing.controller.ts`: GET, GET/:id, POST, PATCH). **Billing** UI: `/billing` list + `/billing/new` (generate from billable time in a period × rate) + `/billing/[id]` (line items, mark sent/paid). `Invoice` shape in `lib/billing.ts`. `company.manage` only. |
| ✅ (UI built) | GET | `/api/:t/modules/agency/approvals/decided` | BUILT. Decided-approval **history** (Approvals page "Recently decided"). Add `campaignId` to pending items so the UI deep-links to the campaign. |
| — | (pure UI) | Calendar `/calendar` | Agenda + workload built entirely from existing task/deliverable/project due dates — no new endpoint. |
| ✅ (UI built) | GET/POST/DELETE | `/api/:t/files[?entityType&entityId][/:id]` | BUILT (`files.controller.ts`: GET, POST, GET/:id, GET/:id/content, DELETE). **Attachments** on project + task detail. POST body today is a **reference** `{entityType,entityId,filename,url?}` → `{id}`. **TODO: true binary/multipart upload** (`multipart/form-data` with the file part) — UI attaches references for now. |
| ✅ (UI built) | GET/POST | `/api/:t/comments?entityType=&entityId=` | BUILT (`collab.controller.ts`). **Generic threaded comments** — task comments (via `lib/pm`) + **project "Discussion"** (via `lib/entities.postComment`). Any `entityType`. POST body `{body}`. |
| ✅ | GET/POST | `/api/rollups?period`, `/api/:t/rollups/recompute` | Add drill-down (records behind a metric) + period history for the reporting UI. |
| ✅ | GET/POST | `/api/:t/notifications[?unread]`, `/api/:t/notifications/:id/read` | BUILT — list, per-item read, and `read-all` all present (`collab.controller.ts`). **Add `payload.href`** (deep-link target) so notifications become clickable. |

## 5. Project management (Repsona-style) — `lib/pm.ts`, `lib/pmActions.ts`  — **ALL ✅ BUILT**
**See [`memory/pm-ai-tracker-contract`].** All routes below are present in `modules/pm/pm.controller.ts`
per the 2026-07-17 route inventory (confirm UI has been repointed off the in-memory demo store
`lib/demoPm.ts` if it still is):
- `GET /api/:t/pm/projects/:id` (+`PATCH` owner/status), `GET /api/:t/pm/projects/:id/tasks`
- `GET /api/:t/pm/tasks?assignee=me` (tenant-wide task list — the Tasks page uses this; falls back to base `/api/:t/tasks`)
- `GET /api/:t/pm/tasks/:id`, `POST /api/:t/pm/tasks`, `PATCH /api/:t/pm/tasks/:id`, `DELETE /api/:t/pm/tasks/:id`
  (`status|progress|assignee|title|priority|dueDate|startDate|estimateMinutes|milestoneId|description|addSubtask|toggleSubtask|removeSubtask|addDependency|removeDependency`)
- `GET/POST /api/:t/pm/projects/:id/milestones`, `PATCH …/:mid`
- `GET/POST /api/:t/pm/projects/:id/docs`, `GET/PATCH …/:docId`
- `GET/POST /api/:t/pm/tasks/:id/time` (time logs)
- **BUILT (P2-01, 2026-07-24):** `GET/POST /api/:t/pm/projects/:id/tags`, `PATCH/DELETE …/:tagId`
  — `Tag = {id, label, color}`; `color` is a closed 8-slug set (`bronze|champagne|olive|slate|clay|
  moss|dust|ink`, stored as the slug not a hex — the UI owns the swatch→hex mapping). Manage-gated
  (leads/admins) like milestones/docs. `DELETE` 409s `{inUse: <count>}` if any task in the project
  references the tag; `?force=1` strips the tag from every referencing task then deletes it.
  `PATCH /api/:t/pm/tasks/:id` now also accepts `tags: string[]` (rejects ids outside the task's own
  project's tag registry) and every task read response now includes `tags: string[]`. Migration
  `0036_pm_tags.sql` (table `pm_project_tags`, FORCE RLS; `pm_tasks.tags uuid[] DEFAULT '{}'`).
- **BUILT (P2-04, 2026-07-24):** `GET/POST /api/:t/pm/projects/:id/statuses`, `PATCH/DELETE …/:sid`
  — `ProjectStatus = {id, label, color, isDone, isBlocked, wipLimit?, position}`, per-project ordered
  workflow. Manage-gated (`pm.manage`). A project that never opens the editor **reads back 4
  synthesized defaults** (`todo|in_progress|blocked|done` at today's labels/colors) — no rows are
  written until the first status-editor write **materializes** them (`ensureMaterialized`). `POST`
  derives the id by slugifying the label (unique-suffixed). `DELETE` → **400 `{inUse: <count>}`** if
  any task references the status and no `?moveTo=<sid>` is given; with `?moveTo=<sid>` it reassigns
  those tasks then soft-deletes. `PmProject` GET responses now include `statuses: ProjectStatus[]`.
  Task create/`PATCH` **validate `status`** against the project's effective status set (unknown or
  cross-project ids → 400). **ENGINE FLAGS:** all server-side done/blocked semantics (progress↔done
  coupling on PATCH, the AI-tracker, `confirm`) derive from `isDone`/`isBlocked`, not the literal id,
  so a renamed done status (e.g. `shipped`) still couples. Migration `0038_pm_project_statuses.sql`
  (table `pm_project_statuses`, PK `(tenant_id, project_id, id)`, FORCE RLS; drops the legacy
  `pm_tasks.status` CHECK — column stays `text`, zero row rewrites).
- **BUILT (P3-01, 2026-07-24):** `POST /api/:t/pm/tasks` now also accepts `subtasks: string[]`
  (→ `[{id,title,done:false}]`) and `tags: string[]` (same cross-project-registry validation as
  `PATCH /api/:t/pm/tasks/:id` — a tag id outside this task's own project's `pm_project_tags` →
  400). `POST /api/:t/pm/tasks/:id/duplicate` → `{id}` (create-gated like `POST …/tasks`): copies
  title (+" (copy)"), description, priority, tags, subtasks (ids regenerated, `done` reset to
  false), estimate, milestone, assignee (assignee gets a fresh assignment notification pointing
  at the copy), dates, recurrence; resets `status` to the project's first-by-position **NON-done**
  status via `effectiveStatuses`' `isDone` FLAG (never the literal `"todo"` — verified with a
  project where the literal `todo` status is itself flagged done) and `progress` to 0; drops
  comments/time-entries/suggestions/`dependsOn` (never copied, never referenced — `depends_on`
  keeps its `'{}'` column default on the copy).
  **`GET/POST /api/:t/pm/templates[?kind=task|doc]`, `PATCH/DELETE …/:id`** — tenant-scoped (not
  project-scoped) reusable templates, manage-gated like tags/milestones/docs
  (`authorize({kind:"pm_task",tenantId},"manage")`). `Template = {id, kind: "task"|"doc", name,
  payload, updatedAt}`; `kind` is immutable post-creation (`PATCH` validates `payload` against the
  EXISTING row's kind, read server-side, never re-derived from the request body). Payload shape
  per kind, rejected (400) if it doesn't match: `task` = `{title, description?, priority?,
  estimateMinutes?, subtasks?: string[], tagLabels?: string[]}` (`tagLabels` are free-text labels,
  not registry ids — templates aren't project-scoped so there is no tag registry to validate
  against; resolving them into real project tags is an **apply-template** feature, not yet built);
  `doc` = `{title, body}`. Migration `0041_pm_templates.sql` (table `pm_templates`, FORCE RLS off
  the 0025 `app_current_tenants()` helper).
- **BUILT (P3-02, 2026-07-24):** `POST /api/:t/pm/projects/:projectId/duplicate {name}` → `{id}`
  (manage-gated: `authorize({kind:"pm_project",tenantId,id:projectId},"manage")`). Deep-clones a
  project + its structure in ONE tenant-scoped transaction: base `projects` row (name from input,
  `status` reset to `active`, NO due date, owner/`pm_project_meta` NOT copied; keeps
  `department_id`/`client_id`/`is_internal`/`custom_fields`), `pm_project_statuses` copied VERBATIM
  (same per-project slug ids; an unmaterialized/default project copies zero rows and the clone reads
  the same 4 synthesized defaults), `pm_project_tags` with FRESH uuids, `pm_milestones` with fresh
  ids (`status` reset to `open`, dates kept), `pm_docs` (author = duplicating user), and every task.
  Tasks follow P3-01 copy semantics EXCEPT: assignee CLEARED, `status` reset to the clone's
  first-by-position NON-done status (via `effectiveStatuses`' `isDone` FLAG), `progress` 0, subtasks
  reset (fresh ids, `done:false`), **tags remapped** through the tag map, **milestone_id remapped**
  through the milestone map, and (SECOND pass, once every new task id is known) **`depends_on`
  remapped** through the task map with any id that didn't copy DROPPED. Task titles kept verbatim
  (the PROJECT is the copy). No source-project id survives anywhere in the copy;
  comments/time-entries/suggestions/`recurrence_spawned_from` not carried. Emits
  `pm.project.duplicated`. No new migration (existing tables).
- **DEV-VERIFIED (WD-28, 2026-07-30):** per-project short-codes (OQ-7 default). `projects` gains
  `short_code text` (`UNIQUE(tenant_id, short_code) WHERE deleted_at IS NULL AND short_code IS NOT
  NULL`, derived on creation — first 3-4 uppercase alnum chars of the name, numeric-suffixed on
  collision — via `deriveUniqueShortCode()` in NEW `src/core/project-short-codes.ts`, wired into
  both project-creation call sites: `POST /api/:t/projects` (`core.controller.ts`) and `POST
  /api/:t/pm/projects/:id/duplicate`) and `task_seq integer NOT NULL DEFAULT 0` (the per-project
  atomic counter). `pm_tasks` gains `seq integer` (`UNIQUE(tenant_id, project_id, seq) WHERE seq
  IS NOT NULL`). **Atomicity mechanism:** a single `UPDATE projects SET task_seq = task_seq + 1
  WHERE id = $1 RETURNING task_seq` (`allocateTaskSeq()`) inside the same transaction as the
  `pm_tasks` INSERT — the UPDATE's row lock is held for the transaction's duration, so a second
  concurrent allocation on the same project blocks until the first commits; proven under 30
  genuinely concurrent live HTTP requests (`Promise.all`/parallel curl, not sequential) yielding
  exactly 30 distinct gapless seq values, zero duplicates. Every `pm_tasks` INSERT path allocates
  through it: `POST /api/:t/pm/tasks`, `POST …/tasks/:id/duplicate`, the recurrence-spawn child
  insert in `PATCH …/tasks/:id`, and each task copied by `POST …/projects/:id/duplicate` (which
  also derives the clone a FRESH short_code, never the source's, and its counter restarts at 0).
  `GET`/list responses for `pm_tasks` (`TASK_SELECT`) now carry `projectShortCode`, `seq`, and a
  server-computed `displayCode` (`"CODE-SEQ"`, e.g. `"WEB-142"`, null if either half is missing);
  `PmProject` GET responses and the base `GET /api/:t/projects` list carry `shortCode`. Backfill
  for pre-existing rows ships as **two** migrations: `0050_pm_short_codes.sql` (schema + an
  owner-run backfill DO block) and a same-day follow-up `0051_pm_short_codes_backfill_fix.sql` —
  **0050's backfill silently touched zero rows on live verification**: migrations run as
  `platform_owner`, which does NOT have `BYPASSRLS` (2026-07-15 DB-topology role split), and
  `projects`/`pm_tasks` carry FORCE ROW LEVEL SECURITY, so an owner-run backfill with no
  `app.current_tenant_ids` GUC set sees zero rows under RLS (no error, ledger still records
  "applied" because the DDL half succeeds) — 0051 wraps the same backfill logic per-tenant
  (`PERFORM set_config('app.current_tenant_ids', <company id>, true)` before touching each
  tenant's rows), verified idempotent (re-run directly against `platform_owner`, bypassing the
  ledger, three times running — zero rows changed after the first). Cross-tenant isolation
  verified live: two different tenants derived the identical literal code text with zero
  collision (uniqueness is `(tenant_id, short_code)`, never global). No Cerbos policy changes (no
  new action; existing `pm_project`/`pm_task`/`project` create/manage/read cover the new
  columns). `platform-ui`: `lib/pm.ts` (`PmTask.projectShortCode/seq/displayCode`,
  `PmProject.shortCode`), `lib/entities.ts` (`Project.shortCode`), board card + task detail
  header render `displayCode`; `demoPm.ts`/`demoFixtures.ts` synthesize the same shape
  (per-project counter + derived code) for DEMO_MODE parity.
- `GET /api/:t/pm/tasks/:id/suggestions`, `POST /api/:t/pm/tasks/:id/tracker/run`,
  `POST /api/:t/pm/suggestions/:id/confirm|dismiss`
- Task comments reuse `GET/POST /api/:t/comments?entityType=task&entityId=`.
- **BUILT (P3-08, 2026-07-24):** `GET /api/:t/pm/tasks/:id/followers` → `[{id,name}]`,
  `POST`/`DELETE /api/:t/pm/tasks/:id/follow` (no body — the followed row is ALWAYS
  `user_id = principal`, never client-supplied; read-gated, since following is a self-scoped
  preference, not a privileged action). Migration `0043_pm_task_followers_comment_reactions.sql`
  adds `pm_task_followers` (FORCE RLS off the 0025 `app_current_tenants()` helper). Follow is
  idempotent (`ON CONFLICT DO NOTHING`); both endpoints 404 on an unknown/foreign (RLS-hidden)
  task id. **Reactions** (`src/core/collab.controller.ts`): `POST /api/:t/comments/:commentId/reactions
  {emoji}` (comment-`create`-gated; 404 if the comment is gone/foreign; emoji is a closed set
  `👍❤️🎉👀✅💡🙏🔥` — off-set → 400; idempotent add via the table's own PK
  `(tenant_id,comment_id,user_id,emoji)`), `DELETE …/reactions/:emoji` (self-row delete only —
  `user_id` is always the caller, so it is structurally impossible to delete another user's
  reaction through this endpoint). `GET /api/:t/comments` gained an **additive**
  `reactions: [{emoji,count,mine}]` field per comment (viewer-scoped `mine`); every other field/
  shape is unchanged so existing comment consumers are unaffected. Same table
  (`comment_reactions`, migration 0043).
  **Notification fan-out (both endpoints above feed it):** in `patchTask`, when the task's status
  actually changes, every follower gets ONE `type:"task_update"` notification (title `“<task>”
  moved to “<status label>”`, `href:/tasks/:id`); in `createComment` for `entityType==='task'`,
  followers join the existing mention/assignee notify fan-out. **Dedup contract:** recipients from
  mentions ∪ assignee ∪ followers are collected into a single `Set` per event so nobody gets two
  notifications for one event (mentions win the single call when a recipient is both mentioned and
  a follower/assignee; the newly-reassigned assignee wins over a same-call status-change follower
  notification). `notify()` already auto-skips the actor (`recipientId === actorId`), verified —
  no separate actor-skip was needed.
- **Poly-assignee** `{kind:person|department|division, refId, refName, responsibleId, responsibleName}`;
  units come from the org structure. **Unify with the base task model** (§4) — today they are split.
- Emit `pm.task.created|updated`, `pm.tracker.run`, `pm.suggestion.confirmed`. The AI Tracker should run
  as the WS8 PM specialist agent (Gateway model + Knowledge/D9 docs); the UI renders its output.
- **BUILT (P3-10, 2026-07-24):** doc version history — append-only, DOC-scoped (not project-scoped)
  routes: `GET /api/:t/pm/docs/:docId/versions` → META only `[{version, authorId, authorName,
  createdAt}]` (no title/body; read-gated), `GET /api/:t/pm/docs/:docId/versions/:v` → full
  `{version, title, body, authorName, createdAt}` (read-gated, 404 on an unknown version or a
  gone/foreign doc), `POST /api/:t/pm/docs/:docId/versions/:v/restore` → sets the doc to version
  `v`'s content AND appends a brand-new version authored by the restorer (manage-gated, never
  rewrites any existing version row). Since these routes carry no `projectId`, authz resolves the
  doc's `project_id` from the (tenant-scoped, RLS-filtered) doc row first, then gates on
  `{kind:"pm_project", id: projectId}` exactly like `createDoc`/`patchDoc`. **Version-on-write:**
  `createDoc` writes version 1; `patchDoc` row-locks the doc (`SELECT … FOR UPDATE`) and appends
  `MAX(version)+1` authored by the patcher ONLY when title and/or body actually changed — a true
  no-op PATCH (both fields omitted or resubmitted identical) appends nothing. The row lock
  serializes concurrent writers on the same doc so two racing PATCH/restore calls can never compute
  the same next version number (`UNIQUE(tenant_id, doc_id, version)` is the hard backstop).
  `getDoc`/`listDocs` gained an additive `version` field (current/max version number, `COALESCE`d to
  1 for any pre-migration doc with no version rows yet — synth-on-read, not a backfill DML).
  Migration `0044_pm_doc_versions.sql` (table `pm_doc_versions`, FORCE RLS off the 0025
  `app_current_tenants()` helper).
- **BUILT (TR-02, 2026-07-30 — tracker/reporting program, see
  `docs/blueprints/tracker-reporting-foundation.md` §3.1/§12/§15):** task GET responses (`GET
  /api/:t/pm/tasks/:id`, `GET …/projects/:id/tasks`, `GET …/tasks?assignee=me`) gained an additive
  `contributors: {userId, name}[]` field (`[]` when none — old FE builds simply ignore the extra
  key). `PATCH /api/:t/pm/tasks/:id` gained `addContributor`/`removeContributor` ops (a user id;
  same op-style as `addSubtask`) — a mere `pm.update`-level member can call these (not
  manage-gated like reassigning `assignee`); the target must be a UUID and an active member of the
  tenant (400 otherwise); re-adding/removing an absent contributor is a no-op, never an error.
  Contributors are **never outcome-credited** and are **not** copied by `duplicate`/`duplicateTask`.
  Underneath, every path that writes the `assignee` blob (`createTask`, `patchTask` reassignment,
  the recurrence-spawn child insert, `duplicateTask`) now ALSO writes migration `0054`'s
  `pm_task_assignees` owner/responsible rows in the SAME transaction (dual-write; the blob stays
  the byte-unchanged FE wire format — no existing response field changed shape). A write-time
  drift-guard hook (`assigneeDrift`/`logAssigneeDriftIfAny` in `pm.controller.ts`) compares blob↔rows
  after every dual-write and logs `[PM-ASSIGNEE-DRIFT]` on a mismatch (TR-07 will wire the nightly
  per-tenant sweep). No new migration in this ticket (schema is TR-01's `0054_pm_task_assignees.sql`).

## 6. IT: devices & n8n — `lib/it.ts`  — **ALL ✅ BUILT**
**See [`memory/it-device-contract`].** All present per the route inventory: `GET/POST /api/:t/it/devices`,
`GET /api/:t/it/devices/:id`, `GET /api/:t/it/events`, `GET /api/admin/automation/workflows`,
`GET /api/admin/automation/workflows/:id` (`modules/it/it.controller.ts` +
`admin/admin-systems.controller.ts`). Heartbeat ingest (`POST /api/:t/it/devices/:id/heartbeat`) is
backend-only (UI reads) and is also present.

**Extended 2026-08-03 (IT-02/03/05, migration `0071`)** — see
`docs/superpowers/specs/2026-08-03-it-network-discovery-design.md`:
- ✅ `PATCH /api/:t/it/devices/:id` — the edit half this section previously claimed as built via
  "GET/POST". It never existed; a typo'd device was permanent. On a **discovered** row only the
  descriptive fields are editable and they land in an `overrides` layer that survives the next poll;
  collector-owned facts (`ip`/`mac`/`hostname`/`status`) are rejected with an explanatory 400.
- ✅ `DELETE /api/:t/it/devices/:id` — soft delete. `deleted_at` had been filtered on by every query
  since `0019` and written by nothing.
- ✅ `GET /api/:t/it/topology` — server-computed graph (`{ devices, links, lastRun }`). The old
  client-side `buildTopology()` grouped rows by two free-text strings and could not express an
  uplink; `lastRun` is required so the UI can tell a **dead collector** from an **empty network**.
- ✅ `POST /api/:t/it/discovery/report` — push ingest from `it-site-collector` (NOT YET BUILT). The
  ERP cannot poll the office UniFi controller: it is RFC1918 behind NAT and unreachable from
  `gda-aicenter` (verified, HTTP `000`).
- ✅ `GET /api/:t/it/devices` now accepts `?q=` (name/hostname/IP/MAC) and `?deviceClass=`.
- `Device` gained `discoverySource`, `deviceClass`, `hostname`, `isWired`, `ssid`, `uplinkMac`,
  `uplinkPort`, `lastSeenAt`, `firstSeenAt` — all optional, so the UI still renders against an
  older backend.

## 7. Systems & Intelligence consoles — `lib/admin.ts`  — **MOSTLY ✅ BUILT (one gap)**
`admin/admin-systems.controller.ts` + `admin/intelligence.controller.ts` now exist:
- ✅ `GET /api/admin/:system/status`, ✅ `GET /api/admin/:system/config` for `system ∈
  {bot,gateway,hub,agents,knowledge,automation}`. **⛔ `PUT /api/admin/:system/config` is NOT in the
  route inventory for gateway/hub/agents/knowledge/automation — config remains read-only for those;
  the write side is still pending.** **✅ `system=bot` is the one exception (A4, 2026-07-24):**
  `admin/admin-systems.controller.ts`'s `GET /api/admin/bot/config` now proxies the bot's own
  live config fields (editable:true for `postToGroups`/`managementGroupId`) instead of the honest
  url/tokenConfigured-only descriptor, and `bot`'s status `detail` gained a `session` field.
- ✅ `GET /api/admin/gateway/egress-audit`, ✅ `GET /api/admin/hub/tools`,
  ✅ `GET /api/:t/agents/goals`, ✅ `GET /api/:t/knowledge/sources` (+ ✅ `POST …/:id/review`).
- **✅ NEW (systems-console depth pass, 2026-07-27) — the gateway/hub/automation consoles were
  rendering a `/health` reshape plus a two-row `{url, tokenConfigured}` descriptor while the
  services themselves held far more. `GET /api/admin/:system/config` now returns a REAL projection
  for `gateway`/`hub`/`automation` (chain order, caps, breaker tuning, TLS/topology/DLP posture;
  policy engine, rate limits, peer allowlist; n8n + event-bridge posture), always with the honest
  connection descriptor appended and every secret still `kind:"secretPresence"`. New routes:**
  | Method | Path | Gate | Notes |
  |---|---|---|---|
  | GET | `/api/admin/gateway/detail` | `isElevated` | Proxies **new** ai-gateway-go `GET /admin/config`: per-capability chain in FAILOVER ORDER + live breaker state (`ok`/`open`/`unconfigured`, `rateLimited`, `openUntil`), provider inventory w/ `keyConfigured` presence only, budget breakdown **incl. per-tenant spend**, reliability tuning, security + topology posture. `null` when unreachable |
  | POST | `/api/admin/gateway/dr-mode` | `isElevated` | Body `{enable, durationMinutes?}` → gateway `POST /admin/dr-mode` (WS9 D15). Proxied so the gateway token never reaches the browser. Raises the daily cap → platform-admin/owner only |
  | GET | `/api/admin/gateway/egress-audit` | `isElevated` | **Extended:** `?limit&provider&capability&decision` (`decision` = `allow`\|`blocked`\|a specific block reason). Rows now carry structured `{capability, ok, blocked, redactions, latencyMs}` alongside the legacy `{time, provider, decision, detail}` |
  | GET | `/api/admin/hub/detail` | `isElevated` | Proxies **new** mcp-hub `GET /admin/info`: policy engine (**Cerbos vs in-code fallback**), deny-by-default, assurance ranks, the D14 automation write gate, revocation, rate limits (per principal + per service token), mTLS mode/peer allowlist/topology, tool counts by source, **Resources + Prompts** (the two primitives the console never showed), and the per-workflow `AUTOMATION_ALLOWLIST` scope matrix |
  | GET | `/api/admin/hub/audit` | `isElevated` | Proxies **new** mcp-hub `GET /audit`: the §8 tool-call decision trail (principal, tool, allow/deny, reason), newest-first. It was written to JSONL and readable nowhere |
  | GET | `/api/admin/hub/tools` | `isElevated` | **Extended:** each row now carries `source` (`core`/`platform-read`/`platform-write`/`pipeline`/`delivery`/`module`) |
  | GET | `/api/admin/automation/executions` | `isItOrElevated` | n8n run history, newest-first, with `workflowId` resolved to a name + `durationMs`. Previously fetched and discarded except one "last run" cell |
  | GET | `/api/admin/automation/bridge` | `isItOrElevated` | Event→n8n bridge health (`events/bridge-health.ts`): per watched stream `backlog`/`deadLetter`/`oldestPendingMs`, plus the bridged event allow-list and retry/timeout config. A stalled bridge silently stops every event-triggered workflow; this is the only surface that shows it |
- **✅ NEW (write levers, 2026-07-27) — the consoles gained the actions that were previously
  read-only-by-omission. Every write is `isElevated` (platform_admin / group_executive) and proxied,
  so no service token ever reaches the browser:**
  | Method | Path | Gate | Notes |
  |---|---|---|---|
  | PUT | `/api/admin/gateway/config` | `isElevated` | Body `{key,value}` → gateway `PUT /admin/config`. **The gateway owns the allowlist + bounds + persistence**; this proxy re-throws its 4xx VERBATIM (400 bounds/type, 400 non-writable key, 409 "can't take effect") so a rejected value explains itself instead of becoming a generic 502. Writable: `dailyCallCap`, `perTenantDailyCallCap`, `breakerThreshold`, `breakerCooldownMs`, `providerTimeoutMs`, `dlpClassifierEnabled`, `llmChain`/`mediaChain`/`embedChain`. **NOT writable (env + restart): provider credentials, egress allowlist, TLS mode, topology** — a console session must not widen the gateway's own security boundary |
  | DELETE | `/api/admin/gateway/config?key=` | `isElevated` | Drops the override → the key reverts to its env value, **live**, not restart-deferred. Without it a console write is permanently sticky (the override file keeps shadowing a corrected env) |
  | POST | `/api/admin/automation/workflows/:id/activate\|deactivate` | **`isElevated`** (NOT `isItOrElevated`) | n8n Public API `POST /workflows/:id/{activate,deactivate}`; returns n8n's own resulting `{id,active}` rather than assuming the requested state. Deliberately a NARROWER gate than the read-only canvas: deactivating silently stops business automation |
  | POST | `/api/admin/automation/bridge/:entityType/replay` | `isElevated` | Moves dead-lettered entries back onto the source stream so the bridge redelivers them (`replayBridgeDeadLetters`). Re-adds BEFORE deleting (a crash duplicates — which the at-least-once bridge + n8n's envelope-id dedupe handle — rather than dropping). The stream name must be one the bridge actually watches, so an arbitrary Redis key can't be targeted |

  `GET /api/admin/gateway/config` now sets `editable` per field from the gateway's own
  `writableKeys`, and `GET .../detail` carries `writableKeys` + `overriddenKeys` — so an older
  gateway with no write route yields a fully read-only page automatically, and a value that is a
  console override rather than the env value says so.

  **Deliberately NOT built — n8n execution retry.** n8n's Public API has no execution-retry route
  (retry lives on its internal `/rest` surface, which needs a browser session). Replaying the
  triggering EVENT is the sanctioned equivalent and is both more correct (re-runs from the real
  input instead of resuming a half-finished run) and available for every event-triggered flow.
- **✅ NEW (B3, `erp-whatsapp-and-agent-runtime-e2e.md` §3.3) — real agent-runner proxy,
  replacing the old hardcoded `[]`/"CLI/library, no live status" stubs.**
  `config.services.agents = {url: AGENTS_URL, token: AGENT_RUNNER_TOKEN}`;
  `admin/admin-systems.controller.ts`'s `probeStatus("agents")`/`connectionConfig("agents")` now
  hit the runner's real `GET /health` (no more special-cased "not an HTTP service" note — status
  `detail.agents`/`detail.writeAgents` feed the UI's agent-select).
  `admin/intelligence.controller.ts`:
  | Method | Path | Gate | Notes |
  |---|---|---|---|
  | GET | `/api/:t/agents/goals` | `authorize(activity read)` (unchanged) | Runner `GET /goals?tenant=:t` reshaped to the UI `AgentGoal` (`budgetSpent=modelCalls+toolCalls`, `budgetTotal` from `budget`, `fanOut`) + `{agent,createdAt,endedAt,errorKind,approvalId}`. `[]` when `AGENTS_URL` unset/unreachable |
  | GET | `/api/:t/agents/goals/:goalId` | `authorize(activity read)` | Runner detail (tenant-pinned), same reshape + `blackboard`/`runs`. 404 when unconfigured/unreachable/unknown |
  | GET | `/api/:t/agents/runs/:runId` | **`isElevated`** (shared `admin/elevated.ts`) | Runner run incl. step transcript (tenant-pinned). Elevated-only — a transcript can carry tool output fetched under the *triggering* user's authority |
  | POST | `/api/:t/agents/goals` | **`isElevated`** | Body `{goal,agent?}`. (1) idempotently upserts the **platform self-link** `identity_links(provider='platform', external_id=userId, user_id=userId)` via `ON CONFLICT (provider, external_id) DO NOTHING`, both sides pinned server-side from `req.principal.userId` — never from the body; (2) calls runner `POST /goals` with `envelope={provider:'platform', externalId:userId}`, `requestedBy=userId` → `202 {id,status}` passthrough. `503` when `AGENTS_URL` unset/unreachable |
- **✅ NEW (A4, `erp-whatsapp-and-agent-runtime-e2e.md` §2.4) — `admin/bot-admin.controller.ts`**,
  `@Controller("api/admin/bot")`, `isElevated`-gated (shared with admin-systems via the extracted
  `admin/elevated.ts`), proxying the bot's own ADMIN_TOKEN-gated `/admin/*` (WhatsApp go-live
  self-service — session lifecycle, group registry, safe config write). Fail-soft: bot not
  configured → 404 `{error}`; unreachable/non-2xx → 502 `{error}`; the bot's own validation 400
  `{error,field?}` is surfaced verbatim (the shared `HttpErrorFilter` now forwards an optional
  `field` alongside `error`). This is what makes `updateBotConfig`'s existing `PUT
  /api/admin/bot/config {key,value}` stub (previously 404) real, and unblocks the `/systems/bot`
  Connect-WhatsApp UI (§2.5 of the design doc, not yet built):
  | Method | Path | Notes |
  |---|---|---|
  | POST | `/api/admin/bot/session/start` | 200 `{session,status,engine}` |
  | GET | `/api/admin/bot/session/status` | 200 `{session,status,engine,me,lastEvent}` |
  | GET | `/api/admin/bot/session/qr` | 200 `{qr:"data:image/png;base64,…"\|null,status}`, `Cache-Control: no-store` |
  | POST | `/api/admin/bot/session/{stop,logout,restart}` | 200 `{session,status}` |
  | GET/PUT | `/api/admin/bot/groups` | `{registryActive,groups,discovered,managementGroupId}`; PUT `{groups:[…]}`, 400 on non-array before forwarding, else bot's own field-level 400 passthrough |
  | PUT | `/api/admin/bot/config` | body `{key,value}`; key allow-list `{postToGroups,managementGroupId}`, else 400 |
  (No `GET /api/admin/bot/config` here by design — that read path stays on the generic
  `admin/admin-systems.controller.ts` route above.)
- **✅ BUILT — read-only chat viewer + logs for the WA/TG Bot page** (bot `chat-admin.ts` +
  `store.listChats`, nest `admin/bot-admin.controller.ts`). Same `isElevated` gate / fail-soft
  `botCall` contract as the rest of this controller; content is already decrypted +
  PII-scrubbed at ingest by the bot's store, so these routes add no new PII handling:
  | Method | Path | Notes |
  |---|---|---|
  | GET | `/api/admin/bot/chats?limit=` | `{chats:[{chatId,kind:"group"\|"dm",surface:"whatsapp"\|"telegram",name,messageCount,lastActivityTs,lastPreview}]}`, sorted by `lastActivityTs` desc |
  | GET | `/api/admin/bot/chats/:chatId/messages?limit=` | `{chatId,messages:[{ts,senderId,senderName,text,fromBot,mediaMime?,mediaStatus?,mediaText?}]}`, oldest→newest (thread order); `chatId` is URL-encoded (handles `111@g.us`, `628@c.us`, `tg:-1001`); bot's own 404 (unknown chat) surfaced verbatim |
  | GET | `/api/admin/bot/session/events` | `{events:[{status,ts}]}` — the session-state transitions ring buffer, oldest first |
  | GET | `/api/admin/bot/actions/audit?limit=` | Proxies the bot's existing `/admin/actions/audit` (no new bot route) — same shape as before, now reachable through nest for the Logs tab |

## 8. Backend surfaces with no UI/`lib/*` consumer yet
Found in the 2026-07-17 route inventory but not referenced anywhere in this contract doc (no
`platform-ui/src/lib/*.ts` client uses them yet). Listed here for completeness — all ✅ BUILT
in code, flagged only for "no frontend wired" rather than "backend pending":
| Status | Method | Path | Notes |
|---|---|---|---|
| ✅ (no UI) | POST | `/api/:t/authz/check` | `core/authz-check.controller.ts`. |
| ✅ (no UI) | GET/POST/PATCH | `/api/:t/teams[/:teamId]`, POST/DELETE `/api/:t/teams/:teamId/members[/:userId]` | `core/teams.controller.ts` — base teams entity, no UI screen yet. |
| ✅ (no UI) | GET | `/health` | `health/health.controller.ts` — bare, no `/api` prefix; infra healthcheck only. |
| ✅ (no UI) | POST/GET | `/api/:t/automation-approvals[/:id/decide]` | `core/automation-approvals.controller.ts` — WS4 automation-suspension surface; distinct from `/modules/agency/approvals`. |
| ✅ (no UI) | GET | `/mcp/tool-defs` | `modules/mcp-tools.controller.ts` (`@Controller("mcp")`) — consumed by MCP Hub, not platform-ui. |
| ✅ (no UI) | POST | `/principal/resolve`, `/identity/enroll/start`, `/identity/enroll/confirm` | `identity/identity.controller.ts` — root-level, not under `/api`; OBO/D4 enrollment, service-to-service. |
| ✅ **STALE "no UI" tag — now consumed** | GET/POST | `/api/:t/portal/runs[/:runId]`, POST `/gates/:id/decide`, POST `/runs/:runId/scope-sign` | `core/portal.controller.ts` — the client portal (`/portal`, `lib/portal.ts`). WD-03 (Web Dev Phase 1 §12, D-3): the sign view now renders the LATEST stage artifact (`ArtifactMarkdown`) above the sign/feedback action for the gate it governs — "what a client signs must be what they see." Full doc sweep for this row + neighbors is WD-07's ticket, not redone here. |
| ✅ **STALE "no UI" tag — now consumed** | POST/GET/PATCH | `/api/:t/pipeline/runs[/:runId][/stages]`, `/pipeline/stages/:id`, `/pipeline/gates[/:id/decide]`, `/pipeline/runs/:runId/scope-signoffs` | `core/pipeline.controller.ts` — the WS11 meeting→MOM→PRD/Report/Scope pipeline; consumed by the run workspace (`/pipeline/[runId]`, WD-02, `lib/pipeline.ts`). **WD-03 (D-3) delta:** `PATCH /pipeline/stages/:id` with `artifactRef` present is now a signature-locked EDIT — 409 once the stage's client sign gate (matched by track: `delivery`→`prd_sign`/`customer_feedback`, `scope`→`scope_signoff`; `report` never locks) is `decided`, via ANY path that decides it (native route or the generic `/approvals/:id/decide` façade, since both write the same `pipeline_gates` row); Cerbos `pipeline_stage.update` narrowed to `company_admin`/`manager`/`group_executive` (plain `member` now denied — was previously granted, a widening this ticket closed); every edit gets a `writeActivity` row + `pipeline.stage.updated` event (`artifactEdited:true`). Deliberately does NOT also lock on `stage.status === 'done'` — extraction lands stages `done` immediately, before any client sign gate exists, so that would make editing unreachable for every ingested run (falsified against the live "Acme Coffee kickoff" run — see WD-03 evidence). Workspace edit UI: `pl-edit` details/form in `pipeline/[runId]/page.tsx` (`isStageLocked` in `lib/pipeline.ts` mirrors the backend rule for the "locked" badge; the backend 409 remains the real authority). **WD-29 (DEF-2) delta — response shape is ADDITIVE, no breaking change:** `POST /pipeline/runs/:runId/stages` and `POST /pipeline/gates` may now return an optional `deduped: true` alongside the usual `id` (still `201`), meaning the call was a stale-snapshot repeat and `id` is the EXISTING row the pipeline is really on — same convention `POST /pipeline/runs` already uses for its `sourceMeetingId` dedupe. Callers should treat `{id, deduped:true}` as success and keep using the returned `id` (that is what keeps a raced n8n execution on the live lineage); no client change is required, and nothing that previously succeeded now errors. Every run-state transition (stage create/update, gate open/decide, scope sign-off, run PATCH — on the internal AND `portal/*` routes) now serializes on a per-run advisory lock, so concurrent deciders for ONE run are ordered while different runs stay fully parallel; a `claude_design` create is admitted only when no design exists or the head design has a decided `customer_feedback: changes_requested`, so WD-05's revise loop still produces its legitimate second design but retriggers cannot manufacture extra ones. `scope.signed` now fires only on the TRANSITION to complete (re-filing an already-complete sign-off no longer re-emits). Schema backstop: partial `UNIQUE(run_id, track, name)` over the single-shot stage names (`0052`) — deliberately NOT covering `claude_design`. |
| ✅ **STALE "no UI" tag — now consumed** | POST/PATCH/GET | `/api/:t/meetings/recordings/start`, `PATCH /:id`, `POST /:id/transcript`, `POST /:id/ingest`, `POST /:id/drive`, `GET /`, `GET /:id` | `core/meetings.controller.ts` — WS11 capture-edge registry (helper-driven: record → local whisper → register → transcript → ingest proxy, `N8N_BRIDGE_SECRET` stays server-side). Consumed by `lib/meetings.ts`/`lib/meetingsActions.ts`, the `/meetings` registry + `/meetings/[id]` detail/workbench, and the PRD Studio tab (`departments/[deptId]/prd`, `RecordControls`). **WD-07 (Web Dev Phase 1 §12) additions:** `/meetings`'s table gained a "Run" column resolving the linked `pipeline_runs.status` (not just the recording's own `status`) via one extra `listPipelineRuns` call; PRD Studio's "Source meeting" cell is now a link back to `/meetings/[id]` when the run's `source_meeting_id` resolves to a known recording (`listRecordings` cross-referenced by `meeting_id`, mirroring WD-02's reverse lookup in `lib/meetings.ts`'s `findRecordingByMeetingId`). `RecordControls` also gained optional `clientId`/`projectId` props (hidden fields feeding the existing `/start` body, unchanged contract) — wired into the project workspace (`ProjectWorkspaceView.tsx`'s new "Meetings" card) and the client detail page, each showing its own scoped `GET .../recordings?clientId=`/`?projectId=` list. **Verified end-to-end (not just "should work"):** a recording started from a project page carries that project's `client_id` + the `projectId` itself on the `meeting_recordings` row, and — since another agent's fix to `mtg-dispatcher.json` (WD-01 finding F-1) now forwards `clientId` into `pipeline.createRun` — an ingested run from that recording carries a non-null `pipeline_runs.client_id` too (DB-probed, see WD-07 evidence; this ticket verified the chain, it did not touch the dispatcher). |
| ✅ **STALE "no UI" tag — now consumed** | POST | `/api/:t/meetings/recordings/:id/audio` (multipart, field `file`) → 202 `{id,status:"transcribing",audioRef}`; `/:id/audio/retry` → 202 `{id,status:"transcribing"}` | WD-04 (Web Dev Phase 1 §12) — `core/meetings.controller.ts`. In-ERP audio upload with no helper required: size cap (`MEETING_AUDIO_MAX_BYTES`, default 200MB) + audio-type allowlist enforced at upload; async job calls the whisper container's `/v1/audio/transcriptions` DIRECTLY (not via ai-gateway-go — bypasses its ~2.5-min timeout); flips `transcribing→transcribed` or `→failed` (retryable via the second route, reusing the stored audio — no re-upload). Additive `meeting_recordings.audio_ref` column (migration `0049`); the helper's local-whisper contract (`start`/`transcript` above) is unchanged. **WD-07 (2026-07-30, Part A) landed the frontend** — WD-04's own AC ("an `.m4a` uploaded in the browser becomes a transcript") had only ever been curl-verified; a real gap, not a doc staleness. `AudioUploadForm.tsx` (mounted on `/meetings/[id]`'s workbench) uploads via a new `platformUpload()` helper in `lib/platform.ts` (deliberately separate from `platformFetch` — that helper always forces `content-type: application/json`, which would corrupt a multipart boundary) and polls a new route-handler, `GET /api/meetings/:id/status`, on a 2.5s interval that self-terminates once status reaches `transcribed`/`failed`/`ingested` — the same poll-until-terminal shape as `WhatsAppConnect.tsx`'s bot-session poll. `RecordControls` gained a register-then-upload combined path (`registerAndUploadAudioAction`) for the case where no recording row exists yet — it starts one, uploads into it, then redirects to `/meetings/[id]` where `AudioUploadForm` takes over. DEMO_MODE equivalent: `demoUploadAudio`/`demoRetryAudio` in `demoMeetings.ts` (a filename containing "fail" simulates a whisper-down failure, since demo mode has no real whisper container to fail against). |

---

## Cross-cutting backend needs the UI is built to consume
- **Delete/archive** on every entity (project, task, campaign, milestone, doc, device, company).
- **Server-side list params** (`?page&pageSize&sort&dir&q&filter`) — the UI's `DataTable` does this
  client-side today; add server paging/filtering for real volume. Keep response shape `T[]` or add
  `{rows,total}` (note which in the type).
- **Export** — CSV is generated client-side now; a server export endpoint is optional.
- **Notifications `payload.href`** + real-time channel (SSE/WebSocket) for live updates (IT heartbeat,
  approvals, tracker) — UI is currently no-store per navigation.
- **i18n/timezone/currency** — money is currency-aware in `lib/format.ts`; locale is `en-GB` hardcoded
  (make it a user preference later).

## 9. Daily-Work UX (UX-2, 2026-07-20) — binding new reads, all additive

From `docs/superpowers/specs/2026-07-20-daily-work-ux-spec.md`. All four are NEW reads — no
existing endpoint's shape changes breakingly. Assumes `rbac.ts scopeCovers` fix (A4) lands first.

- **(a) Unified approvals** — ✅ BUILT (read only; WSUX-1, 2026-07-23). `GET /api/approvals?scope=all|<companyId>&origin=agency,pipeline,hr,automation,agent&status=pending|decided&sort=urgency|age` → `Envelope<UnifiedApprovalItem>`
  (`src/core/approvals.controller.ts`). Unions three EXISTING, independently-Cerbos-gated sources
  — `agency_approvals` (origin `agency`), `pipeline_gates` (origin `pipeline`), and
  `automation_approvals` (origins `automation`/`agent`/`hr`, per WSD-4's hr-leave-rides-automation-
  approvals design) — no new authorization model: every row's visibility/decidability is the SAME
  `authorize()`/Cerbos call each origin's own native endpoint already makes, probed per
  `(tenant, origin[, module])` leg. Cross-company fan-out is per-tenant `withTenants([t])` legs
  over the caller's OWN authorized companies (D-UX-2) — never a widened GUC set (A1 lint stays
  clean, zero new allowlist entries). A company with zero readable origins for this request is
  `{included:false, reason:"no_access"}` (soft-probed, never a hard 403 — a crafted/foreign
  `scope=<companyId>` degrades to an excluded envelope entry, not a leak); a per-tenant query
  failure is `{included:false, reason:"error"}`, never a request-wide 500. `UnifiedApprovalItem`
  gains one additive field beyond the interface below — `status: string` (the origin's own
  terminal-state word: `pending` / `approved` / `rejected` / `changes_requested` / `signed` /
  `decided`) — needed for `status=decided` history mode.
  **Canonical `urgencyScore` weights (D-UX-3, `src/core/approvals-urgency.ts` — the ONE file to
  retune, Q13):** `urgencyScore = originBase(origin) + impactBonus(impact) + ageBonus(ageMs)`,
  where `originBase = {pipeline:100, agency:90, automation:80, agent:80, hr:70}` (mirrors the
  binding spec §1.2 mock: gates/agency review rank "NOW", hr leave ranks "SOON" at equal age),
  `impactBonus = {high:15, medium:5, unclassified:0}` (automation/agent only — the other three
  origins pass no impact), and `ageBonus(ageMs)` climbs linearly to +40 as the item approaches
  ~80h (3.3 days) pending, then saturates. The UI's later `lib/queueUrgency.ts` (WSUX-5) MUST cite
  this same table rather than inventing its own, per the ordering-parity fixture test in its AC.
  Plus generic decide façade — ✅ BUILT (WSUX-2, 2026-07-23). `POST /api/:t/approvals/:id/decide {origin,decision,note?}` → `{ok:true}` (`src/core/approvals-decide.controller.ts`). A thin dispatcher, not a reimplementation: it validates `origin` against the same taxonomy, then calls the origin's OWN controller method directly (`AgencyController.decide` / `PipelineController.decideGate` / `AutomationApprovalsController.decide` for automation+agent+hr) — same `authorize()`/Cerbos call, same SQL transition, same outbox event (`pipeline.gate.decided`, `automation_approval.decided`; agency has none). No new authorization model, no widened visibility — a caller denied by the native endpoint is denied identically through the façade (same exception, same status code). The one origin-specific replica needed: agency is module-gated via a class-level `ModuleEnabledGuard`, which a direct method call bypasses, so the façade re-checks `isModuleEnabled(tenantId,'agency')` itself before dispatching (404 if disabled, matching the native route). `decision` shape validation is NOT duplicated here — each origin's own handler still 400s on an invalid value for that origin (e.g. `changes_requested` is valid for pipeline, not for automation/agency). Replaces agency-only `/approvals/pending` as the inbox source.
- **(b) Cross-company My-Work tasks** — ✅ BUILT (read only; WSUX-3, 2026-07-23).
  `GET /api/tasks/mine?scope=all|<companyId>&status=&dueBefore=` → `Envelope<TaskRow>`
  (`src/core/tasks-mine.controller.ts`). A **union shim over the forked task model** (D-UX-1: the
  fork stays until WS-B unifies it) — per authorized company, unions the caller's OWN assigned
  rows from BOTH `tasks` (single-person `assignee_id`) and `pm_tasks` (poly-assignee jsonb,
  module-gated), normalized into one `TaskRow`. No new authorization model: each leg is the SAME
  `authorize()`/Cerbos "read" check (+ pm's own per-tenant module-enable gate) the native
  `/api/:t/tasks?assignee=me` / `/api/:t/pm/tasks?assignee=me` endpoints already make. Cross-
  company fan-out is per-tenant `withTenants([t])` legs over the caller's own authorized
  companies (D-UX-2) — never a widened GUC set (A1 lint stays clean, zero new allowlist
  entries); an inaccessible/foreign `scope=<companyId>` degrades to `{included:false,
  reason:"no_access"}`, a per-tenant query failure to `{included:false, reason:"error"}` —
  never a 500, never a cross-tenant leak. `TaskRow` gains `company`/`tenantId` (additive
  alongside the existing single-tenant reads) **plus two more additive fields**: `source:
  "task"|"pm_task"` (which model the row came from) and a server-computed `href` (both sources
  resolve to `/tasks/:id` today — the pre-existing convention `pm.controller.ts`'s own
  notifications already use — so the UI never re-derives the detail route itself; a future
  per-source route split is backend-only). **Disjointness is asserted, never silently merged:**
  rows are NEVER deduped by id across the two models; if the same id exists in both `tasks` and
  `pm_tasks` for one tenant (a data bug, e.g. a migration collision), that tenant's leg throws
  and is reported as an excluded/errored company entry rather than folding both rows together or
  crashing the whole request. **WS-B swap marker:** the entire union lives in one function,
  `tasksLegForTenant` in `tasks-mine.controller.ts`, clearly marked — when WS-B unifies the
  models, only that function's body collapses to one query; the wire contract is unchanged.
  Deviation from the pre-existing draft above: no `companyIds=` widening param was built (the
  ticket's endpoint shape omitted it and `GET /api/approvals`, WSUX-1, set no precedent for it
  either) — add it later analogous to ORG-7b's envelope reads if a caller needs to widen beyond
  its own companies.
- **(c) Typed notification payload** — ⬜ PENDING (tighten, not new path). `GET /api/:t/notifications` `payload` becomes required `{title, href, body?, entityType?, entityId?, severity?}` (was opaque). Every notification writer must populate it.
- **(d) Inclusion envelope** — ⬜ PENDING (shared shape). `Envelope<T> = {items: T[], companies: [{id,name,included,reason?}]}`, required on (a), (b), and every future ALL/served-company fan-out (`/api/scoped/*`, department Serviced-block once ORG-13 lands).

_Cross-references:_ `memory/org-structure-contract`, `memory/it-device-contract`,
`memory/pm-ai-tracker-contract`, `memory/ui-rbac-and-company-scope`, `memory/backbone-program`. Type shapes are canonical in
`platform-ui/src/lib/{platform,entities,adminData,org,organization,pm,it,admin}.ts`.

## 10. HR module (WSD-4, 2026-07-22) — `modules/hr/hr.controller.ts` — **BACKEND ✅ BUILT (no UI/`lib/hr.ts` consumer yet — WSD-5)**

From `docs/superpowers/specs/2026-07-20-hr-module-design.md`. Module key `'hr'`; dark unless
`companies.enabled_modules ∋ 'hr'` OR an ACTIVE `service_assignment` serves `'hr'` to the tenant
(`registry.ts isModuleEnabled`, §4). All routes mounted `/api/:tenantId/modules/hr/*`.

- ✅ `GET/POST /api/:t/modules/hr/cases`, ✅ `GET/PATCH/DELETE /api/:t/modules/hr/cases/:id`,
  ✅ `POST /api/:t/modules/hr/cases/:id/cancel`, ✅ `PATCH /api/:t/modules/hr/cases/:id/checklist`
  (onboarding/offboarding/review/grievance/other; self-service read/create/cancel of one's own case).
- ✅ `GET/POST /api/:t/modules/hr/records`, ✅ `PATCH/DELETE .../records/:id`,
  ✅ `GET /api/:t/modules/hr/records/export` (D4 high-assurance gate; NO subject self-read in v1).
- ✅ `GET/POST /api/:t/modules/hr/leave` (file → `hr_leave_requests` + an `automation_approvals`
  row with `origin:'hr'` in one transaction), ✅ `POST .../leave/:id/cancel` (own pending only),
  ✅ `GET /api/:t/modules/hr/leave/balances`. Deciding rides the EXISTING
  `POST /api/:t/automation-approvals/:id/decide` (now accepts `?origin=hr` on the list GET too) —
  no forked decide endpoint; the hr eventHandler applies the outcome + moves the balance + notifies
  the subject (`payload.href = "/hr/leave/:id"`).
- ✅ `GET/POST /api/:t/modules/hr/attendance` (staff-editable only, per-day upsert).
- ✅ `GET/POST /api/:t/modules/hr/checklist-templates`, ✅ `POST /api/:t/modules/hr/onboarding/instantiate`
  (manual trigger; the same helper backs the automatic `user.invited` → onboarding-case spawn).
- Rollups: `hr.open_cases`, `hr.leave_pending`, `hr.onboarding_active` feed the cross-company
  management view like every other module.
- **⬜ PENDING (WSD-5):** `/hr`, `/hr/leave`, `/hr/attendance`, `/hr/onboarding` UI + `lib/hr.ts` +
  `rbac.ts` `hr.view`/`hr.manage` caps. Backend is UI-ready — every route above is live now.

## 11. Work-activity / evidence model (P1-04, Web-Dev Phase 1) — `src/core/work-activity.controller.ts` — **BACKEND ✅ BUILT, UI ✅ WIRED (`platform-ui/src/lib/activity.ts` — reconciled 2026-07-30, WD-20)**

**Corrected 2026-07-30 (WD-20 QA gate):** this section previously said "no UI consumer yet" — that
is stale. `platform-ui/src/lib/activity.ts` exports `WorkActivityRow` matching the shape below
verbatim and is consumed by the department Home (`(app)/departments/[deptId]/page.tsx`) and the
Activity tab (`(app)/departments/[deptId]/activity/page.tsx`), with `demoFixtures.ts` entries for
DEMO_MODE. Migration `0030_work_activity.sql`. Deliberately **not** named `activities`/`audit` —
those are the pre-existing flat audit table (`core.controller.ts GET /api/:t/activity`), untouched
by this work.

**Scope note:** P1-04 built the schema + this API + the linker + Cerbos. The **outbox consumer**
that drives ingestion automatically off pm/pipeline/meeting/pipeline_run events
(`src/events/work-activity-consumer.ts`), plus the **historical backfill**
(`src/core/work-activity-backfill.ts`), landed as **WSUX-15 (ex-P1-05)** — this is no longer a gap;
the feed has live automatic writers today, redelivery-safe (dedupe by outbox id, dead-letter after
`DEAD_LETTER_MAX_RETRIES`).

**TR-05 additions (2026-07-30, tracker/reporting program §3.4):** the consumer now also covers
`pm_doc` (create/update/restore, `objectKind: 'doc'` — surfaces via `deliverable_evidence`) and
`pm.task.commented` (comments on a genuine `pm_tasks` row only — a comment on a non-PM "task"
never mints a bogus `source='pm'` row; guarded in `collab.controller.ts`). Task status-change verbs
are now **completed / reopened / status_changed**, derived from the `is_done` FLAG that
`pm.controller.ts`'s `patchTask` already computes via `effectiveStatuses()` (never a literal status
id — a renamed/custom done status still counts; carried through the outbox payload as
`wasDone`/`isDoneNow`/`statusChanged` so the consumer never re-derives is_done-ness itself). A patch
with no status edge still falls back to the generic `updated` verb. Historical `pm_doc` activity is
backfilled the same way pm_task/pm_project already were; historical comment activity is **not**
backfilled (flagged, not silently skipped — see `work-activity-backfill.ts`'s header) because
`writeActivity`'s "commented" rows are filed under whatever `entityType` the caller passed (e.g.
`"task"`, shared across subsystems), so telling a PM comment apart from a non-PM one pre-go-live
would need a join this backfill doesn't do; comment evidence starts from this ticket's live
consumer forward only.

- ✅ `GET /api/:t/work-activity?deptId=&projectId=&personId=&since=&limit=` → `WorkActivityRow[]`
  (member-level read; `deptId`/`projectId`/`personId` filter via a join on `work_activity_links`;
  `since` is an ISO timestamp lower bound on `occurredAt`; `limit` default 100, max 500).
  ```ts
  interface WorkActivityRow {
    id: string; tenantId: string;
    source: 'pm'|'pipeline'|'github'|'google_drive'|'claude'|'manual'|'system';
    sourceRef: string;                    // idempotency leg; the source's own stable id
    actorUserId: string | null; actorExternal: string | null;
    verb: string; objectKind: string; objectRef: string; title: string | null;
    payload: Record<string, unknown>;
    occurredAt: string; originSite: string; createdAt: string;
    links: Array<{ targetKind: 'pm_task'|'project'|'person'|'department'; targetId: string;
                    confidence: 'exact'|'inferred'; rule: string }>;
  }
  ```
- ✅ `POST /api/:t/work-activity` → `201 WorkActivityRow & {deduped: boolean}`. **Admin/service-
  principal only** (Cerbos `work_activity:create`, `company_admin`+ — mirrors
  `rollup_recompute:create`; NOT an everyday staff action). Body: `{source, sourceRef, verb,
  objectKind, objectRef, actorUserId?, actorExternal?, title?, payload?, occurredAt?, text?}`.
  **Idempotent** on `(tenantId, source, sourceRef)` (`ON CONFLICT DO UPDATE`, returns the
  existing/updated row with `deduped:true` on a redelivery; `work_activity.created` fires on the
  outbox only on the FIRST ingest of a given key, never on a redelivery). `payload.taskId` /
  `payload.projectId` / `payload.actorId` are structured link hints (exact); `title`+`text` are
  uuid-scanned for additional (inferred) links the auto-link engine can positively classify as a
  pm_task/project/person id already in this tenant. `sourceRef` is REQUIRED (it IS the idempotency
  key — omitting it is a 400, not an auto-minted id, since a minted id could never dedupe a retry).
- **Auto-link engine** (`src/core/work-activity-linker.ts`): a PURE function, unit-tested
  independent of any database (`work-activity-linker.test.ts`, 16 cases). Rule order: (a) structured
  hints → exact; (b) uuid-scan in free text, only for uuids the DB-lookup boundary positively
  classified → inferred; (c) derived chain — task→its project, project→its `department_id`
  (NULL-tolerant), actor→person → inferred. An exact link is never downgraded by an inferred rule on
  the same target. **GitHub/Drive source-specific rules are Phase-2 slots**, not implemented (the
  `source` CHECK already accepts `'github'`/`'google_drive'` rows so P1-05 can start writing them).
- `deliverable_evidence` — a plain SQL VIEW (no RLS of its own; inherits the base tables' FORCE RLS
  as any view does) over `work_activity` rows whose `objectKind ∈ {file,doc,deliverable}`, left-
  joined to `work_activity_links`. No endpoint yet — a future reporting surface reads it directly.
- Cerbos: `cerbos/policies/resource_work_activity.yaml` (read = member/viewer/manager/team_lead/
  company_admin; create = company_admin/platform_admin only). Policy-parity tests added to
  `src/rbac/cerbos.test.ts` (5 new cases, live-Cerbos-gated like the rest of that file).

**WD-26 additions (2026-07-30) — `wd-digests`/`wd-stale-nag` n8n automation data seams. No UI
consumer yet; these back the digest/nag flows only.**
- ✅ `GET /api/:t/work-activity/stale-tasks?days=N` (member-level read, same tier as the base
  feed) → open `pm_tasks` (`status <> 'done'`) with no linked `work_activity` in the last N days
  (default 5, 1..90):
  ```ts
  { taskId: string; title: string; projectId: string; projectName: string;
    assigneeUserId: string|null; assigneeName: string|null;
    projectOwnerUserId: string|null; projectOwnerName: string|null; daysStale: number }[]
  ```
  `daysStale` is computed server-side off `COALESCE(last linked activity, task.created_at)` so the
  caller (wd-stale-nag) can bucket N vs 2N escalation with one call, no logic of its own.
- ✅ `POST /api/:t/work-activity/relink?limit=N` → `{scanned, relinked, linksAdded}`. **Admin/
  service-principal only** (same `work_activity:create` tier as ingest). Deterministic relink
  sweep (LD-16): re-runs the pure `deriveLinks` engine over rows with ZERO links (bounded batch,
  default 100, oldest-first). Idempotent by construction — a row is only ever selected while it
  has no links.
- **Not part of this API surface, but shipped alongside it (same ticket):** `POST
  /api/:t/meetings/recordings/relink-orphans` (`src/core/meetings.controller.ts`) — a SEPARATE,
  narrower DEF-1 reconciliation sweep for `meeting_recordings` rows orphaned by the (now-fixed)
  5s ingest-proxy timeout: matches `meeting_recordings.meeting_id` ↔ `pipeline_runs.source_meeting_id`
  and flips the recording to `ingested` + sets `pipeline_run_id` where a real run already exists.
  Admin/service-only (new Cerbos action `relink` on `meeting_recording`, company_admin tier).

## 12. Connections subsystem / integration credential vault (WSUX-14, ex-P1-08) — `src/core/integrations.controller.ts` — **BACKEND ✅ BUILT, UI ✅ WIRED (`platform-ui/src/lib/connections.ts` — reconciled 2026-07-30, WD-20)**

**Corrected 2026-07-30 (WD-20 QA gate):** this section previously said "no UI consumer yet" — that
is stale. `platform-ui/src/lib/connections.ts` exports `ConnectionRow` matching the shape below
verbatim; the Connections tab (`(app)/departments/[deptId]/connections/`), `ConnectionsPanel.tsx`,
and `TeamConnectionsGrid.tsx` (WSUX-16) consume it live. A NEW core (not module-gated) subsystem:
the single place a person or a company links an external provider (`github`|`google_drive`|`claude`)
to the ERP, plus the **at-rest credential vault** for that link's OAuth/API tokens. Migration
`0033_integration_connections.sql` (FORCE RLS, tenant-scoped — connections are **per-company** in
v1; a person re-links per company). Note: the original ticket plan (decision #6 in
`web-dev-phase1-tickets.md`) named this migration `0031`; it actually landed as `0031_creative_assets.sql`/
`0032_creative_assets_training.sql` went first (a concurrent program claimed those numbers first), so
integration_connections is `0033` — reconciled in the ticket plan doc alongside this fix.

**Vault + token non-exposure (security-critical — the WSUX-12 gate probes this):** tokens are sealed
with app-layer **AES-256-GCM** (`src/core/secret-box.ts`, `enc:v1:<iv>:<tag>:<data>`, key from env
`INTEGRATION_TOKEN_KEY`, base64 32 bytes; `token_key_version` column for a future OpenBao/KMS swap).
**No response ever serializes `access_token_enc`/`refresh_token_enc`** — a stored credential surfaces
ONLY as `hasToken`/`hasRefreshToken` booleans. Token writes are **fail-closed** (503 without the key).
**Phase-1 HTTP create/patch accept NO tokens**; the seal path (`setConnectionTokens`) is internal,
for the Phase-2 OAuth callbacks that ride this foundation.

- ✅ `GET /api/:t/integrations/connections?owner=me|company|user:<id>&provider=` → `ConnectionRow[]`
  (default `owner=me`; excludes soft-revoked rows). Authz: `owner=me` = self-service (any member);
  `owner=company` and `owner=user:<other>` require **manager+/company_admin** (`company.manage` tier).
  ```ts
  interface ConnectionRow {
    id: string; tenantId: string;
    ownerKind: 'user'|'company'; ownerId: string;
    provider: 'github'|'google_drive'|'claude';
    externalAccount: string | null;            // github login / google email / claude seat email
    scopes: string[];
    status: 'unconfigured'|'pending'|'linked'|'error'|'revoked';
    hasToken: boolean; hasRefreshToken: boolean;   // NEVER the token itself
    tokenExpiresAt: string | null; tokenKeyVersion: string | null;
    meta: Record<string, unknown>;             // e.g. { designLogin } for provider='claude' (C1)
    createdBy: string | null; originSite: string; createdAt: string; updatedAt: string;
  }
  ```
- ✅ `POST /api/:t/integrations/connections` → `201 ConnectionRow`. Body:
  `{ provider, ownerKind?='user', ownerId?, externalAccount?, scopes?, meta? }`. A `user` connection
  defaults `ownerId` to the caller (self-service, member-ok); creating for another user or an
  `ownerKind='company'` row (its `ownerId` is forced to the tenant) requires **manager+**. **No tokens
  accepted.** Idempotent on `UNIQUE(tenantId, ownerKind, ownerId, provider)` — a repeat create (incl.
  re-linking a soft-revoked row) upserts the mapping back to `unconfigured` and returns the same `id`.
- ✅ `PATCH /api/:t/integrations/connections/:id` → `200 ConnectionRow`. Body:
  `{ externalAccount?, meta?, status?, scopes? }`. `status` is client-settable only to
  `unconfigured|pending|error` (400 otherwise — `linked` is set by the token path, `revoked` by
  DELETE). Own-row = self-service; others'/company rows = manager+.
- ✅ `DELETE /api/:t/integrations/connections/:id` → `200 ConnectionRow` — **SOFT revoke**:
  `status='revoked'`, all token columns NULLed, row KEPT (mirrors service-assignment revoke). Same
  own-vs-company authz. A forged/other-tenant `:id` is a **404** (tenant-scoped row load before authz).
- Events: `integration_connection.created` / `.updated` / `.revoked` / `.linked` on the outbox.
- Cerbos: `cerbos/policies/resource_integration_connection.yaml` — own user-rows = self-service
  (`member`/`viewer`/`team_lead` gated by the shared `owns` variable); company rows + others' rows =
  `company_admin`/`manager`/`group_executive`/`platform_admin`.

### 12a. C1 Claude seat registry (WSUX-17, ex-P1-10) — `src/core/claude-seats.{controller,service}.ts` — **BACKEND ✅ BUILT, UI ✅ WIRED (`platform-ui/src/lib/claudeSeats.ts` — reconciled 2026-07-30, WD-20)**

A thin, provider-scoped projection over §12's vault — **NO new table, NO new secret path**. A "seat"
IS an `integration_connections` row with `owner_kind='user'` and `provider='claude'`; this API just
reshapes it (`codeSeatEmail`/`designLogin`/`mapped`) and adds the one thing the generic API can't do:
list every user's claude row in a tenant at once (the team roster). Reuses
`resource_integration_connection.yaml` verbatim — no new Cerbos policy file.

- ✅ `GET /api/:t/integrations/claude-seats?owner=me|team|user:<id>` → `SeatRow[]` (0 or 1 item for
  `me`/`user:<id>`, since a person has at most one claude row per company; any length for `team`).
  `owner=me` = self-service; `owner=team` and `owner=user:<other>` require **company.manage**
  (manager+) — the console's team grid is gated the same as §12's `owner=company`. **`owner=team`
  excludes revoked rows by default**, same convention as §12's list (a person who was never
  seat-mapped has NO row at all — that, not a revoked row, is the `LauncherRow` "Map your seat" state).
  ```ts
  interface SeatRow {
    id: string; tenantId: string; personId: string;      // = the row's owner_id
    codeSeatEmail: string | null;                         // = ConnectionRow.externalAccount
    designLogin: string | null;                           // = ConnectionRow.meta.designLogin
    status: 'unconfigured'|'pending'|'linked'|'error'|'revoked';
    scopes: string[];
    mapped: boolean;             // codeSeatEmail set AND not revoked — NOT derived from status alone
    createdBy: string | null; createdAt: string; updatedAt: string;
  }
  ```
- ✅ `POST /api/:t/integrations/claude-seats` → `201 SeatRow`. Body:
  `{ userId?, codeSeatEmail, designLogin? }`. `userId` defaults to the caller (self-map); mapping
  another `userId` requires company.manage (admin mapping). Upserts on the same
  `UNIQUE(tenant,owner_kind,owner_id,provider)` as §12 — re-mapping (incl. after unmap) reuses the row.
- ✅ `PATCH /api/:t/integrations/claude-seats/:id` → `200 SeatRow`. Body:
  `{ codeSeatEmail?, designLogin?, status? }`. `designLogin` is **read-merged** into the existing
  `meta` (not a wholesale replace) so it never clobbers other meta keys. Same `status` restriction as
  §12. 404s (not just 403) if `:id` isn't a `provider='claude'` row in this tenant.
- ✅ `DELETE /api/:t/integrations/claude-seats/:id` → `200 SeatRow` — unmap, i.e. §12's soft revoke.
- Optional ops/QA seed: `npm run seed:claude-seats [companyName]` (default `Gaia Digital Agency`) —
  maps the first company member's seat, maps+unmaps the second (leaves a revoked row on hand), prints
  the team roster count. Distinct from WSUX-10's DEMO_MODE frontend fixtures.

## 13. Creative module — Studio · Generation · DAM (CR-*, design `blueprints/creative-design.md`) — shapes canonical in `lib/creative.ts`

Existing Image-Studio persistence is **BUILT**; the expansion (generation/edit/upscale/video via the
Creative Render Gateway + the shared DAM) is **PENDING** per the v1.0 design. New surface lives under
`/api/:t/modules/creative/*`; the legacy `/api/:t/creative/assets` path is preserved as a **stable alias**.

- ✅ **BUILT** — `GET/POST /api/:t/creative/assets`, `GET /api/:t/creative/assets/:id/content`,
  `.../:id/original`, `DELETE .../:id`, `PATCH .../:id` (training-set curation). Image Studio grading persistence
  (migrations `0031`/`0032`). Kept working; the module surface below supersedes it going forward.
- ⛔ **PENDING (CR-02/12)** — `GET/POST /api/:t/modules/creative/assets`, `GET .../assets/:id/versions`,
  `POST .../assets/:id/versions`. Asset + version stack (kind/source/rights/`license_class`/`reuse_status`/
  provenance/checksum/phash/CLIP embedding/caption). RLS third-wall `app_module_allowed('creative')`.
- ⛔ **PENDING (CR-12)** — `GET/POST /api/:t/modules/creative/collections`, `.../brand-kits`. Many-to-many
  collections; a brand kit is a typed collection (logo/palette/font slots).
- ⛔ **PENDING (CR-16)** — `GET /api/:t/modules/creative/search?q=&similar_to=&kind=&reuse_status=`. Keyword +
  **CLIP visual/semantic** nearest-neighbour (pgvector) + dedup; cross-dept discovery surface (SMM/SEO/WebDesk
  consume it). Returns rights-gated, reuse-approved assets by default.
- ⛔ **PENDING (CR-08/10/13/22/24)** — `POST /api/:t/modules/creative/jobs` (enqueue a typed render:
  upscale/generate/edit/t2v/i2v), `GET .../jobs`, `GET .../jobs/:id` (state machine: `queued`/`awaiting-approval`/
  `running`/`succeeded`/`failed`/`cancelled`). Spend-gated via WS4 (one-shot payload-hash approvalId); metered
  in `creative_usage_ledger`. Backed by `render-gateway-go`.
- ⛔ **PENDING (CR-06/14)** — `GET /api/:t/modules/creative/scopes`, `PATCH .../scopes/:id`. Per-client caps +
  premium (FLUX/commercial-video) opt-in tiers; feeds the fail-closed stop-loss (image $200 / video $300 envelopes).
- ⛔ **PENDING (CR-11)** — `GET /api/:t/modules/creative/ledger`. Per-client render cost/usage ledger with
  `requester_module` attribution (SMM D-9 generative-image credits book here once, attributed).
- ⛔ **PENDING (CR-20)** — `POST /api/:t/modules/creative/renditions/sign` → signed expiring imgproxy URL
  (per-network crop presets shared with SMM/SEO/WebDesk). **QA gate:** no open proxy; tampered/expired/unsigned refused.
- 🔒 **Internal (not UI):** `POST /api/internal/creative/render-callback` — idempotent by `job_id`, per-job
  callback token (+ optional mTLS); gateway → platform-nest terminal-state transitions only.
- **Cross-dept note:** SMM/SEO/WebDesk pull **approved** assets + imgproxy renditions via `search` +
  `renditions/sign`; reuse is gated by `reuse_status` (WS4 "approve for reuse" gate), not raw asset access.

---

## 14. search-marketing module — SEO · SEM · GEO (SM-*, design `blueprints/seo-sem-design.md`) — shapes canonical in `lib/searchMarketing.ts`

Mounted at `/api/:t/modules/search/*` (`modules/search/search.controller.ts`). Consumer is the **SEO
department console** (`/departments/seo/*`, SM-11). Naming trap: the UI client is
**`lib/searchMarketing.ts`** — `lib/search.ts` is the unrelated app-wide global-search helper.

**✅ BUILT (SM-01/02/04 — the console renders these for real):**

- `GET/POST properties` · `GET/PATCH/DELETE properties/:id` → `SearchProperty`
- `GET/POST engagements` · `GET/PATCH/DELETE engagements/:id` → `SearchEngagement`
- `GET/PUT engagements/:id/scope` → `ToolScopeConfig` (D-11 per-engagement tool scope)
- `GET engagements/:id/cost-projection` → `CostProjection` (priced by SM-04 `estimateCostUsd`)
- `GET/POST kpi-targets` · `GET/PATCH/DELETE kpi-targets/:id` → `SearchKpiTarget`

**SM-33 (simulation provenance) — additive fields on an existing shape, no new endpoint.**
`CostProjection` now also carries `providerMode: "live" | "simulate"` (state it once in the
engagement header) and, per row, `perTool[].simulated: boolean` (render the `SIMULATED` chip — it is
per-tool because provider selection is per-capability, so one toggle can be simulated while another
is live). `search_provider_calls`/`search_data_cache` carry `simulated` too (migration 0047), but
there is still no ledger-listing endpoint (see SM-17 below) — so `cost-projection` is the ONLY
provenance-carrying response the console can read today. **SM-38 badges it** (ScopeEditor's per-tool
grid + total, the engagement header's mode statement) — verified against `providers/dispatch.ts`'s
`ProjectedToolCost`/`projectMonthlyCost` and `search.controller.ts`'s `getEngagementCostProjection`.

**Gap SM-38 found (superseded — migration 0048 landed, SM-14 discharged the Keywords-tab half):**
`search_keywords` originally had NO provenance column at all — no `metrics_provider`, no
`metrics_simulated` — and the three snapshot tables carried `provider` + a nullable
`provider_call_id` but no `simulated` column. All four columns landed together in **migration 0048**.
`listKeywords` (`search.controller.ts`) now selects `metrics_provider AS "metricsProvider",
metrics_simulated AS "metricsSimulated"` alongside `volume`/`difficulty`/`cpc_usd` — SM-14's own AC4 —
and `platform-ui`'s `SearchKeyword` interface (`lib/searchMarketingShared.ts`) + demo fixtures
(`lib/demoFixtures.ts`) carry the same two fields, verified against that exact SELECT. `metricsProvider`
is `null` until a metrics-pull ever runs for that keyword (never a guessed vendor); `metricsSimulated`
is a real boolean (0048: `NOT NULL DEFAULT false`), never absent. `search_rank_snapshots.simulated` is
SM-14's own stamp (below); `search_backlink_snapshots`/`search_ai_visibility.simulated` are SM-16's
(BUILT, see further down this section).

Note for **SM-17**: its ledger/usage read surfaces MUST select and expose `simulated`, or a demo
month's synthetic dollars will render as real client spend.

**✅ BUILT (SM-18 — SEM planning objects; NO live side-effects, matching the ticket's own scope):**

Real paths (the pre-SM-18 rows above listed speculative `sem/...` placeholders — these are the
actual routes `search.controller.ts` mounts):

- `GET/POST engagements/:id/campaigns` · `GET/PATCH/DELETE campaigns/:id` → `SearchCampaign`.
  Campaign `status` is writable ONLY as `draft|proposed` here — `live|paused|ended` mirror a real ad
  account and are out of this ticket's reach (SM-20/25/26).
- `POST engagements/:id/campaigns/generate-plan` — the cluster→plan generator: builds one campaign
  + one ad group per keyword cluster from an already-clustered keyword set (SM-09). Each returned ad
  group carries a `provenance: {providers, simulatedCount, realCount, unpulledCount}` block — the
  keyword-metric provenance flow-through the standing rule requires (§A2/§A4.7): providers are listed
  separately, never blended into one figure.
- `GET/POST campaigns/:id/ad-groups` · `GET/PATCH/DELETE ad-groups/:id` → `SearchAdGroup`.
- `GET/POST ad-groups/:id/ads` · `PATCH/DELETE ads/:id` → `SearchAd`. `status` writable only as
  `draft|approved|rejected` (`live` is sync-only).
- `POST ad-groups/:id/ads/draft` — AI RSA draft (Hermes via ai-gateway-go), grounded in the ad
  group's own cluster keywords; always persists `status:'draft', aiGenerated:true`.
- `GET/POST campaigns/:id/negatives` · `PATCH/DELETE negatives/:id` → `SearchNegative`. `status`
  writable only as `proposed|approved|dismissed` (`applied` is SM-30/21's job).
- `POST campaigns/:id/negatives/propose` — AI negative-keyword classification over
  HUMAN-SUBMITTED search terms only (`{terms:[...]}` or `{text:"one per line"}`) — it does NOT yet
  read the synced `search_term_metrics_daily` rows SM-20 (below) now persists; wiring an AI negative
  sweep to the SYNCED terms (rather than a human paste) is SM-22's job, not this route's. Fallback on
  a gateway outage is deliberately an EMPTY candidate list, never a fabricated rule-based judgment.
- `GET/POST campaigns/:id/change-proposals` · `GET change-proposals/:id` · `PATCH
  change-proposals/:id` → `SearchChangeProposal`. This ticket only reaches
  `proposed → approved | dismissed`; `applied` is refused everywhere here (400) — SM-30 (manual
  mark-applied) and SM-21 (api-mode, one-shot WS4 approval) own that transition exclusively.
  `payload`/`mode` are editable only while `status='proposed'` (payload is hash-matched at approval,
  design §04).

**✅ BUILT (SM-30 — the manual-apply/export twin; D-8's zero-OAuth manual half, ships without SM-25's
Google client):**

- `POST change-proposals/:id/export` → `{fileId, filename, contentType:"text/csv", byteSize,
  provenance}`. Requires `status IN ('approved','applied')` (re-exporting an already-applied proposal
  is allowed — a harmless re-download) AND `mode='manual'` (an `mode='api'` proposal is refused; it
  executes exclusively via SM-21's one-shot approval path — this route never calls a vendor). Builds
  a real, researched Ads-Editor-importable CSV per `kind` (`launch`→Keywords shape,
  `pause`/`budget`/`bid`→Campaigns shape, `negatives_batch`→negative-keywords shape,
  `ads_batch`→RSA shape — see `sem-export.ts`'s file header for the exact Google-doc-sourced column
  names and the 5 explicitly-named format assumptions where confidence ran out). Persists the CSV as
  a `files` row and links it via `search_change_proposals.export_file_id`. `budget`/`bid` read from
  `payload` first, falling back to the campaign's own stored fields; `negatives_batch`/`ads_batch`
  require `payload.ids: string[]` (the specific negative/ad rows this batch covers — an ads_batch ad
  must already be `status='approved'`, never silently skipped). **Honesty on the one data-informed
  kind (`launch`, built from provider-metric-bearing keyword clusters):** the response's `provenance`
  (`{providers, simulatedCount, realCount, unpulledCount}`, never blended, same shape as SM-18's plan
  generator), the `filename` (`-SIMULATED` suffix whenever any row is simulated), and a **per-row
  trailing "Notes" column** in the CSV itself all carry the marker — never a leading comment row
  (which would risk Ads Editor reading it as a shifted header). Cerbos action `update` (baseline
  tier — exporting has no live side effect).
- `POST change-proposals/:id/mark-applied` → body `{note?: string}` → `{id, status:"applied"}`. **The
  one new door to `status='applied'`** — narrow by construction: one route, one elevated Cerbos action
  (`apply_manual`, matching `search:campaign:launch`'s declared scope — module_manager/company_admin/
  group_executive only, no Cerbos policy file changed by this ticket), one precondition
  (`status='approved'` AND `mode='manual'`), one audit trail. The generic `PATCH change-proposals/:id`
  above still refuses `'applied'` unconditionally — unchanged, regression-tested. Idempotent: a
  sequential double-call is refused 400 (already-applied), a genuine concurrent collision is refused
  404 via a compare-and-swap `UPDATE ... WHERE status='approved'` (the same idiom the PATCH route
  uses) — no code path can double-record. Cascades `search_negatives.status→'applied'` /
  `search_ads.status→'live'` for the rows named in `payload.ids` (design §04) — campaign-level kinds
  (`launch`/`pause`/`budget`/`bid`) deliberately do NOT touch `search_campaigns` here (that mirrors
  the campaign PATCH route's own pre-existing rule: live/paused/ended require a real live-ads sync,
  SM-20/25/26 — a human's self-report is not the same authority as a read-back from the account).
  **Deliberately NOT an MCP tool** (an automation principal cannot self-attest a human's live-platform
  action) — `search.exportProposal` IS a real MCP-tool binding now (`method`/`pathTemplate` on the
  module contract), `search.applyNegatives`/`setBudget`/`launchCampaign` remain SM-21/26's stubs.

**✅ BUILT (SM-20 — search-terms sync; the search-terms HALF of the ticket only — the
`search_campaign_metrics_daily` bridge is still not built, see the PENDING row below):**

- `POST search-terms/callback` → body `{engagementId, campaignId, rows:[{adGroupId, date, term,
  matchType?, impressions?, clicks?, costMinor?, currency?, conversions?, convValueMinor?}]}` →
  `{status:"ingested", campaignId, simulated, rowsReceived, rowsUpserted}`. A signed webhook, NOT an
  ordinary console route — authenticated by a shared secret header
  (`x-gaiada-search-sem-callback-secret`, env `SEARCH_SEM_CALLBACK_SECRET`), checked FIRST, before any
  body validation, Cerbos check, or database read. **Deliberately a DIFFERENT secret from
  `SEARCH_CALLBACK_SECRET`** (the DataForSEO collect edge's own, SM-56) — two different external
  trust boundaries (a paid-vendor postback vs. a Google Ads Script running inside a client's own
  account), never sharing one secret. Fail-closed when unconfigured (an unset secret refuses EVERY
  request, same as SM-56's edge). Every request whose `campaignId` does not resolve to a campaign
  under the claimed `engagementId`, or whose `adGroupId` does not resolve to an ad group under that
  campaign, is refused with the SAME 404 (`SearchTermScopeError`) as a campaign that does not exist at
  all — the SM-63 admission-check class, applied on this edge from day one rather than discovered by a
  gate. **Not a paid pull**: never routes through `dispatchProviderOp`, writes no `search_provider_calls`
  row — `costMinor` on an ingested row is the CLIENT's OWN real Google Ads spend, self-reported by
  their account, never our metered provider cost (design addendum §A3 money-language rule). Idempotent
  via a schema-level `UNIQUE (tenant_id, campaign_id, row_hash)` (migration 0062) — `row_hash` is a
  server-computed sha256 over the canonical tuple (SM-08's precedent, chosen over a tuple UNIQUE
  because `term` is unbounded caller text) — enforced via `INSERT ... ON CONFLICT ... DO UPDATE`, so a
  redelivered or partially-overlapping batch never duplicates rows, proven under a genuinely forced
  concurrent race (see `sem-search-terms.test.ts`). `simulated` stamped from
  `config.search.providerMode` at write time (§A4.7 — this edge has neither a `DispatchResult` nor a
  per-connection OAuth issuer flag to draw the flag from).
- `GET campaigns/:id/search-terms?adGroupId=&startDate=&endDate=` → the persisted rows (newest date
  first), each carrying its own `simulated` badge — the "Search Terms" tab's read surface (this row
  used to say "no live search-term LISTING exists yet"; it now does).
- **Still not built** (see the PENDING table below): a `search_campaign_metrics_daily` ingest route —
  SM-20's design-doc line also names a campaign-level metrics-daily bridge; this ticket's brief scoped
  it to the search-terms half only, and that table has no writer yet.

**✅ BUILT (SM-14 — rank tracking; real routes, not the speculative `rankings/pull`-style paths an
earlier draft of this doc's own PENDING table used to list):**

- `POST engagements/:id/rank-pull` → body `{keywordIds?: string[]}` (omit for every `is_tracked=true`
  keyword under the engagement). Sequential per-keyword dispatch (`kind:"serp"`, tool-scope toggle
  `rank`); a mid-batch scope/budget/pillar refusal stops the loop but never rolls back already-pulled
  keywords — remaining ones report `{status:"skipped", reason:<code>}` inside the batch response
  (HTTP 200), same shape as SM-16's pulls. Each pulled result + the persisted `search_rank_snapshots`
  row carry `position` (nullable — the tracked property genuinely not found in that SERP is honest,
  never an error), `rankedUrl`, `provider`/`simulated` stamped from `DispatchResult.simulated` (never
  re-derived from the platform mode or the nullable `provider_call_id` FK), and `dropped` +
  `previousPosition` (a found→worse or found→not-found regression vs. the immediately-prior snapshot
  emits `search.rank.dropped`; first-ever pulls and not-found→not-found never do).
- `POST keyword-sets/:id/metrics-pull` → body `{keywordIds?: string[]}` (omit for every keyword in
  the set). Same sequential/hard-stop shape, dispatching `kind:"volume"` (tool-scope toggle
  `volume`). `search_keywords.volume`/`difficulty`/`cpc_usd` + `metrics_provider`/`metrics_simulated`
  are all written in ONE UPDATE (provenance can never disagree with the value it sits on). A keyword
  absent from the provider's response is left completely untouched — "absent stays absent," never a
  re-stamp with no new value.
- `POST rank-pulls/callback` → body `{engagementId, propertyId, keywordId, taskId}` — the
  Standard-queue **COLLECT** edge n8n's DataForSEO postback bridge hits (**BUILT**, SM-56; the
  postback itself carries only a task id and is never trusted as data). **A collect costs nothing:**
  it retrieves a task this platform already paid for at post time via a task-id-keyed fetch
  (`task_get` only) and writes **no** ledger row. It does not route through the dispatch choke-point
  (which cannot retrieve without re-posting — that was the SM-56 double charge), but still enforces
  the **pillar** and **scope** gates; only the budget cascade is skipped, because there is no
  purchase to price. n8n gets no bypass.
  - **`taskId` is REQUIRED** (it was optional pre-SM-56, used only as a correlation id): a collect
    with no task id has nothing to collect.
  - **Auth:** every existing wall is unchanged (service/IdP token, module gate, tenant scope, RLS,
    Cerbos `research`) **plus** a required `x-gaiada-search-callback-secret` header compared in
    constant time against `SEARCH_CALLBACK_SECRET`. **Fail-closed:** with that env unset the route
    refuses every request. `401 {error}` for a missing *or* wrong secret — deliberately
    indistinguishable, so the edge is not an oracle.
  - **Responses:** `200 {keywordId, keyword, status, position, rankedUrl, provider, simulated,
    dropped, previousPosition, taskId, reconciledIncurred}` where `status` is `"collected"` (one new
    snapshot, attributed to the original paid call) or `"duplicate"`. **Postbacks are at-least-once,
    so redelivery is normal and idempotent:** the same task id arriving again returns
    `status:"duplicate"` with **200** (the platform holds the data — a retrying vendor must not be
    told it failed) and writes no second snapshot and no second ledger row.
    `reconciledIncurred: true` means this collect closed out a charge previously written off as
    `incurred`, advancing that row to `completed` **at the same cost** (never a second row).
  - **Refusals:** `400` bad/missing ids or missing `taskId`, or `keywordId`↔`engagementId`↔
    `propertyId` linkage mismatch · `401` secret · `404` no ledger record of a paid task with that id
    for this tenant (refused *before* any vendor call, so a forged postback cannot cause spend or
    even a vendor round-trip) · `409 {code:"scope_disabled"}` · `503
    {code:"pillar_disabled"|"collect_unsupported"}` (`collect_unsupported` = the resolved driver has
    no task-id fetch; refused rather than downgraded to a paid re-post).
- `GET properties/:id/rank-snapshots` → optional `?keywordId=&engine=&device=&limit=`, raw history
  newest-first, **badge, not filter** — every row keeps its own `provider`/`simulated` truth across a
  mode flip (there is no aggregate/COUNT reader over this table in the console yet).
- `GET keyword-sets/:id/keywords` (`listKeywords`, pre-existing SM-09 route) widened to also select
  `metricsProvider`/`metricsSimulated` (see the "Gap SM-38 found" note above) — SM-14's AC4.
- Both pulls are `resource_search_keyword` actioned as `research` (a paid-pull action distinct from
  plain `read`/`update`, per that policy's own header comment); the callback route is `research`
  scoped to the specific `keywordId`.
- DB-backed integration coverage: `platform-nest/src/modules/search/search-rank.test.ts` (live
  Postgres + real HTTP, mirrors SM-16's `search-provider-pulls.test.ts`) — happy path, the
  **mutation probe** proving both writers stamp from `DispatchResult.simulated` and not
  `config.search.providerMode` (swapping the source turns exactly those 2 tests red, all others
  green — verified by temporarily making that exact substitution and reverting), drop/no-drop
  detection, mid-batch refusal leaving already-pulled rows intact, "absent stays absent," a live
  re-pull overwriting previously-simulated metrics atomically, the callback route (happy path +
  cross-linkage 400), and the badge-not-filter reader.

**✅ BUILT (SM-16 — backlinks + GEO/AI-visibility pulls; real routes, mirroring SM-14's shape
above):**

- `POST engagements/:id/backlinks-pull` → one dispatch for the engagement's own property (0034: an
  engagement has exactly one). Response + the persisted `search_backlink_snapshots` row both carry
  `provider`/`simulated` stamped from `DispatchResult.simulated` (never re-derived from the platform
  mode), plus `lostSpike`/`previousBacklinks` (aggregate-delta detection — `new_links`/`lost_links`
  stay honestly `[]`, no per-link sample exists in the provider abstraction to store).
- `GET properties/:id/backlinks` → raw history, newest first, `{totals, newLinks, lostLinks,
  provider, simulated}` per row — **badge, not filter** (every row keeps its own truth across a mode
  flip; there is no aggregate/COUNT reader over this table yet, which would need the opposite,
  mode-filtered treatment per §A4.7).
- `POST engagements/:id/ai-visibility-pull` → body `{queries?: string[]}` OVERRIDES the engagement's
  own `tool_scope.ai_visibility.queries`; omit it to pull the scope-configured list (scope-driven,
  same D-11 rule SM-15's flows lean on). One query can return several rows (one per engine — brand
  mentioned/cited across ChatGPT/AI-Overview/Gemini/Claude/Perplexity), each stamped with the SAME
  dispatch's provenance and a `changed` flag (did brandMentioned/cited flip vs. the immediately-prior
  row for that exact engine+query). **DataForSEO has no fallback for this capability (§A2)** — a
  scope-disabled or unresolvable-provider refusal shows up per-query as `{status:"skipped",
  reason:"scope_disabled"|...}` inside the batch response (HTTP 200; same shape as SM-14's
  rank-pull/metrics-pull batches), not a 4xx.
- `GET properties/:id/ai-visibility` → raw history, optional `?engine=&query=` filters, same
  badge-not-filter shape as backlinks.
- Both pulls are `resource_search_audit` (design §11's own kind for
  "audits/findings/backlinks/ai-visibility") actioned as `create`/`read` — that policy has no
  dedicated "research" action the way `resource_search_keyword` does, and §12's own button-matrix
  gates these two on "budget stop-loss" only, not a named extra permission.
- **No Backlinks tab exists yet** (uiManifest still lists only Rankings/AI Visibility under
  Optimize) — `search.backlinks.lost_spike` is therefore a real, ledgered producer with no wired
  notification (SM-13's own note explicitly punted that call to whoever built this pull; a
  wrong-but-plausible href was judged worse than none). `search.ai_visibility.changed` IS wired
  (SM-13, real producer now landed) since the AI Visibility tab already exists.
- Provider ledger rows (`search_provider_calls`) for both ops carry `simulated` + `provider`
  exactly like every other SM-04 dispatch; a scope refusal is ALSO ledgered (`recordBlocked`,
  status `failed`, endpoint suffixed `.scope_disabled`) — verified live against the seeded "Bali
  Beach SEO" engagement (`ai_visibility` starts `enabled:false` in the seed on purpose, to make the
  refusal path demonstrable before an operator flips it on).

**✅ BUILT (SM-17 — engagement ledger read surface; tracker §6n. AC discharged, ⚡ QA gate still
owed — code is real and UI-wired, verified against `search.controller.ts`, not yet gate-cleared):**

- `GET engagements/:id/ledger` → `EngagementLedger` — up to 200 most-recent `search_provider_calls`
  rows (each carrying its own `provider`/`simulated`, never re-derived from platform mode),
  current-mode month-to-date `costToServeUsd` (via the shared `sumMonthToDate` the budget stop-loss
  itself reads), a separate `simulatedHistoryExcludedUsd` for the other mode's MTD figure (never
  blended in), and `currentModeRowCount` so a real $0.00 (rows exist, summed to zero) reads
  differently from no rows at all. Consumed by `platform-ui/src/lib/searchMarketing.ts`'s
  `getEngagementLedger` and rendered by `CostLedgerPanel.tsx` on the
  `/departments/[deptId]/ledger` page (**this is now live UI, not a `BackendPending` stub**).
  Language is ticket-binding: "cost-to-serve (standard rates)", never "spend"/"cash"/"actual" (the
  word "actual" is forbidden on this endpoint's figures until SM-42/SM-41 land).
- **Not built:** any tenant-scope (cross-engagement) MTD read or a threshold-event listing — see
  the PENDING table below.

**✅ BUILT (SM-25a — Google OAuth core, HTTP surface; design addendum §A12, tracker §6ao/§6ap):**
GSC/GA4/Ads per-client credential links. The service layer (`modules/search/google/oauth.ts` +
`oauth-state.ts`) is DEV-VERIFIED against the SM-51 sandbox and a real Keycloak IdP (tracker §6ao);
this wave adds the routes. **Every response below is `GoogleConnectionView` — token material and
`enc:v1:` ciphertext are STRUCTURALLY ABSENT, asserted at the HTTP boundary in
`search-google-oauth.controller.test.ts`, never just trusted from the service layer.**

- `POST :t/modules/search/google/connections/:provider/authorize` → body
  `{clientId, propertyId?, scopes?, loginHint?}` → `{authorizeUrl, state, expiresAt, issuerHost,
  simulated, scopes}`. `:provider` ∈ `google_search_console|google_analytics|google_ads` (400
  otherwise). Validates `clientId` belongs to the tenant and, if `propertyId` is given, that it
  belongs to `clientId` (same cross-client-mix-up guard `createEngagement` uses) — both 400.
  Cerbos `resource_search_property` + `update`.
- `GET api/search/google/oauth/callback` → query `code, state, provider` (or `error` +
  `error_description` on the user declining consent at the issuer — a clean, non-throwing
  `200 {status:"denied", error, errorDescription}`, not an exception). **Deliberately
  tenant-agnostic — no `:tenantId` in the path.** Real Google permits no wildcard `redirect_uri`,
  so a per-tenant callback path is impossible; the tenant travels inside the signed `state`
  instead (`gs1.<stateId>.<tenantId>.<HMAC>`). Lives on its own controller
  (`search-google-oauth.controller.ts`, registered in `app.module.ts`), NOT on `SearchController`,
  because that controller's `@Controller()` prefix bakes `:tenantId` into every route.
  - **Auth shape, stated because it is the one route that cannot use the usual chain:**
    `AuthGuard` applies (it does not require `:tenantId`), but `ModuleEnabledGuard("search")`
    structurally cannot (it reads `req.params.tenantId` directly) and is not applied — the
    module-sliced RLS wall still fires deep inside `consumeAuthorizationState`, so a tenant
    without `search` enabled reads/writes zero rows regardless. Google's own redirect is a bare
    browser navigation that cannot carry an Authorization header — the URL registered as
    Google's `redirect_uri` is therefore a fixed page the FRONT END owns (UI-wiring, out of this
    contract), which calls this endpoint as an ordinary authenticated BFF request, passing
    `provider` from its own flow context (Google's redirect never carries it).
  - **What stops a forged or replayed callback:** (1) `parseStateToken` recomputes the state's
    HMAC over the canonical (stateId, tenantId) pair — a tampered signature OR a spliced tenant
    segment both fail `timingSafeEqual` before any DB read, 400. (2) `consumeAuthorizationState`'s
    single atomic `UPDATE … WHERE consumed_at IS NULL … RETURNING` makes a second presentation of
    the same state match zero rows — replay is refused, 400. (3) the state's `created_by` must
    equal the calling principal (`req.principal.userId`) — closes login-CSRF. (4) **added by this
    route, defense-in-depth, not present in the service layer**: once the signature verifies (so
    the state's `tenantId` claim is trustworthy), an ordinary Cerbos check
    (`resource_search_property` + `update`, scoped to that tenant) runs BEFORE the exchange — a
    principal whose `search` role was revoked after starting but before completing the flow is
    refused (403) rather than allowed to finish a link the platform would no longer let them
    start.
  - Returns the masked `GoogleConnectionView` on success.
- `GET :t/modules/search/google/connections?clientId=` → `GoogleConnectionView[]`. Cerbos
  `resource_search_property` + `read`.
- `GET :t/modules/search/google/connections/:id` → `GoogleConnectionView` or 404.
- `POST :t/modules/search/google/connections/:id/refresh` → forces a refresh (`force:true`),
  returns the refreshed masked view. Cerbos `update`.
- `POST :t/modules/search/google/connections/:id/revoke` → RFC-7009 revoke at the issuer, then a
  local soft-revoke regardless of the issuer's own response → `{connection, issuerRevoked,
  issuerStatus}`. Cerbos `update`.
- `PUT :t/modules/search/properties/:propertyId/google-connection/:provider` → body
  `{connectionId: string|null}` → `{propertyId, provider, connectionId}`. Binds/unbinds a
  connection to a property's `gsc_connection_id`/`ga4_connection_id`/`ads_connection_id` (0034).
  Adds ONE guard the service function (`bindPropertyConnection`) does not itself make: the
  connection's owning client must match the property's client (400 otherwise) — the service
  function only resolves both ids through the tenant, not against each other. Cerbos
  `resource_search_property` + `update`, scoped to `propertyId`.
- **§A12.3's honesty rule, surfaced:** every view above carries `issuerHost` (string) and
  `issuerIsGoogle` (boolean). **The Connections tab MUST render `issuerHost` whenever
  `issuerIsGoogle` is `false`** — a dev/sandbox-issued connection must be readable as one at a
  glance. This is still owed on the UI side (SM-11's Connections tab shows only GitHub + Drive).
- Errors are the `GoogleSurfaceError` family (`modules/search/google/errors.ts`), mapped by the
  globally-registered `GoogleOAuthErrorFilter` to `{error, code, detail?}` (SM-53/SM-57's contract
  shape): `503 google_oauth_not_configured` (deployment state), `400
  google_oauth_invalid_state` (forged/expired/replayed/mismatched callback — deliberately coarse,
  never distinguishes WHY), `502 google_token_endpoint_error` / `502 google_api_error` (issuer
  refused), `409 google_connection_not_linked` (dead connection — re-link, don't retry).
- DB-backed integration coverage: `search-google-oauth.controller.test.ts` (live Postgres + real
  Cerbos, not mocked, + the SM-51 sandbox over real sockets) — the full authorize→consent→
  callback→exchange→seal chain over every route, unknown provider, missing-Cerbos-permission (real
  Cerbos denial), unauthenticated callback (401), forged signature, spliced-tenant signature,
  replay, cross-tenant connection isolation (404, not a leak), both HTTP-layer ownership guards,
  Google's `error=access_denied` outcome, and a malformed-id sweep across every id-shaped param —
  plus a string-scan assertion (`enc:v1:`/`accessToken`/`refreshToken`/etc.) that no response body
  anywhere in the chain ever carries secret material. 4 mutation probes (the callback's
  defense-in-depth Cerbos check, an `assertUuid` guard, and both ownership cross-checks), all red
  when removed.
- **Defers to SM-41G** (unchanged from the service layer's own header): Google's consent screen,
  incremental consent/scope-grant semantics, Testing-mode's 7-day refresh-token expiry,
  Google-side revocation behaviour, quota/429, the Ads developer token + MCC, and whether real
  Google accepts our serialized requests at all. **A green run of this surface is a validated
  client of our own model of Google, not a validated Google integration.**

## 15. Reports module — Work Tracker · Reports · Appraisal (TR-* tracker program)

[Design: `../blueprints/tracker-reporting-foundation.md`](../blueprints/tracker-reporting-foundation.md)

### 15a. Reports surface — documents, periods, exports — `modules/reports/reports.controller.ts`

| Status | Method | Path | Notes |
|---|---|---|---|
| ✅ | POST | `/api/:t/reports/facts/recompute` | `{from, to}` (YYYY-MM-DD dates, inclusive). Idempotent backfill/recompute of `report_work_facts` over the window. Validates window ≤400 days; 422 if larger. Returns `{from, to, days, factRows, autoMissedCheckins, driftFindings, jobRunId}`. Authz: `report_admin` role. |
| ✅ | GET | `/api/:t/reports/document` | Query: `grain` (person\|project\|department\|company), `scopeRef`, `periodKind` (day\|week\|month\|custom), `start` (YYYY-MM-DD), `end` (optional, required when `periodKind=custom`), `servedTenant` (optional, department-grain only), `revision` (optional pin). Returns `ReportDocument` JSON (§6.1). Sealed calendar periods serve stored document; custom/open periods compute live. Authz: per-grain matrix (§8). |
| ✅ | GET | `/api/:t/reports/overview` | Query: `grain`, `periodKind`, `start`, `end`. Returns `{periodKind, start, end, scopes:[{scopeRef, scopeName, kpis:[]}]}` (console landing, headline KPIs per scope). Authz: per-grain read. |
| ✅ | GET | `/api/:t/reports/metrics` | Query: `metricKey`, `grain` (optional), `from` (YYYY-MM-DD), `to`. Returns raw governed-metric series (power users/MCP). Calendar periods and custom ranges both read live from `report_work_facts`. Authz: per-grain read. |
| ✅ | GET | `/api/:t/reports/periods` | Query: `kind` (day\|week\|month\|custom, optional), `from`, `to`. Lists report periods and seal status. Calendar kinds auto-vivify; customs list only existing rows. Authz: `report_period` read. |
| ✅ | GET | `/api/:t/reports/periods/:id` | One period's seal state + revision. Authz: `report_period` read. |
| ✅ | POST | `/api/:t/reports/periods/pin` | `{start, end, label}` (all required). Creates/idempotently re-labels a `period_kind='custom'` row. Never sealed, never appraisal-admissible. Authz: `report_period` pin. |
| ✅ | POST | `/api/:t/reports/periods/:id/seal` | Seal a calendar period (idempotent-once-open; 409 if already sealed; 422 if `period_kind='custom'`). Authz: `report_period` seal. |
| ✅ | POST | `/api/:t/reports/periods/:id/amend` | `{reason}` (required). Flags sealed period `amended` + audits. Actual re-seal (revision+1) happens via subsequent `/seal` call. Authz: `report_period` amend. |
| ✅ | POST | `/api/:t/reports/export` | `{grain, scopeRef, periodKind, start, end?, format}` → `{id, status, filename}`. Format: pdf\|xlsx\|csv. Synchronous: builds, renders, persists to storage. Unmarked (unsealed/custom) exports carry `AD HOC · UNSEALED` marking on the artifact. Authz: same as document read. |
| ✅ | GET | `/api/:t/reports/exports/:jobId` | Export job status (always `"completed"` today). |
| ✅ | GET | `/api/:t/reports/exports/:jobId/download` | Download export bytes. Validates authorization every time (stored `storage_key` re-derives the scope and re-runs the same Cerbos check). |

### 15b. Check-ins surface — daily end-of-day submissions — `modules/reports/checkins.controller.ts`

| Status | Method | Path | Notes |
|---|---|---|---|
| ✅ | GET | `/api/:t/checkins/today` | Returns `{expected, alreadySubmitted, draft}`. Draft is live-prefilled from today's activity/time. Authz: self only. |
| ✅ | POST | `/api/:t/checkins` | `{date?, summary, blockers?}` → checkin row. `summary` required, non-empty. Authz: self only (subject == principal, enforced). Emits `checkin.created` event. |
| ✅ | GET | `/api/:t/checkins` | Query: `userId`, `from`, `to`. History (self; manager for own unit; HR-appraisal role). Authz: per-grain matrix (§8). |
| ✅ | GET | `/api/:t/checkins/compliance` | Query: `unit`, `periodKind`, `start`, `end` (optional, required when `periodKind=custom`). Compliance grid (expected/submitted/missed/excused). Authz: lead/exec/HR or self-for-own-row (TR-39). |
| ✅ | POST | `/api/:t/checkins/:id/excuse` | `{reason}` → audited excuse. Authz: lead (own unit)/HR. |
| ✅ | GET | `/api/:t/checkins/pending-reminders` | Query: `date`. Internal for n8n: expected-but-missing list + WA identity link presence. Authz: service/admin. |

### 15c. Appraisals surface — manager scoring + acknowledgement — `modules/reports/appraisals.controller.ts`

| Status | Method | Path | Notes |
|---|---|---|---|
| ✅ | POST | `/api/:t/appraisals/cycles` | `{name, startsAt, endsAt, weights:{delivery,quality,effort,collaboration}, roleWeights}` → cycle. Authz: `HR-appraisal` role. |
| ✅ | GET | `/api/:t/appraisals/cycles` | List cycles. Authz: `HR-appraisal` or elevated. |
| ✅ | GET | `/api/:t/appraisals/cycles/:id` | Cycle detail + weights. Authz: HR-appraisal. |
| ✅ | PATCH | `/api/:t/appraisals/cycles/:id` | `{weights?, roleWeights?, status?}`. Authz: HR-appraisal. |
| ✅ | POST | `/api/:t/appraisals/cycles/:id/generate` | Generate per-subject appraisals from sealed calendar periods covering the cycle range. 409 if any period unsealed; 422 if any covering period is `period_kind='custom'`. Authz: HR-appraisal. |
| ✅ | GET | `/api/:t/appraisals` | Query: `cycleId`, `subjectId`. Appraisal list + pinned sealed person-doc(s). Authz: per-grain matrix (self/manager/HR/exec, §8). |
| ✅ | GET | `/api/:t/appraisals/:id` | Appraisal pack read. Authz: per-grain matrix. |
| ✅ | GET | `/api/:t/appraisals/mine` | Self's appraisals (status ≥ submitted). Authz: self only. |
| ✅ | PATCH | `/api/:t/appraisals/:id` | Manager scores + notes + commentary (draft only). Commentary ≥50 chars; justification required if score deviates >±1 band from auto-inputs. Authz: manager-of-subject. |
| ✅ | POST | `/api/:t/appraisals/:id/submit` | Validates commentary + justifications → status `submitted`, notifies subject. Authz: manager-of-subject. |
| ✅ | POST | `/api/:t/appraisals/:id/ack` | `{action:"acknowledged"|"disputed", comment?}` → appends to immutable ack trail. Authz: subject only. |
| ✅ | POST | `/api/:t/appraisals/:id/finalize` | HR closes (post-ack or post-dispute-resolution) → appends `finalized` ack row. Authz: HR-appraisal. |

### 15d. Internal (non-tenant path, sidecar-only) — `modules/reports/print-payload.controller.ts`

| Status | Method | Path | Notes |
|---|---|---|---|
| ✅ | GET | `/internal/reports/print-payload/:jobToken` | One-shot, 5-min-TTL token (minted at export time, burned on read). Returns JSON payload for the PDF renderer; validates token + burns it + re-authorizes the same grain/scope the export was created under. Consumed by the Next print route (`platform-ui/src/app/print/reports/[jobToken]`). Authz: token validates; re-checks document read (standing ruling 1). |

**Known gaps & deferrals:**
- **No appraisal UI** (TR-26 not built). Package read/write endpoints exist; employee acknowledgement surface does not. Backend appraisal engine is DEV-VERIFIED with 50+ tests; no integration tests against the UI yet.
- ~~**Report viewer/charts** (TR-16/TR-17 not built) … stubs rendering `BackendPending`.~~ **FALSE — corrected 2026-07-31 by the architect. TR-16 and TR-17 both LANDED.** The chart kit (`platform-ui/src/components/reports/charts/`, zero external deps), `ReportViewer`, `PeriodSelector` (Daily/Weekly/Monthly/**Custom range** + presets), `WarningsBanner`, per-grain compositions (`GrainCharts.tsx`) and **all four real routes** at `platform-ui/src/app/(app)/reports/{person,project,department,company}` exist and render live documents — range in the URL, 403 limited-access branch, DEMO_MODE fixtures. **862 platform-ui tests green**, `next build` clean, light/dark verified by Playwright screenshot. Verified on disk before this correction.
- ~~**Print route + print CSS** (TR-20 not built) … does not exist.~~ **FALSE — corrected 2026-07-31 by the architect. TR-20 LANDED:** `platform-ui/src/app/print/reports/[jobToken]/` + `print.css`, session-less, rendering the SAME viewer components, with real multi-page PDFs produced and inspected. **Genuinely outstanding:** the live `mint → sidecar → real print route → PDF` hop has not been driven end to end (owned by TR-29).
- ⚠ **Why these two rows were wrong matters more than the rows:** they were written from the blueprint's ticket list rather than from the filesystem. **A contract doc that declares an existing surface "not built" is worse than a gap** — it invites someone to rebuild it. Verify UI claims with `ls` against `platform-ui/src/app/`, not against a ticket's status.
- ~~**Retroactive leave must retract stale check-in rows** (TR-41)…~~ **DEV-VERIFIED 2026-08-01.** `writeAutoMissedCheckins` (`modules/reports/fact-job.ts`) now runs a RETRACTION pass every time it recomputes a past day's slice: any stored `auto_missed` row no longer in the freshly-derived `expectedCheckinUsers()` set (leave approved late, a holiday/calendar change, or a membership correction) is DELETED — never a `submitted` or `excused` row, those survive untouched — and audited via `activities` (`checkin.auto_missed_retracted`, carrying subject/date/prior status/cause). No new endpoint, no new status value; `GET /checkins` history and `GET /checkins/compliance` now agree once the next recompute runs (the window until then is real but bounded, not a permanent gap). A sealed period's stored `kpis` are unaffected by construction (the pass never touches `report_work_facts`/`rollup_metrics`/`report_documents`) — pinned directly against a sealed period. New tests: `fact-job.test.ts` (pure `checkinRetractionCause`), `fact-job.db.test.ts`, `checkins.controller.db.test.ts`, `report-seal.db.test.ts`; 552/552 reports-module tests green.
- **Production deployment** is untouched. All endpoints work against live Postgres, Cerbos, Redis; code is DEV-VERIFIED with 400+ tests; there is **no deployed build**.

**⏳ PENDING — each console tab renders `BackendPending` naming its owner until these land:**

| Endpoint(s) | Tab | Owner |
|---|---|---|
| `POST audits`, `GET audits`, `GET audits/:id/findings`, `PATCH findings/:id` | Site Audit | SM-07 (crawlers) + SM-08 (ingest/triage) |
| `GET/POST keywords`, `POST keywords/cluster`, `GET clusters` | Keywords | SM-09 |
| ~~backend BUILT, see SM-14 above; `/departments/[deptId]/rankings/page.tsx` is still a `PendingCapability` placeholder — no console UI wired yet~~ **STALE, corrected 2026-07-31 (SM-23, tracker §6bk/§6bd):** the Rankings tab is a real, live-wired console surface — `RankingsPanel` + `PaidActionGate` render real rank snapshots, driven twice (`DEMO_MODE` and live `:3004`, tracker §6bd). Removed from PENDING. | — | — |
| `GET/POST briefs`, `POST briefs/:id/draft` | Content Briefs | SM-10 |
| ~~backend BUILT, see SM-30 above; the manual-mode HALF of the dual-mode picker — no console UI wired yet~~ **STALE, corrected 2026-07-31 (SM-23, tracker §6bk):** the manual-mode twin is live-wired — `ApplyProposalTwins.tsx` (in `ChangeProposalsPanel`) renders per approved/applied change proposal on the planner page, with `PaidActionGate.tsx` covering the metered-pull disclosure on Rankings. Committed, self-labelled SM-19 in both files' headers; no ticket-scoped gate has run against them (tracker §6bk). Removed from PENDING for the manual half. | — | — |
| api-mode execute (`applyNegatives`/`setBudget`/`launchCampaign`) — the API-mode twin still renders honestly-disabled pending SM-21's executor | Ads Studio | SM-21/26 |
| `GET sem/pacing`, `POST sem/metrics-daily/import` (campaign-level metrics-daily bridge — the OTHER half of SM-20's design-doc line; the search-terms half is BUILT, see SM-20 above) | Pacing | SM-18 (metrics-daily CSV/bridge) + SM-22 |
| `GET/POST reports`, `POST reports/:id/approve\|deliver` | Reports | SM-22 |
| tenant-level MTD spend + threshold-event reads (no such endpoint exists; only `GET engagements/:id/ledger` is built — see SM-17 below) | Pacing | SM-17 (tenant-scope remainder) / SM-22 |

🔵 = metered provider capability: gated on BOTH the DataForSEO deposit (OQ-2) **and** the
engagement's own tool-scope toggle. An absent toggle counts as OFF and dispatch refuses naming it —
the console renders absent and explicitly-disabled identically, because the backend treats them the same.

**Permissions** (already mirrored in `lib/rbac.ts`, authoritative in Cerbos): `search.view` ·
`search.manage` (draft-only baseline = `search_staff`) · elevated `search.scope.write` ·
`search.campaign.launch` · `search.report.approve` · `search.ledger.admin` (= `search_manager`).

**Connections gap:** the SEO console's Connections tab still shows only GitHub + Drive. The
backend side (SM-25a, above) is now built and DEV-VERIFIED against a sandbox/Keycloak issuer —
Google Search Console / GA4 / Google Ads connection entries just need the UI wired to the routes
in the SM-25a section above (deliberately not stubbed in SM-11). **Real Google acceptance is still
gated on a Google OAuth client (SM-41G)** — construction is unblocked, only staging/production
verification is not.
