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
- `GET /api/:t/pm/tasks/:id/suggestions`, `POST /api/:t/pm/tasks/:id/tracker/run`,
  `POST /api/:t/pm/suggestions/:id/confirm|dismiss`
- Task comments reuse `GET/POST /api/:t/comments?entityType=task&entityId=`.
- **Poly-assignee** `{kind:person|department|division, refId, refName, responsibleId, responsibleName}`;
  units come from the org structure. **Unify with the base task model** (§4) — today they are split.
- Emit `pm.task.created|updated`, `pm.tracker.run`, `pm.suggestion.confirmed`. The AI Tracker should run
  as the WS8 PM specialist agent (Gateway model + Knowledge/D9 docs); the UI renders its output.

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
  route inventory — config remains read-only; the write side is still pending.**
- ✅ `GET /api/admin/gateway/egress-audit`, ✅ `GET /api/admin/hub/tools`,
  ✅ `GET /api/:t/agents/goals`, ✅ `GET /api/:t/knowledge/sources` (+ ✅ `POST …/:id/review`).

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
| ✅ (no UI) | GET/POST | `/api/:t/portal/runs[/:runId]`, POST `/gates/:id/decide`, POST `/runs/:runId/scope-sign` | `core/portal.controller.ts` — likely the WS11 delivery-pipeline client portal surface. |
| ✅ (no UI) | POST/GET/PATCH | `/api/:t/pipeline/runs[/:runId][/stages]`, `/pipeline/stages/:id`, `/pipeline/gates[/:id/decide]`, `/pipeline/runs/:runId/scope-signoffs` | `core/pipeline.controller.ts` — likely the WS11 meeting→MOM→PRD/Report/Scope pipeline (see `memory/ws11-delivery-pipeline-plan`). |

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

## 11. Work-activity / evidence model (P1-04, Web-Dev Phase 1) — `src/core/work-activity.controller.ts` — **BACKEND ✅ BUILT (no UI/`lib/activity.ts` consumer yet — P1-05 wires the feed)**

**BACKEND-FIRST** (unlike most of this doc): this is a NEW core (not module-gated) normalized
activity/evidence model — schema + a synchronous ingest/read API + a pure auto-link engine. There is
no `lib/activity.ts` on the frontend yet; **the shapes below ARE the canonical contract** — when the
UI is built, export `WorkActivityRow` in `platform-ui/src/lib/activity.ts` matching this shape
verbatim (per the ticket's own naming). Migration `0030_work_activity.sql`. Deliberately **not**
named `activities`/`audit` — those are the pre-existing flat audit table
(`core.controller.ts GET /api/:t/activity`), untouched by this work.

**Scope note:** this ticket (P1-04) builds the schema + this API + the linker + Cerbos only. The
**outbox consumer** that drives ingestion automatically off pm/pipeline/github/drive events, and the
**historical backfill**, are **P1-05 (separate ticket, not yet built)** — until it lands, this API
has no automatic writers; a human, script, or admin tool must POST activities explicitly.

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

## 12. Connections subsystem / integration credential vault (WSUX-14, ex-P1-08) — `src/core/integrations.controller.ts` — **BACKEND ✅ BUILT (vault + core API; no UI/`lib/connections.ts` consumer yet — WSUX-16 wires it)**

**BACKEND-FIRST.** A NEW core (not module-gated) subsystem: the single place a person or a company
links an external provider (`github`|`google_drive`|`claude`) to the ERP, plus the **at-rest
credential vault** for that link's OAuth/API tokens. Migration `0033_integration_connections.sql`
(FORCE RLS, tenant-scoped — connections are **per-company** in v1; a person re-links per company).
When the UI is built, export `ConnectionRow` in `platform-ui/src/lib/connections.ts` matching the
response shape below verbatim.

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

### 12a. C1 Claude seat registry (WSUX-17, ex-P1-10) — `src/core/claude-seats.{controller,service}.ts` — **BACKEND ✅ BUILT (no UI consumer yet — WSUX-16/17's FE half is not built)**

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
