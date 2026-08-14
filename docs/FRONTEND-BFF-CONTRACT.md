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
| ✅ | POST | `/api/:t/users` | `{name,email,title?,roleId?}` → `{id}` | BUILT. Invite/onboard. `admin.access`. Emit `user.invited`. **P2-04 (2026-08-13) — NEW REFUSAL, no shape change:** when `roleId` is supplied and the invited email resolves to the CALLER's own user, the request is now a `400` whose body contains `self_grant_forbidden` (D-9 no-self-escalation, design §6.4). Refused before ANY write, so no user/membership/activity row is created. Inviting somebody else, or inviting yourself WITHOUT a `roleId`, is unaffected. The grant itself now goes through `GrantWriteService` (`grant-write.service.ts`), the single `user_roles` choke point. |
| ✅ | PATCH | `/api/:t/users/:id` | `{title?,status?,name?}` → `{ok}` | BUILT. Edit profile / deactivate. `admin.access`. |
| ✅ | GET | `/api/roles` | → `RoleRow[]` | BUILT. Assignable roles (drives the invite + role pickers). |
| ✅ | POST | `/api/:t/users/:id/roles` | `{roleId,scopeType,scopeId?}` → `{ok}` | BUILT. Assign role. Emit `role.assigned`. **ORG-7 A14 hook (NEW, behind `SERVICE_ASSIGNMENTS_ENABLED`):** if `scopeType='company'` and the (user,role,scope) row already exists reconciler-managed (`managed_by IS NOT NULL`), this admin grant ADOPTS it as manual (`adoptManagedGrantAsManual` — clears `managed_by`, drops its `service_grant_claims`) so a later revoke of the OWNING service assignment cannot decrement this now-doubly-intended row into deletion. **P2-04 (2026-08-13) — NEW REFUSAL, no shape change:** granting a role to YOURSELF (`:id` == the caller) is now a `400` containing `self_grant_forbidden` (D-9, design §6.4), refused before the insert. Everything else on this endpoint is unchanged — scope guard, A14 adoption, idempotent re-grant, session bump. Revoking your OWN grant is deliberately still allowed (a de-escalation is not an escalation). |
| ✅ | DELETE | `/api/:t/users/:id/roles/:grantId` | → `{ok}` | BUILT. Revoke role. |
| ✅ | GET / POST(verify) / DELETE | `/api/:t/identity-links[/:id[/verify]]` | → `IdentityLink[]` | BUILT. WA/TG identity links. |
| ✅ | GET/POST/PATCH/DELETE | `/api/:t/custom-fields[?entityType][/:id]` | → `FieldDef[]` | BUILT — all four methods present (`custom-fields.controller.ts`). |
| ✅ | GET/PATCH | `/api/:t/compliance-gates[/:id]` | → `ComplianceGate[]` | BUILT (`company-admin.controller.ts`). PATCH persists status/evidence. |
| ✅ | PATCH | `/api/:t/company/modules` | `{module,enabled}` → `{ok}` | BUILT. Enable/disable modules. |
| ✅ | GET | `/api/module-catalog` | → `{key,label,paths}[]` | BUILT (`module-catalog.controller.ts`). Modules compiled into the running build; tenant-agnostic. The settings toggle list MUST come from here — deriving it from `enabled_modules` makes disabling one-way. |
| ✅ | GET | `/api/:t/modules-enabled` | → `{tenantId,enabled[]}` | BUILT (same controller). Effective set = own `enabled_modules` ∪ active service assignments (`enabledModuleKeys`, the rule `ModuleEnabledGuard` enforces). Membership-gated; 403 without membership. Consumed by `lib/modules.ts` to render `ModuleDisabled` instead of an empty page. |
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
| — (no UI yet) | POST | `/api/:t/invoices/:invoiceId/approve` | **NEW, IAM-GAP-01 (2026-08-13, BACKEND BUILT, no UI).** Maker/checker: `draft → approved`. Requires `billing.invoice.approve`; policy denies the invoice's own creator (`created_by`, migration `0107`) and fails closed if the creator is unknown (legacy pre-migration rows). `PATCH .../invoices/:id` can no longer reach `'sent'`/`'paid'` unless the invoice is already `'approved'` — `'approved'` itself is reachable ONLY through this endpoint, never via the generic PATCH. Response adds `createdBy`/`approvedBy`/`approvedAt` to the GET/list shape. **UI TODO**: an "Approve" action + these three fields on `/billing/[id]`; not built by this backend-only ticket. **IAM-GAP-02 (2026-08-13) update: the self-approval hole is closed for EVERY approver tier, including `platform_admin`/`group_executive`** (they previously bypassed the creator check via their pre-existing wildcard; now a structural Cerbos `EFFECT_DENY` blocks creator===approver for anyone, no exceptions) — no contract/shape change, callers just see the SAME 403 a company_admin/manager already got, now also for those two roles. |
| — (no UI, no read endpoint yet) | — | *(data-layer only)* invoice revision history | **NEW, IAM-GAP-02 (2026-08-13, DATA CAPTURE ONLY).** Every invoice mutation (create/status-change/approve, plus the staff payment-confirmation path in `contracts.controller.ts`) now writes one `invoice_revisions` row (who/when/before-snapshot/after-snapshot) in the SAME transaction as the mutation, and every mutation sets `invoices.updated_by`. The GET/list response gains one additive field: **`updatedBy`** alongside the existing `createdBy`/`approvedBy`/`approvedAt`. **No new read endpoint for the revision history itself** — deeper forensics/analysis surface is explicitly deferred to a separate session (per the ticket); this row exists so the UI team knows `updatedBy` is now real data, not so they build a history view against it yet. |
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
- **BUILT (P4-B1..B5, 2026-08-07):** `GET /api/:t/pm/tasks/:taskId/assignment-history` →
  the full append-only chain, newest-first, with ref/responsible/changed-by names resolved.
  Read-gated identically to `GET /pm/tasks/:id`.
  Migration `0087_pm_task_assignment_events.sql` adds `pm_task_assignment_events` (FORCE RLS +
  the plain `tenant_isolation` policy off `app_current_tenants()`, per the pm_* convention —
  **not** the `app_module_allowed` third wall).
  **"Ball" is NOT a new field.** Per the owner's 2026-08-06 decision, Ball *is* the existing
  `assignee`, renamed for the team's Repsona vocabulary: **Ball = `assignee.refId`/`kind`**,
  **Responsible = `assignee.responsibleId`**. There is no `ball_user_id` column and no second
  assignment axis — this endpoint returns the HISTORY beside the existing field, which remains
  the one source of truth for the current value.
  Append-only is enforced in the database by `BEFORE UPDATE`/`BEFORE DELETE` triggers that
  unconditionally raise (a GRANT/REVOKE is not exercisable through this repo's test harness —
  same precedent as `0068`). The append itself lives inside `syncTaskAssignees`, the single
  choke point every write path already shares, so a new write path cannot forget to log.
  UI consumer: `P4-B7` — **BUILT** (assignment-history timeline on the task detail, `fef853d`).
- **BUILT (P4-A1/A2, 2026-08-07):** the tenant-wide list is now faceted and paginated.
  **⚠ BREAKING SHAPE CHANGE — `GET /api/:t/pm/tasks` answers `{ items, nextCursor }`, not a bare
  array.** Six frontend callers went through `listAllPmTasks` and one backend test
  (`modules/hr/wsd7-acceptance.test.ts`) consumed it; the reader now unwraps centrally and
  tolerates **both** shapes, because UI and backend deploy separately and one side is briefly older
  during every rollout. Do not "tidy" that tolerance away.
  Facets: `status[]`, `tag[]`, `priority[]`, `responsible[]`, `ball[]`, `milestone[]`, `dueFrom`,
  `dueTo`, `q`, `overdueOnly`, `dueSoon`, `dueSoonDays`, `includeClosed` (**defaults false** — done
  tasks hidden), `includeSubtasks` (accepted, **no-op** — our subtasks are a JSONB checklist, not
  `pm_tasks` rows), `cursor`, `limit` (default 50, max 200). Arrays take repeated keys or
  comma-separated, max 50, deduped.
  `ball[]` matches `assignee->>'refId'` **kind-agnostically**, so a department- or division-held
  ball filters too — a poly-assignee superset Repsona cannot express.
  Every row carries `isDone`/`isBlocked` resolved from **that task's own project registry**, so
  clients need no N+1 registry lookup. `overdueOnly`/`dueSoon` mirror `lib/pmUrgency.ts` exactly
  (3-day default, done excluded, inclusive boundary); passing both is a **union**, since the tiers
  are mutually exclusive and an intersection is always empty.
  Also adds tenant-grain `GET /api/:t/pm/flow` and `GET /api/:t/pm/burndown`.
- **BUILT (P4-G6, 2026-08-07):** `GET /api/:t/pm/projects/:projectId/tasks` gained the same
  `overdueOnly`/`dueSoon`/`dueSoonDays` semantics via shared helpers, so "what is about to slip"
  answers identically at project and tenant scope. Omitting them reproduces the old query exactly.
- **BUILT (P4-E2, 2026-08-07):** `GET /api/:t/pm/productivity?userId=&from=&to=` → `{userId, from, to,
  days, series[], totals, score, scoreNote}`. `series` is **zero-filled per calendar day** (a gap
  day is `0`, never an absent entry — a heatmap with holes lies about inactivity). Components:
  `completedTasks` · `assignedCompleted` · `involvedCompleted` · `tasksAccepted` ·
  `reactionsGiven` · `reactionsReceived` · `notesContributions` · `comments` · `total`.
  Defaults to the trailing 365 days (a GitHub-style year heatmap's span); max window 400.
  **`score` is deliberately `null` and deliberately PRESENT.** No composite is computed: the formula
  and its visibility are decision 9 / `P4-E1`, a people decision that has not been made. `scoreNote`
  carries that explanation in-band so a client cannot mistake the null for a backend fault. Also
  note `total` is activity VOLUME, not a de-duplicated task count — a task you both completed and
  commented on contributes to more than one component.
  Credit semantics matter for fairness: `completedTasks` credits the actor who flipped the switch,
  `assignedCompleted` credits whoever held the ball — closing someone else's task does not transfer
  their credit.
  **Read authorization is enforced in-app, not inherited.** Self is always allowed;
  `unrestricted`/`company_wide` may read anyone in tenant; `unit_scoped` is narrowed to the caller's
  own led-unit subtree; `self_only` is refused explicitly. That last branch is NOT delegated to
  `assertPersonInLedScope`, because its `self_only` case assumes Cerbos already filtered a
  foreign-subject read — true for `report_document` (which has an `owns` policy condition) but NOT
  for this endpoint's `pm_task:read` gate, which carries no subject at all. Reusing the helper
  blindly would have let a plain member read a colleague's series.
  **UI consumer (P4-E3/E4, 2026-08-08):** `platform-ui`'s `lib/pm.ts::getProductivity` +
  `components/pm/Productivity.tsx`, mounted as the `/pm?view=productivity` tab (self-view only; the
  `?userId=` param has no picker UI yet, out of E3/E4's scope). Renders `score:null` as an explicit
  "—" plus the full `scoreNote` text — never coerces it to `0`. Reconciled against `/reports/person`
  in-UI: that page's `delivery.tasks_completed` KPI counts the same underlying fact
  (`work_activity`, verb='completed', actor-credited) but through the TR-07 **nightly fact job**,
  while this endpoint queries `work_activity` **live** — the two can disagree for a few hours around
  the nightly refresh, which the UI states explicitly rather than presenting two silent, possibly-
  conflicting numbers for "how many tasks did I complete". `DEMO_MODE` fixture:
  `lib/demoPm.ts::productivityDemo` (deterministic, seeded-hash synthetic series — not random per
  render — matching the real contract's shape including the null score).
- **BUILT (P4-I6, 2026-08-07):** closing the LAST open blocker notifies the promoted task's ball
  holder and followers (`dependency_cleared`). Fires once per task however many blockers it had,
  skips the actor, and needs no dedup table — a completed promotion moves the task off its intake
  status, so a re-run produces no second transition to notify about.
- **BUILT (P4-H1, 2026-08-07):** `GET /api/:t/pm/projects/:id` now also returns `startDate` (the
  base `projects.start_date` column — already existed, simply wasn't selected here before) and
  `dependencyEnforcement: boolean` (P4-I3, see below). `PATCH /api/:t/pm/projects/:id` accepts
  `startDate`/`dueDate`/`dependencyEnforcement` alongside the existing `owner`/`status`. This
  **AUTHORED** range (decision 12) is never overwritten from task dates — a project's own
  `startDate`/`dueDate` stay independent of whatever range its tasks' `startDate`/`dueDate` imply.
  The task-derived envelope + the Gantt project-bar rendering (P4-H2/H3, plan §H) are `platform-ui`
  work against data it already has (`GET .../pm/tasks` already carries every task's own dates) —
  not built here. No new migration column: both `start_date`/`due_date` predate this ticket
  (`0001_core.sql`).
- **BUILT (P4-I1/I2/I3, decision 17, 2026-08-07):** `dependsOn` enforcement — previously fully
  advisory (nothing server-side stopped a blocked task from being started). Migration
  `0089_pm_dependency_enforcement.sql` adds `pm_tasks.block_reason text` and
  `pm_project_meta.dependency_enforcement boolean NOT NULL DEFAULT true`. No new "chain" table —
  enforcement runs on the EXISTING `depends_on` graph.
  **The rule** (coordinated byte-for-byte with `platform-ui`'s `lib/pm.ts::reachableStatusIds`),
  enforced in `PATCH /api/:t/pm/tasks/:id` (and `POST /api/:t/pm/suggestions/:id/confirm`'s
  status-kind branch) whenever the task has an open dependency (`openDependencies()`, resolved
  per-dependency against ITS OWN project's `isDone` flag — a dependency may live in a different
  project) and the project hasn't opted out via `dependencyEnforcement:false`:
    1. A transition into any status that is neither `isDone` nor `isBlocked` and is not the
       project's intake status (`Backlog`) is rejected — **409**, `{error: "cannot move to […]:
       blocked by N open dependenc(y|ies) (\"title\", …)"}` (the platform's global
       `HttpErrorFilter` collapses every exception down to `{error, field?}`, so the blocker's
       name travels in the message text, not a structured field).
    2. A transition into an `isDone` status is ALWAYS allowed even with open dependencies —
       closing a blocked task never unblocks anything (only closing ITS OWN blocker does); this is
       an audited override (`pm.task.updated`'s `completedWithOpenDependencies: true`), never a
       silent bypass.
    3. The task's own CURRENT status is always reachable — an unrelated field edit on an
       already-blocked task (retitle, log time, pass the ball) never 409s.
    4. `Backlog`↔ toDo is the only auto-transition the system makes on its own: when the LAST open
       blocker closes (the blocker completes OR is deleted) — cross-task via
       `promoteClearedDependents`, or self-triggered via `removeDependency` — a task sitting in
       `Backlog` (or a SYSTEM-set `Blocked`, see below) is promoted to the project's `readyStatus`
       (never the literal `"todo"`). Audited: a `pm.task.dependencyCleared` event + a
       `writeActivity` row (actor `null`, `closedTaskId`/`closedByUserId` in the metadata) — "a
       write triggered by someone else's action," per the plan, never silent.
  **Decision 17 — Blocked is distinguishable, system vs human:** `GET /api/:t/pm/tasks/:id`
  gained `blockReason: string|null` and `blockedBy: [{id,title}]` (computed live off
  `openDependencies()`, never stored — a stored blocker id would drift the moment that task's own
  status changes). An explicit `PATCH … {status:"blocked", blockReason?}` while a dependency is
  open FORCES `blockReason` to `null` regardless of what's sent (system attribution — "which
  blocker" is `blockedBy`, not a stored string); with NO open dependency, an optional human
  `blockReason` is stored verbatim (NOT required — an `isBlocked`-flagged status is also plain
  product vocabulary outside this feature, e.g. a review gate, and a mandatory-reason gate would
  400 on ordinary board moves that have nothing to do with `dependsOn`). A HUMAN-set block
  (non-null reason) is never auto-cleared by dependency activity; only a SYSTEM-set one is.
  **P4-I3/decision 14** — hard-block is the only enforced mode (no "warn" mode exists, by design);
  a project may explicitly turn enforcement off via `PATCH /api/:t/pm/projects/:id
  {dependencyEnforcement:false}` — audited for free through that endpoint's existing
  `pm.project.updated` event + `writeActivity` row, not a separate mechanism.
  **P4-I5 pinned:** passing the ball (reassigning `assignee`) on a blocked task is ALLOWED; bundling
  it with an explicit `status` into a started column in the SAME `PATCH` is still rejected (409) —
  see `pm.test.ts`'s dedicated case.
  **Not built here (other tickets in workstream I):** `P4-I4` (UI: disabled-transition affordance +
  a "ready to start" filter facet — `platform-ui` owns this, `reachableStatusIds` already landed)
  and `P4-I6` (notify the ball holder when the last blocker clears — the event/audit trail this
  ticket guarantees is the substrate `I6` consumes, no notification is sent yet).
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
| ✅ (no UI, IAM-05c, 2026-08-10) | GET | `/api/:t/authz/permissions` | `core/authz-permissions.controller.ts`. Company-scope **effective permissions** — `{scopeType, scopeId, scopeLevelPermissions, excludedRelationshipClass, wildcardBypassRoles, caveat}`. `scopeLevelPermissions` is resolved from the pre-computed role→permission bundle (no live Cerbos round trip) over the 215 grantable catalog keys — **NOT** a per-resource answer. See `docs/PERMISSION-CONTRACT.md` §4–§5 before wiring any UI consumer: this is for rendering ("does the caller hold this key ANYWHERE in this scope"), never for deciding whether one specific action on one specific resource may proceed (condition-dependent grants — `ownerId`/`subjectUserId`/`teamId`/assurance — cannot be answered in bulk; use `can()` server-side for that). 403 (never 404) if the caller has no membership in `:t` and no global `platform_admin`. ETag'd (`private, max-age=30, must-revalidate`), keyed on `(userId, sessionVersion, scope, computed answer)` — a `session_version` bump (D11 revoke/downgrade) invalidates the ETag by construction, no explicit purge. `wildcardBypassRoles` names any held role from `["platform_admin","group_executive"]` — for those, the caveat states the list is a floor, not a ceiling, because a bundle regeneration lag could under-report a brand-new wildcard grant. |
| ✅ (no UI, IAM-05c, 2026-08-10) | GET | `/api/authz/permissions` | Same controller — **global-scope** effective permissions, no tenancy gate (global names no company). What a principal with zero company memberships (e.g. a `group_executive`-shaped seed) uses to learn cross-company reach before picking a company. Same response shape, same caveat semantics, `scopeId: null`. |
| 🗑️ RETIRED (HIER-3, 2026-08-11) | ~~GET/POST/PATCH~~ | ~~`/api/:t/teams[/:teamId]`, POST/DELETE `/api/:t/teams/:teamId/members[/:userId]`~~ | `core/teams.controller.ts` DELETED — `teams`/`team_memberships` were 0-row vestigial tables with zero UI callers; the `team`/`org_unit` hierarchy consolidation (`docs/superpowers/plans/2026-08-10-hierarchy-consolidation.md`) retired the whole surface. The org chart (`company_org_structure`/`org_units`/`org_unit_memberships`) is the one surviving hierarchy; `org_unit_lead` (HIER-2) is `team_lead`'s replacement. |
| ✅ (no UI) | GET | `/health` | `health/health.controller.ts` — bare, no `/api` prefix; infra healthcheck only. |
| ✅ (UI built, APPR-01) | POST/GET | `/api/:t/automation-approvals[/:id][/:id/decide]` | `core/automation-approvals.controller.ts` — WS4 automation-suspension surface; distinct from `/modules/agency/approvals`. **APPR-01 (2026-08-05) added `GET /:id`** — the single-row read backing `platform-ui`'s `/approvals/[id]` detail page (`lib/approvals.ts`'s `getAutomationApprovalDetail`). Fetches the row BEFORE authorizing (mirrors the existing `decide()`'s own WSD-4 pattern) so an hr-origin row's `module:'hr'` branch of `resource_automation_approval.yaml` still applies; a cross-tenant id is invisible via RLS ⇒ 404, never a leak. Response is camelCase (`workflowId`/`toolName`/`toolArgs`/`agentName`/`requestedByName`/`decidedByName`/`executionStatus`/…), NOT a mirror of the list's snake_case rows — nothing else consumed a single row before this. Same `read` action the list already gates on; no Cerbos policy change. |
| ✅ (UI built, APPR-01) | GET | `/api/:t/modules/agency/approvals/:approvalId` | `modules/agency/agency.controller.ts` — the agency twin of the row above, same rationale + same fetch-before-authorize shape, same `read` action `pending`/`decided` already use. camelCase (`campaignId`/`campaign`/`assetId`/`requestedByName`/`decidedByName`/…). Module-gated like every other route in this controller (404 if `agency` isn't enabled for the tenant). |
| ✅ (no UI — machine surface) | POST | `/api/:t/automation-approvals/resolve-and-execute` | **D14-10** — `core/automation-approvals.controller.ts`. NOT a UI endpoint and must never be called from `platform-ui`: it is how the **agent runner** (`ai-agents`) resumes a suspended goal under the owner’s D14-b "re-run from the top" decision. Body `{agentName, toolName, toolArgs}`; matches a decided `origin='agent'` row on `(workflow_id = agentName, tool_name, canonical argsSha256)` and returns a typed `{match: none|executed|rejected|executing|failed|not_executable}` — every branch is a **200** so the caller can never mistake a fault for "nothing on file" (that mistake re-files a duplicate approval). Executes only through D14-03’s single-use `pending → executing` claim, so the executor-auto-execute and re-run paths together produce exactly ONE tool call; the loser consumes the stored `execution_result`. Cerbos-gated to the ORIGINAL requester (`create` + `requested_by == principal`), never the approver — a non-requester gets 403, not `none`. The approvals UI keeps using `/:id`, `/:id/decide` and `/:id/retry`. |
| ✅ (no UI) | GET | `/mcp/tool-defs` | `modules/mcp-tools.controller.ts` (`@Controller("mcp")`) — consumed by MCP Hub, not platform-ui. |
| ✅ (no UI) | POST | `/principal/resolve`, `/identity/enroll/start`, `/identity/enroll/confirm` | `identity/identity.controller.ts` — root-level, not under `/api`; OBO/D4 enrollment, service-to-service. |
| ✅ **STALE "no UI" tag — now consumed** | GET/POST | `/api/:t/portal/runs[/:runId]`, POST `/gates/:id/decide`, POST `/runs/:runId/scope-sign` | `core/portal.controller.ts` — the client portal (`/portal`, `lib/portal.ts`). WD-03 (Web Dev Phase 1 §12, D-3): the sign view now renders the LATEST stage artifact (`ArtifactMarkdown`) above the sign/feedback action for the gate it governs — "what a client signs must be what they see." Full doc sweep for this row + neighbors is WD-07's ticket, not redone here. **D-3 notify delta (2026-08-03):** `POST /portal/gates/:id/decide` now notifies the internal side (the run's `owner_id`, else its `created_by`) via `notify()`, and `POST /runs/:runId/scope-signoffs` / this controller's own `scope-sign` notify BOTH sides once `scope.signed` completes — `href: "/pipeline/:runId"` for staff, `href: "/portal"` for the client. Best-effort: a `notify()` failure is caught per-recipient and logged (`[client-notify]`), never rolls back the decide/sign-off write. No response-shape change. **C3/C5 delta (2026-08-04):** `GET /portal/runs` returns each run's **`pendingActions`** count (outstanding client decisions) and computes every blockage in TWO batched queries instead of two per run — it was 2N+1, up to 201 round trips on a full page, on the one surface whose latency is paid by someone outside the company. `GET /portal/runs/:runId` is now actually rendered; before this the reader and its type existed as dead code and the list page fetched every run's detail (1+N HTTP calls) to inline it. **Route moved (CP-2..CP-5, 2026-08-04):** it renders at **`(portal)/portal/approvals/[runId]`**, not `(app)/portal/[runId]` — the client portal is now its own route group with its own `PortalShell`, and the readers moved to `lib/portal-data.ts` (types + pure helpers stayed in `lib/portal.ts`, which is now deliberately client-safe for the live-SSE component). `pendingActions` feeds the new approvals list and `PortalGateActions` is reused verbatim, so this delta's substance is intact — only the path changed. |
| ✅ **STALE "no UI" tag — now consumed** | POST/GET/PATCH | `/api/:t/pipeline/runs[/:runId][/stages]`, `/pipeline/stages/:id`, `/pipeline/gates[/:id/decide]`, `/pipeline/runs/:runId/scope-signoffs` | `core/pipeline.controller.ts` — the WS11 meeting→MOM→PRD/Report/Scope pipeline; consumed by the run workspace (`/pipeline/[runId]`, WD-02, `lib/pipeline.ts`). **WD-03 (D-3) delta:** `PATCH /pipeline/stages/:id` with `artifactRef` present is now a signature-locked EDIT — 409 once the stage's client sign gate (matched by track: `delivery`→`prd_sign`/`customer_feedback`, `scope`→`scope_signoff`; `report` never locks) is `decided`, via ANY path that decides it (native route or the generic `/approvals/:id/decide` façade, since both write the same `pipeline_gates` row); Cerbos `pipeline_stage.update` narrowed to `company_admin`/`manager`/`group_executive` (plain `member` now denied — was previously granted, a widening this ticket closed); every edit gets a `writeActivity` row + `pipeline.stage.updated` event (`artifactEdited:true`). Deliberately does NOT also lock on `stage.status === 'done'` — extraction lands stages `done` immediately, before any client sign gate exists, so that would make editing unreachable for every ingested run (falsified against the live "Acme Coffee kickoff" run — see WD-03 evidence). Workspace edit UI: `pl-edit` details/form in `pipeline/[runId]/page.tsx` (`isStageLocked` in `lib/pipeline.ts` mirrors the backend rule for the "locked" badge; the backend 409 remains the real authority). **WD-29 (DEF-2) delta — response shape is ADDITIVE, no breaking change:** `POST /pipeline/runs/:runId/stages` and `POST /pipeline/gates` may now return an optional `deduped: true` alongside the usual `id` (still `201`), meaning the call was a stale-snapshot repeat and `id` is the EXISTING row the pipeline is really on — same convention `POST /pipeline/runs` already uses for its `sourceMeetingId` dedupe. Callers should treat `{id, deduped:true}` as success and keep using the returned `id` (that is what keeps a raced n8n execution on the live lineage); no client change is required, and nothing that previously succeeded now errors. Every run-state transition (stage create/update, gate open/decide, scope sign-off, run PATCH — on the internal AND `portal/*` routes) now serializes on a per-run advisory lock, so concurrent deciders for ONE run are ordered while different runs stay fully parallel; a `claude_design` create is admitted only when no design exists or the head design has a decided `customer_feedback: changes_requested`, so WD-05's revise loop still produces its legitimate second design but retriggers cannot manufacture extra ones. `scope.signed` now fires only on the TRANSITION to complete (re-filing an already-complete sign-off no longer re-emits). Schema backstop: partial `UNIQUE(run_id, track, name)` over the single-shot stage names (`0052`) — deliberately NOT covering `claude_design`. **D-3 notify delta (2026-08-03):** `POST /pipeline/gates` now notifies active `client_contacts` (migration `0072`) when it opens a `client`-side gate — `resolveClientRecipients`/`clientNotifyKindForGate` (new `core/client-notify.ts`) restrict a signature-kind gate (`prd_sign`/`scope_signoff`) to `capability='signer'` contacts scoped (client-wide or the run's own `project_id`) and active only; a feedback gate (`customer_feedback`) reaches every active contact in scope, signer or viewer. `POST /pipeline/runs/:runId/scope-signoffs` notifies both sides on the `scope.signed` transition, same as the portal twin above. Best-effort throughout: see the portal row's note. No response-shape change; a suppressed (`deduped:true`) gate-open does not re-notify. **C1/B2/B6 delta (2026-08-04):** `GET /pipeline/runs` accepts **`clientId`** and **`projectId`** alongside `status`/`sourceMeetingId`, and its SELECT now returns `client_id`, `project_id` and `owner_id` (it previously omitted them, which is why the UI cross-referenced the recordings registry to draw a client column and why run->project navigation did not exist). Filtering happens server-side — `/pipeline` used to fetch the 200-row cap and narrow in the browser, which stops being a filter past 200 runs. Newly CONSUMED, having existed unused: `POST /pipeline/runs` (start a delivery run with no source meeting — `createRunAction`; the UI requires a clientId even though the API permits null, because a clientless run can never reach a portal) and `POST /meetings/recordings/relink-orphans` (`relinkOrphanRecordingsAction`; idempotent, which is what makes it safe as a button rather than a runbook step). Ids are compared as text, so a malformed id from a hand-edited query string matches nothing instead of 500ing on a uuid cast. |
| ✅ **STALE "no UI" tag — now consumed** | POST/PATCH/GET | `/api/:t/meetings/recordings/start`, `PATCH /:id`, `POST /:id/transcript`, `POST /:id/ingest`, `POST /:id/drive`, `GET /`, `GET /:id` | `core/meetings.controller.ts` — WS11 capture-edge registry (helper-driven: record → local whisper → register → transcript → ingest proxy, `N8N_BRIDGE_SECRET` stays server-side). Consumed by `lib/meetings.ts`/`lib/meetingsActions.ts`, the `/meetings` registry + `/meetings/[id]` detail/workbench, and the PRD Studio tab (`departments/[deptId]/prd`, `RecordControls`). **WD-07 (Web Dev Phase 1 §12) additions:** `/meetings`'s table gained a "Run" column resolving the linked `pipeline_runs.status` (not just the recording's own `status`) via one extra `listPipelineRuns` call; PRD Studio's "Source meeting" cell is now a link back to `/meetings/[id]` when the run's `source_meeting_id` resolves to a known recording (`listRecordings` cross-referenced by `meeting_id`, mirroring WD-02's reverse lookup in `lib/meetings.ts`'s `findRecordingByMeetingId`). `RecordControls` also gained optional `clientId`/`projectId` props (hidden fields feeding the existing `/start` body, unchanged contract) — wired into the project workspace (`ProjectWorkspaceView.tsx`'s new "Meetings" card) and the client detail page, each showing its own scoped `GET .../recordings?clientId=`/`?projectId=` list. **Verified end-to-end (not just "should work"):** a recording started from a project page carries that project's `client_id` + the `projectId` itself on the `meeting_recordings` row, and — since another agent's fix to `mtg-dispatcher.json` (WD-01 finding F-1) now forwards `clientId` into `pipeline.createRun` — an ingested run from that recording carries a non-null `pipeline_runs.client_id` too (DB-probed, see WD-07 evidence; this ticket verified the chain, it did not touch the dispatcher). |
| ✅ **STALE "no UI" tag — now consumed** | POST | `/api/:t/meetings/recordings/:id/audio` (multipart, field `file`) → 202 `{id,status:"transcribing",audioRef}`; `/:id/audio/retry` → 202 `{id,status:"transcribing"}` | WD-04 (Web Dev Phase 1 §12) — `core/meetings.controller.ts`. In-ERP audio upload with no helper required: size cap (`MEETING_AUDIO_MAX_BYTES`, default 200MB) + audio-type allowlist enforced at upload; async job calls the whisper container's `/v1/audio/transcriptions` DIRECTLY (not via ai-gateway-go — bypasses its ~2.5-min timeout); flips `transcribing→transcribed` or `→failed` (retryable via the second route, reusing the stored audio — no re-upload). Additive `meeting_recordings.audio_ref` column (migration `0049`); the helper's local-whisper contract (`start`/`transcript` above) is unchanged. **WD-07 (2026-07-30, Part A) landed the frontend** — WD-04's own AC ("an `.m4a` uploaded in the browser becomes a transcript") had only ever been curl-verified; a real gap, not a doc staleness. `AudioUploadForm.tsx` (mounted on `/meetings/[id]`'s workbench) uploads via a new `platformUpload()` helper in `lib/platform.ts` (deliberately separate from `platformFetch` — that helper always forces `content-type: application/json`, which would corrupt a multipart boundary) and polls a new route-handler, `GET /api/meetings/:id/status`, on a 2.5s interval that self-terminates once status reaches `transcribed`/`failed`/`ingested` — the same poll-until-terminal shape as `WhatsAppConnect.tsx`'s bot-session poll. `RecordControls` gained a register-then-upload combined path (`registerAndUploadAudioAction`) for the case where no recording row exists yet — it starts one, uploads into it, then redirects to `/meetings/[id]` where `AudioUploadForm` takes over. DEMO_MODE equivalent: `demoUploadAudio`/`demoRetryAudio` in `demoMeetings.ts` (a filename containing "fail" simulates a whisper-down failure, since demo mode has no real whisper container to fail against). |
| ✅ BUILT (no UI yet) | POST | `/api/:t/meetings/recordings/schedule` → 201 `{id, meetingId, scheduledAt}` | W0 (`2026-08-03-webdev-w0-engagement-setup-spec.md` §2.5/2.6, D-3) — `core/meetings.controller.ts`. Creates a `meeting_recordings` row at `status='scheduled'` BEFORE anyone presses record — the row is scoped to `clientId`/`projectId` and mints `meeting_id` through the exact same `mintMeetingId` helper `start` uses (never a second, divergent implementation), so it is a legitimate dedupe key for the frozen dispatcher contract from the moment it exists. Body: optional `title`/`kind`/`clientId`/`projectId`, required `scheduledAt` (ISO datetime; a missing or unparsable value is 400). Cerbos action reused: `create` on `meeting_recording` (no new action, no new policy). |
| ✅ BUILT (no UI yet) | PATCH | `/api/:t/meetings/recordings/:id` (unchanged route) | Widened, not replacing: `STATUSES` now admits `'scheduled'` (matching the migration `0072` CHECK), so a scheduled row can advance to `status:'recording'` through this SAME endpoint — "the recorder attaches to it" (spec §2.5), not a new "convert" route. When the transition target is `'recording'` and `started_at` is still `NULL` (true only for a row that began `scheduled`), this stamps `started_at = now()`; every other transition (already carrying a `started_at` from `start`) is untouched, and the transcribe/ingest chain downstream is unmodified. |
| ✅ BUILT (no UI yet) | POST/DELETE | `/api/:t/meetings/recordings/:id/participants` (idempotent add, `{userId}`) / `/participants/:userId` (remove) | W0 §2.6 (`meeting_participants`, migration `0072`) — `core/meetings.controller.ts`. `side` (`internal`/`client`) is ALWAYS derived server-side from an ACTIVE `client_contacts` row for that user+tenant — a request body's own `side`/similar claim is never read, so a caller cannot mislabel either party. Add is idempotent on the `(tenant_id, recording_id, user_id)` unique index (`ON CONFLICT ... DO UPDATE SET side = EXCLUDED.side` — a re-add re-derives the label rather than erroring or silently keeping a stale one); remove is a hard delete (the table has no soft-delete column). Both 404 when the recording does not resolve inside the caller's tenant (rival-tenant isolation). Cerbos action reused: `update` on `meeting_recording`. Detail `GET /api/:t/meetings/recordings/:id` now also returns `scheduled_at`/`scheduled_by` and a `participants: [{user_id, side, email, name, created_at}]` array; the list `GET /api/:t/meetings/recordings` supports `?scheduled=upcoming` (still-`scheduled`, `scheduled_at` in the future, ordered soonest-first) alongside the existing `status`/`clientId`/`projectId` filters. Events: `meeting.recording.scheduled`, `meeting.recording.participant_added`, `meeting.recording.participant_removed`, consistent with the file's existing `meeting.recording.*` pattern. No UI consumes this yet — `lib/meetings.ts`/`RecordControls`/the `/meetings` screens are unchanged by this ticket. |

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

## 10. HR module (WSD-4, 2026-07-22) — `modules/hr/hr.controller.ts` + `loans.controller.ts` — **BACKEND ✅ BUILT, UI ✅ WIRED**

**Corrected 2026-08-05:** this header previously read "no UI/`lib/hr.ts` consumer yet — WSD-5", and
the ⬜ PENDING line below claimed the `/hr` UI was unbuilt. Both were stale: `platform-ui/src/lib/hr.ts`
+ `hrActions.ts` exist, the `/hr/{leave,attendance,onboarding,cases}` console pages are built, and
`rbac.ts` carries `hr.view`/`hr.manage`. Employee-portal wave A additionally re-homes the
self-service half at `/me/leave` (same lib, same actions, addressed to the subject).

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
  the subject (`payload.href = "/hr/leave/:id"`). **IAM-GAP-01 (2026-08-13):** this same route now
  authorizes leave rows (`workflow_id:'hr:leave'`) against the dedicated `hr.leave.decide` permission
  (Cerbos action `decide_leave`) rather than the generic `core.automation_approval.decide` — loan
  requests (`workflow_id:'hr:loan'`, §10a below) are unaffected and still use the generic action.
  No client-visible change: the decider population is identical (`company_admin`/`group_executive`/
  `hr_manager`/`platform_admin`), only the permission catalog gained a dedicated key.
- ✅ `GET/POST /api/:t/modules/hr/attendance` (staff-editable only, per-day upsert).
- ✅ `GET/POST /api/:t/modules/hr/checklist-templates`, ✅ `POST /api/:t/modules/hr/onboarding/instantiate`
  (manual trigger; the same helper backs the automatic `user.invited` → onboarding-case spawn).
- Rollups: `hr.open_cases`, `hr.leave_pending`, `hr.onboarding_active` feed the cross-company
  management view like every other module.
### 10a. Employee loans (employee-portal wave E, 2026-08-05) — `modules/hr/loans.controller.ts` — **BACKEND ✅ BUILT, UI ✅ WIRED (`lib/loans.ts` + `loans-data.ts` + `loanActions.ts`)**

Migration `0081_hr_loans.sql`: `hr_loan_requests` (the agreement) + `hr_loan_installments` (the
schedule FROZEN at approval) + `hr_loan_repayments` (append-only ledger), all three behind the same
`app_module_allowed('hr')` third wall as the rest of §10.

- ✅ `POST /api/:t/modules/hr/loans` `{subjectUserId, principalAmount, termMonths, annualInterestRate?,
  currency?, purpose?}` → `{id, approvalId, status:"pending"}`. Files the request AND an
  `automation_approvals` row (`origin:'hr'`, `workflow_id:'hr:loan'`, impact **`high`** — leave is
  `medium`; this one moves money) in ONE transaction, with a schedule PREVIEW in `tool_args` so the
  decider sees the monthly burden, not just the principal. **One live loan per employee** (a pending
  or approved loan 400s a second request).
- ✅ `GET /api/:t/modules/hr/loans[?subjectUserId&status]` → `{loans[], scope:"self"|"tenant"}`.
  `scope` reports which Cerbos path won: `"self"` means a plain `member` whose list is ALREADY
  narrowed server-side — the UI must not offer a subject filter in that case.
- ✅ `GET /api/:t/modules/hr/loans/:id` → the loan + `schedule[]` + `summary` + `repayments[]`.
  404 (not 403) when invisible, so an id's existence never leaks.
- ✅ `POST /api/:t/modules/hr/loans/:id/cancel` — own PENDING only; also withdraws the paired approval.
- ✅ `POST /api/:t/modules/hr/loans/:id/repayments` `{amount, paidOn?, method?, note?}` —
  **STAFF ONLY**, authorized as `hr_case:update`, an action the `member` derived role does not hold,
  so the employee who owes the money can never declare it repaid. Auto-settles when the ledger covers
  the schedule (status is DERIVED from the ledger, not latched).
- Deciding rides the EXISTING `POST /api/:t/automation-approvals/:id/decide` — no forked endpoint.
  `loan-decision.ts` applies the outcome, and **approval is where the schedule is born**: the
  amortization rows are materialized then, anchored on the APPROVAL date (so a request that sat in the
  inbox does not get a first instalment in the past), and the subject is notified with the terms.
- Authorization reuses Cerbos kind **`hr_case`** rather than a new `resource_hr_loan.yaml` — a brand-new
  policy file is not hot-reloaded through the bind mount, and an unlisted kind is a silent DENY that
  reads like a logic bug.
- MCP: `hr.listLoans` (read) + `hr.requestLoan` (write, impact `high` → D14-suspended for a human).
- **Deferred seam:** `method:'payroll_deduction'` is selectable but nothing writes it automatically —
  employee-portal wave D (payroll) is not built. When it lands it becomes the automated writer of
  exactly this ledger row; the shape does not need to change.

### 10b. `/me` personal hub (employee-portal wave A/F, 2026-08-05) — **UI ✅ BUILT on existing endpoints**

No new backend surface. `/me` is a SECTION of the staff ERP (not a second shell like `/portal` —
an employee already IS an ERP user), and it re-homes the seven scattered self-service pages: `/`,
`/account`, `/people/:userId`, `/reports/person`, `/appraisals/mine`, `/timesheets`, plus the
notification feed. `/me/inbox` (wave F) unifies `GET /api/:t/notifications` with the entity-scoped
`GET /api/:t/mail/threads` from §mail — there is no personal-mailbox store, and inventing one would
mean a second unread model; a notification row is therefore the unit. `/me/leave` and `/me/loans`
carry their own `ModuleDisabled` note because `hr` is dark for every company except the agency.

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
- Cerbos: `cerbos/policies/resource_work_activity.yaml` (read = member/viewer/manager/
  company_admin — `team_lead` retired, HIER-3; create = company_admin/platform_admin only). Policy-parity tests added to
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
  (`member`/`viewer` gated by the shared `owns` variable — `team_lead` retired, HIER-3); company
  rows + others' rows = `company_admin`/`manager`/`group_executive`/`platform_admin`.

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

## 16. Client portal (CP-* program, 2026-08-04) — `platform-ui/src/lib/portal{,-data}.ts`, `portalActions.ts`

[Deployment plan: `plans/2026-08-04-client-portal-deployment.md`](plans/2026-08-04-client-portal-deployment.md)

The client-facing dashboard, served from its own `(portal)` route group with its own shell — a
SEPARATE INTERFACE from the staff ERP (owner decision, 2026-08-04), not a client-gated corner of it.

**Unlike every other section of this document, this one is NOT frontend-first.** Backend and frontend
were built together, so every row below is ✅ on both sides. That is deliberate: frontend-first drift
(the console reading fields the backend never sends) is this repo's recurring bug class, and the
portal is read by people outside the company where a confidently-wrong number costs the most.

### Isolation model — read this before adding a portal route

Four layers, and only the third is per-client:

1. **RLS** — tenant, in Postgres (FORCE RLS on the authorized-tenant-set).
2. **Cerbos** — the `client` derived role on the `portal` resource. Actions: `read`, `decide`, `sign`,
   `pay`, `update_profile`. **Cerbos does not see rows**, so `read` means "may ask the portal", never
   "may see any client's data".
3. **`src/core/portal-scope.ts`** — `client_id = ANY(:callerClientIds)` plus the project restriction,
   applied as a SQL predicate on **every** portal query. This is what stops client A reading client B
   inside the same tenant. Ownership resolves through `client_contacts` UNIONed with the legacy
   `clients.portal_user_id`; the union is load-bearing (the invite flow never writes that column).
4. **Per-route** — the addressed entity belongs to a run/invoice/contract inside that scoped set.

`capability` (`signer` | `viewer`) gates signing only: a viewer may still give feedback and record a
payment. Not-yours and does-not-exist both answer **404**, deliberately indistinguishable, so no route
becomes an existence oracle for another client's ids.

### 16a. Workspace reads — `src/core/portal-workspace.controller.ts`

| Status | Method | Path | Notes |
|---|---|---|---|
| ✅ | GET | `/api/:t/portal/overview` | The whole landing payload in ONE request: `{clients[], client, viewOnly, progress{projects,activeProjects,completedProjects,percent}, deliverables{total,delivered,overdue}, nextMilestone, needsYou[], finance{byCurrency[],primary}}`. `needsYou[]` = `{kind:'gate'\|'contract', id, requires:'signature'\|'feedback', label, context, href, since}`. Progress is the mean of PROJECT progress (not of pooled tasks), each project weighted by `pm_tasks.progress` with `done` counting 100. |
| ✅ | GET | `/api/:t/portal/projects` | `PortalProject[]` — progress, milestone counts, deliverable count, next milestone due. |
| ✅ | GET | `/api/:t/portal/projects/:projectId` | Adds `milestones[]`, `deliverables[]`, `runs[]`, `workload{todo,in_progress,blocked,done}`. **Never returns individual tasks** — `workload` is aggregate counts only. 404 for another client's or another project-scope's project. |
| ✅ | GET | `/api/:t/portal/milestones` | Commitment calendar across visible projects. |
| ✅ | GET | `/api/:t/portal/timeline` | `?limit` (clamped 1–400, default 120). `PortalTimelineEvent[]` = `{kind, id, label, status, at, tense:'due'\|'happened', context, projectId}`. Composed as a UNION over client-visible OBJECTS — **never** from `activities`, so a new internal event type cannot leak into a client's feed by default. |
| ✅ | GET | `/api/:t/portal/deliverables` | `?projectId`. Attachment metadata batched in one query (`files[]` per deliverable). |

### 16b. Commerce — `src/core/portal-commerce.controller.ts`

| Status | Method | Path | Notes |
|---|---|---|---|
| ✅ | GET | `/api/:t/portal/invoices` | `draft` excluded. Adds `paid`, `pendingConfirmation`, `balance`, `overdue`. **Not** `ModuleEnabledGuard("billing")`-gated — a client with invoices must keep reading them if the module is switched off. |
| ✅ | GET | `/api/:t/portal/invoices/:invoiceId` | Frozen `lines[]` + `payments[]` + `paid`/`balance`. |
| ✅ | POST | `/api/:t/portal/invoices/:invoiceId/payments` | `{amount, paidOn(YYYY-MM-DD), method, reference?, note?, proof?{filename,contentType,content(base64)}}`. Records a **CLAIM**: inserted `status='pending'`, `invoices.status` untouched, `client_id`/`currency` read from the invoice (never the body). Refuses future dates and overpayment beyond a 1% tolerance. Proof ≤10 MB. Action `pay`; **capability not required**. |
| ✅ | GET | `/api/:t/portal/contracts` | `draft` excluded. `clientSigned`/`providerSigned`/`termEnded` per row (`termEnded` derived on read, never written back). |
| ✅ | GET | `/api/:t/portal/contracts/:contractId` | Adds `bodyMd`, `document`, `signatures[]`, `canSign`, `viewOnly`. **`canSign` is the exact conjunction `POST /sign` enforces** — mirror it, never recompute it. |
| ✅ | POST | `/api/:t/portal/contracts/:contractId/sign` | `{signerName, signerTitle?, agree:true}`. `agree` refused server-side if absent. Requires `signer` capability. Idempotent — a re-sign answers 200 `{alreadySigned:true}`, checked BEFORE the status check (signing is what changes the status). Flips to `signed` only when BOTH parties are present. |
| ✅ | GET | `/api/:t/portal/files/:fileId` | The portal's OWN download. Resolves ownership by walking the file's parent entity through the scope predicate; parent kinds limited to `deliverable\|contract\|invoice_payment\|project`. Attachment-only + `nosniff` + sandbox CSP. **Do not link the staff `/files/:id/content` route from the portal** — it authorizes on the parent resource kind, which the `client` role does not hold, so it 403s by design. |

### 16c. Profile — `src/core/portal-profile.controller.ts`

| Status | Method | Path | Notes |
|---|---|---|---|
| ✅ | GET | `/api/:t/portal/profile` | `{me, clients[], contacts[], access{canSign,wholeClient,grants[]}}`. `contacts[]` = fellow contacts of THEIR clients only. |
| ✅ | PATCH | `/api/:t/portal/profile` | `{name?, title?}` — the caller's own `users` row, two columns, nothing else. **Never `email`** (the IdP identity and the invite's bound address) or `status`. Action `update_profile`. |
| ✅ | POST | `/api/:t/portal/profile/change-request` | `{message, clientId?}` → **202**. Records an activity + notifies the account owners. Mutates NOTHING: `clients.name`/`contact` appear on issued invoices and signed contracts, so a client editing them would change what frozen documents appear to say. |

### 16d. Realtime — `src/core/portal-stream.controller.ts` + `portal-live.service.ts`

| Status | Method | Path | Notes |
|---|---|---|---|
| ✅ | GET | `/api/:t/portal/stream` | SSE. Opens `retry:` + `event: hello` `{mode:'live'\|'poll'}`; then `event: change` `{topic, at}`; `:` heartbeat every 25s; 30-minute connection rotation (forces re-authorization). Sends `X-Accel-Buffering: no`. |

**A frame carries a topic and a timestamp — no ids, no payload, no business data.** The browser's only
reaction is `router.refresh()`, which re-runs the ordinary reads through the ownership-enforcing BFF.
Authorization therefore still happens once, where it already worked. A filtering bug in the fan-out
costs a wasted refetch, not a disclosure — that inversion is the whole security argument for shipping
realtime to external parties. `mode:'poll'` when `REDIS_URL` is unset; the client polls unconditionally
anyway (120s when live, 30s when not), because SSE fails in ways invisible from the client.

Topics: `approvals · projects · deliverables · invoices · contracts · profile`. The event→topic map in
`portal-live.service.ts` is an **allowlist** — an unmapped event type produces no frame, so adding an
internal event cannot wake a client's browser by default.

### 16e. Staff counterpart — `src/core/contracts.controller.ts` (**no UI yet — see deferrals**)

Shipped in the same change because without it the portal's contracts section is permanently empty and
a client-recorded payment can never leave `pending`.

| Status | Method | Path | Notes |
|---|---|---|---|
| ✅ | GET | `/api/:t/contracts` | `?clientId`, `?status`. Authz: `contract` read (company_admin/manager). |
| ✅ | GET | `/api/:t/contracts/:contractId` | Adds `signatures[]`. |
| ✅ | POST | `/api/:t/contracts` | Always created `draft`. Validates the project belongs to the named client; `supersedesId` bumps `version`. |
| ✅ | PATCH | `/api/:t/contracts/:contractId` | Draft-only, except `status:'void'`. A sent/signed contract is re-issued via `supersedesId`, never edited. |
| ✅ | POST | `/api/:t/contracts/:contractId/send` | `draft → sent` + notifies signer contacts. Refuses with no document or `bodyMd`. Action `send`. |
| ✅ | POST | `/api/:t/contracts/:contractId/countersign` | `{signerName, signerTitle?}`. Action `countersign` — **owner-only** (`platform_admin`/`group_executive`); company_admin deliberately excluded. |
| ✅ | GET | `/api/:t/invoice-payments` | `?status` — finance's confirmation queue. Authz: `invoice` read. |
| ✅ | POST | `/api/:t/invoice-payments/:paymentId/decide` | `{decision:'confirm'\|'reject', reason?}`. `reason` required to reject. **Refuses self-confirmation** (recorder ≠ confirmer). On confirm, derives `invoices.status='paid'` by comparing the CONFIRMED ledger against the total (±1 tolerance), only from `sent`. Notifies the client either way. Authz: `invoice` update. |

**⚠ NO STAFF UI EXISTS FOR §16e.** Contracts must be created and payments confirmed via API until
`/clients/[id]/contracts` and a finance queue page are built. Whoever owns finance needs to know the
decide endpoint exists, or client payments accumulate as `pending` with nobody looking.

### 16f. Change Requests (maintenance intake) — `src/core/webdev-change-requests{,-portal}.controller.ts` — **STATUS: DEV-VERIFIED (MI-01..05)**

Portal view for client-submitted change requests + staff triage queue.

#### 16f-i. Portal — client submission and tracking

| Status | Method | Path | Notes |
|---|---|---|---|
| ✅ | GET | `/api/:t/portal/change-requests` | `{id, kind, title, body, status, route, clientId, projectId, projectName, pipelineRunId, pmTaskId, declinedReason, requestedBy, createdAt, updatedAt}[]`. Client's own requests (own clients, own project scope), newest-first, capped at 200. Authz: `portal` read. |
| ✅ | GET | `/api/:t/portal/change-requests/:id` | Single request. 404 for out-of-scope (not 403 — same existence-oracle avoidance as other portal detail endpoints). Authz: `portal` read. |
| ✅ | POST | `/api/:t/portal/change-requests` | `{kind, title, body?, projectId?, clientId?}` → `{id, status:'new'}`. `kind` ∈ `content|design|feature|bug`. `title` required, ≤300 chars. Server-derives `client_id`, `project_id`, `requested_by`, `source='portal'`, `status='new'` (all from request context, never body-trusted). Viewer-permitted (capability `request_change`, gated on `portal` resource only — no `canSign` check). Emits `webdev.change_request.created` and notifies the client's project owners (best-effort). |

#### 16f-ii. Staff — triage queue and conversion

| Status | Method | Path | Notes |
|---|---|---|---|
| ✅ | GET | `/api/:t/webdev/change-requests` | `{id, kind, title, status, route, clientId, clientName, projectId, projectName, source, requestedBy, requestedByName, triagedBy, triagedByName, triagedAt, declinedReason, createdAt, updatedAt}[]`. Triage queue + full list. `?status`, `?clientId`, `?projectId`, `?kind` filters. Oldest-first (queue order), capped at 200. Authz: `webdev_change_request` read (manager/module-manager+ — `member` excluded). |
| ✅ | GET | `/api/:t/webdev/change-requests/:id` | Full row + linked artifact status. Adds `body`, `runStatus`, `runTitle`, `taskTitle`, `taskStatus` (joined at read time, so CR shows live status without a stale copy). Authz: `webdev_change_request` read. |
| ✅ | POST | `/api/:t/webdev/change-requests` | `{kind, title, body?, clientId?, projectId?}` → `{id, status:'new'}`. Staff-logged maintenance work. `source='internal'` (staff-raised, no client solicitation). `client_id` may be NULL (internal-only work). Server-derives all identity fields. No notification on create (internal work, not client-actionable). Authz: `webdev_change_request` create. |
| ✅ | POST | `/api/:t/webdev/change-requests/:id/triage` | `{action, route?, reason?, kindOverride?}` → `{id, status, route, pipelineRunId?, pmTaskId?, signers[]?}`. Single triage decision (decline or convert). `action` ∈ `decline|convert`. Decline requires `reason` (≤1000 chars); convert picks a `route` ∈ `control_plane|mini_run|pm_task` (defaults by kind: content→pm_task, design/feature→mini_run, bug→pm_task). `kindOverride` ∈ `content|design|feature|bug` (optional, re-stamps the kind if provided). Serialized on the CR + precondition re-check (lock → re-read → check `status='new'` → spawn/update). **D-2a:** CR table takes CORE tenant wall, no `app_module_allowed()`. **F1:** notification audience follows source (portal requests notify contacts; internal requests don't — even when converted to a mini-run that opens a real `prd_sign` gate the client must sign, the disposition *notification* is withheld for internal-sourced requests; the gate opening itself notifies signers separately). Converts mini_run route spawn gates `prd_sign` directly (no dispatcher step); emits `pipeline.run.created` with honest `sourceMeetingId:null`. Emits `webdev.change_request.updated` + lifecycle event per outcome. Authz: `webdev_change_request` triage. |

### 16g. Site Provisioning (PRV-00..04) — `src/modules/webdev/webdev.controller.ts` — **STATUS: PROTOTYPED**

**⚠ GATES FAIL-CLOSED:** until Cerbos loads the `webdev_provisioned_site` resource policy (PRV-03), all endpoints return 403. That is the correct resting state for a surface that creates public infrastructure (GitHub repos + vhosts).

| Status | Method | Path | Notes |
|---|---|---|---|
| ⛔ | POST | `/api/:t/modules/webdev/provision` | `{runId?: string, framework?: string, slug?: string, stack?: string}` → `201 {site}` (new) or `200 {site}` (existing, idempotent re-call). `runId` or `slug` required. Idempotent provision: lock → re-read → precondition re-check → egress in one transaction. Returns mirror row immediately; polling is detached. On 409 `slug_conflict_foreign`, the mirror row is committed as `failed/slug_conflict_foreign` before the response. Authz: `webdev_provisioned_site` provision (gated by Cerbos policy `resource_webdev_provisioned_site.yaml`; policy does not exist yet). Emits `provisioned` activity. Migration `0090`. |
| ⛔ | GET | `/api/:t/modules/webdev/provisioned-sites` | `SiteDto[]` (list all, optionally filtered by `?runId=`). Authz: `webdev_provisioned_site` read. |
| ⛔ | GET | `/api/:t/modules/webdev/provisioned-sites/:id` | `SiteDto` (single row). Authz: `webdev_provisioned_site` read. |
| ⛔ | POST | `/api/:t/modules/webdev/provisioned-sites/:id/reconcile` | `{} → SiteDto`. Re-drive the poller synchronously; same logic as `POST /provision` detached poll but on-demand and blocking. Authz: `webdev_provisioned_site` reconcile (different action, can cause egress). |

---

## 17. Mail subsystem (MAIL-* program, 2026-08-04) — `src/mail/` — **STATUS: IN PROGRESS**

Design: [`../superpowers/specs/2026-08-04-zone-a-mail-design.md`](../superpowers/specs/2026-08-04-zone-a-mail-design.md)
(v3) + ticket plan [`../superpowers/plans/2026-08-04-mail-subsystem-tickets.md`](../superpowers/plans/2026-08-04-mail-subsystem-tickets.md).
`src/mail/` is core infra (design A1), not a `ModuleContract` module — no per-tenant enable gate,
same class as `src/events/`. **Status-language discipline (design §13, binding):** everything below
is verified only against a local fake-SMTP stand-in and a live Postgres test DB — **not** against
the real Mailpit sink on gda-aicenter (no server access in this ticket) and **not** against any
real provider. Caps at **IN PROGRESS**, never DEV-VERIFIED, until that live smoke runs (tracked as
a follow-up on MAIL-09).

MAIL-04 shipped the core module: adapter + queue + sender + delivery webhook + admin log reads.
MAIL-05 landed the `notify()` tap (`src/mail/intake.ts`), which populates `mail_log` for real, for
exactly two notification types — `approval.requested` and `pipeline.gate.opened` — whenever
`MAIL_ENABLED=1`. Everything else in the bell (`mention`, `comment`, `approval_decided`, etc.)
still never enqueues mail.

**MAIL-06 has now landed** (2026-08-04, F1 fix): `approval.requested` is EMITTED for real, from
FOUR creation sites (`notify()` via `notifyBestEffort()`, `core/client-notify.ts`) — the ticket
named two, a third live insert site was found and closed for full-fidelity (see the CHANGELOG
`mail` §0.0.7 entry for the exact reasoning):
1. `core/automation-approvals.controller.ts` `create()` — origin `automation`/`agent` (the WS4
   hub-gate suspension path). Notifies the tenant's `company_admin` + `group_executive`.
2. `modules/hr/hr.controller.ts` `fileLeave()` — the ONLY `origin='hr'` insert site. Notifies
   `company_admin` + `group_executive` **plus** the providing unit's `hr_manager` (module_manager
   scoped `module='hr'` — a DIFFERENT module's manager is never included).
3. `modules/agency/agency.controller.ts` `createApproval()` (subject-review path).
4. `modules/agency/agency.controller.ts` `submit()` (asset-review path).
   Both agency paths notify the `resource_agency_approval.yaml` `approve`-action set:
   `company_admin` + `agency_approver` (ex-Q-V8 — that policy's DECIDE-equivalent action is named
   `approve`, not `decide`).
5. (Beyond the ticket's two named tables, closed for consistency) `modules/search/search.controller.ts`'s
   Google-Ads change-proposal suspend path — a THIRD `automation_approvals` insert site, origin
   `automation`, same decider set as (1).
Recipient resolution mirrors the Cerbos policy (`src/core/approval-deciders.ts`, new — see its
header for the exact mirror and why it is routing-only, never an authz decision), deduped by user
id, with `notify()`'s existing self-skip preserved. `pipeline.gate.opened` was already emitted
(`pipeline.controller.ts`), unchanged by this ticket — a client-actionable gate opening already
sends mail once `MAIL_ENABLED=1` on a deployed box.

| Status | Method | Path | Notes |
|---|---|---|---|
| ✅ | GET | `/api/admin/mail/log` | Elevated-only (`isElevated` — `platform_admin`/`group_executive` global). Filters: `?stream`, `?status`, `?tenantId`, `?entityType`, `?entityId`, `?since`; `?limit`/`?offset` pagination. Non-elevated caller: 403. `mail_log` is a GLOBAL (tenant-less) table and this is its ONLY read path today — but **"no RLS" is stale and actively dangerous**: MAIL-22 put `FORCE ROW LEVEL SECURITY` on `mail_log`/`mail_messages`/`mail_suppressions` behind an `app.mail_context` GUC. A reader without `BYPASSRLS` that has not set the GUC gets **zero rows and no error**, which is indistinguishable from an empty table — this misled two separate verification runs on 2026-08-07 into reporting the mail pipeline dead when it was working. Read via `withMailContext()`, or as superuser, never a plain `SELECT`. **`tenantId`/`entityId` must be uuid-shaped and `since` must be a parseable date — a malformed value now 400s (fixed 2026-08-04; previously an uncaught Postgres error surfaced as a bare 500).** |
| ✅ | GET | `/api/admin/mail/log/:id` | Full row. 404 for an unknown id. Same elevated-only gate. |
| ✅ | GET | `/api/admin/mail/log/:id/preview` | **MAIL-38** — the RENDERED body, recomposed on demand. `mail_log` stores `template_key` + `payload` and **never the composed body** (design §6.1), so before this the ERP could show that a mail was sent but not what it said — only the Mailpit dev sink could, and that sink does not survive the move to a real relay. Returns `{ mailLogId, templateKey, subject, html, text, renderedFromCurrentTemplate }` from the SAME `renderTemplate()` the sender uses; **nothing is cached** (design §11 "render on demand, cache nothing" — a cache would put bodies in the DB the schema deliberately excludes, and give erasure a second place to reach). Elevated-only, matching `/:id` rather than `/thread`: a preview exposes only what this platform composed and already sent, from a row the caller can already read in full, so it does not need `thread`'s A10 parent-entity gate. 404 (not 500) when `template_key` has no registered renderer. **Honest limit, surfaced in the payload:** re-rendered from the *current* template, so a template changed since send renders differently from what the recipient received. UI renders it in a `sandbox=""` iframe via `srcDoc` — defence in depth over the templates' own `escapeHtml()`, because `payload` can carry inbound-derived text and MAIL-18 only proved those bytes inert *as stored*, not as composed into an elevated-only page. |
| ✅ | POST | `/api/mail/webhooks/brevo` | Provider delivery-event intake (design §7.7). NOT behind `AuthGuard` — the only wall is the `x-gaiada-mail-webhook-token` header (constant-time compare against `MAIL_WEBHOOK_TOKEN`; fail-closed when unset). Idempotent by `provider_message_id`; unknown/unmatched id or unrecognized event shape → `204` (never a 5xx a provider would retry forever over). In the dev stage this endpoint receives nothing (no live Brevo) — built and tested for real so it is ready the moment §15 R3 wires a real webhook at staging. |
| ✅ | POST | `/api/mail/inbound/brevo` | **MAIL-13** — inbound reply intake (design §7.6). Session-less like the webhook above; walls are `x-gaiada-mail-inbound-token` (constant-time vs `MAIL_INBOUND_TOKEN`, **fail-closed when unset**) plus, when `MAIL_INBOUND_SIGNING_KEY` is set, a REQUIRED `x-gaiada-mail-inbound-signature: t=<unix>,v1=<hex hmac-sha256 of "<t>.<raw body>">`. Statuses: `401` bad/absent token or signature · `413` over `MAIL_INBOUND_MAX_BYTES` · `429` per-source rate limit · `400` unparseable body · **`204` for everything else including threaded, replayed and the A9 unmatched drop** — the 204 body is empty and byte-identical in all those cases, deliberately, so the endpoint is not a reply-token oracle. Not a UI endpoint; listed because it is what populates the thread reads below. |
| ✅ | GET | `/api/:tenantId/mail/threads?entityType=&entityId=` | **MAIL-13** — the entity thread panel's read (approval detail, run workspace). `entityType` ∈ `automation_approval` \| `agency_approval` \| `pipeline_run`; anything else → `400`. **Authorized against the PARENT entity (A10), not against the mail tables** — it 403s in exactly the cases the parent surface 403s (`/api/:t/pipeline/runs`, `/api/:t/automation-approvals`), cross-tenant included. Returns `{entityType, entityId, messages[]}`; each message is `{id, mailLogId, fromEmail, senderVerified: false, provenance: "inbound-email", subject, bodyText, bodyHtmlSanitized, bodyTruncated, bodyTruncatedChars, sizeBytes, receivedAt, attachments[]}`. **`senderVerified` is always `false` and is the field the "Email reply — sender unverified" banner must be driven by** — do not hardcode the banner, and do not present `fromEmail` as an identity. `bodyHtmlSanitized` has already been through the server-side allowlist at intake (raw MIME is never stored) and must still be rendered in a constrained container. **MAIL-25 (2026-08-05):** `bodyTruncated`/`bodyTruncatedChars` are the STRUCTURED truncation signal — set at intake from length arithmetic alone (migration `0082_mail_truncation_metadata.sql`), never by parsing `bodyText`. `platform-ui`'s `QuotedMessageBody` renders its truncation notice from these two fields only, never from matching the `[truncated at intake: ...]` marker string that MAIL-19 may also have spliced into `bodyText` — a forged marker cannot set them. Never returns `mail_log.payload`, `reply_token`, or storage keys. |
| ✅ | GET | `/api/:tenantId/mail/messages/:messageId/attachments/:index` | **MAIL-13** — quarantined attachment bytes. Same A10 parent-entity authorization as the thread read, then gated on scan status: `clean` serves · `infected` `403` at every privilege (the bytes were never stored) · `pending` (unscannable) `403` at every privilege · `skipped` (scanning off) **admin-only**. Always `Content-Disposition: attachment` + `nosniff` + a `sandbox` CSP. Use the thread payload's per-attachment `downloadable` / `blockedReason` (`infected` \| `not_yet_scanned` \| `admin_only` \| `no_content`) to decide whether to render a link at all — those fields are computed with the SAME gate the endpoint enforces. |
| ✅ | GET | `/api/:tenantId/portal/mail/threads?runId=` | **MAIL-13** — the portal run view's thread panel. Client principals are NOT authorized by `resource_pipeline_run` (its read rules are elevated-only), so this route uses the portal's own kernel: Cerbos `portal` read + `resolvePortalScope` client/project ownership applied TO THE RUN before any mail table is touched. Another client's run → **`404`, not `403`** (portal non-disclosure). Same message shape as above (incl. `bodyTruncated`/`bodyTruncatedChars`, MAIL-25); `skipped` attachments are never downloadable on this surface. |
| ✅ | GET | `/api/admin/mail/log/:id/thread` | **MAIL-13** — the admin log detail pane's thread. Elevated-only (`isElevated`) **AND** the A10 parent-entity check when the mail hangs off an entity, so this is not the one thread read that outranks its parent. Mail with no entity (auth-stream mail, and NDR/bounce messages — which intake stores with a NULL entity precisely so a bounce never renders as a human reply on a decision surface) is governed by elevation alone. Attachments are reported metadata-only here (`downloadable: false`); bytes come from the tenant-scoped route above. Same message shape, incl. `bodyTruncated`/`bodyTruncatedChars` (MAIL-25). |
| ✅ | POST | `/auth/magic-link` | **MAIL-10** — mint a magic-link login token (design §9). Root-level, BFF-internal (`ServiceGuard`, Bearer `PLATFORM_SERVICE_TOKEN` — a browser cannot call this directly). `{email}` → **always `202 {ok:true}`**, body AND timing flattened so an existing address is indistinguishable from an unknown one (best-effort — see `src/mail/magic-link/service.ts`'s `dummyEquivalentWork` comment on what "flattened" does and doesn't guarantee against a real network attacker). Rate-limited 3/address/hour + 10/IP/hour (`MAIL_MAGIC_LINK_RATE_PER_ADDRESS_HOUR`/`_IP_HOUR`) — over either limit still returns the identical `202`, just skips the mint. **One documented exception (design §5.1):** a known-but-suppressed auth address gets a distinguishable `503 {error:"delivery unavailable — contact an admin"}` instead — deliberate, not a leak of the enumeration-resistance property above. `404` when `MAIL_MAGIC_LINKS_ENABLED=0` (the default). Caller must forward the real end-user IP via `x-forwarded-for` for the per-IP limit to mean anything (see the controller's own header comment). |
| ✅ | POST | `/auth/magic-link/consume` | **MAIL-10** — single-use atomic consume. Root-level, `ServiceGuard`-gated (called by `platform-ui/src/app/auth/magic/route.ts`, never directly by a browser). `{token}` → `200 {userId}` on success. Unknown, already-consumed (replayed), and expired tokens ALL return the exact same `422 {error:"this sign-in link is not usable — request a new one"}` — no distinguishing detail, no timing tell by construction (one atomic `UPDATE … WHERE consumed_at IS NULL AND expires_at > now() RETURNING`). `404` when the feature flag is off. `auth_magic_links` stores only `sha256(rawToken)` — never a usable token, never logged. |

**No "send arbitrary mail" endpoint exists at any privilege** (design §6.1) — the only way a row
lands in `mail_log` is the internal `enqueueMail()` primitive (`src/mail/queue.ts`), called by
server-side code, never by an HTTP body. **MAIL-13 has now landed** (2026-08-05): the inbound intake and all four thread reads above are
built, with a committed adversarial corpus (`platform-nest/src/mail/__fixtures__/inbound/`, 15
provider-shaped fixtures) as their permanent regression suite per design A13. **Caps at IN PROGRESS,
not DEV-VERIFIED:** `npm run mail:replay-inbound -- --base <url>` has never been pointed at a
deployed box (**PENDING-DEPLOY**), and the corpus is wired into CI but **cannot be shown running**
while GitHub Actions is billing-blocked. Real Brevo payload/signature fidelity is §15 R3 (note: Brevo
does **not** sign webhooks at all — its documented mechanisms are basic-auth-in-URL, a token header,
or custom headers, so the HMAC verifier is ours and R3 needs re-scoping), and real relay NDR format is
§15 R4.

**MAIL-10 has now landed** (2026-08-05): magic links (migration `0080_auth_magic_links.sql`,
GLOBAL/no-tenant table accessed via `withGlobal` — same class as `users`/`identity_links`, NOT one
of the `app.mail_context`-GUC-gated 0077 mail tables). **M11 restated for this doc too: a magic
link is never an approval mechanism** — approval/warning mail keeps carrying a plain, tokenless
entity URL, forever; pinned by `src/mail/magic-link/m11-non-goal.test.ts`. `platform-ui`'s
`/auth/magic` route (GET, reads `?token=`) is the landing page an emailed link opens; it consumes
the token against the endpoint above and mints EXACTLY the same cookie shape dev-login's
`sealSession(userId)` produces — not the OIDC-wrapped form `auth/callback/route.ts` uses. **Caps
at IN PROGRESS, not DEV-VERIFIED:** the live round-trip on a deployed box (mint → Mailpit capture
→ consume → cookie) is **PENDING-DEPLOY** (no deploy path while GitHub Actions is billing-blocked);
everything else is proven against the real test Postgres (`npx vitest run src/mail src/db` from
`platform-nest/`, 291/291 green incl. `src/db/rls.test.ts` **unmodified** — this table carries no
`tenant_id` column, so that estate-wide FORCE-RLS invariant does not select it). **No SLO claim
anywhere** — the M8 auth-stream latency SLO needs ≥7 days of real relay traffic (design §15 R5)
and stays whole-deferred.

**Env (`MAIL_*`, all in `src/config.ts` + the `platform` service's `environment:` block in
`infra/compose/docker-compose.vps.yml` + `.env.example` in both `platform-nest/` and
`infra/compose/`):** `MAIL_ENABLED` (master gate, default `0` — dark: no sender loop, `enqueueMail`
no-ops), `MAIL_SENDER_INTERVAL_MS`, per-stream `MAIL_STREAM_{NOTIFY,AUTH}_{TRANSPORT,RELAY_*,
BREVO_*,FROM}`, `MAIL_REPLY_DOMAIN`, `MAIL_LINK_BASE_URL` (A12 — new; the deep-link base every
approval template's `href` is built from; compiled default `https://erp.gaiada.invalid`),
`MAIL_WEBHOOK_TOKEN`, `MAIL_INBOUND_TOKEN`, `MAIL_INBOUND_MAX_BYTES`, `MAIL_INBOUND_SCAN`,
`MAIL_MAGIC_LINKS_ENABLED` (default `0`), `MAIL_MAGIC_LINK_TTL_SECONDS` (default `900`),
`MAIL_MAGIC_LINK_RATE_PER_ADDRESS_HOUR` (default `3`), `MAIL_MAGIC_LINK_RATE_PER_IP_HOUR` (default
`10`). gda-aicenter's compose already defaults both streams at
`mailpit:1025` (authless) — see MAIL-00's Mailpit service in the same compose file.

**A12 (binding):** every domain/FROM/link-base in `src/mail/` is env config with a reserved-TLD
(`*.gaiada.invalid`) compiled default — grep-gate-enforced (`rg -n "gaiada\.(com|online)"
platform-nest/src/mail/` returns zero, tests/fixtures included, wired into CI as
`src/mail/grep-gate.test.ts`).

**MAIL-15 (2026-08-05, `platform-ui`) now consumes this section for real.** `lib/mail.ts` calls
`GET /api/admin/mail/log[/:id[/thread]]` for `/admin/mail` + `/admin/mail/[id]`, and
`GET /api/:t/mail/threads` / `GET /api/:t/portal/mail/threads` (MAIL-13, landed concurrently) for
the `MailThreadPanel` embedded in the pipeline run workspace and the portal run view. Thread reads
absence-degrade to an empty thread on 404/405 — treated as "not there yet", not an error — but a
403 still propagates as a real refusal. No new endpoints requested; this is a consumer note, not a
contract change.

**APPR-01 (2026-08-05) fixed a real gap this section's own MAIL-06 note left standing**: every
`approval.requested` emission set `payload.href: "/approvals"` — the bare list, no id — so an
emailed approval link landed a decider on the inbox, not the item. `entityHref()`'s own header
(§ above, unchanged) already documented this as staff/portal §7.5 routing; the fix is at BOTH
ends and is now pinned so they can't drift apart again: (1) all five `approval.requested`
emission sites (§ "MAIL-06 has now landed" list above — `core/automation-approvals.controller.ts`,
`modules/hr/hr.controller.ts`, `modules/search/search.controller.ts`, `modules/agency/
agency.controller.ts` ×2) now set `href: \`/approvals/${id}\`` — a test per site reads the real
`notifications.payload` row and asserts the exact string; (2) `platform-ui`'s `entityHref()`
(used by the admin mail-log UI to reconstruct the same link from `entity_type`/`entity_id` alone)
returns the same shape, pinned in `lib/mail.test.ts`. `platform-ui`'s new `/approvals/[id]`
(`app/(app)/approvals/[id]/page.tsx`) is what that id-bearing link now resolves to — see §8's two
new `GET .../:id` rows above for the reads it's built on, and MODULES.md/CHANGELOG.md for the
full writeup (both projects, `IN PROGRESS`, `PENDING-DEPLOY` on the live-walk ACs).

## 18. Assistant module (ASST-* program, 2026-08-05) — `modules/assistant/assistant.controller.ts` — **BACKEND ✅ BUILT — threads/messages CRUD (ASST-05) + send→stream engine (ASST-06); FE ✅ BUILT (ASST-07 + the ASST-16/17/18/19/21 iterations + T4, 2026-08-06)**

From `docs/blueprints/assistant-foundation.md` (design) and
`docs/superpowers/plans/2026-08-05-d14-and-assistant-tickets.md` ("### ASST-05", the authoritative
ticket). Module key `'assistant'`; dark unless `companies.enabled_modules ∋ 'assistant'` OR an
ACTIVE `service_assignment` serves it. All routes mounted `/api/:tenantId/assistant/*` (no
`/modules/` segment — matches the blueprint's literal BFF contract table, same top-level-prefix
convention as `PmController`/`ItController`).

**Authorization model — read before touching this surface.** `assistant_thread` is **owner-only,
with NO company_admin/group_executive/superadmin bypass** (ASST-02's Cerbos policy,
`cerbos/policies/resource_assistant_thread.yaml`, live + verified). Every `authorize()` call passes
`ownerId` — list uses the caller's own id (self-scoped by construction), read/update/delete use the
FETCHED row's `owner_user_id`, never anything client-supplied. A same-company user who isn't the
owner gets **403**, not a degraded view — this is deliberate, not a gap to "fix" toward consistency
with other resources' admin-bypass rules. Do not add one; see the policy file's header for why.

- ✅ `GET /api/:t/assistant/threads` — paginated (`limit`/`offset`, default 50 / max 200),
  substring search on title (`q`), optional `status` filter (`active`/`archived`), ordered
  pinned-first then `last_message_at DESC NULLS LAST`. Response `{ items, total }`.
- ✅ `POST /api/:t/assistant/threads` — `{ title?, brainProvider?, brainModel? }` → `{ id }`. Owner
  is always the caller; `brain` is stored but **not routed** until Phase 2 (ASST-06/Hermes) — see
  that ticket, not this one, for per-brain dispatch.
- ✅ `GET /api/:t/assistant/threads/:id` — thread + paged messages (`messageLimit` default 200/max
  500, `beforeSeq` cursor for older pages), returned oldest→newest. Response
  `{ thread, messages, hasMoreMessages }`.
- ✅ `PATCH /api/:t/assistant/threads/:id` — rename (`title`) / pin (`pinned`) / archive
  (`status: 'active'|'archived'`) / brain (`brainProvider`/`brainModel`).
- ✅ `DELETE /api/:t/assistant/threads/:id` — hard delete; CASCADEs to `assistant_messages` →
  `assistant_tool_calls`, and SETs NULL (row survives) on `assistant_memory.source_thread_id` —
  proven by `modules/assistant/assistant.test.ts`'s cascade probe (admin-pool reads, not just
  invisible-under-RLS).
- Deliberately **NO** `writeActivity()`/`notify()` call on any of the above: the tenant activity
  feed (`GET :t/activity`) is readable by every plain member, and writing thread metadata into it
  would leak a private thread's existence/title to people with no Cerbos grant to read it — the
  same class of admin-adjacent backdoor the Cerbos policy itself refuses to open.
- ✅ **`POST /api/:t/assistant/threads/:id/messages`** (ASST-06) — `{ content }` →
  `{ messageId, streamUrl }`. The "POST" half of the POST-then-GET pair (`EventSource` cannot
  POST). Persists the user's message AND an assistant-role **placeholder** (`content=NULL,
  error_kind=NULL`) at the next two `seq` values, in ONE transaction, behind a
  `pg_advisory_xact_lock` on the thread id (same idiom as `core/pipeline-lock.ts`'s WD-29 fix,
  own namespace) — the placeholder's existence + null-content state IS the "generation pending"
  signal (no new column). A second send while one is still pending/streaming gets **409**, not a
  silent interleave — the lock only serializes the race, a precondition re-check INSIDE it (the
  same D14 lesson: a lock alone is not enough) is what makes the loser actually refuse.
  **Server-side auto-titling (2026-08-07 owner fix):** in the SAME transaction, when this INSERT is
  the thread's first message ever (`userSeq === 1`) AND `assistant_threads.title IS NULL`, the
  title is derived from the raw `content` (ASST-22 page-context preamble stripped first — see
  `modules/assistant/thread-title.ts::deriveServerThreadTitle`) and persisted. This is the
  AUTHORITATIVE fix for "every thread in the sidebar reads New chat" — the client-side titling
  that shipped in alpha-01.024.0063a (`AssistantWorkspace.tsx`'s `handleSend`) only ever fired on
  `messages.length === 0`, which is never true for a pre-existing thread, so it fixed nothing for
  any thread that already had history and never ran at all for any OTHER caller (the drawer, an
  agent-created thread, a future API client). That FE code is KEPT as a belt-and-braces optimistic
  update — not removed — because its derivation is byte-for-byte identical to this one, so the
  two cannot disagree regardless of which write lands first. A manual rename (`PATCH .../threads/
  :id` with `title`) always wins and is never overwritten by this. Migration
  `0086_assistant_thread_title_backfill.sql` backfills every pre-existing `title IS NULL` thread
  from its first user message using the same algorithm.
- ✅ **`GET /api/:t/assistant/threads/:id/stream?messageId=<id>`** (ASST-06) — SSE. Re-emits
  typed events `token` (`{text}`), **`meta`** (`{provider, model}` — ASST-12, added 2026-08-05:
  relayed the instant ai-gateway-go's own `event: meta` arrives, i.e. before the first token; see
  the "Gateway wire addendum" below for the gateway-side timing invariant this mirrors), `usage`
  (`{tokens, latencyMs, source, promptTokens?, completionTokens?}` — ASST-12 added `source` ∈
  `"provider" | "estimate"` plus the real breakdown when present; `tokens` is the ASST-06
  ~4-chars/token estimate ONLY when `source === "estimate"` — when `source === "provider"` it is
  `promptTokens + completionTokens`, a REAL count relayed from the gateway's own terminal
  `event: usage` (ASST-11). Absent real usage is the common path today (only `ollama` reports it) —
  `source` still arrives as `"estimate"` in that case, never omitted and never silently zero-filled).
  Also `done` (`{}`), `error` (`{error, errorKind}`). `errorKind` ∈ `upstream_error` (the gateway sent
  `event: error`) | **`abnormal_drop`** (the gateway's stream ended with NEITHER `done` NOR
  `error` — treated as a failure, never as success, per ASST-10's explicit mandate) | `idle_timeout`
  (no upstream activity for `ASSISTANT_STREAM_IDLE_TIMEOUT_MS`, default 60s — a stalled generation
  fails visibly instead of hanging the connection forever) | `stopped` (see below) |
  `client_disconnected` | `not_configured` (`GATEWAY_URL` unset) | `transport_error`. On `done`,
  the placeholder is finalized with the full text + the token count (real when `usageSource ===
  'provider'`, else the estimate) + latency and the thread's `total_tokens`/`last_message_at` are
  bumped; on ANY other outcome it is finalized with the partial text received so far (possibly
  `""`) + a typed `error_kind` — a stopped/failed generation's partial reply is always visible,
  never silently discarded. Re-opening an already-finalized `messageId` **404s**.
  **`provider`/`model` (ASST-12, 2026-08-05):** filled from ai-gateway-go's `event: meta` (ASST-11)
  whenever it arrived — **left NULL when it never did** (an older gateway, or a provider that died
  before committing bytes to the wire), which is the honest "unknown provider" state, never an
  error; `model` may itself be `""` (a provider with no fixed-model concept, e.g. `echo`) —
  distinct from NULL, rendered by the UI as "unknown model" rather than a broken value.
  `usageSource` (`'provider' | 'estimate'`) is persisted too, but NOT as its own column — it lives
  inside the existing `parts` jsonb (previously always `[]` and unused; see `stream.ts`'s
  `usageMetaParts`/`UsageMetaPart`, mirrored byte-for-byte by platform-ui's `parseUsageMeta`) so no
  migration was needed. **Thread `brain` is stored but NOT ROUTED in Phase 1** — the gateway's own
  chain/failover picks the provider; per-brain dispatch is Phase 2. Context assembly
  (`modules/assistant/context.ts`) folds the system preamble + a
  rolling **compaction summary** + the most recent messages (char-budget
  `ASSISTANT_CONTEXT_CHAR_BUDGET`, default 12000) into the single `prompt` string
  `/complete(/stream)` accepts (that route has no chat-messages array). **Compaction v1**: when
  the window overflows, the oldest excerpt is folded into `assistant_threads.compaction_summary`
  via one `POST /complete` call and `compaction_summary_upto_seq` advances — the RAW messages are
  NEVER deleted, so resuming an old thread still replays every one of them (`GET .../threads/:id`
  already pages through the full transcript); only a NEW generation's prompt is shortened.
- ✅ **`POST /api/:t/assistant/threads/:id/stop`** (ASST-06) → `{ ok, stopped }`. **Cancels the
  upstream gateway request** (aborts the in-flight `fetch`, which propagates to ai-gateway-go's
  own `r.Context()` and stops `chain.Run` mid-provider) — verified directly against a fake
  gateway observing the client disconnect, not inferred (`assistant-stream.test.ts`). Two paths:
  if this process is running the generation, abort it via an in-memory per-thread registry
  (`modules/assistant/stream.ts`, best-effort/single-instance-v1 — same posture as mcp-hub's D14
  nonce cache); otherwise (never opened, or already finished on this process) a direct `UPDATE`
  closes any still-pending placeholder so the thread is never left wedged. The SSE socket
  disconnecting client-side (tab closed) triggers the identical cancellation path.
- Deliberately **NO** `writeActivity()`/`notify()` call on any of the above (same reasoning as
  ASST-05's CRUD — see above).
- **Corrected 2026-08-06 (T4):** the two bullets below this note were ASST-06's original "not built
  yet" list — stale, per this doc's own "a stale 'no UI consumer yet' row is a real defect" rule
  (platform-ui/CLAUDE.md). Current status: `GET :t/assistant/capabilities` (ASST-18), memory
  CRUD (ASST-19), `POST .../threads/:id/handoff` (ASST-21) all shipped with FE consumers.
  `POST .../messages/:id/feedback` remains genuinely unbuilt (not part of any landed ticket).
  `tool_call`/`tool_result`/`approval_required` (ASST-17) plus `confirm_required` (T3b) all have a
  live FE decoder + renderer as of T4 (below) — `/assistant`'s composer can send `mode:'tools'`,
  the transcript renders tool chips + the full D14 proposal card, and Confirm/Dismiss call T3b's
  endpoints. Original text, left as written rather than edited in place:
  - ~~PENDING (ASST-06+): `GET /api/:t/assistant/capabilities`,
    `GET·POST·DELETE /api/:t/assistant/memory`, `POST .../messages/:id/feedback`,
    `POST .../threads/:id/handoff` — phases 2-5 of the blueprint's build sequence (§9), not
    decomposed into tickets yet. Tool-call (`tool_call`/`tool_result`/`approval_required`) SSE
    events are Phase 3 — this ticket's relay never emits them.~~
  - ~~PENDING: `/assistant` UI (`platform-ui`) + `lib/assistant.ts` (ASST-07). Backend is
    UI-ready for all eight endpoints above.~~
- **DEVOPS — SSE-BEHIND-A-PROXY (ASST-09, config written 2026-08-05, NOT YET applied to the live
  box):** nginx buffers SSE by default; the client portal's own stream
  (`core/portal-stream.controller.ts`) needed a hand-applied `proxy_buffering off` /
  `X-Accel-Buffering: no` vhost block before it worked in production. THIS route (the
  browser-facing platform-ui proxy at `GET /api/assistant/threads/:id/stream` — platform-nest's
  own `GET .../threads/:id/stream` is called server-side over `PLATFORM_URL` and never crosses
  the public vhost, so it needs no nginx change) now has the identical treatment committed in
  `infra/nginx/erp.gaiada.online.conf` (`nginx -t` verified). The response already sends
  `X-Accel-Buffering: no` itself, so the vhost-level `proxy_buffering off` block is
  belt-and-braces, per the portal's own precedent — but nginx config is never synced by CI, so
  this is still a **separate, manual apply-on-the-box step** before it takes effect in prod. See
  `infra/runbooks/deploy-vps.md`'s "nginx SSE: assistant stream (ASST-09)" section for the exact
  block, the apply steps, and the `curl -N` verification that streaming is genuinely incremental.
- `ModuleContract.mcpTools` and `rollupProviders` are deliberately **empty** in this ticket — the
  tool-broker surface is Phase 3 (unregistered on purpose, not a placeholder omission) and no
  metric surface is specified yet. See `modules/assistant/index.ts`'s header comment.

### Gateway wire addendum — `event: meta` + terminal `event: usage` (ASST-11, 2026-08-05)

**`ai-gateway-go`'s `POST /complete/stream` only — NOT platform-nest's `.../threads/:id/stream`**
(that BFF-facing route has its OWN, separate `meta`/`usage` frames, documented in the bullet
above — ASST-12 re-emits them on ITS wire, it does not merely forward the gateway's). Two ADDITIVE
grammar-v2 events (ASST-10: single-line JSON `data:`, same as every other frame on this route),
layered onto the wire while it still had exactly one consumer. **ASST-12 (2026-08-05) is that
consumer now — platform-nest's relay (`modules/assistant/stream.ts`) parses both, absent-tolerantly**
(an older gateway build, or any provider that reports neither, degrades to exactly ASST-06's
original behaviour: NULL provider/model, the char-count estimate — never an error). This was the
last moment either event could be added for free; once a SECOND gateway consumer exists (beyond
this relay), changing this framing again is a breaking change.

- **`event: meta`** — `data: {"provider":string,"model":string}`. **(ASST-15, 2026-08-05: the
  `providerSession"?:string` field this payload carried under ASST-11 is REMOVED — see the
  "ASST-15 — one grammar for `meta`" addendum below for why and what replaced it.)**
  Emitted **exactly once per stream**, at the moment the ASST-04 DLP scrubber releases its FIRST
  bytes to the wire — i.e. immediately before the first content `data:` frame, NOT at provider
  selection time. That timing is load-bearing: it names the provider that actually **committed**
  output under ASST-03/04's `streamed` discipline. A provider that dies while its output is still
  inside the scrubber's hold window (nothing yet reached the client) never gets `meta` written for
  it — the failover replacement's `meta` is what the client sees, and it is never contradicted
  afterward (once `meta` is written, no further provider can run for that response). `model` is
  `""` for a provider with no fixed-model concept (e.g. `echo`) — truthful absence, not a guess.
  **Additive contract: a consumer MUST treat an absent `meta` event as "unknown provider" — never
  an error.** This covers both an older gateway build (pre-ASST-11) and, until the ASST-06
  follow-up lands, THIS gateway's only real consumer, which simply never looks for it yet.
- **`event: usage`** — `data: {"promptTokens":int,"completionTokens":int}`. **Terminal** — written
  immediately before `event: done`, and **only** when a provider reports REAL end-of-stream token
  counts (never zero-filled, never estimated — the whole point of this event is that it is never
  ASST-06's own ~4-chars/token estimate wearing a "real" label). Absent on every error path, and
  absent whenever the serving provider doesn't report counts.
  **Which providers can report it today: `ollama` only** (`internal/providers/ollama.go` —
  Ollama's NDJSON final line carries `prompt_eval_count`/`eval_count`, wired via the new
  `providers.UsageStreamingProvider` extension of `StreamingProvider`). `echo`, `openai` (incl.
  Ollama Cloud), `gemini`, and `claude` report no real counts today — `usage` is simply absent for
  them, by design, not a gap. Live production usage from the real Ollama upstream is
  **UNVERIFIED** — proven only against fixture NDJSON in `internal/providers/ollama_test.go`; no
  live Ollama instance was driven for this ticket.
- Both events go through the same `writeSSEData`/`writeSSEError`/`writeSSEDone`-style helpers
  (`writeSSEMeta`/`writeSSEUsage` in `internal/server/server.go`) that guarantee the one-line-JSON
  invariant — no call site can bypass it. Full coverage in
  `internal/server/server_meta_test.go` and `internal/providers/ollama_test.go`.

### ASST-15 — provider hint, `providerSession` passthrough, and one grammar for `meta`

**The divergence this ticket resolves.** ASST-14 shipped `hermes-gateway`'s `/complete/stream`
emitting `meta` **terminally** (right before `done`), because Hermes' session id is only knowable
once its footer parses — a genuinely late fact. ASST-11's ruling above says `meta` fires
**pre-first-token**, everywhere. That was one grammar with two dialects — the exact shape of every
recurring defect named at planning time (the AgentDef-vs-registry impact drift; the impact gate
living in two places): the same event name meaning two different things depending on which
process emitted it. Concretely, it also left a real user-visible defect: the "served by" badge
read "Unknown provider" for the entire length of a Hermes reply, resolving only at the very end.

**Resolution chosen: (a) — keep `meta` pre-first-token, UNCONDITIONALLY, everywhere; move the
late-arriving fact to a new, separate, additive terminal event.** `providerSession` is deleted
from `meta`'s payload (see the updated bullet above) and never reappears there. A brand new event,
`event: session`, carries it instead:

- **`event: session`** — `data: {"providerSession":string}`. **Terminal** — written after the
  last token (and after `event: usage`, if any), immediately before `event: done`. Emitted **at
  most once**, and **only when the serving provider actually has a session id to report** — never
  invented, never sent empty, mirroring `event: usage`'s "real counts or nothing" discipline
  exactly. Absent on every error path (a provider that dies never gets to report a session for a
  reply the client is being told failed). Which providers can report it today: **`hermes` only**
  (`internal/providers/hermes.go`'s `SessionStreamingProvider` extension of `StreamingProvider`) —
  `ollama`/`gemini`/`claude`/`openai`/`echo` have no session concept and never emit it, by design,
  not a gap.

**Why (a) over (b) ("meta gains a formally-permitted terminal form, providerSession allowed
late").** (b) was considered — it's cheaper (no new event name) and ASST-12's relay
(`platform-nest/src/modules/assistant/stream.ts`) already tolerates a `meta` frame arriving at any
point, so it would not have required a platform-nest change either. It was rejected because **it
does not fix the actual defect**: under (b), Hermes' `meta` would still land right before `done`,
so the badge would still read "Unknown provider" for the whole reply — the divergence would be
merely *documented*, not *closed*. Under (a), `provider`/`model` are known the instant an attempt
starts (`p.Name()`/`ModelName()`, static, no network round-trip needed) for every provider
including `hermes` — there is no real reason for `meta` itself to ever be late; only the
session id is genuinely late, and only for one provider. Splitting the late fact into its own event
means `meta`'s timing rule has **zero exceptions, for any current or future provider** — the
single-dialect property the whole ticket exists to establish — while `hermes` still gets its badge
lit up immediately like every other provider, closing the user-visible bug, not just relabeling
it.

**Both emitters agree, byte-for-byte grammar:**
- `ai-gateway-go` (`internal/server/server.go`): `writeSSEMeta` writes `{provider,model}` only (the
  `ProviderSession` field was removed from `metaPayload`); a new `writeSSESession` writes
  `event: session` from a `SessionStreamingProvider`'s `onSession` callback, gated exactly like
  `onUsage` — discarded on failover if the attempt died inside the ASST-04 hold window, never
  written on any error path, at most once.
- `hermes-gateway` (`server.mjs`): `writeSSEMeta` now fires at the **first** piece the
  `HermesBoxStreamParser` emits (mirroring ai-gateway-go's scrubber-release timing exactly — a
  Hermes run that dies before any body content is parsed never gets a `meta` written for it,
  matching the ASST-11 hold-window discipline), carrying `{provider:"hermes", model}` only. A new
  `writeSSESession` fires once, terminally, with `{providerSession}` **only when
  `parser.sessionId` is non-null** — never on the timeout/spawn-error/non-zero-exit/box-never-closed
  paths, which all return before it. `/complete` and `/media` are untouched (wa-chat-bot depends on
  them byte-for-byte); zero runtime dependencies preserved.

**Provider hint + `providerSession` request fields (`POST /complete/stream` only).** The request
body gains two optional fields: `provider` (a hint — route to the NAMED provider first when it is
available *and* its breaker is closed; otherwise fall through to the normal failover chain,
**never a hard error** — OQ-6's ruling is "fail over and LABEL", and `meta` does the labelling) and
`providerSession` (an **opaque** token the gateway never inspects, generates, or validates — it is
threaded verbatim into whichever attempted provider implements
`providers.SessionStreamingProvider`, today only `hermes`). The hint is a pure **reordering** of
the chain's provider snapshot (`chain.RunWithHint`) — it does not skip the breaker/availability
checks for the hinted provider (an open breaker or `Available()==false` still skips it exactly as
if it were first in line naturally) and does not touch breaker state; an empty or unmatched hint
falls through to the chain's untouched `Run` behavior. Absent hint ⇒ byte-identical behavior to
before this ticket for every existing caller (`/complete`, `/media`, `/embed` don't accept a hint
at all; `/complete/stream` with no `provider` field delegates straight to `Run`).

### Memory panel backend — propose vs confirm, quarantine discipline (ASST-19, 2026-08-05)

Note on the "PENDING (ASST-06+)" bullet above (in §18's own list): it still names
`GET·POST·DELETE /api/:t/assistant/memory` as pending — that line is left as written rather than
edited in place (per this ticket's own instruction, to avoid clobbering concurrent edits to that
list); this subsection is the up-to-date status. `GET /api/:t/assistant/capabilities`,
`POST .../messages/:id/feedback` and `POST .../threads/:id/handoff` remain genuinely pending.

`assistant_memory` is memory #2 of the blueprint's "four memories" (§4.1) — durable, editable,
deletable, and its writes are **proposals**: a row is recorded the instant it is proposed, but
`confirmed_at IS NULL` until a human confirms it, and an unconfirmed row is completely inert (see
below). Same owner-only Cerbos policy as threads (`resource_assistant_memory.yaml`, ASST-02, **NO**
company_admin/group_executive/superadmin rule), with exactly four actions —
`list`/`propose`/`confirm`/`delete` — and no separate `update` action.

- ✅ **`GET /api/:t/assistant/memory`** — action `list`, self-scoped (`WHERE owner_user_id` = the
  caller). Query: `scope` (`user`|`company`), `pinned` (bool), `confirmed` (bool — the confirm UI's
  "pending proposals" vs "confirmed memory" split), `limit`/`offset` (default 100/max 500).
  Response `{ items, total }`; ordered pinned-first, then confirmed-first (nulls first, i.e.
  unconfirmed proposals surface at the top of their own group), then most-recent.
- ✅ **`POST /api/:t/assistant/memory`** — action `propose`. `{ content, scope?, sourceThreadId? }`
  → `{ id }`. Always inserts `provenance='user'`, `trust` and `confirmed_at` left at their
  migration-0079 column defaults (`'untrusted'` / `NULL`) — this is THE quarantine boundary: the
  row exists (for audit + the confirm UI) but is otherwise inert until confirmed. A future ASST-17
  wiring (the assistant proposing memories through its own event surface, this ticket's stated
  dependency) would call the same INSERT shape with `provenance='assistant'` — not built here.
- ✅ **`POST /api/:t/assistant/memory/:id/confirm`** — action `confirm`, the ONLY way
  `confirmed_at`/`trust` ever change. `{ content?, pinned? }` optional. Idempotent on the
  confirmation TIMESTAMP (`confirmed_at = COALESCE(confirmed_at, now())` — re-confirming an
  already-confirmed row does not reset when it was first confirmed) but doubles as the **pin/edit**
  affordance for an already-confirmed row: Cerbos has no separate `update` action, so editing
  `content` or toggling `pinned` on an existing memory reuses `confirm` with just those fields set.
- ✅ **`DELETE /api/:t/assistant/memory/:id`** — action `delete`. Hard delete. **Deleting the
  THREAD it was mined from does NOT delete the memory** — migration 0079's composite tenant-scoped
  FK on `source_thread_id` is `ON DELETE SET NULL (source_thread_id)` (PG15+ column-list form): the
  memory row survives with its provenance link cleared, proven by
  `modules/assistant/assistant-memory.test.ts`.
- **`scope` implemented as metadata only, NOT a visibility switch** — the ticket left this
  ambiguous ("if the ticket is ambiguous, say what you implemented and why"). `assistant_memory.scope`
  (`user`|`company`, migration 0079) records what the fact is ABOUT (a personal preference vs.
  something about the company the user chose to have remembered); `resource_assistant_memory.yaml`
  does not branch on it, so a `scope='company'` row is exactly as owner-private as a `scope='user'`
  one — same 403s for every non-owner, proven in `assistant-memory.test.ts`. A genuine
  shared-company-memory feature (any principal in the company can read a `scope='company'` row)
  would need its own Cerbos rule and its own ticket — reading `scope` as a widening switch here
  would be exactly the "for consistency" backdoor ASST-02's policy header warns against.
- **THE QUARANTINE GATE lives in `context.ts`, not here** — `assembleContext`'s
  `fetchConfirmedMemory` reads `assistant_memory` with `WHERE owner_user_id = $1 AND confirmed_at IS
  NOT NULL` and injects the result as a "known facts about this user (confirmed)" block ahead of
  the transcript. An unconfirmed row is invisible to every assembled prompt, full stop — proven
  directly on the assembled `prompt` STRING (never the UI/API shape) by
  `modules/assistant/context-memory.test.ts`'s two tests: (1) the blueprint's Phase-4 gate — a
  DELETED memory is absent from the next assembled context; (2) the negative — an UNCONFIRMED
  memory never appears in an assembled prompt, until it is confirmed.
- Deliberately **NO** `writeActivity()`/`notify()` on any memory write (same reasoning as every
  other assistant write — the tenant activity feed is member-readable and would leak private
  memory content, not just a thread's existence).
- **⬜ PENDING:** the platform-ui right-rail memory panel (view/edit/delete/pin) — this ticket's
  backend is UI-ready for all four endpoints above.

### Per-thread brain picker + Hermes session mapping (ASST-16, 2026-08-05) — blueprint Phase-2 gate

Consumes ASST-15's request-side additions to `POST /complete/stream` (`provider` hint,
`providerSession` passthrough) and its `event: meta`/`event: session` split (see the addenda
above) from platform-nest's own relay, `modules/assistant/stream.ts`. **No new BFF route** — the
existing `PATCH /api/:t/assistant/threads/:id` (ASST-05) already accepted `brainProvider`/
`brainModel`; this ticket is the first thing that actually ROUTES on the stored value.

- ✅ **Routing:** `GET .../threads/:id/stream` now sends the thread's `brain_provider` as
  `/complete/stream`'s `provider` HINT and the thread's `hermes_session_id` (if any) as
  `providerSession`. Both are hints/passthrough only — OQ-6's "fail over and label" — never a hard
  requirement: a down/unavailable hinted provider silently falls through to the gateway's normal
  failover chain, and the persisted/relayed `meta` (`provider`/`model`, ASST-12's badge) ALWAYS
  names the provider that actually served the reply, which may legitimately differ from the hint.
- ✅ **Session continuity — the Phase-2 gate:** the relay captures ASST-15's terminal
  `event: session` (`{providerSession}`, today only `hermes`) and persists it to
  `assistant_threads.hermes_session_id` via
  `... SET hermes_session_id = COALESCE($session, hermes_session_id) ...` — a turn that reports no
  session (a non-hermes provider, or hermes failing before its terminal frame) never CLEARS an
  existing one. The NEXT `GET .../stream` call on the same thread reads that column back and sends
  it as `providerSession`, which is what makes turn 2 resume the exact SAME Hermes conversation —
  proven directly on the request the fake gateway received in
  `modules/assistant/assistant-stream.test.ts`'s `"THE PHASE-2 GATE"` test (asserts
  `req2.providerSession === capturedSessionFromTurn1`), not merely on the persisted column.
- ✅ **Brain switch clears the session (own decision, ticket left it open):** `PATCH
  .../threads/:id` with a `brainProvider` that actually CHANGES the stored value also sets
  `hermes_session_id = NULL` in the same UPDATE, in either direction (switching away from hermes,
  switching TO hermes from something else, or switching hermes→ollama→hermes) — a stale session
  belongs to a routing decision that's no longer in effect, and resuming it after other turns were
  served by a different provider would silently misrepresent what the model has actually seen. A
  PATCH that re-picks the IDENTICAL value (or doesn't mention `brainProvider` at all) is a no-op on
  the session id — re-selecting the same brain, or renaming/pinning the thread, must not throw away
  an in-progress Hermes conversation. The ERP transcript (`assistant_messages`) is entirely
  unaffected either way — context assembly (`context.ts`) never reads `brain_provider`/
  `hermes_session_id`, so switching brains loses no history, only the provider-side session token.
- ✅ **platform-ui:** `components/assistant/BrainPicker.tsx`, a right-rail toolbar control (next to
  the ASST-19 memory toggle) backed by `lib/assistant.ts`'s `BRAIN_OPTIONS` and
  `assistantActions.ts`'s `setThreadBrainAction` — calls the SAME `PATCH` endpoint, no new route.
  Disabled while a generation is streaming (switching mid-flight wouldn't retroactively change the
  in-flight relay's already-captured provider/session inputs, which would be confusing rather than
  broken). The "served by" badge (`Message.tsx`, ASST-12) is intentionally untouched — it already
  reads the truthful `meta`, independent of what this picker requests.
- Tests: `modules/assistant/stream.ts`'s consuming side (`stream.test.ts`) covers the `meta`/
  `session` grammar split in isolation; `assistant-stream.test.ts`'s `"ASST-16: brain routing +
  Hermes session continuity"` block covers the Phase-2 gate, the Hermes-down failover badge, brain
  switching (incl. the no-op-on-identical-value case), and end-to-end against a fake gateway that
  reproduces ASST-15's request/response shape byte-for-byte.

### ASST-24 — Hermes session-resume mismatch is now reported, not silently forked (2026-08-06)

**The defect this closes (ASST-24 QA gate, MEDIUM).** ASST-15/16 above made Hermes session
continuity work on the happy path, but left one adversarial case with zero diagnostic signal: if
`hermes-gateway` loses its session state (e.g. a restart) and is then asked to `--resume` a
`providerSession` id it no longer has any record of, the real Hermes CLI exits 0 with a perfectly
well-formed reply and a well-formed `Session:` footer — it just silently mints a brand-new,
unrelated session instead of continuing the old one. `hermes-gateway/server.mjs` had no code path
that compared the id it got back against the id it was asked to resume, so the wire looked like an
ordinary success: `event: session` naming the new id, `event: done`, no `event: error` anywhere.
platform-nest's own `hermes_session_id = COALESCE($2, hermes_session_id)` persistence
(`assistant.controller.ts`) then happily overwrote the thread's session id with the forked one — the
ERP transcript kept reading as one continuous conversation while Hermes' own agent memory had
silently diverged. Reproduced by `hermes-gateway/test/session-resume-mismatch.test.mjs`.

**The fix — additive fields on the SAME `event: session`, no new event, never `event: error`.**
The reply itself is a genuinely valid answer; only the continuity claim was false, so this is not
an error condition — it is dishonest labelling of a success. Widening `event: session`'s payload
keeps grammar v2 single-dialect (the whole point of the ASST-15 resolution above): a new event name
would have been a second way to say "here is what happened with the session," which is exactly the
kind of two-dialects-for-one-fact problem ASST-15 was written to eliminate.

- **`event: session`** — `data: {"providerSession":string,"resumed":boolean,"requestedSession"?:string}`.
  Still terminal, still at most once, still only when the serving provider actually has a session
  id to report (unchanged from ASST-15). Two ADDITIVE fields:
  - **`resumed`** — always present. `true` when a resume was requested AND the returned
    `providerSession` equals the requested id (a genuine resume happened), or when NO resume was
    requested at all (turn 1 / a fresh conversation — nothing to mismatch, so a brand-new session
    is exactly what was expected: this repo's chosen definition for the "no-resume-requested"
    case). `false` when a resume WAS requested and the returned id differs — Hermes silently forked
    instead of continuing.
  - **`requestedSession`** — present ONLY when the request actually carried a `providerSession` to
    resume (never invented, never sent empty — the same discipline `providerSession`/`event: usage`
    already follow on this wire). Absent whenever `resumed` is `true` because nothing was
    requested; present whenever `resumed` is `false`, carrying the id that was asked for so a
    consumer can log/display exactly what failed to resume.
  - This is the ONLY signal `hermes-gateway` has available — Hermes gives no distinct exit code or
    stderr marker for "I ignored your --resume and started fresh" — but comparing the two ids is
    sufficient: it is exactly the fact an ERP consumer needs.
  - `ai-gateway-go` is UNCHANGED by this ticket (it has no session-forking failure mode to detect
    today); this addendum is `hermes-gateway`-only.
- **What a consumer (platform-nest's relay / a future UI) should do with `resumed: false`: SURFACE
  it, never swallow it.** The honest UX is telling the user the conversation restarted — e.g. a
  system-style message in the thread ("Hermes couldn't resume the previous conversation and started
  a new one") or a badge next to the reply — NOT silently accepting the new session id as if
  nothing happened, which is the exact user-visible failure mode this ticket exists to close.
  **Not built in this ticket** (scoped to `hermes-gateway` only, per the ticket that authorized this
  work) — `platform-nest/src/modules/assistant/stream.ts`'s relay still parses `event: session` for
  `providerSession` alone and does not yet read `resumed`/`requestedSession`; consuming the signal
  is an explicit follow-up. Additive fields are safe to ship ahead of that consumer: ASST-12's relay
  parses known fields and ignores unknown ones, exactly like an older gateway build ignoring
  `event: usage`.
- Tests: `hermes-gateway/test/session-resume-mismatch.test.mjs` — the stale/unknown-id case
  (`resumed: false`, both ids present, reply still completes with `event: done` and no
  `event: error`), the happy path (id returned unchanged ⇒ `resumed: true`), and the
  no-resume-requested case (`resumed: true`, `requestedSession` absent). Wired into
  `hermes-gateway/package.json`'s `test` script (the QA gate found it was written but not run;
  now fixed) — `npm test` is 24/24 green, and `/complete`/`/media` are proven byte-for-byte
  unchanged by `git diff` (this ticket's entire diff is confined to `writeSSESession` and the one
  call site inside `handleCompleteStream`'s `finish()`).

**Follow-up closed (2026-08-06): the signal now reaches ai-gateway-go, platform-nest, and
platform-ui — nothing swallows it.** The paragraph above's "Not built in this ticket" note left a
gap this addendum closes: `hermes-gateway`'s fix only reaches the ERP because THREE more hops now
carry the same two additive fields, unchanged in shape end to end.

- **`ai-gateway-go` (the missing hop — platform-nest never talks to hermes-gateway directly).**
  `internal/providers/provider.go`'s `SessionStreamingProvider.CompleteStreamSession` and
  `internal/providers/hermes.go`'s `parseHermesSSE`/`CompleteStreamSession` widen `onSession`'s
  signature to `(session string, resumed bool, requestedSession string)` — parsed off
  hermes-gateway's own `event: session` frame with `resumed` read as a `*bool` so a genuinely
  ABSENT field (an older hermes-gateway build) is distinguishable from an explicit `false` and
  defaults to `true` ("assume fine, never assume failed" — the ticket's own mandate, not a guess
  made up here). `internal/server/server.go`'s `sessionPayload`/`writeSSESession` widen this
  gateway's OWN outer `event: session` frame the identical way — `Resumed` is always present (no
  `omitempty`: a consumer must be able to tell "this build reports it, and it's true" from "this
  build has never heard of the field"), `RequestedSession` is `omitempty` (absent whenever nothing
  was requested, mirroring `ProviderSession`'s own never-invented discipline). Both fields are
  captured in the SAME `onSession` closure firing as `session` itself inside the `/complete/stream`
  handler and reset together (never independently) on the mid-stream-failover discard path, so a
  discarded attempt's mismatch can never leak into the winning attempt's frame. Tests:
  `internal/providers/hermes_test.go` (absent-on-the-wire defaults to `resumed: true`; a real
  `resumed: false` + `requestedSession` relays verbatim; a genuine `resumed: true` WITH a
  `requestedSession` present is distinguished from the no-resume-requested default-true case) and
  `internal/server/server_routing_test.go` (`TestCompleteStreamRelaysResumedFalseEndToEndThroughTheRoute`
  — a fake hermes-gateway shim scripts the exact `resumed:false` wire shape and this gateway's OWN
  outer wire is asserted to carry it through, still with a clean `event: done` and no
  `event: error`). Full `go test ./internal/server/... ./internal/providers/... ./internal/chain/...`
  green via `wsl.ps1` (Smart App Control blocks a native host build, per this repo's standing note).
- **`platform-nest/src/modules/assistant/stream.ts`** — `GatewayStreamEvent`'s `session` variant
  and `parseGatewayStream`'s `"session"` case now read `resumed`/`requestedSession` off
  ai-gateway-go's frame the same absent-tolerant way (a malformed or missing `resumed` on THIS
  wire also defaults to `true`, so an ai-gateway-go build that predates this rollout is safe too —
  the compatibility chain holds at every hop, not just the first one). `RelayEmit.session` and
  `RelayResult` grow `sessionResumed?: boolean` / `requestedSession?: string`, captured in
  `relayGeneration` alongside the existing `metaProviderSession` capture and returned on every exit
  path (done/error/abnormal_drop/catch) — `undefined` together whenever no session event ever
  arrived, exactly mirroring `providerSession`'s own convention. New persistence helper
  `sessionResumeMismatchParts(result)` returns `[]` for `sessionResumed !== false` (covers `true`
  AND `undefined` in one guard — the ticket's explicit "absent must never read as a failure"
  requirement) and a single `{ type: "session_resume_mismatch", requestedSession }` part
  otherwise, appended into the SAME `parts` jsonb column ASST-12's `usageMetaParts`/ASST-18's
  `citationParts` already write to (migration 0079's `parts jsonb`, no schema change needed —
  the established convention this ticket follows, not a new one).
  `assistant.controller.ts`'s persist block appends `...sessionResumeMismatchParts(result)` next to
  the two existing part-builders; **ASST-16's `hermes_session_id = COALESCE($2, hermes_session_id)`
  UPDATE is completely untouched** — a forked session is still the live one going forward, so it is
  still what gets persisted and resumed on the NEXT turn, mismatch or not. The controller's
  `session: () => {}` no-op emit callback (unchanged — see the ASST-16 addendum above for why the
  raw Hermes token was never relayed onto the BROWSER-facing wire) stays a no-op: the new fields are
  captured on `RelayResult`, read straight off it after `relayGeneration` returns, never threaded
  through that closure. Tests: `stream.test.ts` (parsing: absent defaults true, explicit false +
  requestedSession, explicit true + requestedSession present; `sessionResumeMismatchParts`'s three
  cases) and `assistant-stream.test.ts`'s new `SIMULATE_HERMES_FORK` fake-gateway branch + "ASST-24"
  nested describe (resumed:false persists AND survives a completely separate refetch — not just
  live state — while `hermes_session_id` still updates to the FORKED id, not the stale original;
  resumed:true renders nothing; the absent-fields/older-gateway case renders nothing) — 20/20 green
  in that file, 105/107 across the whole `assistant/` suite (2 pre-existing skips, unrelated).
- **`platform-ui`** — `lib/assistant.ts`'s `parseSessionResumeMismatch(parts)` mirrors
  `stream.ts`'s `SessionResumeMismatchPart` byte-for-byte (the same "read the persisted fact, never
  re-derive it" discipline `parseUsageMeta`/`parseCitations` already established), returning `null`
  for every case that renders as nothing — a genuine resume, turn 1, an older gateway, or a message
  that predates this ticket. **Deliberately READ-ONLY, persisted-only — there is no live-stream
  counterpart**: the backend's own `session` event was never relayed onto the browser-facing SSE
  wire (by ASST-16's own design), so this note only appears once the transcript reloads after the
  turn's terminal state, the same "refetch after done" path ASST-12's badge/meter already rely on.
  `components/assistant/Message.tsx` renders it as a quiet, honest, non-error note — "Hermes
  couldn't resume the previous conversation and started a new one" — directly below the citation
  chips, styled by `assistant.css`'s new `.asst-msg__session-note` (reuses the existing
  `--ink-subtle` token, no new colour literal, no `--status-danger` — this is an informational
  note, not a failure state, per the ticket's own framing: the reply itself was valid). Never shown
  on the row currently streaming in the caller's own tab (`sessionResumeMismatch` is `null` while
  `streaming` is true) — it only ever appears on a finalized row, exactly matching where the fact
  actually lives. Tests: `lib/assistant.test.ts`'s new `parseSessionResumeMismatch` describe block.
  Baselines: `tsc --noEmit` clean, full `npm test` 1171/1171 green (was ≥1168), `DEMO_MODE=1 npm run
  build` exits 0.

### ASST-17 — tool broker under the CHATTING USER's principal (Phase 3 core, 2026-08-05)

`modules/assistant/broker.ts` (new) + the tool-turn branch in `assistant.controller.ts`'s stream
route. **Supersedes** the ASST-06 bullet above that says "Tool-call
(`tool_call`/`tool_result`/`approval_required`) SSE events are Phase 3 — this ticket's relay never
emits them": they are emitted now, on the tool-turn path only. A plain chat turn's wire is
byte-identical to before this ticket.

**THE AUTHZ PROPERTY THIS SURFACE RESTS ON — read before touching anything here.** Reading an agent
*run transcript* elsewhere in this platform is `isElevated`-only *by design*
(`admin/intelligence.controller.ts`), because a transcript can contain tool output fetched under the
triggering user's authority. **A chat thread IS a transcript.** The assistant is safe for ordinary,
non-elevated users only because two things hold *together*: threads are owner-private with no admin
bypass (ASST-02), **and** every tool executes under the **chatting user's own Cerbos principal** —
never a service principal, never an ambient/elevated one. Break the second and the first stops
mattering. Structurally, there is exactly ONE function that can spell an OBO envelope in this
surface (`broker.ts`'s `oboEnvelopeFor`); it takes the chatting user and nothing else, hard-codes
`provider: "platform"`, and throws (`ServicePrincipalRefusedError`) on anything that is not a real
user uuid. Do not add a second envelope spelling.

- ✅ **`POST /api/:t/assistant/threads/:id/messages`** gains two OPTIONAL fields:
  `mode?: 'chat' | 'tools'` (default `chat`) and `agent?: string` (default `status-reporter`; must
  be a key of `broker.ts`'s `ASSISTANT_AGENT_TOOLS` — an unknown agent is a **400 at send time**,
  not a mid-stream surprise). A tool turn records the fact on the PLACEHOLDER ROW, inside the
  existing `parts` jsonb, as `[{type:'turn_mode',mode:'tools',agent}]` — the same "no schema change
  needed" move ASST-12 made for `usageSource`. **The returned `streamUrl` gains `&mode=tools` as a
  CLIENT CONVENIENCE ONLY: the stream route reads the mode off the ROW, never off its own query
  string** — an `EventSource` URL is client-controlled, so reading `?mode=` there would let a client
  flip a turn the server never accepted as a tool turn.
- ✅ **`GET .../stream`** emits three ADDITIVE, **non-terminal** frames on the tool path (a turn
  still ends with exactly one `done` or one `error`, so stream-end-without-`done` remains an ERROR,
  unchanged):
  - `event: tool_call` — `{callId, toolName, args}`. **`args` is ALWAYS the redacted shape**, never
    raw values (see redaction below).
  - `event: tool_result` — `{callId, toolName, status: 'succeeded'|'failed'|'denied', summary}`.
  - `event: approval_required` — `{callId, toolName, approvalId, impact}`. The D14 write-proposal
    surface (blueprint §7): the broker **never executes** a suspended write; D14's own resume path
    does, under the requester's authority. Terminal outcome for such a turn is `error` +
    `errorKind: 'approval_required'`, with the runner's own suspension text as the message content.
  - `errorKind` additions on the tool path: `tool_denied` (the capability gate refused),
    `not_configured` (`AGENTS_URL` unset), `runner_busy` (429), `runner_error`, `unknown_agent`,
    `no_authority`, plus the runner's own `errorKind` passthrough (e.g. `ToolNotAllowedError`).
  - The answer arrives as **ONE `token` frame**, not a synthesized cadence: the agent-runner is a
    queued service with no incremental output (ai-agents design §3.2). Faking a token cadence would
    be the same class of dishonesty as ASST-12's estimate-labelled-as-a-measurement. `meta` carries
    the run's reported provider with `model: ""`; `usage` is always `source: 'estimate'`.
- ✅ **Two walls, both under the user's own principal.**
  **Wall 1** (`broker.ts`, before a goal exists): the broker asks the hub `tools/list` **under the
  user's own OBO envelope**; the hub answers `visibleToolsFor(principal)`, Cerbos-authoritative. Any
  tool the turn needs that this user cannot see is REFUSED in-thread — typed `tool_denied`, a
  `denied` `assistant_tool_calls` row, and **the goal is never POSTed at all**, so nothing runs
  anywhere under any principal. Fails **closed** in every direction: an unconfigured, unreachable or
  unparsable hub yields an empty visible-tool set ⇒ refuse. A hub we cannot reach is not evidence
  that the user is authorized.
  **Wall 2** (mcp-hub, unchanged): every `tools/call` is re-authorized under the same principal, and
  platform-nest re-checks Cerbos + RLS behind it. Wall 1 is an early honest refusal; wall 2 is the
  authority.
- ✅ **`assistant_tool_calls` persistence** (migration 0079, no new migration): written in the SAME
  transaction as the assistant message it belongs to — a visible tool chip whose row never landed
  (or vice versa) is a transcript that lies about what ran. `authority_user_id` is **always the
  chatting user**, passed as its own required parameter and re-validated inside `persistToolCalls`
  (`ServicePrincipalRefusedError` on anything that is not a user uuid; the column's own
  `REFERENCES users(id)` is a second wall).
  **`args` redaction** (0079's column comment, "REDACTED before persist (app layer)" — this is that
  layer): `redactToolArgs` preserves the SHAPE (key names at every depth, arrays collapsed to
  `[redacted:array(n)]`, nesting capped at depth 4) and destroys every VALUE (`[redacted:string]`,
  `[redacted:number]`, …). An auditor needs to know which tool ran with which argument *names*;
  nobody needs the values, and the values are exactly what could carry PII/secrets. Honest scope
  note: on the runner path the broker never even SEES raw arguments (the runner's step transcript
  records `"<tool> ok"`/`"<tool> failed"` and no args), so those rows carry `{}` — the one place real
  arguments reach this process is a suspended write's `automation_approvals.tool_args`, and that is
  where the redaction actually runs. Do NOT "improve" this by teaching the runner to report raw
  args: the current split means the agents database never holds them either.
- **Do NOT close the agent/registry impact drift by widening `mcp-hub/src/policy.ts`'s
  `isAutomation` branch to all principals.** It would push every human/OBO medium+ write into D14
  suspension and break this broker's ordinary read path. The human write half is §7's proposal model
  plus D14's approvals surface, which this broker *consumes*, not re-implements.
- Reading a run transcript **server-side inside the broker** is not the elevated-only read the
  intelligence controller guards: that rule protects an admin from reading through a *different*
  user's authority. This run executed under THIS user's envelope and its output is relayed into THIS
  user's own owner-private thread — the transcript goes exactly where it was already permitted to go.
  (The same argument ASST-21 will make for handoff runs.)
- No new Cerbos policy or action: a tool turn runs inside `assistant_thread`'s existing `stream`
  action (ASST-02), which is already owner-only. That deliberately avoids the "a NEW policy file is
  not hot-reloaded over the Windows bind mount, and an unlisted kind is a SILENT DENY" trap.
- Deliberately **NO** `writeActivity()`/`notify()` on any of this (same reasoning as ASST-05/06):
  the tenant activity feed is member-readable and would leak private thread content.
- Tests — `modules/assistant/assistant-broker.test.ts` (16 tests, live PG + Cerbos + a recording
  fake hub and fake agent-runner). The load-bearing ones, and why each is shaped the way it is:
  - **the Phase-3 gate** — a tool turn's rows are attributable to the chatting user, AND the runner
    was invoked with `envelope {provider:'platform', externalId:<chatting user>}` / `requestedBy` the
    same, AND the hub's visibility call carried that user's OBO headers. The `Bearer` on both hops is
    asserted explicitly as the *transport* credential, so the "token ≠ authority" distinction is
    recorded in a test rather than only in a comment.
  - **the refusal, on BOTH halves** — the typed/visible in-thread refusal *and*
    `runner.receivedGoals === 0`. Asserting only "the user saw an error" would pass in exactly the
    world this ticket exists to prevent (the call ran under the wrong principal and merely reported a
    failure). Verified load-bearing by deliberate mutation: patching the broker to still emit the
    refusal while submitting the goal anyway fails on the zero-requests assertion alone.
  - **live tenant data, scoped to that user** — the fake runner performs a REAL
    `GET /api/:t/projects` under the envelope it was handed, and the streamed answer contains a
    project row inserted by that test run (so it cannot be a fixture); the same endpoint with the
    same service token but a DIFFERENT verified user's envelope returns **403**, which is what rules
    out an ambient read.
  - **owner-private end to end after a tool turn** — a same-company `member` and a `company_admin`
    are both 403 on thread read, on send, and on opening the stream URL, and the thread is absent
    from their list.
  - **a table-wide sweep** — `SELECT DISTINCT authority_user_id … WHERE tenant_id = A` is exactly the
    set of humans who chatted, and never the `kind='service'` account seeded alongside them.
- **⬜ Still PENDING after this ticket:** `GET /api/:t/assistant/capabilities` (ASST-18 — reuse
  `broker.ts`'s `listUserVisibleTools`, which is already the "under the user's own envelope" reader
  that panel needs), the `/assistant` UI's tool-chip rendering for the three new frames, and
  per-tool-call `duration_ms`/`args` fidelity, which would need the ai-agents runner to report richer
  tool steps than `"<tool> ok"` — deliberately NOT done here (see the redaction note above).

### Capabilities panel + knowledge citations (ASST-18, 2026-08-06)

Closes the "still PENDING" bullet directly above for `GET /api/:t/assistant/capabilities`, and adds
the RAG-retrieval/citations half of blueprint §8 (right-rail "capabilities" list, the empty-state
capability cards, and knowledge citation chips under a grounded reply).

- ✅ **`GET /api/:t/assistant/capabilities`** (`modules/assistant/capabilities.ts`) —
  `visibleToolsFor(user) ∩ tenant's module gates`, literally: `broker.ts`'s new
  `listUserVisibleToolDefs` (a refactor of the existing `listUserVisibleTools` — same fetch, same
  fail-closed posture, now also returning `description`) asks the hub under the CALLER'S OWN OBO
  envelope, and this file intersects the result with `allModules()[].mcpTools[].name` ownership ∩
  `enabledModuleKeys(tenantId)`. Response `{ tools: [{name, description, module}], hubConfigured }`.
  `module` is `null` for an ungated platform-core tool (most of them — see the file's own header on
  why the hub's `source` tag is NOT a module key). `hubConfigured` distinguishes "the hub isn't set
  up in this environment at all" from "configured, and this user genuinely has none" — both
  currently collapse to the same empty `tools` array, so this flag is what lets the panel word its
  empty state honestly instead of guessing. **No new Cerbos resource/action** — the result is
  inherently self-scoped (always and only the caller's own envelope) and the hub/Cerbos re-authorize
  every tool again before anything runs; there is no parameter here that could widen whose
  capabilities come back.
- ✅ **UI: `CapabilityCards`** (`components/assistant/CapabilityCards.tsx`) is the ONE component that
  fetches + renders this endpoint's result, consumed by BOTH `CapabilitiesPanel` (the right-rail
  panel, toggled the same way `MemoryPanel` is — one of the two occupies the shared right-rail grid
  column at a time) and `ThreadView`'s empty state (blueprint §8: "Empty state: capability cards —
  doubles as the discoverability answer"). Grouped by the tool name's dot-prefix
  (`lib/assistant.ts`'s `groupCapabilities`) for display only.
- ✅ **`GET /api/:t/assistant/citations/:sourceRef`** (`modules/assistant/citations.ts`) — resolves
  ONE knowledge-chunk `sourceRef` (erp-source.ts's own `erp:<kind>:<id>` ingestion convention) to a
  navigable `{kind, label, href}`, or a 404 **on purpose** when this file has no honest destination
  for it (a deleted row, an unmapped kind like `report`/`file`, a malformed ref, or a `person`/`org`
  ref whose EMBEDDED tenant id doesn't match the route tenant). Resolvable kinds today: `client`,
  `project`, `task`, `pmtask`/`deliverable`/`pmdoc` (resolve to their containing project — no
  standalone detail route exists yet for those three), `meeting`, `person`, `org`/`orgunits`.
  Gated the same broad way `admin/intelligence.controller.ts`'s `knowledgeSources` proxy is
  (`activity`/`read` — any tenant member).
- ✅ **Context assembly RAG retrieval** (`modules/assistant/context.ts`) — one retrieval per
  generation (BOTH the plain-chat and the tool-turn branch, since both share `assembleContext`),
  reusing `modules/search/knowledge-client.ts`'s `queryPropertyKnowledge` VERBATIM (no second
  retrieval implementation) against the LATEST user message, `aclScope: ""` (matches
  erp-source.ts's own `acl = []` convention for internal ERP documents — "every member of this
  tenant"). Fail-soft by construction (`queryPropertyKnowledge` already degrades to `[]` on any
  error; this file also wraps the call in its own `try/catch` in case a test double throws) — an
  unreachable/unconfigured knowledge service narrows THIS turn's grounding, never fails the turn.
  `config.assistant.knowledgeTopK` (env `ASSISTANT_KNOWLEDGE_TOPK`, default 4; `0` disables
  retrieval outright) caps how many chunks are requested. Citations are appended to the prompt as a
  "cite as [1], [2], …" block and returned as `AssembledContext.citations` (always an array).
- ✅ **Wire + persistence**: a new NON-TERMINAL SSE event `citations` (`{items:[{sourceRef,text}]}`),
  emitted from `assistant.controller.ts`'s `stream()` handler directly (not through
  `stream.ts`'s `relayGeneration` — ASST-16's brain-picker/session code is untouched) the instant the
  stream opens, before the first `token` (context assembly, including retrieval, already finished by
  then). Persisted onto the finalized message's existing `parts` jsonb via a new `citationParts()`
  helper (`stream.ts`), mirroring `usageMetaParts`'s "no schema change needed" shape — `[]` (not an
  empty-items marker) for a turn that used no grounding, so an ordinary chat turn's `parts` is
  byte-identical to before this ticket. UI: `lib/assistant.ts`'s `parseCitations` reads it back;
  `StreamState.citations` carries the live value while streaming (same "live-then-persisted" split
  ASST-12's badge/meter already use). Rendered by `components/assistant/CitationChips.tsx` under an
  assistant bubble — **a chip is NEVER a plain `<a href>`**: clicking it calls
  `resolveCitationAction` → the citations endpoint FIRST, and only navigates to the href the backend
  just re-verified still exists; an unresolvable ref renders a disabled "Source unavailable" chip,
  never a link that 404s.
- **Module gating note**: `assembleCapabilities`'s module-ownership map comes from
  `allModules()[].mcpTools[].name` — a tool NOT registered via any `ModuleContract.mcpTools` (every
  `platform-read`/`platform-write`/core tool the hub itself serves, e.g. `projects.list`/
  `tasks.list`, and the two tools `ASSISTANT_AGENT_TOOLS` already drives a turn with) passes through
  UNGATED regardless of tenant module toggles — that is correct, not a gap: those tools were never
  owned by a toggleable module in the first place, so there is nothing to gate them against.
- Tests — `modules/assistant/assistant-capabilities.test.ts` (6 tests: the two-user SET-DIFFERENCE
  assertion — an unauthorized tool is absent from the array, not present-and-disabled — module
  gating across two tenants with the SAME user and SAME hub answer, hub-unreachable vs
  hub-not-configured-at-all as two distinct honest states, and per-caller OBO headers reaching the
  hub) and `modules/assistant/assistant-citations.test.ts` (5 tests: resolution against real rows,
  the "never resolves a chip that would 404" negative sweep — deleted row / unknown kind / malformed
  ref / cross-tenant ref forgery — and an end-to-end run: a fake knowledge service names a REAL
  project row, the stream emits `event: citations` carrying that exact ref before `done`, the
  persisted message's `parts` carries the same fact on reload, and resolving that exact chip returns
  the project's real href).
- **UNVERIFIED note**: citation resolution was proven end-to-end against a FAKE knowledge service in
  this test environment (no live pgvector/embedding stack reachable from this sandbox) — the SQL
  query shape, the SSE frame, the persistence, and the resolve-then-navigate UI flow are all real and
  tested; whether the LIVE WS8 knowledge service (on a deployed box, with real ERP documents actually
  ingested) returns retrievable hits for a real user query is not verified by this ticket and should
  be checked against a live environment before relying on it.

### Agent roster + handoff to a goal run (ASST-21, 2026-08-06)

blueprint §8's "agent roster" line + D-B ("one Hermes front door + a visible agent roster — hand a
longer task to a specialist," deliberately NOT per-department personas).

- **THE AUTHZ DESIGN PIN (binding — read this before touching either read gate)**: a handoff runs
  under the CHATTING USER's own OBO envelope — `broker.ts`'s `oboEnvelopeFor`, the ONE function in
  this codebase that can spell one, reused VERBATIM by `modules/assistant/handoffs.ts::createHandoff`
  (the SECOND caller of it, after the broker's tool turns). That is what makes the run's transcript
  SAFE for that same owner to read back: it is output fetched under their OWN authority, not an
  elevation. So a NEW, ADDITIVE Cerbos rule (`cerbos/policies/resource_agent_run.yaml`, a brand-new
  `agent_run` resource kind) lets the triggering owner read a run with `origin='assistant_handoff'`
  — and `admin/intelligence.controller.ts`'s pre-existing `isElevated(req)` gate on `GET
  :t/agents/runs/:runId` is **completely UNCHANGED**: it is checked FIRST, exactly as before, and the
  additive Cerbos check only runs when it was false, and even then only allows through when
  `modules/assistant/handoffs.ts::fetchHandoffByRunId` says THIS runId is a handoff THIS caller
  triggered. A non-handoff run (or a handoff run some OTHER user triggered) still 403s a non-elevated
  caller exactly like before this ticket — proven by a REGRESSION test in `admin/intelligence.test.ts`
  reusing the SAME `run-1` fixture the pre-existing "run transcript is elevated-only" test already
  covers, plus a second regression case in the ASST-21 describe block itself.
- ✅ **`POST /api/:t/assistant/threads/:id/handoff`** (`modules/assistant/assistant.controller.ts`'s
  `handoff()`, `modules/assistant/handoffs.ts::createHandoff`) — owner-only, same Cerbos resource as
  every other thread action: `resource_assistant_thread.yaml` gained ONE additive action
  (`"handoff"`, appended to the existing owner-only rule's `actions` list — an EDIT to an EXISTING
  file, hot-reloads live, no container restart). Body `{agent, goal}`; `agent` is validated against
  the RUNNER'S REAL registry (`GET /agents` on the runner — see below), never a hardcoded list — an
  unknown name 400s naming the real ones. Mints the OBO envelope via `oboEnvelopeFor({userId: owner,
  tenantId})`, upserts the platform self-link (`ensurePlatformSelfLink`, same as the broker), POSTs
  `/goals` to the runner with that envelope + `requestedBy`, and persists a NEW `assistant_handoffs`
  row (migration `0084_assistant_handoffs.sql`) linking `thread_id` -> `goal_id`, with
  `owner_user_id` = the chatting user (redundantly, not just derivable via the thread join, so the
  additive Cerbos check never needs a second table). Response `{id, goalId, status}`. Supervisor
  fan-out is deliberately NOT offered here (one handoff -> at most one run; a supervisor goal can fan
  out into several, which the run-linking model doesn't support). **No `writeActivity()`/`notify()`**
  on the write (same reasoning as ASST-05/06 — the shared tenant feed must never learn a private
  thread exists).
- ✅ **`GET /api/:t/assistant/threads/:id/handoffs`** (`listHandoffs()`,
  `handoffs.ts::listHandoffsForThread`/`refreshHandoff`) — the run-watch view's one read. Owner-only
  (same thread `"read"` action, unchanged). LAZILY syncs each non-terminal row from the runner's own
  `GET /goals/:goalId` before returning — `run_id` (NULL while queued/running) is filled the moment
  the runner reports a run, which is the cue the UI uses to know `GET :t/agents/runs/:runId` (now
  additionally owner-readable) has something to show.
- ✅ **`GET /api/:t/assistant/agents`** (`roster()`, `handoffs.ts::fetchRoster`/`fetchEpisodicHistory`)
  — the roster panel's one read: `{agents, supervisor, runnerConfigured, episodicHistory}`. `agents`
  comes from a NEW runner endpoint, `GET /agents` (`ai-agents/src/runner/service.ts`), which reflects
  `AgentRegistry.specialists`/`writeSpecialists` LIVE (`{name, tools, maxSteps, maxToolCalls,
  writeCapable, evaledProviders}`) — never a hand-maintained mirror (unlike `broker.ts`'s
  `ASSISTANT_AGENT_TOOLS`, which stays a deliberately narrow read-only-agent mirror for the TOOL-TURN
  gate only, untouched by this ticket). `episodicHistory` comes from a NEW runner endpoint, `GET
  /episodes?tenant=&runIds=` — narrowed by the run ids THIS caller's OWN `assistant_handoffs` rows
  name, never a bare "give me this tenant's whole history": an `Episode` (`ai-agents/src/memory/
  episodic{,-pg}.ts`) carries a `tenantId` but NO owner/user column, so `EpisodicStore.query`/
  `PgEpisodicStore.query` gained an ADDITIVE, optional `runIds` filter (omitted = unfiltered, byte-
  identical to pre-ASST-21 behaviour) — the caller-supplied id SET is what turns "tenant-wide" into
  "this user's own." Self-scoped by construction, same reasoning as `capabilities()`: no parameter
  here could widen whose history comes back. `runnerConfigured:false` (not an empty list) is the
  honest "the runner isn't reachable" state, same convention as ASST-18's `hubConfigured`.
- ✅ **UI**: `components/assistant/RosterPanel.tsx` — a FOURTH right-rail panel joining the SAME
  one-at-a-time slot as Memory/Capabilities (`AssistantWorkspace`'s `rightRailOpen` gate widened to
  `memoryOpen || capabilitiesOpen || rosterOpen`). Renders the registry, a "hand off to a specialist"
  form (agent picker sourced from the SAME `GET :t/assistant/agents` read — never a second list), THIS
  thread's own handoffs (the run-watch view — polls every 4s via `lib/assistant.ts::hasActiveHandoff`
  while any handoff is non-terminal, stops the instant all are terminal), and episodic history.
  "View transcript" on a handoff with a `runId` is LAZY (fetched only on click, via
  `getHandoffTranscriptAction` → the SAME `lib/admin.ts::getAgentRun` the Intelligence console
  already uses against `GET :t/agents/runs/:runId` — no second reader implementation) — a transcript
  can be long, so it is never auto-loaded for every row.
- **Schema**: `assistant_handoffs` (migration `0084_assistant_handoffs.sql`) — `id, tenant_id,
  thread_id (composite FK -> assistant_threads, CASCADE), owner_user_id, agent, goal_text, goal_id
  (uuid, no FK — separate ai-agents DB), run_id (uuid, no FK, nullable until the runner reports one,
  UNIQUE when present), status, outcome, error_kind, approval_id (no FK, mirrors
  assistant_tool_calls.approval_id)`. Same composed `tenant_isolation` RLS policy (mod='assistant') as
  every other assistant_* table (0079's pattern).
- **Cerbos**: `resource_agent_run.yaml` is a BRAND-NEW resource kind/file — it needed a
  `docker restart gaiada-test-cerbos` (+ health wait) before its tests could pass; a `matchedPolicy`
  smoke check (`rbac/cerbos-agent-run.test.ts`) proves the owner-ALLOW path resolves for real, not a
  uniform silent deny. `resource_assistant_thread.yaml`'s edit (adding `"handoff"` to the existing
  rule's action list) needed NO restart — same file, hot-reloads live.
- **`fetchHandoffByRunId` fails closed on a malformed runId, not a 500**: `assistant_handoffs.run_id`
  is a `uuid` column; a non-uuid `:runId` path param (client-supplied, unvalidated upstream) short-
  circuits to `null` BEFORE the query — otherwise Postgres's "invalid input syntax for type uuid"
  would turn a plain "not a handoff, fall through to elevated-only" into a 500 instead of a clean 403.
  Caught by this ticket's own regression tests re-using the pre-existing `run-1` (non-uuid-shaped)
  fixture id in `admin/intelligence.test.ts`.
- Tests: `modules/assistant/assistant-handoff.test.ts` (8 — the write side: envelope assertion
  against the exact body the fake runner received, owner-only create/list, unknown-agent 400 naming
  the real registry, no writeActivity/notify, roster reflects the fake runner's real registry,
  episodic history narrowed to the caller's own run ids), `admin/intelligence.test.ts`'s new "ASST-21:
  handoff-owner additive carve-out" block (5 — owner CAN / different same-company user CANNOT /
  company_admin CANNOT / a runId with no handoff row still 403s / the regression guard restated with
  this suite's own elevated principal), `rbac/cerbos-agent-run.test.ts` (8 — the Cerbos policy in
  isolation, incl. the matchedPolicy smoke check and an explicit "wrong origin still denies" probe),
  plus additive unit tests in `ai-agents/src/memory/episodic{,-pg}.test.ts` and
  `ai-agents/src/runner/service.test.ts` for the `runIds` filter and the two new runner endpoints.
- **CLOSED 2026-08-07** (was: "Deferred, out of this ticket's scope") — see the new dated addendum
  below, "Closing the handoff confirm-chip bypass". A suspended handoff run now surfaces IN the
  thread transcript itself, via the SAME confirm-chip machinery T3b built for the chat path.

### T3a — the broker's first write turn: registry gate + write-tool mirror + card-state join (ASST-23, 2026-08-06)

Implements the platform-nest half of `docs/superpowers/plans/2026-08-06-asst-23-unblock-design.md`
§7.4/T3a — the owner's OQ-1/OQ-2 override of the original ASST-23 design (§2). **T3a is scoped to
this repo only and codes against a FAKE runner** (the real `task-filer` AgentDef is `ai-agents`' T2,
a separate ticket in a separate standalone project — see CLAUDE.md). Everything below lands
independently of T2 and is provably safe to ship first: a turn naming `task-filer` today reaches a
real runner that doesn't know that name yet (a `runner_error`/404 from the real agent-runner,
unchanged failure shape) rather than anything worse.

**Explicitly NOT this ticket** (owner's §7.2 override, T3b/T2b's scope): the in-thread confirm chip,
`assistant_write_intents`, the confirm/dismiss endpoints, `fileOnSuspend`, and the Cerbos
`confirm_write` edit. The flow below is `approval_required` exactly as ASST-17 already shipped it —
a write turn suspends and FILES immediately (no confirmation gate yet); T3b adds the chip on top of
this without changing anything documented here.

- ✅ **`ASSISTANT_AGENT_TOOLS` gains `"task-filer": ["projects.list", "tasks.list", "pm.createTask",
  "pm.createDoc"]`** (`modules/assistant/broker.ts`) — mirrors `ai-agents/src/specialists.ts`'s
  `writeSpecialists.task-filer` (T2). Both v1 write tools ship together per the owner's OQ-1 answer
  (§7.1: "both now") — `pm.createDoc` is not a fast-follow.
- ✅ **NEW `ASSISTANT_AGENT_WRITE_TOOLS: Record<string, readonly string[]>`** — the WRITE subset of
  the map above, per agent (`{"task-filer": ["pm.createTask", "pm.createDoc"]}` today). An agent
  absent from this map (every read-only one) is read-only in exactly ASST-17's original sense.
- ✅ **NEW — step (0.5), THE REGISTRY GATE, runs BEFORE wall 1** (`runToolTurn`, `broker.ts`): every
  tool in `ASSISTANT_AGENT_WRITE_TOOLS[agent]` must have a registered `core/approval-executables.ts`
  entry (`getExecutable(name) !== undefined`) or the turn is refused — typed
  (`errorKind: "tool_not_executable"`), a `denied` `assistant_tool_calls` row per offending tool, and
  **the runner is never contacted** (same "provably nothing ran" shape as wall 1's own refusal).
  This is a platform-registry question ("if this agent proposes this write, does anything exist that
  could ever execute it"), deliberately distinct from wall 1's Cerbos question ("may this user call
  this tool") — getting it wrong in the permissive direction would let a write get filed, approved,
  and dead-end at `execution_status='not_applicable'` with nobody told until they read the row; this
  gate surfaces that dead end in-thread, at proposal time, instead. Both of v1's write tools
  (`pm.createTask`/`pm.createDoc`) already have a D14-15 registry entry, so this gate passes for
  `task-filer` today — it exists for the drift case (a future write tool added to the mirror before
  its registry entry lands), proven live by a test that deliberately un-registers both tools first.
- ✅ **`GET /api/:t/assistant/threads/:id` gains per-message `toolCalls[]`** (`assistant.controller.ts`'s
  `getThread`, additive — every existing field on `thread`/`messages` is unchanged):
  ```
  toolCalls: Array<{
    id, toolName, mcpServer, args, resultSummary, status, approvalId, durationMs, createdAt,
    approval: { status, executionStatus, executionError } | null   // null iff approvalId is null
  }>
  ```
  Fetched by a single additive query (`fetchToolCallsByMessage`) LEFT JOINing `assistant_tool_calls`
  to `automation_approvals` on `approval_id = id`, inside the SAME `withTenants([tenantId], …,
  {modules:["assistant"]})` transaction as the message SELECT — no second DB round trip's worth of
  module-scope reasoning needed. **Why the join is legal without widening anything**:
  `automation_approvals`'s own RLS policy (migration 0014) is `tenant_id = ANY(app_current_tenants())`
  ONLY — no module conjunct — so it is readable in this transaction's GUC state exactly as it would be
  from any other core controller; this endpoint only ever surfaces the row's STATUS/EXECUTION fields
  back into a thread the caller already owns (Cerbos already cleared `"read"` on the thread above),
  never the approver's OWN differently-authorized `/approvals/:id` read. `args` here is the ledger's
  OWN already-redacted column (`assistant_tool_calls.args` — ASST-17's `redactToolArgs`), never
  `automation_approvals.tool_args` (the real, unredacted values) — no raw argument value reaches this
  response by construction. Card states this makes derivable on the FE (computed by the FE, not this
  endpoint — it hands back raw facts per the "select the columns you assert on" discipline): a row
  with `approval: null` is a plain read or a wall-1/step-0.5 refusal; one with `approval` set reads
  `approval.status` (`pending|approved|rejected|cancelled`) and, once approved,
  `approval.executionStatus` (`pending|executing|executed|failed|not_applicable`) +
  `approval.executionError`. **The ledger row's own `status` column is NEVER mutated by decide/
  execute** — verified live: `decide()`/`executeApprovedAutomationWrite()` run exactly as they did
  before this ticket, and the join is what makes their effect visible on a re-fetch of the thread.
- ✅ **`GET /api/:t/assistant/capabilities` gains `toolAgents: Array<{name, tools, writeTools}>`**
  (`modules/assistant/capabilities.ts`) — the AUTHORITATIVE agent roster for the composer's tools-mode
  agent picker, sourced directly from `ASSISTANT_AGENT_TOOLS`/`ASSISTANT_AGENT_WRITE_TOOLS` (never a
  hand-maintained FE mirror). Independent of the existing `tools`/`hubConfigured` fields — it is the
  broker's own real roster, not filtered by what the calling user currently sees (the hub/Cerbos still
  decide that per-turn, twice, exactly as before).
- ✅ **`core/d14-17-assistant-write-registry.test.ts` REWRITTEN, not deleted** — its old (A)/
  (A-reverse) pinned "the broker's entire tool universe is read-only, and none of it is registered".
  That pin is now FALSE by design (`task-filer`'s two tools ARE registered, on purpose), so ASST-23
  legitimately supersedes it. The successor invariant, per `broker.ts`'s own "write-map contract"
  header: (A1) every tool named in `ASSISTANT_AGENT_WRITE_TOOLS[agent]` HAS a registered executable;
  (A2) every tool in `ASSISTANT_AGENT_TOOLS[agent]` NOT also in the write map has NO registered
  executable (reads genuinely stay reads); (A3) the write map is always a SUBSET of the full tool
  list. (B)/(C) are unchanged in spirit; (C) is EXTENDED to cover `pm.createDoc`'s
  `origin='agent'` execution (happy path + archived-project refusal), not just `pm.createTask`'s —
  closing the one honest caveat §7.1 named: "both tools covered" had to be made true, not asserted.
- Tests — `modules/assistant/assistant-broker.test.ts` gains two live-PG-+-Cerbos cases: **the
  registry-gate refusal** (both v1 write tools deliberately un-registered via
  `resetExecutableApprovals()`/`registerCoreExecutableApprovals()`, restored in a `finally`; asserts
  the typed refusal, zero runner goals, and a `denied` row per tool — then restores the registry for
  every test after it) and **the card-state join end to end** (a seam-suspended `origin='agent'
  pm.createTask` row → the REAL `POST .../decide` endpoint, as a real `company_admin` → the REAL
  `executeApprovedAutomationWrite()` — no second implementation of either — → a fresh `GET thread`
  shows `approval: {status:'approved', executionStatus:'executed', executionError:null}`; the
  pre-decision fetch is asserted first, against the column DEFAULT (`execution_status:
  'not_applicable'` — decide() has not run yet), not a guessed `'pending'`, so the post-decision
  assertion actually proves a transition rather than a coincidence).
- **Follow-ups this ticket deliberately leaves open** (all named in the design doc, none silently
  dropped): `ai-agents`' real `task-filer` AgentDef + `RERUN_CAPABLE_HIGH_WRITES` allowlist entry
  (T2); the in-thread confirm chip + `assistant_write_intents` (T3b/T2b, §7.2); the FE's tool-chip/
  proposal-card rendering and agent picker consuming `toolAgents` (T4); `AGENT_SERVING_PROVIDER` pinned
  on the deployed box (T6).

### T3b — the confirm-before-file machinery (ASST-23, §7.2, 2026-08-06)

The owner's OQ-2 override (§7.2 of `docs/superpowers/plans/2026-08-06-asst-23-unblock-design.md`):
a chat-path write no longer files an `automation_approvals` row at suspension time. It suspends as a
**draft**, in-thread, and the OWNER explicitly confirms or dismisses it before anything is filed or
any decider is notified. `approval_required` (ASST-17, above) keeps its exact prior meaning — a
FILED proposal — and remains correct for any future `fileOnSuspend:true` caller; it simply no longer
occurs on the chat path's first leg. (Original note, since SUPERSEDED 2026-08-07 — see the dated
addendum below: "and remains correct for handoff-origin suspensions… the handoff click is itself the
explicit consent" — the handoff path now defers filing too; see "Closing the handoff confirm-chip
bypass" below.)

- **Migration `0085_assistant_write_intents.sql`** — new table `assistant_write_intents`
  (tenant-scoped, `assistant`-module RLS, composite FK to `assistant_tool_calls`, zero DML). Holds the
  ONLY durable pre-filing home of the REAL (unredacted) args; NULL from the moment `status` leaves
  `'draft'`, in every direction. See the migration's own header for the full rationale.
- ✅ **`GET .../stream` gains a FOURTH additive, non-terminal frame**: `event: confirm_required` —
  `{callId, toolName, intentId, args, impact, expiresAt}`. `args` is the REDACTED shape (same
  `redactToolArgs`, never raw values — the real args are persisted server-side into
  `assistant_write_intents.tool_args`, keyed by the SAME `intentId`, never sent to the browser).
  Terminal outcome for this turn is `error` + `errorKind: 'confirm_required'` (render as
  awaiting-confirmation, **never** error styling — same rule ASST-17 established for
  `approval_required`).
- ✅ **`POST /api/:t/assistant/threads/:id/tool-calls/:callId/confirm`** and **`.../dismiss`** — new
  endpoints, owner-only (Cerbos `confirm_write` on `assistant_thread`, same rule/condition as every
  other thread action — no admin path). `callId` is the tool call's own id (the `callId` a
  `confirm_required` frame carried, and the `id` a `toolCalls[]` entry carries on GET thread). The
  confirm REQUEST body is EMPTY — no args field exists on this endpoint, deliberately: the server
  files exactly what `assistant_write_intents.tool_args` holds, claimed atomically inside one
  transaction (single-winner `UPDATE … WHERE status='draft' AND expires_at > now()`), never
  re-derived from a request. Both endpoints return the post-action card state directly (no extra
  fetch needed):
  ```
  { intentId, status: 'filed'|'dismissed', approvalId: string|null,
    approval: { status, executionStatus, executionError } | null }
  ```
  A second click (double-click, replay, or a losing racer) gets the row's CURRENT state back as a
  **200**, idempotently — never a second filing, never a second dismiss. Confirming an already
  `dismissed`/`expired` intent (or dismissing an already `filed` one) is a **409** with
  `{error, status}` naming the row's actual current status — a typed refusal, not a silent no-op.
  A `callId` with no draft at all is a **404**.
- ✅ **`GET /api/:t/assistant/threads/:id` — `toolCalls[]` gains `intent: {status, expiresAt} | null`**
  (additive; every ASST-23/T3a field on the same array is unchanged). `intent` is non-null only while
  a row is `draft`/`dismissed`/`expired` — once `approvalId` is set (filed, whether by this confirm
  path or the legacy filed-at-turn-time shape), the EXISTING `approval` join (T3a) takes over and
  `intent` goes back to `null` rather than reporting `'filed'` redundantly. Full card-state set now:
  `awaiting confirmation → sent for approval → approved+executed | approved+failed (an administrator
  can retry) | rejected | approved but not executable`, plus the two terminal-without-filing states
  `dismissed` / `expired`. **Lazy reap, same request**: before this join runs, `GET thread` flips any
  of THIS thread's past-expiry `draft` rows to `expired` (and scrubs `tool_args`) in one UPDATE — no
  background job anywhere in this feature.
- **Filing extraction** (`core/approval-filing.ts`, new) — `automation-approvals.controller.ts`'s
  `create()` body (INSERT + activity log + decider notification) is now `fileAutomationApproval()`;
  `create()` is a thin wrapper calling it. The confirm endpoint's atomic claim calls the lower-level
  `insertAutomationApprovalRow()` (same INSERT, on the confirm transaction's own connection) directly,
  so a confirm-filed row is **byte-for-byte shape-identical** to a runner-filed or n8n-filed one —
  `origin='agent'`, `workflow_id` = the agent name, `requested_by` = the CHATTING USER (never the
  approver — this is what keeps the D14 executor's re-drive principal and `resolve-and-execute`'s
  `requested_by` gate intact) — the matching/executor/grant chains downstream need zero changes. The
  n8n path (`create()`) is unaffected in behaviour, only the code that runs it moved.
- **Config** — `ASSISTANT_INTENT_TTL_MS` (default 1h). Purely a raw-args retention bound; correctness
  (can this write still legally happen) is re-checked at EXECUTION time by the registry precondition,
  never by this value.
- **No new SSE frame for dismiss** — a dismissal is only ever the RESULT of the owner's own
  `POST …/dismiss` call, so its outcome arrives in that call's HTTP response, not on the stream (the
  stream may not even be open by the time a human clicks dismiss on a reloaded thread).
- **Explicitly unaffected**: `wf:report`'s n8n `pm.createTask` path (still executes unattended,
  `create()` byte-identical); D13 (provider gate, unchanged — the consult still happens inside the
  runner's goal, before the confirm machinery exists); the transcript-redaction invariant (the
  `confirm_required` frame and every GET carry redacted args + `intentId` only, exactly like
  `approval_required`'s existing rule). (Original note, since SUPERSEDED 2026-08-07 — the handoff
  endpoint no longer "still files directly": see "Closing the handoff confirm-chip bypass" below.)

### T4 — platform-ui: event grammar + proposal card + tools-mode composer (ASST-23, §7.4, 2026-08-06)

Pure FE work — no new backend endpoint; this section records how the FE now CONSUMES every shape
T3a/T3b already defined above (per platform-ui/CLAUDE.md's "update the relevant § when you add or
change a consumed endpoint" rule).

- ✅ **`lib/assistant.ts`** decodes all four tool-turn SSE frames (`tool_call`/`tool_result`/
  `approval_required`/`confirm_required` — previously decoded to `null`, pinned by
  `lib/assistant.test.ts`'s old ":105" case; that pin is now inverted onto a genuinely-unrecognised
  event name, not deleted). New types: `ThreadToolCall`/`ToolCallApprovalJoin`/`ToolCallIntentJoin`
  (mirror `assistant.controller.ts`'s `ThreadToolCall` byte-for-byte) and `AssistantMessage.toolCalls?`
  (additive). `StreamState.toolCalls: LiveToolCall[]` accumulates the SSE-live view by `callId`.
- ✅ **`deriveProposalCardState(call)`** is THE trap fix, mechanized: reads `intent` first,
  `approval` second, and only falls back to "not a proposal" (`'plain'`) when BOTH are absent —
  `approvalId` itself is never read as a discriminant anywhere in the FE. Full state set:
  `awaiting_confirmation | sent_for_approval | executing | executed | execution_failed |
  not_executable | rejected | cancelled | dismissed | expired | plain`.
- ✅ **UI**: `components/assistant/ProposalCard.tsx` (the D14 execution chip — Confirm/Dismiss call
  `confirmWriteAction`/`dismissWriteAction`, POSTing `tool-calls/:callId/confirm|dismiss` with an
  EMPTY body, per T3b's own "the confirm request carries no args" invariant; the redacted args are
  rendered via `formatRedactedArgs`, never a real value), `ToolCallChips.tsx` (plain reads/refusals).
  `Message.tsx` partitions a turn's tool calls (`partitionToolCalls`, split on `isWriteProposal`,
  never `approvalId` alone) and suppresses the generic red-error paragraph for
  `errorKind ∈ {confirm_required, approval_required}` — rendered as proposal-pending, **not** error
  styling, and this ticket introduces **no** "approval does not execute" copy (verified none existed
  before it either — nothing to remove, only a requirement not to add one).
- ✅ **`Composer.tsx`** gains the tools-mode affordance (a checkbox + agent `<select>`, sourced from
  `GET :t/assistant/capabilities`'s new `toolAgents` field — never a hand-maintained FE mirror) —
  the first UI path able to send `mode:'tools'`/`agent` at all. `sendMessageAction` only adds
  `mode`/`agent` to the POST body when tools mode is actually engaged; a plain chat send's body is
  byte-identical to pre-T4 (`{content}` only).
- ✅ **Pending-poll**: `AssistantWorkspace` re-fetches the thread (silently — never through
  `loadThread`, which flips the `loading` flag and would blank `ThreadView` on every tick) every 4s
  while `hasPendingProposalDecision(messages)` is true (a card `sent_for_approval`/`executing` —
  i.e. a decision that could land out-of-band, on `/approvals/[id]`, in a different session).
- ✅ **A11y** (VER-03's standing gap rule — not a follow-up): Confirm/Dismiss are real `<button>`s
  with a tool-naming `aria-label` (disambiguates two proposal cards on the same thread), inherit the
  app-wide `:focus-visible` ring via the shared `lux-btn` classes. A proposal card appearing
  mid-stream is not an announcement storm: it mutates at most a handful of discrete times per turn
  (never token-by-token, unlike the typewriter, which is what `aria-live="off"` on the streaming row
  already exists to contain) — the SAME "meta/citations arrive once, non-terminal" precedent ASST-12/
  18 already established for this exact `role="log"` region.
- **DEMO_MODE**: `lib/demoAssistant.ts` gained `toolAgents` on the capabilities fixture, a
  `assistant_write_intents`/`assistant_tool_calls`/automation-approval-lite store set, tools-mode
  send-time validation, and a full tool-turn stream simulation (read-only chip for
  `status-reporter`/`approvals-chaser`, a deterministic `pm.createTask` draft for `task-filer`) plus
  the confirm/dismiss endpoints. **One stated demo-only simplification**: confirming a demo draft
  resolves straight to `approved`+`executed` (mirrors `DemoHandoff`'s own "resolves instantly, no
  fake async loop" convention) rather than faking a separate human-decides-later step against a
  second demo approvals store — sufficient to drive the full card lifecycle in DEMO_MODE/e2e; the
  "a human decides out of band, in a different session" half of the story is a live-stack-only
  proof (T5), not a demo-mode one.
- Tests: `lib/assistant.test.ts` (new decode/reducer/`deriveProposalCardState`/`partitionToolCalls`/
  `hasPendingProposalDecision` cases), `components/assistant/ProposalCard.test.tsx` (8 — button
  presence per state, the confirm/dismiss request shape, the "fresher prop beats a stale local
  override" regression guard), `ToolCallChips.test.tsx`, `lib/demoAssistant.test.ts` (11 — an
  integration test over the real demo dispatcher + the real SSE generator, not further mocked:
  proves send-time 400s, the read-only chip path, the full write-proposal lifecycle including the
  redaction check, double-confirm idempotency, and the 409/404 refusal shapes).

### Closing the handoff confirm-chip bypass (2026-08-07)

`platform-nest` only — no `platform-ui`/`ai-agents` files touched. Full analysis + evidence:
`docs/superpowers/plans/2026-08-07-handoff-confirm-report.md`.

The owner overruled ASST-21/§7.2.5's original scope note ("the handoff click is itself the explicit
consent"): clicking "hand off to a specialist" is consent to RUN AN AGENT, not to ONE SPECIFIC WRITE
with THESE SPECIFIC ARGUMENTS — which is exactly what the confirm chip shows (redacted) before
anything is filed. A separate modal at handoff time would be consent to a blank cheque. The fix
therefore reuses T3b's existing confirm-chip machinery end to end rather than adding a second one.

- ✅ **`POST :t/assistant/threads/:id/handoff`'s goal submission gains `fileOnSuspend: false`**
  (`modules/assistant/handoffs.ts::createHandoff`) — byte-identical body otherwise. A `high_write`
  the specialist proposes now suspends as a DRAFT (never filed) exactly like a chat-path tool turn.
- ✅ **NEW `harvestSuspendedIntent`** (`handoffs.ts`, called from `refreshHandoff` — i.e. on every
  `GET :t/assistant/threads/:id/handoffs` poll): when the polled goal reports
  `status:'suspended'` + a `suspendedIntent`, it writes ONE new `assistant_messages` row (the
  in-thread confirm chip's home), ONE `assistant_tool_calls` row, and ONE `assistant_write_intents`
  DRAFT — the SAME three tables, same shapes, the broker's own chat-path harvest
  (`modules/assistant/broker.ts`'s `runToolTurn`) writes. No new endpoint: the existing
  `POST …/tool-calls/:callId/confirm`/`.../dismiss` and the existing `GET :t/assistant/threads/:id`
  card-state join handle a harvested handoff intent with ZERO changes, because from their point of
  view it is indistinguishable in shape from a chat-turn intent. `ProposalCard` (T4) therefore
  renders it with no FE code change either.
- **Idempotent without a new column**: the synthesized `assistant_tool_calls.id` is the handoff's
  OWN `assistant_handoffs.id` (a different table's PK space — no collision). A goal can suspend at
  most once ever (`ai-agents/src/agent.ts` ends the goal at the first unresolved `high_write`), so
  "does a tool_call with this id already exist" is an exact, race-safe "already harvested" check —
  repolling `GET …/handoffs` never re-harvests. No migration.
- **Locking**: the harvest takes the SAME per-thread advisory lock `sendMessage` uses, extracted
  into a new tiny shared module `modules/assistant/thread-lock.ts` (`ASSISTANT_THREAD_LOCK_NS`/
  `lockAssistantThread`, moved out of `assistant.controller.ts` so `handoffs.ts` can import it
  without a controller↔handoffs cycle) — a concurrent chat turn on the same thread can never
  collide with a handoff harvest on `assistant_messages`' `UNIQUE (thread_id, seq)`.
- **Invariants re-verified for this path specifically** (all hold, same mechanism as the chat
  path): the filing (at confirm time) is attributed to the CHATTING/handoff-OWNING user, never any
  handoff/agent identity; confirm/dismiss stay owner-only (unchanged Cerbos `confirm_write` rule —
  no new authz surface was added); real args live ONLY in `assistant_write_intents.tool_args` until
  confirm, never on the wire (the harvested message's `assistant_tool_calls.args` is
  `redactToolArgs`'d, same as the chat path); unconfirmed intents notify nobody (a suspended handoff
  produces zero `automation_approvals` rows and zero decider notifications — confirmed, live, both
  before AND after a repeated poll); a confirmed handoff-harvested row is byte-for-byte
  shape-identical to a chat-drafted or runner-filed one, so the executor/grant chains need zero
  changes.
- Tests: `modules/assistant/assistant-write-intents.test.ts` gains a new `describe` block (3 cases)
  replacing the old, now-inverted "handoff files directly" pin — `fileOnSuspend:false` is sent;
  a suspended handoff harvests a draft (no filing/notification pre-confirm, real args nowhere on
  the wire, idempotent across a repeated poll) and confirms through the real `decide`-adjacent
  filing path attributed to the owner; a handoff whose goal never suspends harvests nothing (the
  guard is `status==='suspended' && suspendedIntent`, never "this came from a handoff"). Full
  `platform-nest` suite green (typecheck, `lint:withtenants`, `lint:migration-rls`,
  `test:mail-corpus`, `test`) — see the report for the exact run.
- **A found-not-fixed FE gap, reported rather than silently left** (out of `senior-be` scope; no
  `platform-ui` file was touched): `RosterPanel.tsx`'s run-watch poll (`hasActiveHandoff`) refreshes
  ONLY `GET …/handoffs`, never the thread itself, and `AssistantWorkspace.tsx`'s own silent-refresh
  poll only engages once `hasPendingProposalDecision(messages)` is already true (i.e., once the
  harvested message is already IN `messages`). A harvested handoff intent is therefore correctly
  reachable and confirmable, but may not appear in an already-open thread until the user reloads it
  or navigates away and back — a UX-latency gap, not a safety bypass (the backend never files
  without confirmation regardless of when the FE notices). Minimal follow-up: have `RosterPanel`'s
  poll also trigger a silent thread refresh once any handoff's status is `'suspended'`.

---

## 19. Social-media module — SMM · Organic Publishing (SMM-* program, 2026-08-13) — `modules/social/social.controller.ts` — **STATUS: IN PROGRESS (SMM-02/08/19/05 backend built; NO UI yet)**

Design: `blueprints/smm-design.md` as amended by **`blueprints/smm-design-addendum-2026-08-12.md`
(binding)**. Schema `migrations/0105_module_social.sql`; IAM registration `0106` + eight
`cerbos/policies/resource_social_*.yaml`.

**Frontend-first note, stated because this program's recurring bug class is the opposite.** There is
no `platform-ui/src/lib/social.ts` yet and no console route — SMM-11 builds both. The rows below are
the BACKEND as it actually exists today, verified against a live response across
`modules/social/social.test.ts`, `social-ai-drafts.test.ts`, `ai-drafts.test.ts`,
`gateway-client.test.ts`, `media-rules.test.ts` and `canonical-args.test.ts` (87 golden/unit cases).
When the console lands, `lib/social.ts` becomes the canonical shape and this section is reconciled
against it, exactly as §14 was for search.

All routes are under `/api/:tenantId/modules/social`, behind `AuthGuard` +
`ModuleEnabledGuard("social")`. The module is **dark** unless the company has `social` in
`enabled_modules` **or** an ACTIVE `service_assignment` serves `social` to it — for this department
the served path is the normal one (the agency runs social for sibling companies).

| Method + path | Permission (Cerbos `social_engagement`) | Notes |
|---|---|---|
| `GET engagements?clientId=&status=` | `read` | 403 on denial, **never `[]`** — criterion 5 is asserted directly. |
| `POST engagements` | `create` | **Idempotent**: pass a caller-supplied uuid `id`; a retry answers `201 {id, created:false}` rather than 409, because a retry is the point of the key, not an error. |
| `GET engagements/:id` | `read` | Joins the client's brand profile. |
| `PATCH engagements/:id` | `update` | name/status/projectId/ownerId/dates only — **not** scope or budget (see below). |
| `DELETE engagements/:id` | `delete` | Soft delete. |
| `GET engagements/:id/scope` | `read` | Returns `{toolScope, usageBudgetUsd}`, with defaults merged UNDER the stored value so a consumer never sees `undefined` for a toggle that post-dates the row. |
| `PATCH engagements/:id/scope` | **`set_scope`** | Its own permission and its own endpoint: this is the money-and-blast-radius dial. Merges one level deep under `FOR UPDATE`. Returns `{toolScope, usageBudgetUsd, warnings[]}`. |
| `GET brand-profiles/:clientId` | `read` | Config + WS8 knowledge-source POINTERS only — never corpus text, never an embedding (D-13). |
| `PATCH brand-profiles/:clientId` | `update` | Upsert on `(tenant_id, client_id)`; a partial patch does not erase sibling fields. |
| `GET campaigns?engagementId=` / `POST campaigns` | `read` / `update` | `kind` is fixed `'organic'`; `'paid'` is a reserved schema seam, not a parameter. |
| `GET kpi-targets?engagementId=` / `POST kpi-targets` | `read` / `update` | `metricKey` is the canonical set (`followers_total`, `reach_month`, …). |

**Composer surface (SMM-08).** Cerbos kind `social_post`.

| Method + path | Permission | Notes |
|---|---|---|
| `GET posts?engagementId=&status=` | `social.post.read` | Each row carries its variant roll-up (status, schedule, published URL, metered cost) — the calendar as data, without an N+1. |
| `POST posts` | `social.post.create` | Idempotent on a caller-supplied `id`. `source` is `human\|ai\|agent`; `native_import` is NOT settable here. |
| `GET posts/:postId` | `social.post.read` | Post + its variants joined to the account's network and handle. |
| `PATCH posts/:postId` / `DELETE posts/:postId` | `social.post.update` / `.delete` | Delete refuses with `post_has_live_variants` when anything under it is queued/publishing/published — taking a live post down is `delete_published`, a different power. |
| `POST posts/:postId/variants` | `social.post.update` | Returns `{validation, argsSha256, estimatedCostUsd}`. **The network comes from the connector registry, never the request** — a caller cannot claim a different network to dodge its rules. |
| `PATCH variants/:variantId` | `social.post.update` | **Edit invalidates approval**: recomputes `args_sha256`, NULLs `approval_id` and drops `in_review`/`approved` back to `draft`, in the same statement. Answers `approvalInvalidated: true` so the caller learns it immediately. Refuses `variant_native_import_immutable` / `variant_not_editable`. |
| `DELETE variants/:variantId` | `social.post.delete` | Refuses `variant_is_live`. |
| `GET variants/:variantId/validation` | `social.post.read` | Computed **fresh**, not read from the stored column: answers "is this publishable now", since quota moves between edits. |
| `POST posts/import-native` | `social.post.import_native` | Bookkeeping for a hand-posted item: `published`, `native_import`, no approval, no provider id (0105 CHECK-enforced). |

Additional refusal tokens: `invalid_source`, `post_has_live_variants`, `variant_not_editable`,
`variant_native_import_immutable`, `variant_is_live`.

**Brand-voice RAG + AI drafting (SMM-19).** Every capability below runs through `ai-gateway-go`
ONLY (Hermes by default, Claude as a per-request `provider` reorder hint when the engagement's
`toolScope.ai.cloudPolish` is on — never a vendor identity of its own) and writes DRAFT rows only:
nothing here dispatches or reaches a live network. Grounding is a client's own brand corpus,
ingested as tenant+client-ACL'd WS8 knowledge (design D-13) — `social_brand_profiles` holds only
the `knowledge_source_ids` pointer, never corpus text.

| Method + path | Permission | Notes |
|---|---|---|
| `POST engagements/:id/brand-corpus/ingest` | `social.engagement.update` | Body `{chunks: string[]}` (approved past posts + guidelines, ≤40). Ingests into WS8 under a deterministic per-client scope (`social-brand:{tenantId}:{clientId}`) — re-ingesting REPLACES the prior corpus. Returns `{ok, knowledgeSourceIds, chunkCount}`. |
| `POST posts/:postId/variants/:variantId/draft-caption` | `social.post.update` | Drafts (or re-drafts) the variant's `body`/`hashtags`/`firstComment`, RAG-grounded in the variant's own client corpus. Persists through the SAME state law a human `PATCH` triggers: re-validates, recomputes `args_sha256`, invalidates any existing approval (`approvalInvalidated` in the response). Returns `{ok, draft:{body,hashtags,firstComment}, draftedVia:'ai'\|'fallback', groundedOn: string[], validation, argsSha256, estimatedCostUsd, approvalInvalidated}`. |
| `POST posts/draft-ideas` | `social.post.create` | Body `{engagementId, campaignId?, campaignGoal?, count? (default 3, max 10), ids?: string[]}`. Writes `social_posts` rows (`status:'idea', source:'ai'`) — pass `ids` (length == `count`) for idempotency on retry. Returns `{ideas:[{id,created,title,brief}], draftedVia, groundedOn}`. |

Both drafting endpoints refuse `ai_drafting_disabled` (naming the toggle) when the engagement's
`toolScope.ai.drafting` is off, and refuse `image_generation_unavailable` if the body carries
`wantImage:true` — **before any gateway call is attempted**. There is no image-generation path to
opt into (D-17): `ai.imageGen` stays inert, per the two owner-decided defaults below.

Hashtags are NEVER the model's own answer: the brand's `hashtagStrategy` (on `brand-profiles/:clientId`
— `{maxCount?, bannedTags?, requiredTags?, placement?:'body'\|'first_comment'}`) and the network's
own cap (the SAME `validation` matrix's limits, reused not duplicated) both apply to whatever the
model proposes, every time.

**Validation contract.** `validation` is `{ok, errors[], warnings[]}`; every issue is
`{rule, message}` where `rule` is a snake_case token — render against the token. Errors block a
submit; warnings never do. Current tokens: `body_required`, `body_too_long`, `body_near_limit`,
`body_over_base_limit`, `media_required`, `too_many_media`, `wrong_media_kind`, `mixed_media_kinds`,
`missing_alt_text`, `media_missing_file`, `unsupported_media_format`, `media_format_unknown`,
`first_comment_unsupported`, `too_many_hashtags`, `invalid_ig_type`, `reel_requires_video`,
`story_single_media`, `invalid_tiktok_mode`, `tiktok_inbox_mode`, `invalid_yt_visibility`,
`facebook_schedule_window`, `quota_exhausted`, `quota_near`, `quota_unknown`.

Three behaviours a console must not paper over:
- **X's 280 is a soft limit** (a longer body warns, it does not block — premium accounts exist and
  the tier is not visible to us).
- **An unknown quota is a warning, never a pass** — `quota_unknown` means the registry has not
  synced, not that zero posts (or, for YouTube, zero `videos.insert` calls) have been used.
- **Media format is checked, format-unknown is a warning** (SMM-37, addendum §A4f item 2): Instagram
  accepts JPEG images only — a PNG/WebP attachment is a hard `unsupported_media_format` error, never
  transcoded (the engine refuses rather than silently converting bytes an approver never saw; no
  transcode backend exists in the estate either). `MediaItem.format` is composer-supplied, the same
  trust boundary `kind` already uses; an attachment with no format stated warns
  (`media_format_unknown`) rather than blocking, so pre-existing variants keep validating. Facebook
  Pages' native scheduling is bounded **10 minutes to 30 days** from the publish call
  (`facebook_schedule_window`, error on either side) — Instagram has no native API scheduling to
  bound (our own queue publishes it) and no other network in the research trail documents a window,
  so this check is Facebook-only by design, not an oversight.

**Refusal shape (binding for every FE consumer).** A 400 answers `{ error: "<snake_case_token>" }` —
the token IS the contract: `missing_field`, `invalid_id`, `invalid_status`, `unknown_network`,
`invalid_scope`, `invalid_scope_value`, `invalid_budget`, `invalid_direction`, `no_fields`. Render
against the token, never by matching prose. (Note for anyone adding a refusal here: the token must
be thrown as `message`, not `error` — `src/http-error.filter.ts` renames `message` to `error` on the
way out and would silently replace an `error` you set yourself. That trap cost this ticket a
debugging round; its own test caught it.)

**Two owner-decided defaults a UI must render honestly:**
- `toolScope.networks.x` is **false** by default. X is the only pay-per-post network; enabling it is
  allowed and audited, and the PATCH answers with a `warnings[]` entry naming the metered path.
- `toolScope.ai.imageGen` is **false and currently inert** — there is no generative-image backend in
  the estate (the gateway has `/complete`, `/media`, `/embed`; `render-gateway-go` is `0.0.0`).
  Enabling it is stored and answers with a warning naming `image_generation_unavailable`. A console
  must show that state as "not available yet", not as an active feature.

**Publisher seam + connector registry (SMM-05).** Cerbos kind `social_account`. This is the
`SocialPublisher` port's console surface — the mapping publishing will ride on, the registry that
mirrors it, and a status read that keeps answering while the engine is down. **There is still no
publish endpoint**; `social.post.publish` and the D14 executable-approval entry are SMM-09's.

| Method + path | Permission | Notes |
|---|---|---|
| `GET accounts?clientId=&status=` | `social.account.read` | The connector registry as data. A **pure DB read — it never calls the publisher**, which is what makes it keep answering during an outage. Rows carry `{network, handle, displayName, status, quota, capabilities, lastError, healthCheckedAt, connectedAt, publisherOrgRef, driver}`. There is no token field, and there never will be (design D-5: network tokens live inside the engine and are never copied out). |
| `POST publisher-orgs` | `social.account.connect` | Body `{clientId, publisherOrgRef, apiKeyRef?, driver?}`. **Idempotent**: a repeat with the same org ref answers `created:false`. The organization is created by an operator ON THE PUBLISHER HOST (its API has no such route) — this records the mapping. `apiKeyRef` is an **alias**, never a key. Returns `{publisherOrgId, clientId, driver, publisherOrgRef, apiKeyRef, created, verification}`. |
| `POST publisher-orgs/:clientId/sync` | `social.account.update` | Mirrors the engine's integrations into the registry: status, live quota, resolved capabilities, health. Returns `{orgId, accounts[], skipped[], disconnected[]}`. |
| `GET publisher/status` | `social.account.read` | What the seam can do in THIS deployment, **without calling it**: `{configured, driver, enabledNetworks[], capabilities[], inboxSurface, quotaProbe, orgs[]}`. Consult it before spending a call on a capability that may be absent. |

Four behaviours a console (and an agent) must render honestly rather than smooth over:

- **`verification` is an honest field, including when it is a failure.** Provisioning writes the
  mapping even if the engine is unreachable — the mapping is OUR data and an outage must not make our
  own schema hostage to it — and answers `{ok:false, reason:"publisher_unreachable"}` (or
  `publisher_not_configured`). Show "recorded, not yet verified", never a green tick.
- **A sync failure changes NOTHING.** If the publisher is unreachable the call refuses `503`
  `{error, code:"publisher_unreachable"}` and not one registry row is rewritten. An outage is never
  recorded as "every client account is disconnected" — that would be a false, alarming state that
  also hides the real accounts behind it.
- **`capabilities` explains its own falses.** Shape:
  `{schedule, nativeSchedule, directPost, stories, comments, dm, analytics, unsupported:{<cap>:"network"|"driver"|"unverified"}}`.
  `network` = the platform has no such API and waiting will not help (TikTok comments — no comment
  scope exists on its developer platform; LinkedIn/YouTube/TikTok DMs — no DM API exists at all;
  YouTube/TikTok `directPost` — audit-locked to private/SELF_ONLY). `driver` = our engine cannot
  reach it *yet* (today: **comments and DMs on every network** — the engine has zero inbound
  surface). `unverified` = nobody has researched it (the four networks outside OQ-1's scope);
  treated as unavailable, and labelled so it reads as a gap in our knowledge, not a confident "no".
- **`quota` is live or it is unknown — never a constant.** Instagram's is read from the account's own
  `content_publishing_limit`. When the probe is unavailable the column is `{}` and `quotaSource` is
  `probe_unavailable`, which surfaces downstream as the `quota_unknown` WARNING above. Do not render
  a default cap: the long-carried "25/24h" is obsolete and Meta's own doc contradicts itself.

Refusal codes on this surface answer `{error, code}` (the `code` is the discriminator; these are not
`{error: token}` 400s): `publisher_not_configured` · `publisher_unreachable` (503) ·
`publisher_http_error` (502) · `capability_unsupported` (**501** — permanent until a different
driver is deployed, deliberately not a retryable 503) · `org_key_unresolved` (503) · `org_conflict` ·
`org_not_provisioned` · `cross_client_account` · `account_not_connected` · `network_disabled` ·
`approval_required` (409). Plain 400 tokens on these routes: `invalid_client`,
`missing_publisher_org_ref`, `unknown_driver`.

**MCP surface** (`GET /mcp/tool-defs`, aggregated — nothing hub-side is hardcoded):
`social.listEngagements`, `social.getEngagementScope` (reads, `low`),
`social.createEngagement` (write, impact `low`), `social.setEngagementScope` (write, impact
**`medium`** — an automation principal is SUSPENDED into WS4 rather than applied),
`social.ingestBrandCorpus` / `social.draftPostVariant` / `social.draftPostIdeas` (SMM-19, write,
impact `low` — every one writes a draft row or a knowledge pointer, none can reach a live network;
same `authorize()` calls as their HTTP twins above), and SMM-05's `social.listAccounts` /
`social.getPublisherStatus` (reads, `low`), `social.provisionPublisherOrg` (write, impact
**`medium`** — it is the tenant-mapping row whose corruption is the wrong-account-publish nightmare)
and `social.syncConnectorRegistry` (write, impact `low` — mirrored state only, nothing public). The
publish, inbox, report and ledger tools are deliberately NOT declared yet: their endpoints do not
exist, and a tool the hub publishes to every agent without a handler behind it is this program's
"frontend-first drift" bug pointed at automation instead of a console.

**Rollup metrics** (D12): `social.engagements.active`, `social.accounts.connected`,
`social.posts.published.month`, `social.approvals.pending`, `social.inbox.open`,
`social.usage_cost.month` (USD minor units, `isMonetary`). All are real queries against 0105's
tables and read zero until the later write paths land.

---

## 20. Monitoring module — Plane B property/service monitoring (MON-* program, 2026-08-13) — `platform-ui/src/lib/monitoring.ts` — **STATUS: UI PROTOTYPED, BACKEND NOT STARTED (every row PENDING)**

Design: `docs/blueprints/monitoring-program.md`. Shapes are **canonical in `platform-ui/src/lib/monitoring.ts`** —
implement the backend to match those exported types, not a re-derivation from this table.

**Plane separation is load-bearing.** This section covers **Plane B only** — the tenant's clients'
websites and services. Plane A (our own containers: Prometheus/Loki/Tempo/Grafana on `gda-aicenter`)
is staff-only, lives in Grafana behind an SSH tunnel, and must **never** be surfaced through these
endpoints. Merging the two is what made Gaia Nexus's monitoring dashboard fictional.

**Tenancy.** Every row is scoped `company → client → property`, matching `search_properties`
(`tenant_id` + `client_id NOT NULL`). Hierarchy traversal must never cross a root company
(MON-00) — DnA Holding rolling up its children must not become a path to another root's rows.

| Method | Path | Scope / gate | Returns | Status |
|---|---|---|---|---|
| GET | `/api/:t/monitoring/monitors?clientId&kind&status` | `monitoring.read` | `Monitor[]` | ⏳ PENDING |
| POST | `/api/:t/monitoring/monitors` | `monitoring.write` | `{ id }` | ⏳ PENDING |
| GET | `/api/:t/monitoring/monitors/:id` | `monitoring.read` | `MonitorDetail` \| 404 | ⏳ PENDING |
| PATCH | `/api/:t/monitoring/monitors/:id` | `monitoring.write` | `{ id }` | ⏳ PENDING |
| GET | `/api/:t/monitoring/monitors/:id/results?window=24h\|7d\|30d` | `monitoring.read` | `MonitorResult[]` | ⏳ PENDING |
| GET | `/api/:t/monitoring/incidents?status&limit` | `monitoring.read` | `Incident[]` | ⏳ PENDING |
| POST | `/api/:t/monitoring/incidents/:id/ack` | `monitoring.ack` | `{ id }` | ⏳ PENDING |
| GET | `/api/:t/monitoring/summary` | `monitoring.read` | `MonitoringSummary` | ⏳ PENDING |
| GET | `/api/:t/monitoring/kinds` | `monitoring.read` | `MonitorKindSpec[]` | ⏳ PENDING |
| GET | `/api/:t/monitoring/maintenance` | `monitoring.read` | `MaintenanceWindow[]` | ⏳ PENDING |
| POST | `/api/:t/monitoring/maintenance` | `monitoring.write` | `{ id }` | ⏳ PENDING |
| POST | `/api/:t/monitoring/heartbeat/:token` | **unauthenticated by design** (token IS the credential) | `204` | ⏳ PENDING |
| GET | `/api/:t/monitoring/channels` | `monitoring.read` | `MonitorChannel[]` | ⏳ PENDING |
| POST | `/api/:t/monitoring/channels/:id/test` | `monitoring.write` | `{ ok }` | ⏳ PENDING |
| GET | `/api/:t/monitoring/routes` | `monitoring.read` | `MonitorRoute[]` | ⏳ PENDING |

### Contract notes the backend must honour

1. **`GET /summary` must 404 when the module is not enabled — never return a zeroed summary.**
   The UI treats `null` as "backend absent" and renders an explicit *not connected* warning; a
   zeroed `{total:0, up:0, …}` would render as a confident all-clear. This is the single most
   important row in this section: the module exists to replace a dashboard that always looked green.
2. **`lastCheckedAt: null` means never checked.** The UI renders "never" and treats the monitor as
   stale. Do not backfill it with `created_at`.
3. **Staleness is computed client-side** as `age > max(intervalSec * 3, 60s)`. The backend must
   therefore return an accurate `intervalSec` per monitor; a wrong interval silently disables the
   staleness warning.
4. **`GET /kinds` drives the UI kind picker** from the driver registry. A kind whose driver is not
   registered must appear with `available:false`, not be omitted — "absent, not silently inert".
   Omitting it makes an unimplemented capability indistinguishable from one that was never designed.
5. **`config` on `MonitorDetail` is redacted server-side.** It may carry secret *references* only.
   A webhook URL with an embedded token is a credential and must not appear here.
6. **Heartbeat ingest is unauthenticated on purpose** — the URL token is the credential, so that a
   cron job or n8n flow can `curl` it with no session. It must therefore be rate-limited, constant-
   time compared, and scoped to exactly one monitor.
7. **`MonitorChannel.destination` is a DISPLAY-SAFE summary, not the config.** A webhook URL with
   an embedded token is a credential; return `https://host/webhook/abc…` truncated, never the whole
   thing. `monitoring.read` is a broad grant — anyone who can see the board can see this field.
8. **`channelHealth` is computed client-side from `failureCount` + `lastDeliveryOk`.** The backend
   must maintain `failureCount` as *consecutive* failures reset to 0 on success. A channel that is
   enabled and failing is worse than no channel — it looks like coverage — so this counter is what
   the UI escalates on, not a boolean.
9. **Public status pages (`/status/:slug`) are NOT in this section.** They are an unauthenticated
   surface with their own strict field allowlist (monitoring-program.md §3.5) and must not reuse
   these shapes — `target`, `config` and assertion strings are all forbidden there.

### UI consumers (built 2026-08-13)

- `/monitoring` — operations board: KPI tiles, worst-first monitor table, open incidents, explicit
  stale-monitor callout, explicit backend-absent state.
- `/monitoring/[id]` — monitor detail: uptime strip (one cell per check), incident history, recent
  checks, TLS/domain expiry tiles.
- `/monitoring/new` — monitor editor. The kind picker is rendered **from `GET /kinds`**, so a driver
  registered server-side appears here with no frontend change; a kind with `available:false` renders
  disabled rather than hidden.
- `/monitoring/channels` — notification channels + routes, surfacing three quiet failure modes:
  a channel failing its last 3 deliveries, an enabled channel with no route pointing at it, and a
  catch-all route that matches every event.
- Writes: `lib/monitoringActions.ts` (`createMonitor`, `acknowledgeIncident`, `scheduleMaintenance`,
  `testChannel`).
- Nav: **Business → Monitoring** (`components/shell/nav.ts`, indexed in `docs/sidebar-nav-map.md`).
- DEMO_MODE fixtures: `lib/demoMonitoring.ts` — seeded with a down/degraded/stale/maintenance/
  unknown/never-checked spread plus expiring cert and domain, so every branch is drivable with no
  backend. Wired into `demoFixtures.getDemoResponse`.
