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

## 6. IT: devices & n8n — `lib/it.ts`  — **ALL ✅ BUILT**
**See [`memory/it-device-contract`].** All present per the route inventory: `GET/POST /api/:t/it/devices`,
`GET /api/:t/it/devices/:id`, `GET /api/:t/it/events`, `GET /api/admin/automation/workflows`,
`GET /api/admin/automation/workflows/:id` (`modules/it/it.controller.ts` +
`admin/admin-systems.controller.ts`). Heartbeat ingest (`POST /api/:t/it/devices/:id/heartbeat`) is
backend-only (UI reads) and is also present.

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

**Gap SM-38 found, left unbadged rather than faked:** `search_keywords` (the Keywords tab's
`volume`/`difficulty` columns) has NO provenance column at all — no `metrics_provider`, no
`metrics_simulated`. The three snapshot tables a future rankings/backlinks/ai-visibility tab would
read (`search_rank_snapshots`/`search_backlink_snapshots`/`search_ai_visibility`) are one step
further: they carry `provider` + a nullable `provider_call_id`, but **still no `simulated` column**.
All four columns land together in **migration 0048, owned by SM-36 (not started)**. Until then: no
chip, no claim either way on any of these four surfaces — a `simulated` field read from a row that
doesn't have one is `undefined` (falsy), which would silently render every synthetic value as real,
the exact failure this whole ticket exists to prevent. **SM-36/SM-14/15/16 implementers:** badge
these the same way `cost-projection` is badged today once 0048 selects the columns; until it does,
the platform-mode statement (`ProviderModeStatement`, `components/search/SimulatedBadge.tsx`) is the
honest fallback for "is this data simulated" on any surface that goes live ahead of 0048 — in
simulate mode every freshly-pulled row is synthetic by construction (boot-time mutual exclusion means
a live instance can't create one), so the mode statement alone is still truthful even with no per-row
column yet.

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
  HUMAN-SUBMITTED search terms (`{terms:[...]}` or `{text:"one per line"}` — no live search-term
  sync exists yet, that is SM-20's job). Fallback on a gateway outage is deliberately an EMPTY
  candidate list, never a fabricated rule-based judgment.
- `GET/POST campaigns/:id/change-proposals` · `GET change-proposals/:id` · `PATCH
  change-proposals/:id` → `SearchChangeProposal`. This ticket only reaches
  `proposed → approved | dismissed`; `applied` is refused everywhere here (400) — SM-30 (manual
  mark-applied) and SM-21 (api-mode, one-shot WS4 approval) own that transition exclusively.
  `payload`/`mode` are editable only while `status='proposed'` (payload is hash-matched at approval,
  design §04).

**✅ BUILT (SM-16 — backlinks + GEO/AI-visibility pulls; real routes, not the speculative
`rankings/pull`-style paths the PENDING table below still lists for SM-14):**

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

**⏳ PENDING — each console tab renders `BackendPending` naming its owner until these land:**

| Endpoint(s) | Tab | Owner |
|---|---|---|
| `POST audits`, `GET audits`, `GET audits/:id/findings`, `PATCH findings/:id` | Site Audit | SM-07 (crawlers) + SM-08 (ingest/triage) |
| `GET/POST keywords`, `POST keywords/cluster`, `GET clusters` | Keywords | SM-09 |
| `POST rankings/pull`, `GET rankings?keywordId&from&to` | Rankings | SM-14 🔵 |
| `GET/POST briefs`, `POST briefs/:id/draft` | Content Briefs | SM-10 |
| Ads-Editor-ready export + mark-applied on an approved change proposal | Ads Studio | SM-30 |
| dual-mode (manual/api) picker + api-mode execute (`applyNegatives`/`setBudget`/`launchCampaign`) | Ads Studio | SM-19/21/26 |
| a live search-term LISTING (negatives CRUD + AI-propose are BUILT, SM-18 above — there is just nothing to list yet) | Search Terms | SM-20 |
| `GET sem/pacing`, `POST sem/metrics-daily/import` | Pacing | SM-18 (metrics-daily CSV/bridge) + SM-22 |
| `GET/POST reports`, `POST reports/:id/approve\|deliver` | Reports | SM-22 |
| ledger / usage read surfaces (engagement + tenant MTD spend, threshold events) | Engagements, Pacing | SM-17 |

🔵 = metered provider capability: gated on BOTH the DataForSEO deposit (OQ-2) **and** the
engagement's own tool-scope toggle. An absent toggle counts as OFF and dispatch refuses naming it —
the console renders absent and explicitly-disabled identically, because the backend treats them the same.

**Permissions** (already mirrored in `lib/rbac.ts`, authoritative in Cerbos): `search.view` ·
`search.manage` (draft-only baseline = `search_staff`) · elevated `search.scope.write` ·
`search.campaign.launch` · `search.report.approve` · `search.ledger.admin` (= `search_manager`).

**Connections gap:** the SEO console's Connections tab still shows only GitHub + Drive. Google
Search Console / GA4 / Google Ads connection entries need the OAuth work in **SM-25**, which is
gated on a Google OAuth client — deliberately not stubbed in SM-11.
