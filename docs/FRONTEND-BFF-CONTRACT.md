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
| ✅ | POST | `/api/companies` | `{name,type,parentCompanyId?,modules?,vertical?}` → `{id}` | BUILT (0018-era; `company-crud.controller`). Elevated only; creator auto-added as member; emits `company.created`. **PV1-03:** `vertical` is optional, one of holding/agency/hospitality/catering/general (default `general`; anything else is `400 {message, field:"vertical"}`). A body with NO `modules` starts the company from its vertical's pack `defaultModules` (`core/packs.ts`, PV-D17); a body that sends `modules` keeps exactly those. |
| ✅ | PATCH | `/api/companies/:id` | partial `{name?,type?,parentCompanyId?,status?,modules?,vertical?}` → `{ok}` | BUILT. `company.manage`; self-parent rejected; emits `company.updated`. **PV1-03:** `vertical` may be set only by `platform_admin` at global scope (PV-D16): anyone else gets `403`, checked right after the `company.manage` authorize and before any validation; an unknown value is `400 {message, field:"vertical"}`. Changing the vertical never touches `enabled_modules` (PV-D17). `GET /api/companies/:id` now returns `vertical`. |
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
| ✅ | GET | `/api/me` `clientOf` | `Me.clientOf?: {companyId,companyName}[]` | **PV2-02, NEW, additive to `Me`.** Companies where the caller is an ACTIVE, non-deleted `client_contacts` contact (distinct, sorted by company name), so the UI can tell "companies I work in" from "companies I am a client of"; `companies` is the union of both and marks neither. Read from `client_contacts` joined to `companies` (both `deleted_at IS NULL`). WARNING: `client_contacts` is FORCE RLS with a `principal_lookup` policy, so the read runs in a transaction that first sets `app.principal_user_id` (same pattern as `rbac/principal.ts`, MON-00i); from a plain `withGlobal` it returns zero rows with no error. `[]` for a staff member with no contact row. The UI type is optional: treat missing as `[]`. |
| ✅ | GET | `/api/me` `companies[]` | `Me.companies: {id,name,type,vertical,enabledModules,rootCompanyId}[]` | **PV1-01, NEW fields, additive.** `vertical` is the company's business line (`company_verticals`: holding, agency, hospitality, catering, general; PV-D14), which selects its pack. `enabledModules` is the EFFECTIVE module set the page gate uses (`enabledModuleKeys`: the company's own modules plus active service assignments). `rootCompanyId` is the company's root (a root company's is its own id), for the Group and Platform areas (PV-D11, PV-D20). The UI treats a missing `vertical` as `general`, missing modules as unknown (hide nothing) and a missing root as not a root. |
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
| ✅ | GET/POST/PATCH | `/api/:t/projects`, `/api/:t/projects/:id` | list + detail + create + PATCH exist. Projects gain an owning `department_id` (org-node id, nullable) — GET/detail returns it; POST/PATCH accept `departmentId` (optional, camelCase in body). Migration `0029_projects_department.sql` adds the column. Drives the Projects "Department" column + each department console's owned-projects list. Cross-department work still flows via task assignment. **No delete/archive endpoint — add one.** **2026-08-27 (lineage spec 4/4):** a project belongs to a client — `POST` requires `clientId` unless `isInternal: true` is passed (the company's own work; sets `is_internal`); both → 400, neither → 400 `{error, field:"clientId"}`; the client must be in-tenant (400 `clientId`). `PATCH` with `clientId: null` → 400 (was a silent `COALESCE` no-op); setting a client on an internal project flips `is_internal` to false. Legacy client-less rows untouched. UI: `components/forms/ProjectForm` (Client required), `lib/prdActions.ts::createBriefingAction`; hub `projects.create` forwards `isInternal`. |
| ✅ | GET | `/api/:t/tasks?assignee=me` | base task list. |
| ✅ | GET/POST | `/api/:t/projects/:pid/tasks` | list + create. |
| ✅ | PATCH | `/api/:t/tasks/:id` | BUILT (`core.controller.ts`). Base task update. |
| ✅ | Agency | `/api/:t/modules/agency/campaigns[/:cid/briefs]`, `/approvals/pending`, `/approvals/:id/decide` | campaigns + approvals ✅; **briefs GET+POST ✅** (`agency.controller.ts`); assets GET+POST ✅, submit ✅. **Still no campaign detail/edit/delete endpoints** (not in route inventory). |
| ✅ (UI built) | GET/POST/DELETE | `/api/:t/clients[/:id]` | BUILT (`client-work.controller.ts`: GET, GET/:id, POST, PATCH, DELETE). UI: `/clients` list + `/clients/new` + `/clients/[id]` detail. Create/delete gated `pm.manage`. **Additive (M5-G0b):** every client row carries `isInternal: boolean` (the WSK-D36 internal sentinel; the list shows an "Internal (our own sites)" badge and keeps it out of the "Business type: Other or not set" review filter, and `GET /clients/centre` rows carry `isInternal` too). The sentinel is HIDDEN from the portal and portal scope, portal login provisioning, report delivery and AI report drafting (`400`), invoice creation (`404 client not found`), the knowledge client ingest and assistant client citations; staff lists, the Clients Centre and monitoring still show it. **PV3-04: POST now REQUIRES `businessType`; see §26.** |
| ✅ (UI built) | GET/POST/PATCH | `/api/:t/deliverables[?projectId][/:id]` | BUILT (`client-work.controller.ts`). UI: `/deliverables` list + `/deliverables/new`. |
| ✅ (UI built) | GET/POST | `/api/:t/time-entries` | BUILT (incl. PATCH). UI: `/timesheets` (totals + billable rollup + log). POST body `{minutes,projectId?,taskId?,billable,entryDate,notes}`. |
| ✅ (UI built) | GET/POST | `/api/:t/invoices[/:id]` (+`PATCH` status) | BUILT (`invoice.controller.ts`: GET, GET/:id, POST, PATCH). **Invoices** UI: `/invoices` list + `/invoices/new` (generate from billable time in a period × rate) + `/invoices/[id]` (line items; **Issue** since PV5-04). `Invoice` shape in `lib/invoice.ts`. `company.manage` only. **PV5-04 (PROTOTYPED):** `PATCH` accepts `draft\|void` only — `sent` answers **400** naming `POST …/issue`, `paid` answers **400** (paid follows from confirmed payments), and `void` on an ISSUED invoice answers **409** (use `POST …/void`). Authorization now runs before the body is validated. `POST` takes an optional `taxCode` (applied at issue) and defaults `currency` to the billing profile's (else `USD`), rounding line amounts to the currency's minor unit. GET/list add the invoice of record: `invoiceNo`, `issuedAt`, `issuedBy`, `issueDate`, `dueDate`, `subtotal`, `taxTotal`, `taxCode`, `issuer`, `arInvoiceId`, `legacyUnissued` (a pre-PV-5 sent/paid row). |
| ✅ (UI built) | POST | `/api/:t/invoices/:invoiceId/approve` | **IAM-GAP-01 (2026-08-13, BACKEND BUILT) — UI landed 2026-09-02, closing IAM-GAP-01's own "no UI" gap.** Maker/checker: `draft → approved`. Requires `invoice.approve`; policy denies the invoice's own creator (`created_by`, migration `0107`) and fails closed if the creator is unknown (legacy pre-migration rows). `PATCH .../invoices/:id` can no longer reach `'sent'`/`'paid'` unless the invoice is already `'approved'` — `'approved'` itself is reachable ONLY through this endpoint, never via the generic PATCH. Response adds `createdBy`/`approvedBy`/`approvedAt` to the GET/list shape. **UI**: `/invoices/[invoiceId]` (`InvoiceActions.tsx`) — an "Approve" action gated on the new `invoice.approve` capability (`lib/rbac.ts`, mirrored ONLY to `company_admin`/`manager` — verified against the exact `derivedRoles` the Cerbos rule names, deliberately NOT folded into the wider `company.manage`, which `owner` also holds but which Cerbos never grants approve reach to); the page additionally hides the button outright when the viewer IS the invoice's own `createdBy` (rendering an honest inline explanation instead of waiting for a 403) and again when the creator is unknown on a legacy row and the viewer isn't `platform_admin`; the three new fields render in an "Approval trail" card, name-resolved against `/members` with a raw-id fallback. The self-approval 403 (the one race the page can't pre-empt — a second tab, a role change) surfaces as a clear message via `useActionState`, never a crash or a generic error. **IAM-GAP-02 (2026-08-13) update: the self-approval hole is closed for EVERY approver tier, including `platform_admin`/`group_executive`** (they previously bypassed the creator check via their pre-existing wildcard; now a structural Cerbos `EFFECT_DENY` blocks creator===approver for anyone, no exceptions) — no contract/shape change, callers just see the SAME 403 a company_admin/manager already got, now also for those two roles. |
| ✅ PV5-04 (UI: readiness shown on refusal) | GET | `/api/:t/invoices/:invoiceId/issue-readiness` | **PROTOTYPED.** `{ invoiceId, status, issued, invoiceNo, ready, blockers: [{code, message}] }` — every reason the invoice cannot be issued now, all at once: `NOT_APPROVED`, `NO_CLIENT`, `FINANCE_MODULE_OFF`, `NO_FINANCE_SETTINGS`, `NO_BILLING_PROFILE`, `NO_BANK_DETAILS`, `NO_REVENUE_ACCOUNT`, `NO_RECEIPT_ACCOUNT`, `NO_AR_CONTROL_ACCOUNT`, `NO_OPEN_PERIOD`, `CURRENCY_UNKNOWN`, `CURRENCY_NOT_FUNCTIONAL`, `EMPTY_INVOICE`, `LINES_INVALID`, `LINES_TOTAL_MISMATCH`, `AMOUNT_PRECISION`, `PKP_NOT_CONFIRMED`, `TAX_CODE_NOT_IN_FORCE`, `NO_VAT_ACCOUNT`. Branch on `code`. Authz: `invoice` read. See §30. |
| ✅ PV5-04 (UI built: Issue button) | POST | `/api/:t/invoices/:invoiceId/issue` | **PROTOTYPED.** No body. Issues an `approved` invoice through the ledger in ONE transaction (§30): number `{prefix}/{yyyy}/{nnnn}`, AR customer, tax via `finance_tax_compute`, AR invoice posted, issuer frozen, status `sent` (UI label "Issued"). **200** `{ id, status, invoiceNo, issueDate, dueDate, subtotal, taxTotal, total, currency, arInvoiceId, alreadyIssued }` (money as decimal strings). Idempotent: a second call answers `alreadyIssued: true`. **409** `{ error, reason: "issue_blocked", blockers }` with NOTHING written when not ready (the readiness list, re-checked inside the transaction). Authz: `invoice` `issue` (company_admin, manager, owner; bots/automation DENIED), before anything else. |
| ✅ PV5-04 (no UI yet: PV5-09) | POST | `/api/:t/invoices/:invoiceId/void` | **PROTOTYPED.** `{ reason }` (≥4 chars, 400 otherwise). Voids an ISSUED `sent` invoice: a credit note for the full amount is posted and applied, and both the AR invoice and the invoice read `void`. **409** when never issued (use PATCH), when paid / part-paid / credited / written off (a credit note in Finance), or while a payment claim is pending. Idempotent: `{ alreadyVoid: true }`. Authz: `invoice` `void_issued` (company_admin, owner; manager and bots DENIED). |
| — (no UI, no read endpoint yet) | — | *(data-layer only)* invoice revision history | **NEW, IAM-GAP-02 (2026-08-13, DATA CAPTURE ONLY).** Every invoice mutation (create/status-change/approve, plus the staff payment-confirmation path in `contracts.controller.ts`) now writes one `invoice_revisions` row (who/when/before-snapshot/after-snapshot) in the SAME transaction as the mutation, and every mutation sets `invoices.updated_by`. The GET/list response gains one additive field: **`updatedBy`** alongside the existing `createdBy`/`approvedBy`/`approvedAt`. **No new read endpoint for the revision history itself** — deeper forensics/analysis surface is explicitly deferred to a separate session (per the ticket); this row exists so the UI team knows `updatedBy` is now real data, not so they build a history view against it yet. |
| ✅ (UI built) | GET | `/api/:t/modules/agency/approvals/decided` | BUILT. Decided-approval **history** (Approvals page "Recently decided"). Add `campaignId` to pending items so the UI deep-links to the campaign. |
| — | (pure UI) | Calendar `/calendar` | Agenda + workload built entirely from existing task/deliverable/project due dates — no new endpoint. |
| ✅ (UI built) | GET/POST/DELETE | `/api/:t/files[?entityType&entityId][/:id]` | BUILT (`files.controller.ts`: GET, POST, GET/:id, GET/:id/content, DELETE). **Attachments** on project + task detail. POST body today is a **reference** `{entityType,entityId,filename,url?}` → `{id}`. **Staff download (PV3-08 follow-up, PROTOTYPED):** the UI proxies `GET :id/content` at its own `GET /api/files/:fileId` (`platform-ui/src/app/api/files/[fileId]/route.ts`; not a platform endpoint, no backend change). It sends the caller's session auth, takes the company from the active company (never the URL), validates the id as a plain token, and STREAMS the bytes back with `content-disposition: attachment` (forced even if the platform sent another), `x-content-type-options: nosniff`, `content-security-policy: sandbox; default-src 'none'` and `cache-control: private, no-store`. 401/403/404 pass through as JSON `{error}` sentences; a platform fault or an unreachable platform is a 502 sentence, never a 500; a bad id is 400. A raw storage key or URL is never exposed. DEMO_MODE answers a small labelled text placeholder through the same headers. The client portal keeps its own `/portal/files/:id`. **TODO: true binary/multipart upload** (`multipart/form-data` with the file part) — UI attaches references for now. |
| ✅ (UI built) | GET/POST | `/api/:t/comments?entityType=&entityId=` | BUILT (`collab.controller.ts`). **Generic threaded comments** — task comments (via `lib/pm`) + **project "Discussion"** (via `lib/entities.postComment`). Any `entityType`. POST body `{body}`. |
| ✅ | GET/POST | `/api/rollups?period`, `/api/:t/rollups/recompute` | Add drill-down (records behind a metric) + period history for the reporting UI. **PV1-06a (2026-10-11, PV-D19/PV-D20) — `GET /api/rollups` WIDENED:** besides `platform_admin` (estate-wide) and `core.rollup.read` holders, the **owner of a root** now reads it. The tenant checked is the caller's own root (from `users.home_company_id`), and the rule needs an `owner` grant at company scope ON that root, so an owner of a child company only is still refused (403). Response shape unchanged. The Group area (PV1-04/06b) consumes it; `owner` still does not hold `core.rollup.read`, so an owner cannot delegate this read. |
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
  | GET | `/api/:t/agents/runs/:runId/events` | **`isElevated`** (+ the ASST-21 handoff-owner carve-out, reused not reimplemented) | O4. Runner `GET /runs/:id/events?since=<seq>` reshaped through `reshapeEvent` to `{eventId,runId,goalId,seq,ts,kind,detail,durationMs,parentRunId}`; the runner's own `tenantId` is dropped. Never 404s — an in-flight run has no `agent_runs` row yet — and degrades to `{events:[]}` when `AGENTS_URL` is unset. **Polling, not SSE**: the runner's event bus is an in-process EventEmitter (single-replica only), so a `since` cursor is resumable where a second SSE hop would just add failure modes. `seq` is allocated BEFORE the fail-soft write, so gaps are real and detectable — `lib/agentEvents.ts::findSeqGaps` exists so no consumer re-derives that by hand |
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
| ✅ (UI built, APPR-01) | POST/GET | `/api/:t/automation-approvals[/:id][/:id/decide]` | `core/automation-approvals.controller.ts` — WS4 automation-suspension surface; distinct from `/modules/agency/approvals`. **APPR-01 (2026-08-05) added `GET /:id`** — the single-row read backing `platform-ui`'s `/approvals/[id]` detail page (`lib/approvals.ts`'s `getAutomationApprovalDetail`). Fetches the row BEFORE authorizing (mirrors the existing `decide()`'s own WSD-4 pattern) so an hr-origin row's `module:'hr'` branch of `resource_automation_approval.yaml` still applies; a cross-tenant id is invisible via RLS ⇒ 404, never a leak. Response is camelCase (`workflowId`/`toolName`/`toolArgs`/`agentName`/`requestedByName`/`decidedByName`/`executionStatus`/…), NOT a mirror of the list's snake_case rows — nothing else consumed a single row before this. Same `read` action the list already gates on; no Cerbos policy change. **WSK-66 (2026-10-10, BUILT, backend only):** approving an `origin='webdesk'` row (`workflow_id` ∈ `content.publish`/`content.schedule`/`key.mint`/`site.archive`, filed by `modules/webdev/webdesk-approved-command.ts#fileWebdeskCommandApproval`) executes that ONE WebDesk command in-band, as the decider, over the control channel with a WS4 assertion. Before the decide UPDATE the decider must also pass the command's own Cerbos rule (`webdesk_content_item · publish/schedule` with `approvalId`, `creatorId`, stored `itemCount`; `webdev_provisioned_site · promote` + requester ≠ decider for `key.mint`) — a refusal is `403`/`400`/`503 {reason:"webdesk_not_configured"}` and the row stays `pending`. On `approved` the response gains `webdesk: { command, executionStatus: "executed"\|"failed", … }` (`error` = a typed `webdesk_*` token on failure; the decision itself stands, so it is still `200`). For `key.mint` the API-key plaintext appears ONLY there (`webdesk.plaintextOnce`), never in the row, `activities` or logs. Every other origin is byte-unchanged and carries no `webdesk` key. **WSK-60 (2026-10-10, backend only, PROTOTYPED):** (1) a successful `content.publish` then makes ONE call to `site-builds.service.ts#startSiteRebuild`, which dispatches the site repo's `webdesk-rebuild.yml` through the GitHub chokepoint (`github_repo · deploy`, authorised by this approval's id) and records a `webdev_site_builds` row; the `webdesk` object gains `build: { buildId, state: "rebuilding"\|"failed", failureReason }` (a `failed` build never fails the publish; `content.schedule` carries no `build`). (2) A fourth `workflow_id`, `content.rebuild` (filed by `POST …/modules/webdev/content/sites/:tenantSlug/:siteId/rebuild-requests` → `202 {approvalId}`; one open request per site returns the same id), sends nothing to Zone B and is authorised by `github_repo · deploy` alone (no maker-checker); on approve `webdesk` is `{ command:"content.rebuild", executionStatus:"executed"\|"failed", build }` and a failure is `error: "webdesk_rebuild_failed: <reason>"`. (3) `GET …/modules/webdev/content/sites/:tenantSlug/:siteId/build-status` → `{ build: { approvalId\|null, kind:"publish"\|"rebuild", requestedAt, publishedAt\|null, state:"rebuilding"\|"live"\|"unverified"\|"failed", stagingUrl\|null, verifiedAt\|null } \| null, stagingStale }` (`webdesk_content_item · read`; exactly those keys, which `platform-ui/src/lib/webdeskContent.ts#parseBuildStatus` parses). Runbook: `infra/runbooks/webdesk-staging-rebuild.md`. **UI (2026-10-11, BUILT):** `/approvals/[id]` reads a `key.mint` row (`workflowId` `key.mint` / `toolName` `webdesk.key.mint`) as an **API key request** (title from the row's `reason`, environment + scope from `toolArgs`), and decides it through `platform-ui`'s `decideKeyMintApproval`, the sibling of `decideApprovalItem` that RETURNS the façade's `{ok:true, webdesk}` (`decideApprovalItem` still ignores the body, byte-unchanged, for every other origin). `webdesk.plaintextOnce` is shown ONCE in a client component's state (read-only field + Copy + "won't be shown again"); it is never stored, logged, revalidated or in any later server render. `executed` with `plaintextOnce: null` and `failed` render no key field. **T7 (WebDesk M3, 2026-10-11, BUILT, backend only):** a REQUESTER may now read their OWN approval. `GET /:id` passes `creatorId: row.requested_by` (the users.id that filed it = `principal.id`) to Cerbos, and `resource_automation_approval.yaml` gained one `read`-only ALLOW (`inTenant && notLow && creatorId == principal.id`, no client grant, no derived role, no `perm_*` mirror) so the detail page no longer dead-ends for the person who filed the request; `decide`/`retry`/`decide_*` are untouched (a requester still gets `403` on decide). `GET /` (the list) now has TWO tiers: a caller who passes the existing elevated `read` sees the whole inbox exactly as before; a caller who does not (previously `403`) now gets `200` with ONLY the rows they filed (`requested_by = caller`, an empty array when they filed none); a caller outside the tenant, or at low assurance, is still `403`. The unified `GET /api/approvals` inbox is unchanged. |
| ✅ (UI built, APPR-01) | GET | `/api/:t/modules/agency/approvals/:approvalId` | `modules/agency/agency.controller.ts` — the agency twin of the row above, same rationale + same fetch-before-authorize shape, same `read` action `pending`/`decided` already use. camelCase (`campaignId`/`campaign`/`assetId`/`requestedByName`/`decidedByName`/…). Module-gated like every other route in this controller (404 if `agency` isn't enabled for the tenant). |
| ✅ (no UI — machine surface) | POST | `/api/:t/automation-approvals/resolve-and-execute` | **D14-10** — `core/automation-approvals.controller.ts`. NOT a UI endpoint and must never be called from `platform-ui`: it is how the **agent runner** (`ai-agents`) resumes a suspended goal under the owner’s D14-b "re-run from the top" decision. Body `{agentName, toolName, toolArgs}`; matches a decided `origin='agent'` row on `(workflow_id = agentName, tool_name, canonical argsSha256)` and returns a typed `{match: none|executed|rejected|executing|failed|not_executable}` — every branch is a **200** so the caller can never mistake a fault for "nothing on file" (that mistake re-files a duplicate approval). Executes only through D14-03’s single-use `pending → executing` claim, so the executor-auto-execute and re-run paths together produce exactly ONE tool call; the loser consumes the stored `execution_result`. Cerbos-gated to the ORIGINAL requester (`create` + `requested_by == principal`), never the approver — a non-requester gets 403, not `none`. The approvals UI keeps using `/:id`, `/:id/decide` and `/:id/retry`. |
| ✅ (no UI) | GET | `/mcp/tool-defs` | `modules/mcp-tools.controller.ts` (`@Controller("mcp")`) — consumed by MCP Hub, not platform-ui. |
| ✅ (no UI) | POST | `/principal/resolve`, `/identity/enroll/start`, `/identity/enroll/confirm` | `identity/identity.controller.ts` — root-level, not under `/api`; OBO/D4 enrollment, service-to-service. |
| ✅ **STALE "no UI" tag — now consumed** | GET/POST | `/api/:t/portal/runs[/:runId]`, POST `/gates/:id/decide`, POST `/runs/:runId/scope-sign` | `core/portal.controller.ts` — the client portal (`/portal`, `lib/portal.ts`). WD-03 (Web Dev Phase 1 §12, D-3): the sign view now renders the LATEST stage artifact (`ArtifactMarkdown`) above the sign/feedback action for the gate it governs — "what a client signs must be what they see." Full doc sweep for this row + neighbors is WD-07's ticket, not redone here. **D-3 notify delta (2026-08-03):** `POST /portal/gates/:id/decide` now notifies the internal side (the run's `owner_id`, else its `created_by`) via `notify()`, and `POST /runs/:runId/scope-signoffs` / this controller's own `scope-sign` notify BOTH sides once `scope.signed` completes — `href: "/pipeline/:runId"` for staff, `href: "/portal"` for the client. Best-effort: a `notify()` failure is caught per-recipient and logged (`[client-notify]`), never rolls back the decide/sign-off write. No response-shape change. **C3/C5 delta (2026-08-04):** `GET /portal/runs` returns each run's **`pendingActions`** count (outstanding client decisions) and computes every blockage in TWO batched queries instead of two per run — it was 2N+1, up to 201 round trips on a full page, on the one surface whose latency is paid by someone outside the company. `GET /portal/runs/:runId` is now actually rendered; before this the reader and its type existed as dead code and the list page fetched every run's detail (1+N HTTP calls) to inline it. **Route moved (CP-2..CP-5, 2026-08-04):** it renders at **`(portal)/portal/approvals/[runId]`**, not `(app)/portal/[runId]` — the client portal is now its own route group with its own `PortalShell`, and the readers moved to `lib/portal-data.ts` (types + pure helpers stayed in `lib/portal.ts`, which is now deliberately client-safe for the live-SSE component). `pendingActions` feeds the new approvals list and `PortalGateActions` is reused verbatim, so this delta's substance is intact — only the path changed. |
| ✅ **STALE "no UI" tag — now consumed** | POST/GET/PATCH | `/api/:t/pipeline/runs[/:runId][/stages]`, `/pipeline/stages/:id`, `/pipeline/gates[/:id/decide]`, `/pipeline/runs/:runId/scope-signoffs` | `core/pipeline.controller.ts` — the WS11 meeting→MOM→PRD/Report/Scope pipeline; **2026-08-27:** `POST /runs` accepts `departmentId`, derived like client/project when omitted (caller → source meeting → project); list/detail return `department_id`; `GET /runs?include=gates` returns each run with `gates: PipelineGate[]` (one grouped query; `[]` when none; response unchanged without the parameter). Consumed by the run workspace (`/pipeline/[runId]`, WD-02, `lib/pipeline.ts`) and, since 2026-08-26, by PRD Studio (`components/prd/RunApprovalRow`: `GET /runs/:id` per active run — capped at 12, the LIST carries no gates — for the `prd_review` (GM) / `prd_sign` (client) chips — **2026-08-27:** replaced by `GET /runs?include=gates` (`lib/pipeline.ts::listPipelineRunsWithGates`), no cap; `POST /gates/:id/decide` via the same `decideGateAction`; and `POST /pipeline/runs` from `lib/prdActions.ts::startRunManuallyAction` — the by-hand run when the platform answers `bridge_not_configured` on ingest: `{sourceMeetingId, title, clientId, projectId, stages:[prd_extract|report_extract|scope_extract pending]}`, then `PATCH /meetings/recordings/:id {status:"ingested"}` and best-effort `relink-orphans`). **WD-03 (D-3) delta:** `PATCH /pipeline/stages/:id` with `artifactRef` present is now a signature-locked EDIT — 409 once the stage's client sign gate (matched by track: `delivery`→`prd_sign`/`customer_feedback`, `scope`→`scope_signoff`; `report` never locks) is `decided`, via ANY path that decides it (native route or the generic `/approvals/:id/decide` façade, since both write the same `pipeline_gates` row); Cerbos `pipeline_stage.update` narrowed to `company_admin`/`manager`/`group_executive` (plain `member` now denied — was previously granted, a widening this ticket closed); every edit gets a `writeActivity` row + `pipeline.stage.updated` event (`artifactEdited:true`). Deliberately does NOT also lock on `stage.status === 'done'` — extraction lands stages `done` immediately, before any client sign gate exists, so that would make editing unreachable for every ingested run (falsified against the live "Acme Coffee kickoff" run — see WD-03 evidence). Workspace edit UI: `pl-edit` details/form in `pipeline/[runId]/page.tsx` (`isStageLocked` in `lib/pipeline.ts` mirrors the backend rule for the "locked" badge; the backend 409 remains the real authority). **WD-29 (DEF-2) delta — response shape is ADDITIVE, no breaking change:** `POST /pipeline/runs/:runId/stages` and `POST /pipeline/gates` may now return an optional `deduped: true` alongside the usual `id` (still `201`), meaning the call was a stale-snapshot repeat and `id` is the EXISTING row the pipeline is really on — same convention `POST /pipeline/runs` already uses for its `sourceMeetingId` dedupe. Callers should treat `{id, deduped:true}` as success and keep using the returned `id` (that is what keeps a raced n8n execution on the live lineage); no client change is required, and nothing that previously succeeded now errors. Every run-state transition (stage create/update, gate open/decide, scope sign-off, run PATCH — on the internal AND `portal/*` routes) now serializes on a per-run advisory lock, so concurrent deciders for ONE run are ordered while different runs stay fully parallel; a `claude_design` create is admitted only when no design exists or the head design has a decided `customer_feedback: changes_requested`, so WD-05's revise loop still produces its legitimate second design but retriggers cannot manufacture extra ones. `scope.signed` now fires only on the TRANSITION to complete (re-filing an already-complete sign-off no longer re-emits). Schema backstop: partial `UNIQUE(run_id, track, name)` over the single-shot stage names (`0052`) — deliberately NOT covering `claude_design`. **D-3 notify delta (2026-08-03):** `POST /pipeline/gates` now notifies active `client_contacts` (migration `0072`) when it opens a `client`-side gate — `resolveClientRecipients`/`clientNotifyKindForGate` (new `core/client-notify.ts`) restrict a signature-kind gate (`prd_sign`/`scope_signoff`) to `capability='signer'` contacts scoped (client-wide or the run's own `project_id`) and active only; a feedback gate (`customer_feedback`) reaches every active contact in scope, signer or viewer. `POST /pipeline/runs/:runId/scope-signoffs` notifies both sides on the `scope.signed` transition, same as the portal twin above. Best-effort throughout: see the portal row's note. No response-shape change; a suppressed (`deduped:true`) gate-open does not re-notify. **C1/B2/B6 delta (2026-08-04):** `GET /pipeline/runs` accepts **`clientId`** and **`projectId`** alongside `status`/`sourceMeetingId`, and its SELECT now returns `client_id`, `project_id` and `owner_id` (it previously omitted them, which is why the UI cross-referenced the recordings registry to draw a client column and why run->project navigation did not exist). Filtering happens server-side — `/pipeline` used to fetch the 200-row cap and narrow in the browser, which stops being a filter past 200 runs. Newly CONSUMED, having existed unused: `POST /pipeline/runs` (start a delivery run with no source meeting — `createRunAction`; the UI requires a clientId even though the API permits null, because a clientless run can never reach a portal) and `POST /meetings/recordings/relink-orphans` (`relinkOrphanRecordingsAction`; idempotent, which is what makes it safe as a button rather than a runbook step). Ids are compared as text, so a malformed id from a hand-edited query string matches nothing instead of 500ing on a uuid cast. |
| ✅ **STALE "no UI" tag — now consumed** | POST/PATCH/GET | `/api/:t/meetings/recordings/start`, `PATCH /:id`, `POST /:id/transcript`, `POST /:id/ingest`, `POST /:id/drive`, `GET /`, `GET /:id` | `core/meetings.controller.ts` — WS11 capture-edge registry (helper-driven: record → local whisper → register → transcript → ingest proxy, `N8N_BRIDGE_SECRET` stays server-side). **2026-08-27:** `POST /start` accepts `departmentId` and list/detail return `department_id` (org-node id; NULL for rows that pre-date it). Consumed by `lib/meetings.ts`/`lib/meetingsActions.ts`, the `/meetings` registry + `/meetings/[id]` detail/workbench, and the PRD Studio tab (`departments/[deptId]/prd`) — which since 2026-08-26 renders the registry as ONE flow: `components/prd/BriefingComposer` (`/start`, client required), `BriefingCard` (`/:id/audio` upload + in-browser take, `/:id/audio/retry`, `/:id/transcript` = "Upload a transcript" (pasted or .txt/.md/.srt/.vtt parsed in the browser — no whisper), `/:id/ingest` = "Convert to PRD run", polling `api/meetings/[id]/status`), with `lib/prdFlow.ts` mapping `status` → one headline + one next step and `scopeToDepartment` filtering the tenant-wide list to the department's projects — `projectId` is therefore always set on `/start` from this tab: `lib/prdActions.ts::createBriefingAction` first creates the project (`POST /api/:t/projects` with `{name, clientId, departmentId}`, core.controller) unless the user links an existing one (`RecordControls` remains for the client workspace; a project workspace's Meetings tab renders the same PRD Studio flow via `components/prd/ProjectBriefings`). **WD-07 (Web Dev Phase 1 §12) additions:** `/meetings`'s table gained a "Run" column resolving the linked `pipeline_runs.status` (not just the recording's own `status`) via one extra `listPipelineRuns` call; PRD Studio's "Source meeting" cell is now a link back to `/meetings/[id]` when the run's `source_meeting_id` resolves to a known recording (`listRecordings` cross-referenced by `meeting_id`, mirroring WD-02's reverse lookup in `lib/meetings.ts`'s `findRecordingByMeetingId`). `RecordControls` also gained optional `clientId`/`projectId` props (hidden fields feeding the existing `/start` body, unchanged contract) — wired into the project workspace (`ProjectWorkspaceView.tsx`'s new "Meetings" card) and the client detail page, each showing its own scoped `GET .../recordings?clientId=`/`?projectId=` list. **Verified end-to-end (not just "should work"):** a recording started from a project page carries that project's `client_id` + the `projectId` itself on the `meeting_recordings` row, and — since another agent's fix to `mtg-dispatcher.json` (WD-01 finding F-1) now forwards `clientId` into `pipeline.createRun` — an ingested run from that recording carries a non-null `pipeline_runs.client_id` too (DB-probed, see WD-07 evidence; this ticket verified the chain, it did not touch the dispatcher). |
| ✅ **STALE "no UI" tag — now consumed** | POST | `/api/:t/meetings/recordings/:id/audio` (multipart, field `file`) → 202 `{id,status:"transcribing",audioRef}`; `/:id/audio/retry` → 202 `{id,status:"transcribing"}` | WD-04 (Web Dev Phase 1 §12) — `core/meetings.controller.ts`. **2026-08-26:** PRD Studio reaches `/:id/audio` through the BFF streaming proxy `platform-ui/src/app/api/meetings/[id]/audio/route.ts` (browser XHR with progress → route forwards the multipart body as a stream with the platform auth headers; status + body passed through), because a Server Action buffers and caps the body (1 MB default, raised to 520 MB in `next.config.ts` for the remaining action-based paths). The controller contract is unchanged. In-ERP audio upload with no helper required: size cap (`MEETING_AUDIO_MAX_BYTES`, default 200MB) + audio-type allowlist enforced at upload; async job calls the whisper container's `/v1/audio/transcriptions` DIRECTLY (not via ai-gateway-go — bypasses its ~2.5-min timeout); flips `transcribing→transcribed` or `→failed` (retryable via the second route, reusing the stored audio — no re-upload). Additive `meeting_recordings.audio_ref` column (migration `0049`); the helper's local-whisper contract (`start`/`transcript` above) is unchanged. **WD-07 (2026-07-30, Part A) landed the frontend** — WD-04's own AC ("an `.m4a` uploaded in the browser becomes a transcript") had only ever been curl-verified; a real gap, not a doc staleness. `AudioUploadForm.tsx` (mounted on `/meetings/[id]`'s workbench) uploads via a new `platformUpload()` helper in `lib/platform.ts` (deliberately separate from `platformFetch` — that helper always forces `content-type: application/json`, which would corrupt a multipart boundary) and polls a new route-handler, `GET /api/meetings/:id/status`, on a 2.5s interval that self-terminates once status reaches `transcribed`/`failed`/`ingested` — the same poll-until-terminal shape as `WhatsAppConnect.tsx`'s bot-session poll. `RecordControls` gained a register-then-upload combined path (`registerAndUploadAudioAction`) for the case where no recording row exists yet — it starts one, uploads into it, then redirects to `/meetings/[id]` where `AudioUploadForm` takes over. DEMO_MODE equivalent: `demoUploadAudio`/`demoRetryAudio` in `demoMeetings.ts` (a filename containing "fail" simulates a whisper-down failure, since demo mode has no real whisper container to fail against). |
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

### 10c. HR department waves A–D (HR-FULL, 2026-08-24) — `modules/hr/{hr-policy,recruitment,payroll,hr-lifecycle}.controller.ts` — **BACKEND: SCHEMA DEV-VERIFIED, HANDLERS PROTOTYPED · UI: PROTOTYPED (`lib/hr-full.ts`)**

Closes the capability gaps `docs/blueprints/hr-department-foundation.md` §3 listed as candidates,
plus five the blueprint did not name at all (leave accrual, effective-dated job history, document
expiry, compensation, statutory payroll). Four new controllers, all mounted on the SAME
`/api/:tenantId/modules/hr` prefix behind `AuthGuard + ModuleEnabledGuard("hr")` as §10, and all
behind the same `app_module_allowed('hr')` third wall.

**Status vocabulary, precisely.** The 33 new tables and their RLS are **DEV-VERIFIED** — the
migrations were applied to a real Postgres and `src/db/hr-full-rls.test.ts` proved FORCE RLS, a
byte-identical policy predicate, and zero-rows-without-module-scope on every one of them, plus seven
schema invariants (20 assertions, zero skips). The pure engines are DEV-VERIFIED by 109 unit tests.
The **handlers are PROTOTYPED**: they typecheck, they follow the established `withTenants(...,
{modules:["hr"]})` + `authorize()` shape, and their authorization is pinned by the IAM alignment
suites — but no one has driven the HTTP surface end-to-end against a running stack. Do not read
"BUILT" into any row below.

#### Three new Cerbos kinds

| Kind | Covers | Read tier | Write tier | High-assurance actions |
|---|---|---|---|---|
| `hr_policy` | holiday calendars, leave policies + assignments, review cycles, pay grades, statutory parameter sets | **everyone in the tenant** (see note) | `hr_people_ops` + `company_admin` | `ratify` (company_admin only) |
| `hr_recruitment` | requisitions, candidates, applications, interviews, scorecards, offers | `hr_people_reader` + `company_admin`; **plus** hiring manager / recruiter / panelist by attribute | `hr_people_ops` + `company_admin`; panelists may `create` a scorecard | `approve`, `convert`, `export` |
| `hr_payroll` | compensation, allowances, benefits, tax profiles, payroll runs, payslips, separations | `hr_people_ops` + `company_admin`; **plus** the subject's own PUBLISHED payslip | `hr_people_ops` + `company_admin` | `approve`, `export` |

> **`hr_policy` read is deliberately wide.** There is no person on the other side of a holiday
> calendar, and hiding the leave policy from the people it governs is a support ticket, not a
> posture. `hr_payroll` is deliberately a step ABOVE `hr_record`: an HR assistant who files leave and
> uploads contracts must not reach the salary book, which is why `hr_staff` holds neither
> `hr.payroll.view` nor any payroll write.

**All three are ROLE-ARM ONLY — no `perm_*` mirror.** Same posture `resource_employee.yaml` took
under P2-02, and here it is load-bearing: the recruitment panel rules are attribute-gated and a flat
permission mirror would collapse "only for an interview you are on" into an unconditional grant over
every candidate. See migration `202608240144_iam_hr_full_permissions.sql`'s header for the full
argument, including why `member` IS seeded (it is the `hr_case` precedent) and the one flagged gap in
0114's self-scoped marker.

#### Configuration — `hr-policy.controller.ts` (authorizes `hr_policy`)

| Method | Path (under `/api/:t/modules/hr`) | Returns |
|---|---|---|
| GET / POST | `/calendars` | `HolidayCalendar[]` / `{id}` |
| GET / POST | `/calendars/:id/holidays[?year]` | `Holiday[]` / `{upserted}` |
| DELETE | `/holidays/:id` | `{ok}` |
| GET | `/working-days?from&to[&calendarId]` | `WorkingDayBreakdown` |
| GET / POST | `/leave-policies` | `LeavePolicy[]` / `{id}` |
| PATCH | `/leave-policies/:id` | `{ok}` |
| GET / POST | `/leave-policies/:id/assignments` | `LeavePolicyAssignment[]` / `{id}` |
| GET / POST | `/review-cycles[?status]` | `ReviewCycle[]` / `{id}` |
| PATCH | `/review-cycles/:id` | `{ok}` |
| GET / POST | `/review-cycles/:id/participants` | `ReviewParticipant[]` / `{added}` |
| PATCH | `/review-participants/:id` | `{ok}` |
| GET / POST | `/pay-grades` | `PayGrade[]` / `{id}` |
| GET / POST | `/statutory-parameters` | `ParameterSet[]` / `{id}` |
| GET | `/statutory-parameters/:id` | `ParameterSetDetail` |
| POST | `/statutory-parameters/:id/ratify` | `{ok, ratifiedAt}` |

#### Recruitment — `recruitment.controller.ts` (authorizes `hr_recruitment`)

| Method | Path | Returns |
|---|---|---|
| GET / POST | `/requisitions[?status]` | `Requisition[]` / `{id}` |
| PATCH | `/requisitions/:id` | `{ok}` |
| POST | `/requisitions/:id/submit` | `{approvalId, status}` |
| GET / POST | `/candidates[?q]` | `Candidate[]` / `{id}` |
| POST | `/candidates/:id/erasure-request` | `{ok}` |
| GET / POST | `/applications[?requisitionId&stageKey&status]` | `Application[]` / `{id}` |
| GET | `/applications/:id` | `ApplicationDetail` (events, interviews, scorecards, offer) |
| POST | `/applications/:id/stage` | `{from, to, status}` |
| POST | `/applications/:id/interviews` | `{id}` |
| PATCH | `/interviews/:id` | `{ok}` |
| POST | `/applications/:id/scorecards` | `{id, applicationRating}` |
| POST | `/applications/:id/offers` | `{id}` |
| POST | `/offers/:id/status` | `{ok, applicationId}` |
| POST | `/offers/:id/convert` | `{employeeId, hireDate}` |
| GET / POST | `/pipeline-stages` | `PipelineStage[]` / `{upserted}` |
| GET | `/recruitment/funnel[?requisitionId]` | `FunnelStage[]` |

#### Compensation + payroll — `payroll.controller.ts` (authorizes `hr_payroll`)

| Method | Path | Returns |
|---|---|---|
| GET / POST | `/compensation[?employeeId&current]` | `Compensation[]` / `{id, supersededRows}` |
|  | ⚠ **`payPeriod` no longer exists.** POST takes `rateBasis` **and** `payFrequency`; GET returns both. | see §below |
| GET / POST | `/allowance-types` | `AllowanceType[]` / `{id}` |
| POST | `/employees/:id/allowances` | `{id}` |
| GET / POST | `/benefit-plans` | `BenefitPlan[]` / `{id}` |
| POST | `/employees/:id/benefits` | `{id}` |
| POST | `/employees/:id/tax-profile` | `{id}` |
| GET / POST | `/payroll-runs[?status]` | `PayrollRun[]` / `{id}` |
| GET | `/payroll-runs/:id` | `PayrollRunDetail` |
| POST | `/payroll-runs/:id/calculate` | `CalculateResult` (see below) |
| POST | `/payroll-runs/:id/approve` | `{ok, overrodeUnratified}` |
| POST | `/payroll-runs/:id/publish` | `{published}` |
| POST | `/payroll-runs/:id/paid` | `{ok}` |
| GET | `/payslips[?runId&employeeId]` | `PayslipSummary[]` |
| GET | `/payslips/:id` | `PayslipDetail` (itemized lines) |
| POST | `/payroll-inputs` | `{id}` |
| GET / POST | `/separations` | `Separation[]` / `{id, ...components}` |
| GET | `/separations/preview?employeeId&ground&effectiveOn` | `SeverancePreview` |
| POST | `/separations/:id/approve` | `{ok}` |

#### Lifecycle, compliance, analytics — `hr-lifecycle.controller.ts`

| Method | Path | Authorizes as | Returns |
|---|---|---|---|
| GET / POST | `/employees/:id/history` | `employee` | `JobEvent[]` / `{id, headMoved}` |
| GET / POST | `/cases/:id/events` | `hr_case` | `CaseEvent[]` / `{id}` |
| GET | `/compliance/expiring[?days]` | `hr_record` | `{windowDays, documents}` |
| POST | `/compliance/sweep` | `hr_record` | `{remindersCreated, notified}` |
| POST | `/leave/accrue` | `hr_policy` | `AccrualRunResult` |
| GET | `/leave/ledger[?subjectUserId&year]` | `hr_case` (staff-or-self) | `{subjectUserId, year, entries}` |
| GET | `/analytics[?from&to]` | `employee` | `HrAnalytics` |

---

### ⚠ Rate basis and pay frequency are two fields, and a consumer must show both

`hr_compensation.pay_period` was split (migration `202608260930`). It conflated the unit an amount
is QUOTED in with how often a payslip is PRODUCED, which are independent: an annual salary paid
monthly and an hourly rate paid weekly are both ordinary.

| Field | Owner | Values |
|---|---|---|
| `rateBasis` | HR — a fact about the contract | `hourly` `daily` `weekly` `monthly` `annual` `piece_rate` |
| `payFrequency` | Finance — an operational cadence | `weekly` `biweekly` `semi_monthly` `monthly` |

Three consequences for a consumer:

- **Never render an amount without its basis.** A monthly `12,000,000` and an annual `12,000,000`
  are a twelvefold difference and look identical on their own.
- **Do not invent a multiplier to compare rows.** `hr_annualisation_factor()` (SQL),
  `annualisationFactor()` (platform-nest) and `monthlyEquivalent()` (platform-ui `lib/hr-full.ts`)
  are the same numbers in three places, pinned against each other by tests. Use one of them.
- **`piece_rate` cannot be annualised from a rate at all** — the annual figure depends on output,
  which is not in the row. Every one of those three returns null/undefined for it. Exclude and
  COUNT such rows; folding a guess into a headline produces a wrong number that looks computed.

`payFrequency` other than `monthly` is accepted and stored, but `calculate` currently SKIPS those
employees and says why: PPh 21 withholding is implemented as monthly TER only, and taxing a weekly
slip at a monthly TER rate would under-withhold. That is a reported gap, not a silent approximation.

`hr_pay_grades` and `hr_offers` carry `rateBasis` only — a grade band and an offer quote a rate; the
cadence is set on the compensation record afterwards.

---

### ⚠ Six behaviours a consumer must render, not assume

These are the places where rendering the obvious thing produces a confident wrong answer.

1. **`turnoverRatePct` is `null`, not `0`, when average headcount is zero.** "No meaningful rate" and
   "nobody left" are different answers. Render `null` as `—`.

2. **A payroll `calculate` response carries `statutoryRatified` and `statutoryWarning`, and they are
   the most important fields in it.** The engine will happily compute against unratified numbers; the
   caller has to say so BEFORE showing a total, not after. `approve` then REFUSES against an
   unratified set unless `overrideUnratified: true` and an `overrideReason` are supplied, and the
   override is written to the run permanently.

3. **`calculate` returns a `skipped[]` array and it is never empty by accident.** An employee with no
   compensation record in force is SKIPPED and REPORTED, never paid zero — a zero payslip looks like a
   computed answer, a skip is visibly a gap. Show the count.

4. **A payslip is only visible to its subject once PUBLISHED.** `approve` and `publish` are separate
   calls on purpose: a run can be approved days before anyone should see their slip. `GET /payslips`
   under a member principal returns only `published_at IS NOT NULL` rows.

5. **A recruitment list under a non-HR principal is ALREADY NARROWED to what that person is attached
   to.** The controller applies the same relationship filter the policy's panel arm evaluates. Do not
   re-derive the narrowing client-side; render what you are given.

6. **`hr_case_events` with `visibility: 'hr_only'` are filtered OUT for a subject reading their own
   case.** A consumer must not "helpfully" merge a staff read and a self read into one cache — the two
   return different rows for the same case, by design.

### Statutory posture (read before wiring anything payroll-shaped)

`docs/blueprints/employee-portal-foundation.md` §6 assigned the payroll ENGINE to the employee-portal
program and gated it on "statutory facts". The owner directed on 2026-08-24 that payroll be built as
part of the HR department instead. That gate is honoured differently rather than dropped: **every**
regulated number lives in `hr_statutory_parameters`, effective-dated, with a `ratified_by` column
that is NULL until signed off; the engine hard-codes nothing; each run records which parameter set it
used; and finalizing against an unratified set requires a recorded override. The seeded Indonesian
figures (`DEFAULT_PARAMS_UNRATIFIED` in `payroll-calc.ts`, `DEFAULT_SEVERANCE_UNRATIFIED` in
`severance.ts`) are a TEST FIXTURE expressing the STRUCTURE of PP 58/2023 and PP 35/2021 — they are
not legally verified and must not be presented as such.

**Non-resident withholding (PPh 26) is NOT implemented.** `computePayslip` throws rather than
producing a plausible wrong figure, and `calculate` skips such employees with a reason.

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
    provider: 'github'|'google_drive'|'claude'|'cpanel'|'ftp'|'ssh'|'wp_admin'; // VLT-1: the 4 hosting kinds added 2026-09-04
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

### 12b. VLT-3 — the human credential-reveal path (`docs/plans/2026-09-04-client-hosting-credential-vault.md`) — `src/core/integrations.controller.ts` + `src/core/connection-reveal.ts` — **STATUS: PROTOTYPED (no Linux-container verification run yet — see the ticket report)**

`hasToken`-only reads (§12) are correct for machine deploys and useless when a person must log into
a client's cPanel today. This is the ONE deliberate exception: Cerbos-gated, WS4-approved (never
self-granted), TTL'd (default 15 min), single-use, exactly one audit row per successful reveal, and
the plaintext is never logged and never returned twice for the same grant. Rides the EXISTING
`automation_approvals` table (no new table, no new column, no new Cerbos action — see
`connection-reveal.ts`'s header for why) rather than the D14 hub-redrive registry, which is built for
automation/agent MCP tool calls and does not fit a human-facing single action.

- ✅ `POST /api/:t/integrations/connections/:id/reveal-requests` → `201 { id, status: 'pending' }`.
  Body: `{ reason? }`. Files a WS4 approval (`automation_approvals`, `origin='credential_reveal'`,
  `impact:'high'`). Filing requires only the same `update`-tier reach §12's PATCH already requires
  (self-owner, or manager+ for a company row/someone else's) — filing is not a promise of outcome.
  400 if the connection has no stored credential at all.
- ✅ `POST /api/:t/automation-approvals/:id/decide` (§ existing endpoint, unchanged path) — a
  reveal request decides through the SAME generic decide surface every other approval uses. Two
  reveal-specific rules apply ONLY when the row is a credential-reveal request: (1) the decider must
  hold `core.integration_connection.manage` on the named connection, checked unconditionally
  (`ownerId=""`) so a self-owned row's `owns` branch can never satisfy it — a plain member/viewer can
  never decide one, ever; (2) the decider may not be the same principal who filed the request (403).
  Approving does NOT return the plaintext — it only starts the grant's 15-minute clock.
- ✅ `POST /api/:t/integrations/connections/:id/reveal` → `200 { connectionId, revealedAt, value }`
  or a typed denial. Body: `{ approvalId }`. `value` is the plaintext credential — present in THIS
  response body only, never persisted anywhere, never logged. Requires an `approved` grant filed by
  THIS SAME principal, not yet redeemed, and still inside its 15-minute TTL from `decidedAt`; any
  other state is a named denial (`no_such_grant`|`not_your_grant`|`grant_not_approved`|
  `grant_already_used`|`grant_expired`|`connection_gone`|`no_token_to_reveal`) — 403/404/400
  depending on which. A second call with the same `approvalId` always denies (`grant_already_used`).
  Increments `integration_connections.reveal_count` and stamps `last_revealed_at` on success.
- Audit: exactly one `activities` row per successful reveal (`verb='revealed'`,
  `target_entity_type='integration_connection'`, `metadata.approvalId` — never the plaintext).
- **Known gap, flagged rather than built quietly around:** there is no dedicated `reveal` Cerbos
  permission key. Minting one requires a migration seeding `permissions`/`role_permissions`
  (IAM-14c/WSK-31's own precedent), which this pass could not add — the schema/migration lane was
  owned by a concurrent session. A role that should decide reveals but never otherwise administer
  connections cannot be expressed until that migration lands. See the ticket report for the exact
  migration shape needed.
- **Also not built here (§6 OQ-2.6 of the plan doc):** `INTEGRATION_TOKEN_KEY` rotation
  (`secret-box.ts`'s `token_key_version` is written, never read back — accepted as WSK-D33, not this
  ticket's problem to fix), the `CREDENTIALS.local.md` import (VLT-4), the rotation runbook (VLT-5),
  and last-used/expiry tracking beyond what VLT-6's columns already give this reveal path for free
  (`last_revealed_at`/`reveal_count` bumped here; a general `last_used_at` write for non-reveal use is
  a future deploy-automation ticket's job).

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
| ✅ | GET | `/api/:t/reports/document` | Query: `grain` (person\|project\|department\|company), `scopeRef`, `periodKind` (day\|week\|month\|custom), `start` (YYYY-MM-DD), `end` (optional, required when `periodKind=custom`), `servedTenant` (optional, department-grain only), `revision` (optional pin). Returns `ReportDocument` JSON (§6.1). Sealed calendar periods serve stored document; custom/open periods compute live. Authz: per-grain matrix (§8). **PV1-06a (2026-10-11, PV-D19) — `grain=company` WIDENED:** a principal holding `owner` (company scope) on `:t` now reads the Company Report, beside `company_admin` and `platform_admin`. Company grain only; person/project/department are unchanged for owners. |
| ✅ (PV1-06a, PROTOTYPED) | GET | `/api/:rootId/reports/group` | **The group report (PV-D19).** `group-report.controller.ts`. Query: `periodKind`, `start`, `end` — same rules and 400s as `document`. **Authz:** the owner of the root (an `owner` grant at company scope on `:rootId`) or `platform_admin`; checked FIRST, as two Cerbos reads on `:rootId` (`rollup:read` and `report_document:read_company`), both required. Then **404** unless `:rootId` is a live root company (`root_company_id = id`), so a child id is 404 even for its owner, and a member gets 403 before any 404. No module gate on the root itself. **Returns** `{ rootCompanyId, periodKind, start, end, companies: [{ companyId, name, vertical, figures: [{ metricKey, label, unit, value, numerator?, denominator?, additive }] \| null, figuresUnavailable?: "reports_module_not_enabled" }], sumOfCompanies: [{ metricKey, label, unit, value, companyCount }], consolidated: null, consolidatedReason: "needs F9 eliminations" }`. One card per live company with `root_company_id = :rootId`, root first, then by name. `figures` are that company's own Company Report KPIs (`grain=company`, the same sealed-else-live read), so a card always matches the company's report; `null` (never zeros) when the company does not have `reports` enabled. **Sum of companies** adds only figures marked `additive`: counts and minutes (the registry's additive class) plus the point-in-time overdue count. Ratios/percentages (and averages like WIP) and the distinct source-diversity count are never added or averaged. The company report carries no money today, so no currency rows appear; money must be summed per currency when it arrives. `companyCount` < number of cards means some cards had no figures. **Consolidated** is always `null` until F9 eliminations exist — render the reason, not a number. UI: PV1-06b. |
| ✅ | GET | `/api/:t/reports/overview` | Query: `grain`, `periodKind`, `start`, `end`. Returns `{periodKind, start, end, scopes:[{scopeRef, scopeName, kpis:[]}]}` (console landing, headline KPIs per scope). Authz: per-grain read. **UI consumers: `lib/reports-data.ts::getReportOverview` — the project/department report pages use it as a scope PICKER; the GM console's cockpit + Departments tab (GM-03/04) use it as the DATA, at `grain=company` and `grain=department`.** ⚠ It carries **no `sealed` flag and no `generatedAt`** (unlike `ReportDocument.header`), so a consumer must not present these figures as the sealed record — `GmProvenance` states that limit in the UI rather than implying either answer. |
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
| ✅ | GET | `/api/:t/checkins/compliance` | Query: `unit`, `periodKind`, `start`, `end` (optional, required when `periodKind=custom`). Compliance grid (expected/submitted/missed/excused). Authz: lead/exec/HR or self-for-own-row (TR-39). **UI consumer since GM-07: `lib/checkins-data.ts::getCheckinCompliance`, read by the GM console's People tab.** Three behaviours a consumer must honour, all of them load-bearing: ① **it does NOT 403 a plain member** — it degrades to a one-row self grid, so `rows.length === 1` is not an error and must not be presented as a team view; ② **`unit` in the response is an ECHO of what the server actually scoped to**, which it rewrites for a unit-scoped (dept-lead) caller — read the echo, never the request; ③ **`complianceRate` is `null`, never `0`, when `expectedDays === 0`** — "nobody was due" is not "nobody complied", and rendering `null` as 0% invents a company-wide failure. `lib/checkins.ts::rollUpCompliance` sums numerators/denominators rather than averaging per-person rates (averaging weights one expected day the same as twenty, which is how a headline figure ends up disagreeing with the grid beneath it). |
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

**Which company's portal (PV2-05, 2026-10-10).** Every portal page, the layout and
`portalActions.ts` take the `:t` in `/api/:t/portal/*` from ONE resolver,
`platform-ui/src/lib/portal-company.ts` (`getActivePortalCompany`).

- It reads only `Me.clientOf` (§1): the companies the caller is an active client contact of. It
  never reads `Me.companies`, so a person employed by one group company is never shown that
  company's portal.
- The choice is kept in its own cookie, `gaiada_portal_tenant`, separate from the staff
  `gaiada_tenant`.
- A guard test (`portal-company.guard.test.ts`) fails if any portal file calls `getActiveTenant`.
- One request still targets one company, so isolation is unchanged; this only decides which company
  a request names.

### Isolation model — read this before adding a portal route

Four layers, and only the third is per-client:

1. **RLS** — tenant, in Postgres (FORCE RLS on the authorized-tenant-set).
2. **Cerbos** — the `client` derived role on the `portal` resource. Actions: `read`, `decide`, `sign`,
   `pay`, `update_profile` (and later `request_change`, `approve_post`, `edit_company_profile`, and PV4-02's `converse`, the Conversation write
   action, §29). **Cerbos does not see rows**, so `read` means "may ask the portal", never
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
| ✅ | GET | `/api/:t/portal/overview` | The whole landing payload in ONE request: `{clients[], client, viewOnly, progress{projects,activeProjects,completedProjects,percent}, deliverables{total,delivered,overdue}, nextMilestone, needsYou[], finance{byCurrency[],primary}}`. `needsYou[]` = `{kind:'gate'\|'contract', id, requires:'signature'\|'feedback', label, context, href, since}`. Progress is the mean of PROJECT progress (not of pooled tasks), each project weighted by `pm_tasks.progress` with `done` counting 100. Finished projects = status completed, archived, cancelled (`core/project-status.ts`; PV2-09 closed `projects.status` to planned, active, on_hold, completed, cancelled, archived); `activeProjects` = not finished, `completedProjects` = completed. **Additive (PV4-06):** `conversationUnread: number` = threads in the caller's scope with unread messages from staff (§29d). |
| ✅ | GET | `/api/:t/portal/projects` | `PortalProject[]` — progress, milestone counts, deliverable count, next milestone due. **Additive (PV2-03):** `finished: boolean` — `status` is one of `FINISHED_PROJECT_STATUSES` (`core/project-status.ts`), the same constant the sort order uses; the UI must not re-derive it. |
| ✅ | GET | `/api/:t/portal/projects/:projectId` | Adds `milestones[]`, `deliverables[]`, `runs[]`, `workload{todo,in_progress,blocked,done}`. **Additive (PV2-03):** `finished: boolean` (as on the list) and `lead: {name,email} \| null` — `projects.owner_id` → `users`; null when there is no owner or the owner is deleted/disabled. **Never returns individual tasks** — `workload` is aggregate counts only. 404 for another client's or another project-scope's project. |
| ✅ | GET | `/api/:t/portal/milestones` | Commitment calendar across visible projects. |
| ✅ | GET | `/api/:t/portal/timeline` | `?limit` (clamped 1–400, default 120). `PortalTimelineEvent[]` = `{kind, id, label, status, at, tense:'due'\|'happened', context, projectId}`. Composed as a UNION over client-visible OBJECTS — **never** from `activities`, so a new internal event type cannot leak into a client's feed by default. |
| ✅ | GET | `/api/:t/portal/deliverables` | `?projectId`. Attachment metadata batched in one query (`files[]` per deliverable). |
| PROTOTYPED | GET | `/api/:t/portal/meetings[?projectId]` | **Meeting minutes (PV4-05, §29c).** The minutes a staff member SHARED with the client, newest first (max 200): `{id, title, meetingDate, bodyMd, sharedAt, sharedBy}[]`. A draft never appears; a project-less meeting's minutes reach client-wide contacts only. 400 on a malformed `projectId`. |
| PROTOTYPED | GET | `/api/:t/portal/meetings/:minutesId` | One set of shared minutes (same shape). **404** for a draft, another client's, a project the contact is not scoped to, a project-less meeting for a project-scoped contact, a soft-deleted meeting, a non-uuid or unknown id: one answer for all of them. Never returns the transcript, recording, audio, Drive link, participants or pipeline run. |

**Conversation (PV4-03)** is its own portal area under `/api/:t/portal/conversation*`: see **§29** (a thread per project plus one client-wide thread, unread counts, live topic `conversation`).

### 16b. Commerce — `src/core/portal-commerce.controller.ts`

| Status | Method | Path | Notes |
|---|---|---|---|
| ✅ | GET | `/api/:t/portal/invoices` | `draft` excluded. Adds `paid`, `pendingConfirmation`, `balance`, `overdue`. **PV5-04 (PROTOTYPED):** adds the invoice of record — `invoiceNo`, `issueDate`, `dueDate`, `subtotal`, `taxTotal`, `taxCode`, `issuer` (the snapshot frozen at issue: `legalName`, `address`, `npwp`, `isPkp`, `bank {name, accountName, accountNo}`), `outstanding` (the LEDGER's for an issued invoice; total − confirmed for a legacy one) and `payable` (issued, `sent`, and something still owed after the claims being verified). `overdue` is now by DUE date (a legacy invoice with no due date falls back to its period end); `issuedAt` is the issue time (created time on a legacy row). An approved-but-unissued invoice stays hidden (PV3-02d). **Not** `ModuleEnabledGuard("invoice")`-gated — a client with invoices must keep reading them if the module is switched off. |
| ✅ | GET | `/api/:t/portal/invoices/:invoiceId` | Frozen `lines[]` + `payments[]` + `paid`/`balance`. **PV5-04:** the same invoice-of-record fields as the list (incl. `payable`, `outstanding`, `issuer`) plus `taxLines[] {code, rate, base, amount}` from the ledger lines. The UI hides the "Tell us you've paid" form when `payable` is false and shows a "How to pay" block from `issuer.bank`. |
| ✅ | POST | `/api/:t/portal/invoices/:invoiceId/payments` | `{amount, paidOn(YYYY-MM-DD), method, reference?, note?, proof?{filename,contentType,content(base64)}}`. Records a **CLAIM**: inserted `status='pending'`, `invoices.status` untouched, `client_id`/`currency` read from the invoice (never the body). Refuses future dates. **PV5-04:** authorization (`portal` `pay`) now runs before validation; only an ISSUED invoice accepts a claim (**409** `reason: not_issued` otherwise, legacy invoices included); the amount is bounded by the LEDGER's outstanding less the claims still pending, compared in `numeric` with no tolerance (an allocation can never exceed what is owed), and may not have more decimals than the currency allows (both **400**). Proof ≤10 MB decoded (`MAX_PROOF_BYTES`); the route's Fastify `bodyLimit` is raised to **14,046,550 bytes** (PV4-03b: `ceil(10 MiB × 4/3)` for the base64 + a 64 KiB JSON-envelope allowance), so a proof up to the cap reaches the handler and one byte over gets the handler's own `400 {error: "proof file too large (max 10 MB)"}`, not the body-limit `413 {error: "payload too large", code: "payload_too_large"}` (Fastify's FST_ERR_CTP_BODY_TOO_LARGE). Every other route keeps the 1 MiB default. Action `pay`; **capability not required**. |
| ✅ | GET | `/api/:t/portal/contracts` | `draft` excluded. `clientSigned`/`providerSigned`/`termEnded` per row (`termEnded` derived on read, never written back). **PV4-04 (PROTOTYPED):** every row also carries `kind` (`agreement \| amendment`), `amendsId` and `amendsReference` (the amended contract's id and reference, or `null`) and `changeRequestId`. The two joined rows go through the caller's own scope predicates, so a project-scoped contact never learns the id or reference of a contract, or the id of a request, outside their reach: out of scope reads `null`. |
| ✅ | GET | `/api/:t/portal/contracts/:contractId` | Adds `bodyMd`, `document`, `signatures[]`, `canSign`, `viewOnly`. **`canSign` is the exact conjunction `POST /sign` enforces** — mirror it, never recompute it. **PV5-06 (PROTOTYPED):** adds `contentSha256` (the SHA-256 the server fixed when the contract was sent: the stored file's bytes, else the exact UTF-8 `bodyMd`; `null` only on a contract sent before PV5-06) and `signatureTier` (`attested` \| `certified`). `canSign` is also `false` for a `certified` contract. **PV4-04 (PROTOTYPED):** also `kind`, `amendsId`, `amendsReference`, `changeRequestId`, exactly as on the list. An amendment is shown like any other contract once it is `sent`; a `draft` amendment is 404, as every draft is. An amendment never voids or supersedes the contract it amends. |
| ✅ | POST | `/api/:t/portal/contracts/:contractId/sign` | `{signerName, signerTitle?, agree:true, contentSha256}`. `agree` refused server-side if absent. Requires `signer` capability. Idempotent — a re-sign answers 200 `{alreadySigned:true}`, checked BEFORE the status check (signing is what changes the status). Flips to `signed` only when BOTH parties are present. **PV5-06 (PROTOTYPED): the client signs what they saw.** `contentSha256` is the hash the GET returned, echoed back; the server compares it (case-insensitively) with the hash it fixed at send and writes nothing on a difference: **409 `{error:"this agreement changed since you opened it; reload it and read it again before signing", reason:"content_changed"}`**. A contract with a stored hash and no echo is **400 `reason:"content_hash_required"`** (the page reloads and signs again). The signature row records the stored hash (never the echo), the salted IP hash and the user agent. A **`certified`-tier** contract refuses the typed name: **400 `reason:"certified_tier"`** (certified signing is parked, PV-D25). A contract sent before PV5-06 has no stored hash and signs as before, recording none. Authorization now runs BEFORE body validation (a caller who may not sign gets 403 for any body; before, a thin body got 400). Rows outside the caller's scope stay 404. UI: `portalSignContract` sends the hash from the hidden `contentSha256` field and, on the 409, reloads the page with "This agreement changed since you opened it…". |
| ✅ | GET | `/api/:t/portal/files/:fileId` | The portal's OWN download. Resolves ownership by walking the file's parent entity through the scope predicate; parent kinds limited to `deliverable\|contract\|invoice_payment\|project\|conversation` (`conversation` = a message attachment, admitted through its thread and only while the message is not retracted, §29). Attachment-only + `nosniff` + sandbox CSP. **Do not link the staff `/files/:id/content` route from the portal** — it authorizes on the parent resource kind, which the `client` role does not hold, so it 403s by design. |

### 16c. Profile — `src/core/portal-profile.controller.ts`

| Status | Method | Path | Notes |
|---|---|---|---|
| ✅ | GET | `/api/:t/portal/profile` | `{me, clients[], contacts[], access{canSign,wholeClient,grants[]}}`. `contacts[]` = fellow contacts of THEIR clients only. **Additive (PV2-03):** `clients[].accountManager: {name,email} \| null` (`clients.owner_user_id` → active, non-deleted `users`; read only for clients in the caller's scope) and `contacts[].side: 'client' \| 'provider'` (`users.kind = 'client'` → `client`, anything else → `provider`; `side` labels, it never filters anyone out). |
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

Topics (8): `approvals · projects · deliverables · invoices · contracts · profile · requests · conversation`. `requests` = a webdev change request submitted/triaged/converted (§16f); `conversation` = a conversation thread opened/updated or a message posted/edited/retracted (PV4-03, §29), narrowed to the thread's client; `projects` also carries `meeting.minutes.shared` (PV4-05, §29c: a staff member shared a meeting's minutes, narrowed to the meeting's client). The browser copy of this list is `PortalTopic` in `platform-ui/src/lib/portal.ts` and must match `portal-live.service.ts`. The event→topic map in
`portal-live.service.ts` is an **allowlist** — an unmapped event type produces no frame, so adding an
internal event cannot wake a client's browser by default.

### 16e. Staff counterpart — `src/core/contracts.controller.ts` (**UI built: `/clients/[id]/billing`, PV3-08, PROTOTYPED**)

Shipped in the same change because without it the portal's contracts section is permanently empty and
a client-recorded payment can never leave `pending`.

| Status | Method | Path | Notes |
|---|---|---|---|
| ✅ | GET | `/api/:t/contracts` | `?clientId`, `?status`. Authz: `contract` read (company_admin/manager). **PV3-01 (PROTOTYPED):** `?clientId` is the strict CC-1 facet (`parseClientFilter(raw, true)`): a uuid, or `internal` (`client_id IS NULL`, always empty here since a contract always has a client); anything else is a **400** (it used to 500 on a uuid cast). Parsed after the read check, so an unauthorized caller still gets 403. Every row carries `canCountersign` (below). **PV4-04 (PROTOTYPED):** every row also carries `kind` (`agreement \| amendment`), `amendsId`, `amendsReference` (the amended contract's `reference`) and `changeRequestId`. |
| ✅ | GET | `/api/:t/contracts/:contractId` | Adds `signatures[]` (each with `contentSha256` since PV5-06), and `canCountersign` (PV3-01). **PV5-06:** both GETs carry `contentSha256`, `contentFixedAt`, `signatureTier` (`attested` \| `certified`, `null` while draft) and `certifiedRequested`. **PV4-04 (PROTOTYPED):** the same four amendment fields. |
| ✅ | POST | `/api/:t/contracts` | Always created `draft`. Validates the project belongs to the named client; `supersedesId` bumps `version`. **PV3-06 (PROTOTYPED):** authorizes before it validates (a caller who may not draft gets 403 for any body). **Idempotent on `reference`** (readiness-bar criterion 3): the insert is `ON CONFLICT (tenant_id, reference, version) … DO NOTHING` against `ix_contracts_reference_uniq`; a repeat returns `{id, status, deduped:true}` for the existing contract (still 201, status is its real status), the same reference under another client is a **409**. A draft with no `reference` has no natural key and is not deduped. **PV4-04 (PROTOTYPED): `kind?`, `amendsId?`, `changeRequestId?`.** `kind` defaults to `agreement`; `kind:'amendment'` REQUIRES `amendsId`, a `signed` contract of the same client. Typed 400s (checked after authorize): `kind_invalid`, `amends_id_required`, `amends_id_requires_amendment` (an agreement cannot name one), `amends_id_invalid` (not found, another client's, not signed, or not a uuid: one code, so it is never an existence oracle), `change_request_invalid` (unknown or another client's request: one code), `change_request_not_price_changing` (the request is not yet triaged `changes_price`). `changeRequestId` also points the request's `amendment_contract_id` at the new draft, but ONLY when the request is not already waiting on a live (`draft`/`sent`) or `signed` contract: that is **409 `change_request_already_linked`** and the draft is rolled back (a declined, void or expired contract is how a request is re-pointed). An idempotent replay on `reference` returns `deduped:true` and touches nothing. This route is authorized on `contract` create, not `triage`, so it can never swap out a live amendment. |
| ✅ | PATCH | `/api/:t/contracts/:contractId` | Draft-only, except `status:'void'`. A sent/signed contract is re-issued via `supersedesId`, never edited. **PV3-06 (PROTOTYPED):** a call that arrives through an OBO envelope (an agent or n8n via the hub; `currentVia()` set) is refused **400 `status_not_allowed_via_automation`** if the body carries any `status`, checked after authorize(); void stays a human act (a staff browser session carries no envelope). There is no `contracts.void` tool. |
| ✅ | POST | `/api/:t/contracts/:contractId/send` | `draft → sent` + notifies signer contacts. Refuses with no document or `bodyMd`. Action `send`. **PV5-06 (PROTOTYPED): sending FIXES the content and CHOOSES the tier, in one UPDATE.** The server computes `content_sha256` (SHA-256 of the attached file's STORED bytes, else of the exact UTF-8 `bodyMd`; never from anything the caller sends), sets `content_fixed_at` and `signature_tier`; from then on the database refuses any change to the file, body, hash, stamp or tier. Tier is `certified` when staff marked the draft (`certified_requested`), or `value >=` the company's `company_billing_profiles.signature_threshold`, or it is an `amendment` of a `certified` agreement; else `attested`. While a threshold exists an unvalued contract is **400** ("set the contract's value before sending") and a value in a different currency than the threshold's is **400** (cannot be compared); nothing is written. A `certified` result is **409 `reason:"no_certified_provider"`** ("no certified signing provider is set up") until PV5-11 lands, so no contract is sent that nobody can sign. A file whose stored bytes no longer match the `files.sha256` recorded at upload is **409**; a link-only file (no stored bytes) is **400**. Response: `{ok, status:"sent", notified, contentSha256, signatureTier}`. |
| ✅ | POST | `/api/:t/contracts/:contractId/mark-certified` | `{certified?: boolean}` (default `true`). **PV5-06 (PROTOTYPED).** Draft only; sets `certified_requested`, which `send` turns into the `certified` tier. Action `mark_certified` (PV5-02: company_admin and platform_admin; the permission arm). Authorized FIRST. **Answers 409 `{error:"no certified signing provider is set up", reason:"no_certified_provider"}` and writes nothing while no provider is set up (PV-D25 parks PV5-11).** A non-draft contract is 400. |
| ✅ | POST | `/api/:t/contracts/:contractId/countersign` | `{signerName, signerTitle?, contentSha256?}`. Action `countersign`. **PV5-06 (PROTOTYPED):** the provider signature records the hash fixed at send (so both parties' rows name the same content), the salted IP hash and the user agent, exactly as the client side does. `contentSha256` is an optional "what I saw" echo: when present and different from the stored hash it is **409 `reason:"content_changed"`** and nothing is written. A `certified`-tier contract is **400 `reason:"certified_tier"`**. Through D14 (`contracts.countersign`) the re-drive runs this same route as the human the agent served, so it records the hash like a direct call; the IP hash and agent are those of the hub's hop. **Corrected 2026-10-11 (PV3-01, PROTOTYPED):** allowed for an **`owner` of the contract's company** (company-scope `owner` grant on this tenant) and for `platform_admin` (its wildcard). `group_executive` no longer exists. company_admin, manager, an owner of another company, and any custom role (even one holding every `core.contract.*` key, `core.contract.countersign` included) get 403: no permission-arm rule reads that key, which is catalogued `uiGrantable: false` only because the policy names the action. **PV3-06 (PROTOTYPED):** authorizes BEFORE it validates `signerName`, so a company_admin with an empty body gets 403, not 400 (it used to read the body first). A repeat returns `{alreadySigned:true}` and writes no second activity. |
| ✅ | GET | `/api/:t/invoice-payments` | `?status`, `?clientId=<uuid>\|internal` — finance's confirmation queue. `clientId` is the strict §22a facet (PV3-03, PROTOTYPED): a uuid lists only that client's payments (filters `invoice_payments.client_id`), `internal` lists payments whose invoice names no client (the column is nullable), a non-uuid is **400**. Authz: `invoice` read, checked before `clientId` is validated. |
| ✅ | POST | `/api/:t/invoice-payments/:paymentId/decide` | `{decision:'confirm'\|'reject', reason?}`. `reason` required to reject. **Refuses self-confirmation** (recorder ≠ confirmer). Notifies the client either way. Authz: `invoice` update, checked before the body is validated (PV3-06). **PV5-04 (PROTOTYPED):** on an ISSUED invoice, confirm POSTS the money in the same transaction — an AR receipt (`{prefix}/RC/{yyyy}/{nnnn}`, dated `paidOn`) into the billing profile's receipt account, allocated to the AR invoice (`invoice_payments.ar_receipt_id` set) — and the invoice becomes `paid` exactly when the AR invoice does. **409** with nothing written when the amount exceeds the ledger's outstanding (`overpayment`), the invoice is void (`invoice_void`), it was never issued and is not legacy (`not_issued`), there is no receipt account, or the ledger refuses (closed period: the FINANCE_* code). A reject posts nothing. A LEGACY (pre-PV-5) invoice keeps the old derivation (confirmed ≥ total − 1, in SQL numeric). |

**Price amendments (PV4-04, PV-D5, PROTOTYPED).** A change request that changes the price cannot start until an
amendment recording the new price is `signed` here, on both sides. The rule lives in the change-request routes (§16f-iii);
this surface carries the data. `contracts.kind` is `agreement` (default) or `amendment`; `amends_id` names the SIGNED
contract an amendment amends; `change_request_id` names the request that caused it. **An amendment never voids or
supersedes what it amends** (`supersedes_id` keeps its re-issue meaning: v2 replaces v1). Triage with `changes_price`
creates the draft here, in the same transaction; staff then write the terms, send it and countersign it like any
contract. When it becomes `signed` the `contract.signed` handler (`core/amendment-signed-handler.ts`) notifies the
request's triager (`webdev.change_request.unblocked`, href `/departments/web-dev/requests?request=<id>`) that it can
start; it changes no status. Voiding or declining the amendment leaves the request blocked until staff re-triage.

**`canCountersign` (PV3-01, PROTOTYPED).** On every row of both GETs. True only when all three hold: Cerbos allows `countersign` on `{kind:"contract", tenantId}` for this caller (ONE soft check per request, never per row; for an `actFor` call the acting user must be allowed too), the status is `sent`, and there is no `provider` signature. It is a hint for showing the Countersign control; the POST stays the authority. A probe failure reads as `false`, never a 500.

**Staff UI — PV3-08 (PROTOTYPED, 2026-10-12): `/clients/[clientId]/billing`**, the hub's "Contracts & billing" tab (between Business and People). Three sections:

- **Contracts**, grouped Draft · Sent · Signed · Void (plus "Declined or expired" when a row has that status, so none is dropped). Draft form (title, reference, a project of this client, value and currency, term dates, terms in markdown, optional PDF), Edit (draft only), Send (disabled with its reason when there are neither terms nor a file), Void (any state, with a confirm), and Countersign **only on a row whose `canCountersign` is `true`**. A sent contract shows who has signed (party, name, title, date; from `GET …/contracts/:id`, one read per sent contract). The PDF goes up through `POST /files` with `entityType:"contract"` once the draft exists, then `PATCH {fileId}`; if the draft saves and the file does not, the message says the draft WAS saved.
- **Payments to confirm**: `GET /invoice-payments?clientId=&status=pending`. Confirm, or Reject with a required reason. The maker-checker 403 is shown in words ("You recorded this payment…").
- **Invoices**: a list only (`GET /invoices?clientId=`), linking to `/invoices/[id]`. D7 is open, so nothing deeper.

Every read goes through `readResult()` and refuses explicitly (`<ReadRefusal>`); there is no `.catch(() => [])`, and the invoices read deliberately does not use `listInvoices` (which folds 403 into `[]`). **Tab badge** = pending payments (from the overview's `needsUs`) + contracts the caller may countersign (one `GET /contracts?clientId=` in the layout, fail-soft to "no figure", never `0`). The Overview's payment and contract items link to this page. No "who sees this" markers yet (PV3-09). **File links (PROTOTYPED):** "PDF attached" and "Proof of payment attached" link to the UI's own `GET /api/files/:fileId` (`platform-ui/src/app/api/files/[fileId]/route.ts`), which streams the platform's `GET /api/:t/files/:id/content` with the caller's session for their ACTIVE company (see the files row). A refused read answers in words.

**MCP tools — PV3-06 (PROTOTYPED, 2026-10-12)**, in `core/core-tools.ts`, each a thin front over the endpoint above with that endpoint's authorization. The hub fills `:param` tokens and sends the rest as the body; a GET's remaining args are dropped, so the two list tools carry `clientId` as a query token and require it.

| Tool | Method + path | Impact | D14 |
|---|---|---|---|
| `contracts.list` | GET `/api/:t/contracts?clientId=` | read | no |
| `contracts.get` | GET `/api/:t/contracts/:contractId` | read | no |
| `invoicePayments.list` | GET `/api/:t/invoice-payments?clientId=` | read | no |
| `contracts.createDraft` | POST `/api/:t/contracts` (`reference` required: the idempotency key; **PV4-04:** also `kind`, `amendsId`, `changeRequestId`) | low | no |
| `contracts.updateDraft` | PATCH `/api/:t/contracts/:contractId` (no `status`: voiding is not a tool) | low | no |
| `contracts.send` | POST `…/send` | medium | yes: `contracts.send` entry, precondition `contract_not_draft` / `contract_has_no_document` |
| `contracts.countersign` | POST `…/countersign` | high | yes: precondition `contract_not_sent` / `contract_already_countersigned` |
| `invoicePayments.decide` | POST `…/decide` | high | yes: precondition `payment_not_pending` / `payment_decision_invalid` / `payment_reject_reason_required`; approver rule `approver_recorded_this_payment` |

Approving a medium/high call executes it as the ORIGINAL filing principal (D14 invariant 1), so a company_admin's approved `contracts.countersign` is refused at execution (403) and the recorder's approved `invoicePayments.decide` is refused (maker-checker). **Approver rule (2026-10-12, PROTOTYPED):** because the re-drive runs as the filer, the route's maker-checker check never saw the APPROVER, so the payment's recorder could approve someone else's agent request to decide that payment. `invoicePayments.decide` now declares an `approverCheck` (the general hook on `ExecutableApprovalEntry`): approving it as the payment's `recorded_by` (or with `x-act-for` naming them) is refused at `POST /api/:t/automation-approvals/:id/decide` and the `POST /api/:t/approvals/:id/decide` façade with **403 `{error, reason:"approver_recorded_this_payment"}`**, before the decide UPDATE, so the row stays `pending` and nothing executes. Both decisions (confirm and reject) are covered, as on the route. Rejecting the request stays open to the recorder. The executor re-checks the stored `decided_by` and fails the row `approver_refused: approver_recorded_this_payment` without calling the hub. `contracts.send`/`countersign` declare no approver rule. `send`, `countersign` and `decide` write an `activities` row with the actor, `metadata.via` (the agent or workflow) and the approval, so the actor may be non-human.

**History (2026-08-24, CC-2, §22b).** Before PV3-08 the pending payment and the unsent draft were only SURFACED, in the client hub's `needsUs` list with an age; the write UI (the "Commercial" tab, slice 2 of the CC-* program) was never built. PV3-08 is that slice, under its new name.

### 16f. Change Requests (maintenance intake) — `src/core/webdev-change-requests{,-portal}.controller.ts` — **STATUS: DEV-VERIFIED (MI-01..05)**

Portal view for client-submitted change requests + staff triage queue.

#### 16f-i. Portal — client submission and tracking

| Status | Method | Path | Notes |
|---|---|---|---|
| ✅ | GET | `/api/:t/portal/change-requests` | `{id, kind, title, body, status, route, clientId, projectId, projectName, pipelineRunId, pmTaskId, declinedReason, requestedBy, createdAt, updatedAt}[]`. Client's own requests (own clients, own project scope), newest-first, capped at 200. Authz: `portal` read. **PV4-04 (PROTOTYPED):** every row also carries `priceImpact` (`unassessed \| none \| changes_price`) and `amendmentContractId`. The id comes from the caller-scoped contract join, so it is `null` while the amendment is a `draft` (the agency's unissued working copy is never disclosed), and once it is `sent` it is the id the portal can open at `/portal/contracts/:id`. `priceImpact: 'changes_price'` with a `null` id means "waiting on an amendment we have not sent yet". |
| ✅ | GET | `/api/:t/portal/change-requests/:id` | Single request. 404 for out-of-scope (not 403 — same existence-oracle avoidance as other portal detail endpoints). Authz: `portal` read. **PV4-04 (PROTOTYPED):** the same two fields. |
| ✅ | POST | `/api/:t/portal/change-requests` | `{kind, title, body?, projectId?, clientId?}` → `{id, status:'new'}`. `kind` ∈ `content|design|feature|bug`. `title` required, ≤300 chars. Server-derives `client_id`, `project_id`, `requested_by`, `source='portal'`, `status='new'` (all from request context, never body-trusted). Viewer-permitted (capability `request_change`, gated on `portal` resource only — no `canSign` check). Emits `webdev.change_request.created` and notifies the client's project owners (best-effort). |

#### 16f-ii. Staff — triage queue and conversion

| Status | Method | Path | Notes |
|---|---|---|---|
| ✅ | GET | `/api/:t/webdev/change-requests` | `{id, kind, title, status, route, clientId, clientName, projectId, projectName, source, requestedBy, requestedByName, triagedBy, triagedByName, triagedAt, declinedReason, createdAt, updatedAt}[]`. Triage queue + full list. `?status`, `?clientId`, `?projectId`, `?kind` filters. Oldest-first (queue order), capped at 200. Authz: `webdev_change_request` read (manager/module-manager+ — `member` excluded). **PV4-04 (PROTOTYPED):** every row also carries `priceImpact`, `amendmentContractId` and `amendmentStatus` (the linked contract's status, `null` when none). |
| ✅ | GET | `/api/:t/webdev/change-requests/:id` | Full row + linked artifact status. Adds `body`, `runStatus`, `runTitle`, `taskTitle`, `taskStatus` (joined at read time, so CR shows live status without a stale copy). Authz: `webdev_change_request` read. **PV4-04 (PROTOTYPED):** also `priceImpact`, `amendmentContractId`, `amendmentStatus`. |
| ✅ | POST | `/api/:t/webdev/change-requests` | `{kind, title, body?, clientId?, projectId?}` → `{id, status:'new'}`. Staff-logged maintenance work. `source='internal'` (staff-raised, no client solicitation). `client_id` may be NULL (internal-only work). Server-derives all identity fields. No notification on create (internal work, not client-actionable). Authz: `webdev_change_request` create. |
| ✅ | POST | `/api/:t/webdev/change-requests/:id/triage` | `{action, route?, reason?, kindOverride?}` → `{id, status, route, pipelineRunId?, pmTaskId?, signers[]?}`. Single triage decision (decline or convert). `action` ∈ `decline|convert`. Decline requires `reason` (≤1000 chars); convert picks a `route` ∈ `control_plane|mini_run|pm_task` (defaults by kind: content→pm_task, design/feature→mini_run, bug→pm_task). `kindOverride` ∈ `content|design|feature|bug` (optional, re-stamps the kind if provided). Serialized on the CR + precondition re-check (lock → re-read → check `status='new'` → spawn/update). **D-2a:** CR table takes CORE tenant wall, no `app_module_allowed()`. **F1:** notification audience follows source (portal requests notify contacts; internal requests don't — even when converted to a mini-run that opens a real `prd_sign` gate the client must sign, the disposition *notification* is withheld for internal-sourced requests; the gate opening itself notifies signers separately). Converts mini_run route spawn gates `prd_sign` directly (no dispatcher step); emits `pipeline.run.created` with honest `sourceMeetingId:null`. Emits `webdev.change_request.updated` + lifecycle event per outcome. Authz: `webdev_change_request` triage. **PV4-04 (PROTOTYPED, PV-D5): a `convert` MUST carry `priceImpact` (`none \| changes_price`) and may carry `amendsId`; see §16f-iii.** A convert without it is **400 `price_impact_required`**, any other value (`unassessed` included) is **400 `price_impact_invalid`**; a `decline` is not asked. Authorization still runs before all of it. **The staff UI's triage action must send `priceImpact` or every convert 400s.** |

#### 16f-iii. Price impact and amendments (PV4-04, PV-D5's binding rule — PROTOTYPED)

`webdev_change_requests.price_impact` is `unassessed` (the default; every row that predates PV4 keeps it and is
**grandfathered: never blocked**), `none` or `changes_price`.

**`priceImpact: "none"`** behaves exactly as triage did before. If the request still points at a live (`draft`/`sent`) or
`signed` amendment it is **409 `amendment_exists`** (void or decline the amendment first; a declined, void or expired one is
dropped and the pointer cleared).

**`priceImpact: "changes_price"`**, in the same transaction as the triage:

- No live amendment yet (never made, or the last one is `declined`, `void` or `expired`): a **draft contract** is created and linked both ways
  (`contracts.change_request_id`, `webdev_change_requests.amendment_contract_id`, which a re-triage re-points to the fresh draft), titled
  `Amendment: <request title>`, with the request's `client_id` and `project_id`.
  - `amendsId` (optional) must be a `signed` contract of the SAME client, else **400 `amends_id_invalid`**.
  - Without it the target is the project's latest `signed` agreement, else the client's latest `signed` master agreement
    (`project_id IS NULL`). Agreements only: amendments stack on the agreement, not on each other.
  - When there is no signed agreement to amend, the draft is `kind:'agreement'` with no `amends_id` (titled `Agreement: <title>`).
  - A request with no client is **400 `client_required_for_price_change`**.
- **Nothing starts.** The request stays `status:'new'`, `route:null`, with no run or task, and the response is
  `200 {id, status:'new', route:null, priceImpact:'changes_price', blocked:true, amendmentContractId, amendmentKind, amendsId}`.
  The client is not told: a draft is the agency's working copy until staff send it.
- Re-triage while the amendment is live (`draft`/`sent`) is **409 `amendment_not_signed`**, with
  `existing:{amendmentContractId, amendmentStatus}`. No second draft is ever made for a live one.
- Re-triage once the amendment is `signed` goes ahead: the signed contract is reused (never duplicated) and the request converts as
  usual, so the PM who got the "can start" notice re-triages with a `route`.

**The rule: every transition that STARTS work is refused with `409 amendment_not_signed` while a `changes_price` request's linked
contract is not `signed`.** Code paths guarded: triage `convert` for every route (`mini_run`, `pm_task`, `control_plane`, and the
default route), which covers `status:'in_progress'`, `route`, `pipeline_run_id` and `pm_task_id`; and `verify` with
`action:'unverify'` (it returns the row to `in_progress`). Nothing else writes those columns. A `declined`/`void`/`expired`
contract is not `signed`, so it leaves the request blocked until staff re-triage. The 409 carries
`existing:{amendmentContractId, amendmentStatus}` so a client can link to the contract that must be signed.

**Event:** `contract.signed` (consumed from the `contract` stream by `core/amendment-signed-handler.ts`, a core handler registered in `main.ts`)
notifies the request's `triaged_by` user, type `webdev.change_request.unblocked`, once per request (a redelivery is a no-op).

**Staff UI (PV4-04b, same release):** the triage panel (`components/departments/ChangeRequestsPanel.tsx`) asks "Does this change the
price?" with no default (Convert stays disabled until it is answered), sends `priceImpact`, shows a blocked convert as "Waiting for the
amendment to be signed" linked to `/clients/[clientId]/billing`, and renders `amendment_not_signed`, `amendment_exists` and
`client_required_for_price_change` as plain messages. **Not built yet (PV4-09):** an `amendsId` picker (the server default applies), and
`priceImpact`/`amendmentContractId`/`amendmentStatus` shown on the request rows.

### 16g. Site Provisioning (PRV-00..04) — `src/modules/webdev/webdev.controller.ts` — **STATUS: PROTOTYPED**

**2026-09-01 (WSK-D33):** `provision` (gda-s01) is DECOMMISSIONED (measured 000 on every request; the live `.env` carries no `PROVISION_*` vars). `POST .../provision` now egresses through **ERP repo control** — `modules/webdev/erp-repo-control-provider.ts` — instead of the dead HTTP seam: it files a D14-approved GitHub repo-creation request (GH-12, `POST /api/:t/github/repos/creation-requests`'s own underlying `fileAutomationApproval` path) from a per-KIND template (`config.erpRepoTemplates.{static,fullstack,wp}`, env-only, no name hardcoded) and the row sits `pending` — now meaning "awaiting a company_admin's approval decision", not only "infra spinning up" — until `automation-approvals.controller.ts#decide()` executes the approved creation. `wp` is now provisionable (previously refused by `provision-http.ts`'s own static-export-only capability boundary); `provision-http.ts` is kept but no longer reachable from this controller under any config. See `erp-repo-control-provider.ts`'s header for the crash-resume argument (adopts an in-flight request of its own by name rather than filing a duplicate) and the residual window it does not close (an `approved` row whose execution threw is indistinguishable, from a poll, from one GitHub has not yet made visible — both read `pending` until the poller/reconciler's next ask succeeds). Status stays **PROTOTYPED**: not yet live-server-verified end to end (a real approval decided by a real company_admin against a real GitHub template org).

The Cerbos gate note below is ALSO corrected here: `resource_webdev_provisioned_site.yaml` (PRV-03) and `resource_github_repo.yaml` (GH-03) both exist and are loaded today — the "gates fail-closed, no policy yet" resting state this section originally described no longer applies. The D14 approval step itself (`resource_automation_approval.yaml`'s `decide` action, company_admin-only) is unchanged and is the actual create-time gate — see `core/github/repo-creation.ts`'s header.

| Status | Method | Path | Notes |
|---|---|---|---|
| ✅ | POST | `/api/:t/modules/webdev/provision` | `{runId?: string, framework?: string, slug?: string, stack?: string}` → `201 {site}` (new) or `200 {site}` (existing, idempotent re-call). `runId` or `slug` required. Idempotent provision: lock → re-read → precondition re-check → egress (now: file a GH-12 approval) in one transaction. Returns mirror row immediately at `status:'pending'`; the repo itself is created later, once a company_admin approves the filed request (`automation_approvals`, `workflow_id='github:create_repo'`). On 409 `slug_conflict_foreign`, the mirror row is committed as `failed/slug_conflict_foreign` before the response. Authz: `webdev_provisioned_site` provision (`resource_webdev_provisioned_site.yaml`, PRV-03, loaded). Emits `provisioned` activity. Migration `0090` + `202609011230` (framework widen) + `202609011500` (provider widen, adds `'erp_repo'`). | **2026-08-26:** also consumed by the Web Dev Repositories tab (`departments/[deptId]/repositories`) — `GET provisioned-sites` with no `runId` (tenant-wide, attributed run → project → department in `lib/repoInventory.ts`), `POST provision` from its "Create repository" form — **2026-08-27:** the standalone shape also takes `clientId`/`projectId`, and the DTO returns `clientId`/`projectId` (copied from the run when there is one) — (both shapes: `{runId, framework, slug?}` for a run, and the off-pipeline `{framework, slug}` with no run for a standalone repository — `pipeline_run_id: null`, listed unlinked), and `POST provisioned-sites/:id/reconcile` from the table's "Check status now". **2026-09-01:** the "Create repository" button's egress now files a D14 approval instead of calling the dead `provision` host — a company_admin must approve it in the Approvals inbox before the repo (and `github_repos` row) actually exists.
| ✅ | GET | `/api/:t/modules/webdev/provisioned-sites` | `SiteDto[]` (list all, optionally filtered by `?runId=`). Authz: `webdev_provisioned_site` read (`resource_webdev_provisioned_site.yaml`, loaded). **2026-08-26:** also consumed tenant-wide (no `runId`) by the Web Dev Repositories tab — `lib/webdevProvisionedSites-data.ts::listProvisionedSites` → `lib/repoInventory.ts` attributes each site through its run's project to the department. |
| ✅ | GET | `/api/:t/modules/webdev/provisioned-sites/:id` | `SiteDto` (single row). Authz: `webdev_provisioned_site` read. **M6-P4c (2026-10-12, PROTOTYPED: typechecked + unit-tested locally, DB suites for the Linux gate):** additive `completion: {state: null\|"registered"\|"tenant_ready"\|"complete", next: "not_ready"\|"register"\|"tenant"\|"contract"\|"done", webdevSiteId, webdeskTenantSlug, contractSnapshotId, error, updatedAt} \| null` — where §08's completion stands (the `webdev_sites` row, the WebDesk tenant, the pinned contract snapshot; `error` is the last typed reason a step could not finish, e.g. `contract_not_published` while WebDesk's codegen runs, `webdesk_tenant_slug_foreign`, `registry_domain_taken`). `SiteDto`'s own keys are unchanged. **M6-P4b2 (2026-10-12, PROTOTYPED):** additive `scaffold: {state: null\|"pending"\|"commit_created"\|"committed", branch, baseSha, treeSha, commitSha, snapshotId, manifestSha256, fileCount, totalBytes, error, updatedAt, committedAt} \| null` — where the scaffold's first fill of the repo stands (`error` is the last refusal token, e.g. `scaffold_repo_not_pristine`). **M6-P4g (2026-10-13, PROTOTYPED):** additive `deployGrant: {state: null\|"pending"\|"granted"\|"revoked", secretNames, siteSecretName, pendingNames, snapshotId, repositoryId, headSha, error, updatedAt, grantedAt, revokedAt, revokeReason} \| null` — where the deploy grant stands (`secretNames` are org secret NAMES the repo may read; the ERP never holds a value; `error` is the last refusal token, e.g. `github_permission_missing: organization_secrets` while O-3 is not in effect, or `deploy_grant_secret_not_selected: <name>`; `siteSecretName` is the site's own derived per-site deploy secret; `pendingNames` are secrets the owner has not created yet, which is not an error). |
| ✅ | POST | `/api/:t/modules/webdev/provisioned-sites/:id/reconcile` | `{} → SiteDto`. Re-drive the poller synchronously; same logic as `POST /provision` detached poll but on-demand and blocking. **2026-09-01:** against ERP repo control, this re-asks the filed approval's status and, once approved, GitHub itself (`GET /repos/{org}/{name}` via the read-only App) for the real repo — not `provision`. Authz: `webdev_provisioned_site` reconcile (different action, can cause egress). **M6-P4c (2026-10-12, PROTOTYPED):** the response is `SiteDto & {completion}` (the same additive `completion` as `GET provisioned-sites/:id`). After the repo step's reconcile, the route advances §08's completion as far as it can: once the row is `provisioned`/`live` with a `repoUrl` it upserts the `webdev_sites` row (`origin: provisioned`, `adoption: mandated`, the §08 kind, `repoUrl`, the run's `projectId`/`clientId`, `environment: staging`, placeholder domain `<slug>.provisioned.invalid` until the site has a real one), files WebDesk `tenant.provision` (MEDIUM, deterministic Idempotency-Key `wps-tenant:<id>`), then pins the first contract snapshot once WebDesk has published it. This is THE resume path: each step is idempotent, and a crash between any two is finished by the next call. No approval is filed: the GH-12 approval of the repo covers the provisioning (see `provision-completion.ts`). The same completion also runs, detached, at decide() of the GH-12 approval and at the end of the provision route's detached poll. |
| ✅ | POST | `/api/:t/modules/webdev/provisioned-sites/:id/scaffold-commit` | **M6-P4b2 (2026-10-12, PROTOTYPED: typechecked + unit-tested locally, DB/HTTP suites for the Linux gate).** `{runId, goalId?, contractSnapshotId?, files: [{path, base64, sha256, bytes}]}` → `200 {outcome: "committed"\|"already_committed", siteId, repo, branch, baseSha, treeSha, commitSha, snapshotId, manifestSha256, fileCount, totalBytes}`. The FIRST FILL of the provisioned repo with a `code.scaffold` v2 tree, written by platform-nest with the ERP GitHub App (Git Data API: blobs → tree on the template → commit on the template commit → fast-forward of the default branch). Called by the scaffold job through the hub tool `webdev.provisionedSites.commitScaffold` (low impact, `wf:delivery` only); not a UI action today. Refuses (`{error, reason}`): 422 `scaffold_manifest_invalid` · `scaffold_too_large` (300 files / 512 KiB per file / 600 KiB total) · `scaffold_path_refused` · `scaffold_path_conflict` · `scaffold_mode_refused` · `scaffold_hash_mismatch` · `scaffold_lock_missing` · `scaffold_lock_invalid` · `scaffold_lock_snapshot_mismatch` · `scaffold_template_path_refused` (`.github/`) · `scaffold_path_conflicts_template`; 409 `scaffold_site_not_complete` · `scaffold_run_mismatch` · `scaffold_repo_unresolved` · `scaffold_repo_not_pristine` · `scaffold_already_committed` · `scaffold_superseded`; 429 `github_rate_limited`; 502 `github_blob_sha_mismatch` · `github_write_failed`; 503 `github_app_not_installed` · `github_app_permission_missing` · `github_not_configured` · `github_org_unavailable`; 404. An identical tree re-submitted answers `already_committed` with no GitHub call. Authz: `webdev_provisioned_site` provision (request tenant) + `github_repo` push (GitHub org tenant); no policy change. Migration `202610122130`. Design: `docs/plans/2026-10-12-webdesk-m6-p4b2-scaffold-commit.md`. **M6-P4g (2026-10-13, PROTOTYPED):** the answer gains an additive `deployGrant: {outcome: "granted"\|"already_granted"\|"pending"\|"partial"\|"skipped_revoked"\|"refused", state, siteSecretName, secrets: [{name, result}], pending, error}` — the deploy grant that follows the commit in the same call (same principal, no new approval). It never turns the commit into an error (a refusal is `outcome: "refused"` with its token, also recorded on the row). An identical re-submit still makes no GitHub call for the COMMIT, but re-runs the grant when it is not yet `granted`; it never undoes an operator's revoke. |
| ✅ | POST | `/api/:t/modules/webdev/provisioned-sites/:id/deploy-grant` | **M6-P4g (2026-10-13, PROTOTYPED: typechecked + unit-tested locally, DB/HTTP suites for the Linux gate).** No body → `200 {outcome: "granted"\|"pending"\|"partial", siteId, siteSecretName, pending, state, repo, repositoryId, snapshotId, headSha, secrets: [{name, result: "granted"\|"missing"\|"not_selected"}], error}`. The deploy gate: re-checks that the site is a registered, locked repo (ERP repo control row, §08 completion `complete`, a live `provisioned` `webdev_sites` row naming the repo, the scaffold `committed`, the GH-12 repo, a root `CONTRACT.lock` at the default branch's head naming the pinned snapshot) and adds the repo to the selected repositories of two kinds of org Actions secret: the fixed list (`WEBDESK_DEPLOY_SECRET_NAMES`, default `WEBDESK_DEPLOY_GRANT`) and the site's OWN per-site secret `WEBDESK_DEPLOY_<SLUG>_<ENV>_<H8>` (`siteDeploySecretName()`; H8 = 8 hex of sha256(site id), because the readable part alone can collide across companies; P6's deploy principal, created by hand by an org owner, visible to this repo only). Idempotent; completes a partial grant; also undoes an operator's revoke. The ERP never holds a secret value (WSK-D29). A secret that does not exist YET is NOT an error: `outcome: "pending"`, the name in `pending`, and the next run completes it. A secret not set to "selected repositories" is an error (`partial`, `deploy_grant_secret_not_selected`), never written through. Refuses (`{error, reason}`): 409 `deploy_grant_repo_unresolved` · `deploy_grant_site_not_complete` · `deploy_grant_no_registry_row` · `deploy_grant_registry_mismatch` · `deploy_grant_not_committed` · `deploy_grant_no_lock` · `deploy_grant_lock_invalid` · `deploy_grant_lock_mismatch` · `deploy_grant_superseded`; 429 `github_rate_limited`; 502 `github_request_failed`; 503 `github_permission_missing` (reason starts `organization_secrets:` until the App holds Organization Secrets: read and write, O-3) · `github_app_not_installed` · `github_not_configured` · `github_org_unavailable` · `deploy_grant_not_configured`; 404. Authz: `webdev_provisioned_site` provision (request tenant) + `github_repo` push (GitHub org tenant); no policy change. No hub tool. Migration `202610130100`. Design: `docs/plans/2026-10-13-webdesk-m6-p4g-deploy-grant.md`. |
| ✅ | DELETE | `/api/:t/modules/webdev/provisioned-sites/:id/deploy-grant` | **M6-P4g (2026-10-13, PROTOTYPED).** `{reason}` (8 to 500 characters, validated only AFTER authorization) → `200 {outcome: "revoked"\|"not_granted"\|"partial", siteId, state, repo, repositoryId, secrets: [{name, result: "revoked"\|"missing"\|"not_selected"}], error}`. Removes the repo from every deploy secret it may hold (the fixed list ∪ recorded ∪ the site's own per-site secret); records the reason, the actor and the time. `not_granted`: the ERP never granted this site (the removal still runs, nothing is recorded). `partial`: a secret is visible to all repos, so the repo still reads it. Refuses: 422 `deploy_grant_reason_required`; 409 `deploy_grant_repo_unresolved`; the same 429/502/503 tokens as POST; 404. Authz: the same two gates as POST; a human operator action (no hub tool). Any future archive / registry-removal path must call `revokeDeployForSite()` (none exists today). |

#### 16g-i. VLT-2 — the site PORTFOLIO registry's first write path (`docs/plans/2026-09-04-client-hosting-credential-vault.md`) — DISTINCT table from `webdev_provisioned_sites` above

`webdev_sites` (`202608300747_webdev_sites_portfolio_registry.sql`) is the "what exists" registry —
~78 tracked sites across our own boxes, client cPanels, and legacy hosts, most of which were never
provisioned by this platform. Before this pass it had a read model (`GET .../provisioned-sites`
above does NOT read this table — see §24's own portfolio note) but **no HTTP write path at all**;
every row that ever entered it was a direct test SQL INSERT. `vaultRef` is a POINTER to an
`integration_connections.id` (§12), never a credential — WSK-D30, enforced structurally: the value
must resolve to a real, same-tenant connection row, and a regression test asserts `webdev_sites`
carries no column matching `/token|secret|password|credential/i`.

Authz (**M6-P3c, 2026-10-12**): the registry has its OWN Cerbos kind, `webdev_site` (`resource_webdev_site.yaml`:
`read`/`create`/`update`/`request_probe_consent`), replacing the borrowed `webdev_provisioned_site`
`provision`/`operate`/`read` that VLT-2 shipped with. Behaviour-preserving: each action carries the exact reach of the one
it replaced (`create`<-`provision`, `update`<-`operate`, `read`<-`read`, `request_probe_consent`<-`read`), pinned by
`src/rbac/cerbos-webdev-site.test.ts`. The `id` Cerbos sees for GET/PATCH names a `webdev_sites` row.

| Status | Method | Path | Notes |
|---|---|---|---|
| ✅ | POST | `/api/:t/modules/webdev/sites` | `{domain, environment?, projectId?, clientId?, hostKind?, hostRef?, access?, kind?, repoUrl?, repoBranch?, adoption?, contractVersion?, origin?, notes?}` → `201 WebdevSiteDto`. `vaultRef` is NOT accepted here (400 if present) — set it via the PATCH below, the one place that resolves it. `clientId` is deliberately nullable with no default (WSK-D35: an internal site with no client is a legitimate fact). 409 on a duplicate domain or a second `production` row for the same project (the table's own partial unique indexes). Authz: `webdev_site` create (M6-P3c; was `webdev_provisioned_site` provision, same reach). |
| ✅ | GET | `/api/:t/modules/webdev/sites/:id` | `WebdevSiteDto`. Authz: `webdev_site` read (M6-P3c; was `webdev_provisioned_site` read, same reach). |
| ✅ | PATCH | `/api/:t/modules/webdev/sites/:id` | Body must be EXACTLY `{vaultRef: string\|null}` — any other top-level key is a 400 (proves this cannot become a backdoor write path for any other column). `vaultRef` a string must resolve to an `integration_connections.id` in the SAME tenant (400 otherwise) or `null` to clear the pointer. Authz: `webdev_site` update (M6-P3c; was `webdev_provisioned_site` operate, same reach). |
| ✅ | POST | `/api/:t/modules/webdev/sites/:id/domain` | **M6-P4c2 (2026-10-12, PROTOTYPED).** Body EXACTLY `{domain: string}` (any other key is a 400) → `200 WebdevSiteDto`. A provisioned site CLAIMS its real domain, once: M6-P4c registers the row under the placeholder `<slug>.provisioned.invalid`, and this replaces it. Same domain validation as `POST sites` (trim, lowercase, no whitespace, 3-253 chars) plus a `.invalid` domain is a 400. Only a row with `origin = provisioned` whose domain still ends `.provisioned.invalid` can be claimed; anything else is `409 domain_already_set`. A domain already held by another live row in the tenant is `409`; an unknown site is `404`. NOT a general domain editor (a tracked site's domain change is out of scope). Emits `webdev.site.domain_claimed`. Authz: `webdev_site` `update` (no new action; manager tier, same reach as the vaultRef PATCH). Does not propagate to WebDesk or search_properties (see the plan's M6-P4c2 notes). |
| — | — | — | `WebdevSiteDto`: `{id, tenantId, domain, environment, projectId, clientId, hostKind, hostRef, access, kind, repoUrl, repoBranch, adoption, contractVersion, origin, vaultRef, notes, createdAt, updatedAt}`. `getPortfolio()`'s read model (§24-adjacent) now also carries `vaultRef` on each `PortfolioSite`. |

### 16h. Social post client-review (SMM-31, D-16) — `src/core/social-client-review-portal.controller.ts` — **STATUS: DEV-VERIFIED backend; portal UI IN PROGRESS (SMM-32)**

The client's own decide half of §19's client-review stage; the staff ask/read/withdraw half lives on
`modules/social/social.controller.ts` (§19). Modelled on §16's own gate-decide pattern
(`PortalController.decideGate`) — addressed by the REVIEW's own id, ownership resolved before a
guarded UPDATE. `social_post_client_reviews` is the ONE plain-tenant-wall table in the social
module (D-16 restates 0088's D-2a lesson: a third-walled table here would read as zero rows on
every portal query, since portal controllers declare no module scope). Available to every ACTIVE
contact regardless of `capability` (signer or viewer) — same ratified reasoning `request_change` and
`update_profile` already carry: approving a draft post is weaker than signing a scope agreement or
recording a payment.

| Status | Method | Path | Notes |
|---|---|---|---|
| ✅ | GET | `/api/:t/portal/social-reviews?status=` | `{id, status, comment, requestedAt, decidedAt, variantId, body, media, settings, scheduledAt, network, postTitle}[]`. Caller's own client's reviews only, newest-first, capped 200. Authz: `portal` read. |
| ✅ | POST | `/api/:t/portal/social-reviews/:id/decide` | `{decision:'approved'\|'changes_requested', comment?}` → `{id, status, alreadyDecided?}`. Stamps `reviewedArgsSha256` from the variant's LIVE hash at the moment of decision (so a later edit is detectably `stale`, D-15 restated for the client's side). **Idempotent**: the SAME decision replayed is a 200 no-op (`alreadyDecided:true`, no duplicate event/notification); a DIFFERENT decision after the review is already resolved is a genuine **409** (`client_review_already_decided`), never a silent flip. Unknown/out-of-scope review id is a **404** (existence-oracle-safe — never distinguishes "not yours" from "does not exist"). Authz: `portal` `approve_post`. Emits `social.client_review.decided`, notifying the engagement owner. |

Not a signing act: `approve_post` carries no `requireSigner()` gate, matching `request_change`'s own
ratified reasoning (§16f) — do not add one "for consistency" with `sign`/`pay`.

**UI consumer (SMM-32, this pass):** `platform-ui/src/lib/portal.ts` (`PortalSocialReview` +
`socialReviewStatusLabel`/`describeSocialReviewError`), `portal-data.ts`
(`listPortalSocialReviews`/`getPortalSocialReview` — the latter derived from the list read, since
this surface has no dedicated single-review GET), `portalActions.ts`
(`portalDecideSocialReview`, `useActionState` shape, not the void gate-decide shape — the client
must see a genuine 409 if a race lands a different decision after the review already resolved).
Pages: `(portal)/portal/social-reviews/page.tsx` (list, pending-first) +
`[reviewId]/page.tsx` (detail + decide, rendering `PortalSocialReviewDecideForm` ONLY while
`status === 'pending'` — a decided review has no decide control anywhere on the page). No `topics`
entry was added to `PortalTopic`/`PortalLive` for this surface — `portal-live.service.ts` was not
touched by SMM-31, so there is no SSE frame to filter on; the pages rely on `PortalLive`'s own
unconditional idle poll instead of inventing a topic string nothing emits.

---

### 16i. Client website access (WSK-49f, WSK-D60 amended 2026-10-11) — `src/core/client-website-access.controller.ts` — **STATUS: BACKEND BUILT, PROTOTYPED (tested on local Linux containers, no server gate yet); UI BUILT, PROTOTYPED (WSK-49f UI: the staff Contacts-page and portal People-page grant controls, vitest + DEMO_MODE Playwright on a Windows laptop, not DEV-VERIFIED against a live backend; the portal Website area is a separate ticket)**

Who may edit a client's website through WebDesk, and who may say so. `client_website_editor` is a **role stored as data** scoped to
ONE client record (`user_roles.scope_type = 'client'`, `scope_id = clients.id`; the serving company is that client's tenant), the
same for a plain client and for a CMC client company. It carries **no permission bundle and no `perm_*` mirror**: Cerbos checks it
by an attribute condition (`derived_roles.yaml` `client_website_editor`: the grant's client == `resource.attr.clientId`, in the
grant's tenant). A client-scoped grant only reaches the principal while its holder is still an ACTIVE, client-wide contact of that
client (`assemblePrincipal()`), so revoking the contact switches the grant off. The client-contact capability gains **`admin`**
(beside `signer | viewer`), assigned ONLY by Gaiada staff; an admin may grant this ONE role, to contacts of their OWN client only.

**Order on every route: authorize (Cerbos) → load the target contact on the tenant-scoped connection and verify it belongs to the
client in the URL → write, in the SAME transaction as the audit row.** The role is a literal in the path and the scope is the client
in the path: there is no role/scope/permission parameter anywhere, and any such body field is ignored, never read. Idempotent:
granting twice or revoking what is not held is a **200 with `changed:false` and NO second audit row** (the audit trail records
state changes). Audit rows (`activities`, `target_entity_type = 'client_contact'`, `target_entity_id` = the contact id, actor =
the caller): `client_website_editor.granted|revoked` (metadata `{clientId, contactId, targetUserId, role, grantId, surface:
'staff'|'portal', actorKind}`; the contact-revoke cleanup adds `reason:'contact_revoked'`) and `client_contact.admin_granted|
admin_revoked` (`previousCapability` / `restoredCapability`). A revoke also bumps the target's `session_version`.

| Status | Method | Path | Notes |
|---|---|---|---|
| ✅ | GET | `/api/:t/clients/:clientId/website-access` | STAFF. → `{clientId, role:'client_website_editor', contacts:[{contactId, userId, name, email, capability, status, isAdmin, websiteEditor}]}`. Only client-wide, non-revoked contact rows (a project-scoped or revoked row is not eligible and is not listed). Authz `client_contact · read`. |
| ✅ | PUT / DELETE | `/api/:t/clients/:clientId/contacts/:contactId/website-editor` | STAFF. Grant / revoke → `{clientId, contactId, userId, role, websiteEditor, changed}`. Authz `client_contact · manage_website_editor` (company_admin, manager, **owner**, platform_admin of THIS company). `owner` is permission-native (no role rules): it reaches this through the permission arm, key `core.client_contact.manage_website_editor`, which its bundle carries and the policy mirrors for the STAFF shape only (no `clientId` on the resource), so an owner can never ride the portal arm (PERMISSION-CONTRACT §27). `404` if the contact is not a contact of that client (RLS hides other companies'); `400 website_editor_is_client_wide` for a project-scoped row, `400 target_not_a_contact_of_client` for a revoked one; `400 self_grant_forbidden` when the caller is the target. A client admin gets `403` here (they use the portal route). |
| ✅ | PUT / DELETE | `/api/:t/clients/:clientId/contacts/:contactId/admin` | STAFF ONLY. Assign / remove the `admin` capability → `{clientId, contactId, userId, capability:'admin'\|'signer'\|'viewer', changed}` (`capability` is the contact's resulting capability; on a no-op it is the real current one). Authz `client_contact · manage_admin` (company_admin, **owner** via the permission key `core.client_contact.manage_admin`, platform_admin; **not manager, and no client arm at all** — a client admin can never mint another admin). `admin` REPLACES `signer`/`viewer` in the one column and **IMPLIES SIGNER** (owner ruling 2026-10-11): everywhere a signer is tested an admin passes too (portal contract signing and gate decisions via `canSign`/`requireSigner`, the portal `canSign`/`viewOnly` flags, signature-notification recipients, Client Centre editing), so promoting a signer needs no confirmation and they keep signing (the audit row records `previousCapability`). `DELETE` takes an explicit target, `{ "to": "signer" \| "viewer" }`, default **`viewer`** (least privilege; `400` for anything else); the prior capability is not stored, so a **former signer must be re-made a signer deliberately** (`to:"signer"`). UI note: the portal People page's "Can sign" display must treat `admin` as able to sign. Client-wide rows only (`400 admin_is_client_wide`). |
| ✅ | GET | `/api/:t/portal/clients/:clientId/website-access` | PORTAL (client admin). Same body as the staff list, for the caller's own client. Authz `client_contact · manage_website_editor` with `clientId`, then the portal scope predicate (`resolvePortalScope`): `403` for any client that is not the caller's. |
| ✅ | PUT / DELETE | `/api/:t/portal/clients/:clientId/contacts/:contactId/website-editor` | PORTAL (client admin). Grant / revoke the website editor to a contact of the SAME client. `403` for a signer, a viewer, a plain website editor, an admin of another client, a revoked or project-scoped admin, any staff member (not a contact of the client) and any other company's user; `404` for a contact id of another client/company; `400 self_grant_forbidden` for a grant to themselves (a self-REVOKE is allowed). There is deliberately **no** portal route for `admin` or any other role. |

Existing endpoint touched: `POST /api/:t/client-contacts/:id/revoke` now also deletes that contact's `client_website_editor` grant (when
the row is client-wide) and writes its audit row (`reason:'contact_revoked'`) in the same transaction, so a dormant grant cannot come
back to life if the contact is ever re-invited. `POST /api/:t/clients/:clientId/contacts` still accepts only `signer|viewer`.
Generic grant surfaces (`POST /api/:t/users/:id/roles`, `POST /api/:t/role-grants`) refuse `scope_type='client'` and the role itself
(`400 client_scope_dedicated_path`); a DB trigger (`user_roles_client_scope_guard`) welds the role to the client scope for any writer.

**Principal / Cerbos contract (for WSK-49c and the portal):** `principalPayload` now sends `grants[].scopeTenantId` (client-scoped
grants only) and `attr.clientAdminOf: [{tenantId, clientId}]`; `resourcePayload` sends `attr.clientId` ("" when unfed, which matches
nothing). A handler feeding `clientId` must take it from a row it loaded in the request's tenant, never from a request body. The UI
gets the same facts from the two list endpoints above (`isAdmin`, `websiteEditor`); no `Me` shape changed.

### 16j. Client website editing (WSK-49c, WSK-D58 / D59 / D60 / D62, 2026-10-11) — `src/modules/webdev/webdesk-client-website.{controller,service}.ts`, `webdesk-client-guard.ts`, `webdesk-site-clients.{controller,service}.ts` — **STATUS: BACKEND BUILT, PROTOTYPED (tested on local Linux containers: Postgres + Redis + Cerbos 0.54.0; no server gate yet); the portal UI (WSK-49d: `/portal/website`, `platform-ui/src/lib/portalWebsite*.ts`) is BUILT, PROTOTYPED against a stub of these routes (vitest + Playwright on `next dev`; not run against a live platform-nest)**

A client editor edits THEIR client's WebDesk site through the portal. It is the staff content BFF (§27) **in client mode**, not a second
implementation: every immediate write, the preview, the publish filing and the media calls are the staff service's, handed a gate opened
for the client. What is specific to a client is below. Base path: `/api/:t/portal/clients/:clientId/website` (`:t` = the serving company,
`:clientId` = `clients.id`).

**The order on EVERY route (the security property).** (1) Cerbos, as the caller, under the client-editor rules (`client_website_editor`
for the URL's client; **the first statement of every handler**, so a denial is 403 whatever the body), (2) the site wall: the caller's
portal scope (`resolvePortalScope`) must contain that client AND the site must be LINKED to it (`webdesk_site_clients`, loaded in the
request's tenant); anything else is a uniform `404 site-not-found` problem (unknown slug, another client's site, an unlinked site,
another company's site, a malformed id: no existence oracle), (3) the strict body, (4) the D59 / D62 PRE-CHECK against what WebDesk
holds (below), (5) only then the call to WebDesk, signed with the client marker `ce: true`. Staff roles pass step 1 (they hold the
staff editor tier) and fail step 2 (`403 not a portal client`), so a staff member gets nothing here and WebDesk is never called.
The URL's `clientId` only reaches Cerbos, which matches it against the caller's OWN server-derived grants; the link row, not the URL,
is the authority for which site belongs to which client.

| Status | Method | Path | Notes |
|---|---|---|---|
| ✅ | GET | `/website` | → `{clientId, sites:[{tenantSlug, siteId, name, kind, defaultLocale, locales, linkedAt}]}`: THIS client's linked sites (a link whose site WebDesk no longer lists is omitted; a WebDesk outage is `503 editorial_unavailable`, never `[]`). Authz `webdesk_content_item · read`. |
| ✅ | GET | `/website/sites/:slug/:siteId/collections` | Zone B's `collection.list` body, each collection with a computed **`clientEditable`** map (below). Authz `webdesk_content_item · read` (a client never reads `webdesk_collection`: schema is the agency's). |
| ✅ | GET | `/website/sites/:slug/:siteId/collections/:key/items` | The staff list, plus **`authors`** (below); query allow-list `locale, state, q, cursor, limit, slug`. `?includeDeleted` or `?state=deleted` → `400` (a client never sees a deleted item). |
| ✅ | GET | `/website/sites/:slug/:siteId/items/:itemId[?version=]` | `{item, version, live, group, lint}` PLUS **`composition`**, **`clientEditable`** (below) and **`authors`** (below). A deleted item is `404 item-not-found`. |
| ✅ | GET | `/website/sites/:slug/:siteId/items/:itemId/versions[/:n]` | The staff version reads, plus **`authors`** (below). |
| ✅ | POST | `/website/sites/:slug/:siteId/collections/:key/items` | Create. Body `{locale, slug, twinOf?, fields?, blocks?, note?}`; **no `seo`**. `201` as the staff create. D59 pre-check (below). |
| ✅ | PUT | `/website/sites/:slug/:siteId/items/:itemId` | Update. Body `{baseVersion, fields?, blocks?, note?}`; **no `seo`**. The BFF fills what you omit FROM THE HEAD (fields, generic blocks, and always the existing `seo`) so a partial edit never removes what the client cannot see; a stale `baseVersion` is `409 version-conflict`, decided before the D59 diff (below). |
| ✅ | POST | `/website/sites/:slug/:siteId/items/:itemId/restore` | Body `{version, baseVersion, note?}`. The restored version may differ from the head only in client-editable paths. |
| ✅ | POST | `/website/sites/:slug/:siteId/items/:itemId/preview` | WSK-46's one-time preview link (§27), authorised as the item's `update`. `200 {previewUrl, expiresAt, version}`. |
| ✅ | POST | `/website/sites/:slug/:siteId/publish-requests` | Body `{items:[{itemId, version}], note?}` → `202 {approvalId, command:'content.publish', itemCount}`. Files ONE WS4 approval with the client on the row; publishes nothing. `publishAt` / `unpublishAt` → `403 client-command-not-allowed` (a client never schedules). D62 pre-check (below). |
| ✅ | POST | `/website/sites/:slug/:siteId/items/:itemId/publish` | **Self-publish ONE item (D58).** Body `{version?}` (default: the head). Files the request and approves it as the same person in one call → the approve body below. If the approval step fails, the request it filed is withdrawn so no orphan is left. |
| ✅ | GET | `/website/publish-requests[?status=pending\|approved\|rejected\|cancelled\|all]` | This CLIENT's publish requests, every client editor's (default `pending`, newest first, <= 100): `{requests:[{approvalId, status, createdAt, tenantSlug, siteId, itemCount, itemIds, items:[{itemId, version}], requestedBy:{userId, name}, requestedByMe, canApprove, executionStatus}]}`. **`items`** (WSK-359) is the versions the request NAMED, read from the approval's stored items exactly as the staff list does (an item whose stored entry carries no usable version is simply absent from `items`; `itemIds` is unchanged). The list makes no WebDesk call, so it carries no title or slug (WebDesk's `item.get` has a slug but no title; a title is computed from the version's fields): the portal reads each page AT its requested version (`GET …/items/:id?version=N`) for the words. A request STAFF filed, another client's, or one whose site was re-pointed never appears. `canApprove` is a UI hint (`pending && (!requestedByMe \|\| itemCount == 1)`); Cerbos decides. |
| ✅ | POST | `/website/publish-requests/:approvalId/approve` | **Decide AND execute (D58).** → `200 {approvalId, status:'approved', executionStatus:'executed'\|'failed', selfPublish?, reconciled?, items?, build?, error?}`. **`build`** (WSK-359, WSK-D65) is `{state:'rebuilding'\|'live'\|'unverified'\|'failed', failureReason: string\|null}`, present on an executed publish: the client-safe subset of the executor's `build` (never the build id, repo, ref or URL; `failureReason` is the typed token, e.g. `rebuild_not_configured`, `client_publish_unverified`, `dispatch_unconfirmed`, and anything that is not a plain lower-case token is replaced by `rebuild_failed`). The self-publish route answers the same body. The portal says "live" only for `state === 'live'`. `403` for a self-approved BATCH (Cerbos; the request stays pending, nothing is sent); `404` for a request that is not this client's publish (incl. staff-filed); `409 approval_not_pending` the second time; `422 publish-not-client-editable` when the D62 check fails now (the live page may have moved since filing; the request stays pending). |
| ✅ | POST | `/website/sites/:slug/:siteId/publish-requests/:approvalId/withdraw` | The REQUESTER cancels their own pending request → `200 {approvalId, status:'cancelled'}`. `403` for another client editor's request, `404` when the row is not a publish request for this site, `409 approval_not_pending` once decided. Nothing is sent to WebDesk. |
| ✅ | GET | `/website/sites/:slug/:siteId/media[?mime&q&tag&cursor&limit]` | The staff media list minus `includeDeleted` (`400`), plus **`capabilities`** (§27): in client mode `delete` is always `false`. Authz `webdesk_media_asset · read`. |
| ✅ | POST | `/website/sites/:slug/:siteId/media/upload-token` | Body `{bucket, maxBytes?, mime?}` → `201 {uploadUrl, expiresAt, maxBytes, allowedMimes}` (`no-store`; the URL carries a one-time secret). Authz `upload`. |
| ✅ | PATCH | `/website/sites/:slug/:siteId/media/:assetId` | Body `{title?, alt?, tags?}`. Authz `update`. **There is NO route to delete media, delete / unpublish / schedule an item, or touch schema or keys.** |

**`clientEditable` (what 49d renders read-only fields from).** Computed by the vendored `isClientEditable` (never restated):
`{ fields: {"<name>": bool, "<group>.<member>": bool, ...}, blocks: bool, seo: false, create: {allowed, reason, blockedBy} }`.
`fields` has one entry per declared field at every depth (a multiple group's members share one dotted path); `blocks` is the generic
blocks (editable iff the collection is); `seo` is always false (D59 design default: the agency keeps SEO-critical fields). `create.reason`
is `null | 'system-collection' | 'nothing-editable' | 'required-fields-not-editable'`; **a REQUIRED field that is not client-editable
makes a client create impossible**, so `create.allowed` is false and `blockedBy` names the field(s): hide or disable "New" and say why.

**Author labels (WSK-359).** A client has no directory read, so the ids WebDesk records as version authors (`version.createdBy`, `versions[].createdBy`, `items[].headCreatedBy`) would read as short ids.
`item.get`, `GET …/versions`, `GET …/versions/:n` and the item list therefore carry **`authors: {"<users.id>": "<label>"}`** (absent when the body names no author), resolved server-side in the request's tenant in ONE query
per response: an author who is a contact of THIS client (any `client_contacts` row of the client, or its legacy portal user) → their name; an automation / bot account (`users.kind`) that is a member of the company → its name
(as the staff members list shows it); a Gaiada staff user (an `employee` member of the company) → **"Gaiada"** (no personal name or email: a deliberate privacy choice for this release); anyone else (another client's contact,
a user in no company, a removed account, a non-uuid) → **"Someone else"**. The contact rule is tried first. The UI's `authorLabel` uses a label when present and keeps its short-id fallback otherwise.

**The D59 / D62 pre-check (refused BEFORE any WebDesk write, with WebDesk's own problem slugs; WebDesk's check stays the authority).**
`422 field-not-client-editable` (`issues[].path` = RFC 6901 pointers such as `/blocks/0/props/slugLabel`, `total`; `/seo` for any `seo`;
`/collectionKey` when nothing in the collection is editable) for a create/update/restore that changes a non-editable path; ONE bad path
refuses the whole write. `409 item-deleted` for a deleted item. `422 publish-not-client-editable` (`issues[].path` = `/items/<index>` +
pointer) for a publish whose version differs from what is LIVE in any non-editable path or in `seo` (a never-published item is judged
against an empty baseline; re-publishing what is live is a no-change publish and passes); a batch with one bad item publishes none.
Every problem leaves as `application/problem+json`, byte-for-byte as WebDesk's. The rule is WebDesk's one function
(`webdesk/delivery/vocabulary/client-editable.ts`), **vendored** into `src/modules/webdev/vocabulary/` by
`scripts/vendor-webdesk-vocabulary.mjs` (`npm run vendor:check` and `vocabulary-vendor.test.ts` fail on any drift); the only restated
piece is how a request becomes the stored `{blocks, seo}` (WebDesk's `assembleItemContent`).

**The `ce` claim.** Every WebDesk write made from this surface (create, update, restore, preview, upload token, media update, and the
`content.publish` a client approves) is signed with `ce: true` between `apr` and `iat` (WebDesk vector v4, pinned byte-for-byte in
`webdesk-editorial-signer.test.ts`); no staff write carries it. The two-row ledger of a client write records `clientEditor: true, clientId`.

**What is deliberately NOT done here (follow-ups).** (1) No notification links into `/portal/...`: the pages are WSK-49d's, so a client
requester is NOT notified when another client approves their batch (the staff inbox href would dangle); the request list is the read.
Staff deciders are still notified that a batch awaits (`/approvals/<id>`). The same holds when STAFF decide a client-filed
request in the inbox: the row carries the client, so the client requester is not sent the staff href either.

**A client publish rebuilds staging automatically (WSK-D65).** When a client editor's publish executes (a self-published item, or a
batch another client editor approved), the executor starts the same staging rebuild a staff publish starts (§27, WSK-60). The client
never holds `github_repo · deploy` and no Cerbos policy changed: the rebuild is authorised by the executed publish itself, which the
dispatch re-verifies on the server before any GitHub call (the approval is an executed `content.publish` in this tenant, decided by
this client editor, filed for a client that is STILL linked to this exact site; otherwise the build row is
`failed: client_publish_unverified` and nothing is sent). The target (repo, workflow, ref) comes only from the ERP's rebuild
configuration; it is once per approval, staging only, and the `github.deploy` ledger rows carry `basis: 'client-publish'` and
`ruling: 'WSK-D65'` with the client as actor. The build status the editor reads is unchanged (`rebuilding` -> `live`/`unverified`).
A staff decider's dispatch is untouched (`authorizeDeploy`).

**A stale `baseVersion` is `409 version-conflict` (WebDesk's body: `currentHeadVersion`, `currentContentHash`, `updatedAt`), decided
before the D59 diff**, on update and on restore: a head that moved (e.g. staff edited a protected field after the client loaded the
item) is never answered as a `422` about a field the client did not touch. Reload the item and re-apply. A deleted item's version
history (`/versions`, `/versions/:n`) is `404 item-not-found` to a client, like the item.

#### Site -> client link (staff) — `webdesk_site_clients` (migration `202610111200`)

Which client a WebDesk site serves, in the serving company's tenant. Nothing carried this before (`webdev_sites` / `webdev_provisioned_sites`
have a `client_id` but no WebDesk slug or site id). One site, one client. Base `/api/:t/modules/webdev/content` (`AuthGuard` + `ModuleEnabledGuard("webdev")`).

| Status | Method | Path | Notes |
|---|---|---|---|
| ✅ | GET | `/site-clients` | `{links:[{tenantSlug, siteId, clientId, clientName, linkedBy, linkedAt}]}`. Authz `webdev_provisioned_site · read`. |
| ✅ | GET | `/sites/:slug/:siteId/client` | `{link}` or `{link:null}`. Authz `read`; the cross-company wall applies (`404` for a site that is not this company's). |
| ✅ | PUT | `/sites/:slug/:siteId/client` | Body `{clientId}` → `{link, changed, previousClientId}`. Authz `webdev_provisioned_site · operate` (company_admin, manager, webdev_manager). A client of another company or an unknown one is `404 client_not_found`; the same client again is `changed:false` with no audit row; re-pointing is allowed and audited (`webdesk.site_client.linked\|relinked`). |
| ✅ | DELETE | `/sites/:slug/:siteId/client` | → `{changed, previousClientId}`. The client loses access at once (every portal request reads the link). Audited `webdesk.site_client.unlinked`. |

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
| ✅ | GET | `/api/:tenantId/mail/threads?entityType=&entityId=` | **MAIL-13** — the entity thread panel's read (approval detail, run workspace). `entityType` ∈ `automation_approval` \| `agency_approval` \| `pipeline_run`; anything else → `400`. **Authorized against the PARENT entity (A10), not against the mail tables** — it 403s in exactly the cases the parent surface 403s (`/api/:t/pipeline/runs`, `/api/:t/automation-approvals/:id` for an approval since T7, which also admits the approval's own requester), cross-tenant included. Returns `{entityType, entityId, messages[]}`; each message is `{id, mailLogId, fromEmail, senderVerified: false, provenance: "inbound-email", subject, bodyText, bodyHtmlSanitized, bodyTruncated, bodyTruncatedChars, sizeBytes, receivedAt, attachments[]}`. **`senderVerified` is always `false` and is the field the "Email reply — sender unverified" banner must be driven by** — do not hardcode the banner, and do not present `fromEmail` as an identity. `bodyHtmlSanitized` has already been through the server-side allowlist at intake (raw MIME is never stored) and must still be rendered in a constrained container. **MAIL-25 (2026-08-05):** `bodyTruncated`/`bodyTruncatedChars` are the STRUCTURED truncation signal — set at intake from length arithmetic alone (migration `0082_mail_truncation_metadata.sql`), never by parsing `bodyText`. `platform-ui`'s `QuotedMessageBody` renders its truncation notice from these two fields only, never from matching the `[truncated at intake: ...]` marker string that MAIL-19 may also have spliced into `bodyText` — a forged marker cannot set them. Never returns `mail_log.payload`, `reply_token`, or storage keys. |
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
- **M5-G5d (additive, no shape change).** For a tool with an approval-args policy (`agency_privacy.*`) the draft behind a chip holds the minimised
  shape (hashes + hints) instead of the model's args, so the chip, `confirm_required` frame and GET thread are exactly as above and the confirm
  request still carries no args. One new terminal `errorKind` on the stream's `error` event: `intent_invalid` (a privacy request whose identifier
  the tool would refuse; no draft, no chip, no value in the text) renders as an ordinary error paragraph.

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

## 19. Social-media module — SMM · Organic Publishing (SMM-* program, 2026-08-13) — `modules/social/social.controller.ts` — **STATUS: IN PROGRESS (SMM-02/08/19/05/09/10/31/40 backend built; NO UI yet)**

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
mirrors it, and a status read that keeps answering while the engine is down. The D14
executable-approval entry and the gate's read surface are SMM-09's, immediately below; the DISPATCH
endpoint (`schedulePost` + the transactional stamp) is still SMM-10's and does not exist yet.

| Method + path | Permission | Notes |
|---|---|---|
| `GET accounts?clientId=&status=` | `social.account.read` | The connector registry as data. A **pure DB read — it never calls the publisher**, which is what makes it keep answering during an outage. Rows carry `{network, handle, displayName, status, quota, capabilities, lastError, healthCheckedAt, connectedAt, publisherOrgRef, driver}`. There is no token field, and there never will be (design D-5: network tokens live inside the engine and are never copied out). |
| `POST publisher-orgs` | `social.account.connect` | Body `{clientId, publisherOrgRef, apiKeyRef?, driver?}`. **Idempotent**: a repeat with the same org ref answers `created:false`. The organization is created by an operator ON THE PUBLISHER HOST (its API has no such route) — this records the mapping. `apiKeyRef` is an **alias**, never a key. Returns `{publisherOrgId, clientId, driver, publisherOrgRef, apiKeyRef, created, verification}`. |
| `POST publisher-orgs/:clientId/sync` | `social.account.update` | Mirrors the engine's integrations into the registry: status, live quota, resolved capabilities, health. Returns `{orgId, accounts[], skipped[], disconnected[]}`. |
| `GET publisher/status` | `social.account.read` | What the seam can do in THIS deployment, **without calling it**: `{configured, driver, enabledNetworks[], capabilities[], inboxSurface, quotaProbe, orgs[]}`. Consult it before spending a call on a capability that may be absent. |
| `GET publisher-orgs/:clientId/connect/:network` | `social.account.read` | **BUILT (SMM-07).** Read-only, never calls the publisher: may this (client, network) start a connect attempt right now, and if not, why. Returns `{ok, reason?, detail?}`. Render a disabled connect button with the EXACT reason the POST below would refuse — never guess separately from it. |
| `POST publisher-orgs/:clientId/connect` | `social.account.connect` | **BUILT (SMM-07).** Body `{network, handle}` — `handle` is the account handle the AGENCY already knows (e.g. the client told us `@acmebrand`); it is never discovered from the engine, because at this instant the engine has not been told about the account at all. **Idempotent/resumable** on `(client, network, handle)` (0105's own unique index): a human who closes the tab and comes back later resumes the SAME pending row (`resumed:true`), never a duplicate. Returns `{accountId, status:"pending", connectUrl, resumed}`. The pending row converges to `connected` the next time `sync` (above) observes the SAME `(network, handle)` from the engine — no separate "complete the connection" endpoint exists or is needed. |

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

**The connect flow's own two refusals (SMM-07), both new and both explained on the `GET
.../connect/:network` read before a console ever has to guess:**

- **`platform_app_not_registered` (409).** No `social_platform_apps` row for that network carries a
  live `credential_ref`. Verified on the live engine 2026-08-19: `FACEBOOK_APP_ID`,
  `FACEBOOK_APP_SECRET`, `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `TIKTOK_CLIENT_ID`,
  `YOUTUBE_CLIENT_ID` are all length 0 — **no account can be connected today, on any network, for
  any client, including our own brand**, until the OQ-1 app-review dossier lands at least one
  approved app per network. Render this as "not connectable yet: no platform app is registered", not
  as a broken button and not as an empty list.
- **`client_connect_requires_signoff` (409).** OQ-3 (owner decision): own-brand accounts proceed,
  client accounts wait for AGPL counsel sign-off. Driven by a deployment-level allow-list
  (`SOCIAL_OWN_BRAND_CLIENT_IDS`), empty by default — so with no configuration at all, the honest
  default is that EVERY client refuses, including a would-be "own brand" one nobody has listed yet.
- **`connect_redirect_not_configured` (503).** `SOCIAL_CONNECT_REDIRECT_URL` is unset — a deployment
  configuration gap, same shape as `publisher_not_configured`, nothing the caller can fix by
  retrying.

Plain 400 tokens on the connect POST: `invalid_client`, `unknown_network`, `missing_handle`.

**MCP surface** (`GET /mcp/tool-defs`, aggregated — nothing hub-side is hardcoded):
`social.listEngagements`, `social.getEngagementScope` (reads, `low`),
`social.createEngagement` (write, impact `low`), `social.setEngagementScope` (write, impact
**`medium`** — an automation principal is SUSPENDED into WS4 rather than applied),
`social.ingestBrandCorpus` / `social.draftPostVariant` / `social.draftPostIdeas` (SMM-19, write,
impact `low` — every one writes a draft row or a knowledge pointer, none can reach a live network;
same `authorize()` calls as their HTTP twins above), and SMM-05's `social.listAccounts` /
`social.getPublisherStatus` (reads, `low`), `social.provisionPublisherOrg` (write, impact
**`medium`** — it is the tenant-mapping row whose corruption is the wrong-account-publish nightmare)
and `social.syncConnectorRegistry` (write, impact `low` — mirrored state only, nothing public), plus
SMM-09's `social.checkPublishPreconditions` (read, `low`). The inbox, report and ledger tools are
deliberately NOT declared yet: their endpoints do not exist, and a tool the hub publishes to every
agent without a handler behind it is this program's "frontend-first drift" bug pointed at automation
instead of a console.

⚠ **CORRECTED 2026-08-20 (SMM-24).** This paragraph used to say `social.publishPost` was registered
in the D14 registry but **not** declared as an MCP tool "until SMM-10 builds the dispatch endpoint".
SMM-10 landed on 2026-08-19 and **declared it** — `modules/social/index.ts`, `name:
SOCIAL_PUBLISH_TOOL`, `POST /api/:tenantId/modules/social/variants/:variantId/publish`, classification
spread from `SOCIAL_PUBLISH_TOOL_CLASSIFICATION` so the `write:true, impact:"high"` pair is never
retyped. The stale sentence was believed over the code by a later seat, which is exactly the failure
mode the top of this file warns about. **`social.publishPost` IS declared.**

⚠ **CORRECTED 2026-08-23 (security follow-up, found while closing SMM-22's Cerbos gap).** This line
used to end here saying "`social.publishPostMetered` is BARRED and must never be declared at all —
that has not changed." That was true when SMM-09 wrote it and stopped being true when SMM-22
(2026-08-22) built the metered tool's own real endpoint and declared it (see the `publish-metered`
row below, itself already correctly marked **BUILT**) — the SAME stale-comment class independently
found and fixed in `modules/social/index.ts`'s own import-block comment that pass. What is STILL
true, and is the actual load-bearing fact: `social.publishPostMetered` remains BARRED FROM
AUTO-EXECUTION in `core/approval-executables.ts` by default (`SOCIAL_METERED_PUBLISH_ENABLED`
defaults false) and remains deliberately ABSENT from `cerbos/policies/resource_mcp_tool.yaml`'s
executable-tool bracket, so an agent/automation-origin re-drive of it can never auto-execute —
config flag or no. See that policy file's own dated SMM-22 block and `docs/plans/smm-tracker.md`'s
"Security follow-ups closed" evidence block for the live-Cerbos proof.

**The publish gate (SMM-09) — BUILT.** Cerbos kind `social_post`. This is the D14
executable-approval spine SMM-10/17/22/31 consume. Design: addendum D-14 (publish executes on
approval, money split out of that path), D-15 (`payload_hash` IS `argsSha256`), D-22 (owner decision
2026-08-18 — the composer's explicit selections ARE the TikTok creator consent, and `creator_info`
is re-verified at dispatch).

| Method + path | Permission | Notes |
|---|---|---|
| `GET variants/:variantId/publish-preconditions` | `social.post.read` | **A dry run of the D14 execution precondition — it publishes nothing, consumes no approval and makes no network call.** Runs the EXACT function the approval executor runs, so a console's "why can't this publish" cannot drift from what execution will actually say. Returns `{ok, stage?, reason?, stages[], tool, meteredTool}`. A refusal is DATA with a **200** (it is a successful answer to the question asked); an unknown variant is a **404**; a principal with no social grant is a **403**, never `ok:false`. Read-tier on purpose: asking whether a publish would be allowed is not publishing, and `social.post.publish` stays manager-tier. |
| `POST variants/:variantId/approve` | **`social.post.publish`** (manager-tier — the SAME action `publish` below uses; NO new permission key) | **BUILT (SMM-40, 2026-08-23) — mints the D14 grant, so far missing entirely** (`docs/plans/smm-tracker.md`'s own last open follow-up, found by SMM-17). Flips the variant to `'approved'` (0105's own pre-existing status value, which the `unconsumed` precondition stage already required) and files an `automation_approvals` row for `social.publishPost` — `origin:'agent'`, `tool_args` a snapshot of `variantPublishArgs` — via the SAME shared filing helper `admin/role-grants.controller.ts`'s override request uses. Returns `201 {id, variantId, status:"pending", decideVia}` on a fresh mint, or `{..., alreadyPending:true}` for an idempotent double-click against the identical (unedited) content — a live grant against a DIFFERENT, since-edited snapshot is never returned, only a fresh one. Deciding is the SEPARATE, pre-existing `POST /api/:tenantId/automation-approvals/:id/decide` (`decideVia` names it) — no execute logic lives here; "approving executes" falls out of `social.publishPost`'s pre-existing SMM-09 registry entry. `404` unknown variant; `409 {error:"variant_not_approvable:<status>"}` if the variant is not draft/in_review/approved; `403` non-manager. **Named gap (not fixed here):** a manager with no `identity_links` row (the realistic default for an ordinary Keycloak/OIDC staff login — only the WhatsApp/Telegram dual-proof ceremony creates one) will have their mint decided successfully but fail EXECUTION with the pre-existing, correctly-typed `principal_unresolvable` — an IAM/OIDC identity-linking gap, proven in both directions in `social-publish-approve.test.ts`, out of this ticket's scope. |
| `POST variants/:variantId/publish` | **`social.post.publish`** (manager-tier — the act itself, not the dry run) | **BUILT (SMM-10), added to this table 2026-08-20 — it existed only in prose above until this pass.** The dispatch endpoint `SOCIAL_PUBLISH_TOOL` fronts (`modules/social/index.ts`). Re-runs the precondition under `APPROVAL_EXEC_LOCK_NS`'s lock (never trusts the payload the human saw), then `dispatch.ts` makes the real network call and stamps `approval_id`+`provider_post_id` in one transaction. A refusal answers `409 {message: "<token>"}` — deliberately `message`, not `error` (`HttpErrorFilter` renames it on the way out; see the trap noted below). Ordinarily reachable only through the D14 executor's re-drive (`social.publishPost` is `write:true, impact:'high'`, so a direct agent call always suspends into WS4 first) — the OBO-resolved principal is the ORIGINAL FILING principal, never the approver. |

**Dispatch-stage refusals (`DISPATCH_REFUSAL`, `dispatch.ts`) — reached only AFTER every precondition
above has already passed, so these are the failures that happen with a real network call in
flight:** `approval_not_resolvable` (the approval id on the row does not resolve to exactly one
approved grant — refuses closed rather than guessing which one) · `dispatch_stamp_race_lost` (a
concurrent dispatch already claimed the transactional stamp) · `dispatch_error` (the publisher call
itself failed or its outcome is unknown — lands `failed`, never auto-retried) · `media_upload_failed`
(an attachment's real upload failed BEFORE `schedulePost` is called, so a post is never published
partially-attached).

**The refusal vocabulary — a CONTRACT, not log text.** The same snake_case tokens appear in this
endpoint's `reason` and in `automation_approvals.execution_error` after the `precondition_failed: `
prefix. Evaluated strictly in this order, and the first refusal wins:

| Stage | Tokens |
|---|---|
| `scope` | `variant_not_found` · `cross_client_account` · `account_not_connected` · `network_disabled` · `network_not_in_scope` · `engagement_inactive` · `metered_network_requires_metered_tool` · `metered_tool_requires_metered_network` |
| `quota` | `quota_exhausted` · `media_rules_failed` |
| `hash` | `args_hash_mismatch` |
| `unconsumed` | `already_dispatched` · `approval_already_consumed` · `variant_not_approved` |
| `budget` | `budget_exceeded` · `metered_price_unconfigured` |
| `creator_info` | `creator_info_unverified` · `creator_selection_no_longer_permitted` |

**SMM-22 — the metered path (X), and what the two new tokens mean.** `metered_tool_requires_metered_network`
is the SYMMETRIC twin of the existing `metered_network_requires_metered_tool`: the first stops a metered
variant reaching the free tool, the second stops a free variant reaching the metered one — which would
write an `x_post`-kind ledger row for an Instagram post and leave the usage panel unable to explain
itself. `metered_price_unconfigured` is a **fail-closed** refusal, not an error: `estimateCostUsd` now
returns a reason rather than `$0`, because a `$0` estimate would let an unpriced X post pass every tier
of the stop-loss for free.

`GET variants/:variantId/publish-preconditions` gains **`estimatedCostUsd`** and, when the price is
absent, **`costUnavailableReason`** — so the approval card can show what a publish will cost before a
human approves it, and can say why it cannot when the price is unconfigured.

| Method + path | Cerbos | Note |
|---|---|---|
| `POST /api/:tenantId/modules/social/variants/:variantId/publish-metered` | `social_post` / `publish` | **BUILT.** The metered twin's dispatch endpoint. Shares `dispatch.ts#dispatchApprovedPublish` with the free path via a `toolName` parameter — one implementation, not two. `social.publishPostMetered` is **declared as an MCP tool regardless**, so an automation call still suspends into WS4; what is config-gated (`SOCIAL_METERED_PUBLISH_ENABLED`, default off) is only whether the D14 registry AUTO-EXECUTES it on approval. Boot REFUSES if that flag is true while X's per-post price is unset. |
| `GET /api/:tenantId/modules/social/engagements/:engagementId/usage` | `social_ledger` / `read` | **BUILT.** Month-to-date metered spend for the usage panel, plus the engagement/tenant/global stop-loss tiers' state. The two new tiers apply ONLY to metered dispatches — see `publish-precondition.ts`'s own comment on why extending them to `$0` posts would turn one runaway X bill into a platform-wide freeze on every company's free posting. |


Five properties a console (and every downstream ticket) must not smooth over:

- **Edit invalidates approval, structurally.** The approval is bound to `args_sha256`. Any content
  edit moves the hash, so the grant stops matching and the publish refuses `args_hash_mismatch` —
  this is a property of the hash, not a rule someone remembered to enforce. `PATCH variants/:id`
  already answers `approvalInvalidated: true`; this is the other end of the same fact.
- **Replay is refused twice over.** The approval's own single-use claim stops one row executing
  twice; the VARIANT's `provider_post_id` / `approval_id` stops a SECOND approval publishing the same
  content (`already_dispatched` / `approval_already_consumed`).
- **An ambiguous failure is NEVER auto-retried.** A publish whose outcome is unknown
  (`hub_unreachable`, `tool_error`) may already be on a client's public feed. The row lands `failed`,
  both principals are notified at severity `warning`, and only a HUMAN pressing Retry (which re-takes
  the lock and re-runs this precondition) moves it. The tenant's `automation.approvalRetry.autoRetryCount`
  setting does NOT apply to a publish — the tool's policy outranks it.
- **`quota_unknown` is still only a warning.** An unsynced registry must never read as an exhausted
  account; only a live counter at or over its cap refuses.
- **TikTok fails closed on consent (D-22).** A TikTok variant refuses `creator_info_unverified`
  unless a dispatch-side `creator_info` verification is available, and
  `creator_selection_no_longer_permitted` when the creator's live settings no longer permit the
  approved selections. Neither is auto-retried. SMM-10 installs the verifier; the hook and its typed
  reasons are SMM-09's.

**The D-14 money split, at the tool surface.** `social.publishPost` (the $0 path) is the registered
executable; `social.publishPostMetered` (any metered network — X, which ships disabled in every
scope) is **BARRED**: it is absent from the executable registry and from
`cerbos/policies/resource_mcp_tool.yaml`'s executable-tool list, so an approved row for it stays
`execution_status='not_applicable'` forever. Belt and braces, the free tool's own precondition
refuses a metered-network variant with `metered_network_requires_metered_tool` rather than spending.

**Client review stage (SMM-31/32, D-16) — BUILT, staff side now consumed by the Composer/Calendar
(SMM-32).** Cerbos kind `social_client_review`
(staff side) / `portal` action `approve_post` (client side — see §16g). NOT a 7th stage in the table
above: `PUBLISH_PRECONDITION_STAGES` is unchanged and pinned. When the caller's variant resolves to
an engagement with `toolScope.posting.requiresClientOk` set, `GET .../publish-preconditions` (and
the D14 executor, and SMM-10's dispatch) now check client sign-off FIRST, reporting
`stage:"client_review"` with its own small vocabulary — kept apart from the table above the same way
`DISPATCH_REFUSAL` is kept apart from it.

| Method + path | Permission | Notes |
|---|---|---|
| `POST variants/:variantId/client-review` | `social.client_review.request` | Ask the client to sign off. **Idempotent upsert** — 0105's `UNIQUE(variant_id)` means one review row per variant forever; re-asking from ANY prior state (including after `withdrawn`/`changes_requested`, or after an edit staled a prior `approved`) resets the SAME row to `pending`. A repeat call while already `pending` is a no-op (`alreadyPending:true`, no duplicate event/notification). Returns `{id, status:'pending', alreadyPending}`. |
| `GET variants/:variantId/client-review` | `social.client_review.read` | `{status:'not_requested'}` when nobody has ever asked — data, not a 404 (a variant that never needed sign-off is a legitimate steady state). Otherwise `{id, status, comment, reviewedArgsSha256, requestedAt, decidedBy, decidedAt}`. |
| `POST variants/:variantId/client-review/withdraw` | `social.client_review.withdraw` (**manager-tier**) | Retract a pending ask. Idempotent: withdrawing an already-withdrawn review is a 200 no-op, never an error. 404 if no review was ever requested; 400 `client_review_not_pending` if it is already `approved`/`changes_requested` (use `request` to re-ask instead of trying to withdraw a decision). |

Refusal tokens (`CLIENT_REVIEW_REFUSAL`, reported as `stage:"client_review"` on the dry-run/dispatch
paths above): `client_review_not_requested` (requiresClientOk is set, nobody has ever asked) ·
`client_review_pending` · `client_review_changes_requested` · `client_review_withdrawn` ·
`client_review_stale` (the client approved, but the content changed since — `reviewedArgsSha256` no
longer matches the variant's live `argsSha256`; D-15's edit-invalidates-approval rule, restated for
the client's own side of the same content).

**UI consumer (SMM-32, this pass):** `platform-ui/src/lib/socialShared.ts` mirrors
`CLIENT_REVIEW_REFUSAL` by hand (same reasoning `PUBLISH_PRECONDITION_STAGES`'s own copy gives) plus
`evaluateClientReviewState` — a client-safe re-implementation of `evaluateClientReviewPrecondition`
(same five-way branch, same staleness check against the variant's live `argsSha256`), all five
tokens rendered via `REFUSAL_LABELS`/`describeRefusal`. `lib/social.ts#getClientReview` reads the
staff endpoint; `lib/socialActions.ts#requestClientReview`/`withdrawClientReview` write it.
`components/social/VariantCard.tsx`'s new `ClientReviewPanel` renders the current state per variant
(ask / re-ask / withdraw, gated on the `social.client_review.{request,withdraw}` capability mirror)
and doubles as the honest renderer for `stage:"client_review"` on the EXISTING publish-preconditions
preview button (the `stage`/`reason` pair is data either way). `CalendarGrid.tsx`'s chips show only
the RAW status (never `stale`) — `listPosts`'s roll-up carries no `argsSha256` to compare against,
so the calendar cannot detect staleness without a fabricated field; only the Composer (which reads
the full variant) renders `client_review_stale`.

**Reconcile webhook intake (SMM-10) — added to this table 2026-08-20, existed only as a code comment
until this pass.** Cerbos kind: none — this is machine-to-machine, not a principal-carrying route.

| Method + path | Gate | Notes |
|---|---|---|
| `POST webhooks/post-status` | `AuthGuard`'s platform SERVICE TOKEN **plus** a second factor, `x-social-webhook-secret` header matched against `config.social.webhookSecret` | **BUILT (SMM-10).** Body `{providerPostId}` — the ONLY field read; anything else the caller sends is discarded unread. Re-fetches authoritative state itself via `SocialPublisher.getPostStatus` before writing anything, so a malicious/buggy caller can at most trigger an early honest re-check, never inject a fabricated outcome. An unconfigured secret refuses every request. **No `work_activity` row is written on this path** (`reconcileOneProviderPost`, `post-status-sync-job.ts` — confirmed by reading it, not assumed): unlike the retention purge and metrics pull, which the golden-case table explicitly excuses as "no user attribution to attach an activity row to", this endpoint's own absence of that reasoning has never been written down anywhere. Named as a gap in `docs/modules/social-capability-inventory.md`, not silently matched to the purge job's excuse. |

**Metrics (SMM-21) — read-only, added to this table 2026-08-20; existed in the SMM-21 evidence block
but never reached this contract file.** Cerbos permission `social.account.read` (the same grant
`GET accounts` uses — accounts are client-scoped, not engagement-scoped).

| Method + path | Permission | Notes |
|---|---|---|
| `GET metrics/daily?accountId=&from=&to=` | `social.account.read` | **BUILT (SMM-21).** Per-account daily series from `social_metrics_daily`, populated by the nightly `pullMetrics` sweep (`metrics-job.ts`). 400 `missing_field` without `engagementId` — there is no other way to know which client's rows to read. Every metric field is OPTIONAL and stays SQL `NULL` end to end when the driver never reported it — **never coerced to 0**; the `date` column is cast `::text` server-side to dodge the node-pg timezone-shift trap `pm.controller.ts` already guards against. **No MCP tool** — the SMM-21 ticket named `pullMetrics` + the tables + the Analytics tab, not an agent-facing tool; see `docs/modules/social-capability-inventory.md`. |
| `GET metrics/posts?variantIds=` | `social.account.read` | **BUILT (SMM-21).** Latest `social_post_metrics` snapshot per published variant (`DISTINCT ON (variant_id) ... ORDER BY fetched_at DESC`) — the table is append-only, so this is the newest row, never an aggregate. Same optional-field/never-a-fabricated-zero rule as above. **No MCP tool**, same reason. |

`main.ts` registration for the nightly sweep itself (`startMetricsPullLoop`, gated by
`SOCIAL_METRICS_PULL_ENABLED`) landed with the SMM-21 merge to `main` (verified: `main.ts` now
imports and calls it) — the "pending merge" caveat in this program's earlier SMM-21 evidence is
resolved as of this pass.

**Rollup metrics** (D12): `social.engagements.active`, `social.accounts.connected`,
`social.posts.published.month`, `social.approvals.pending`, `social.inbox.open`,
`social.usage_cost.month` (USD minor units, `isMonetary`). All are real queries against 0105's
tables and read zero until the later write paths land.

---

## 20. Monitoring module — Plane B property/service monitoring (MON-* program, 2026-08-13) — `platform-ui/src/lib/monitoring.ts` — **STATUS: BACKEND MOSTLY BUILT (2026-09-02: channel/route management, results-by-window and maintenance write/delete landed — the alert-delivery management surface described below; `POST/PATCH /monitors` and `POST /incidents/:id/ack` are separately-implemented pre-existing rows whose PENDING marker predates this pass)**

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
| GET | `/api/:t/monitoring/monitors?clientId&kind&status` | `monitoring.read` | `Monitor[]` | ✅ BUILT |
| POST | `/api/:t/monitoring/monitors` | `monitoring.monitor.create` (Cerbos `monitor`/`create`) | `{ id }` | ✅ BUILT (pre-existing — this row was STALE, corrected 2026-09-02: the handler predates this round; verified in `monitoring.controller.ts`) |
| GET | `/api/:t/monitoring/monitors/:id` | `monitoring.read` | `MonitorDetail` \| 404 | ✅ BUILT |
| PATCH | `/api/:t/monitoring/monitors/:id` | `monitoring.monitor.update` (Cerbos `monitor`/`update`) | `{ id }` | ✅ BUILT (pre-existing — this row was STALE, corrected 2026-09-02: the handler predates this round; verified in `monitoring.controller.ts`) |
| GET | `/api/:t/monitoring/monitors/:id/results?window=24h\|7d\|30d` | `monitoring.monitor.read` | `MonitorResult[]` | ✅ BUILT (2026-09-02) |
| GET | `/api/:t/monitoring/incidents?status&limit` | `monitoring.read` | `Incident[]` | ✅ BUILT |
| POST | `/api/:t/monitoring/incidents/:id/ack` | `monitoring.incident.acknowledge` (Cerbos `monitor_incident`/`acknowledge`) | `{ id }` | ✅ BUILT (pre-existing — this row was STALE, corrected 2026-09-02: the handler predates this round; verified in `monitoring.controller.ts`) |
| GET | `/api/:t/monitoring/summary` | `monitoring.read` | `MonitoringSummary` | ✅ BUILT |
| GET | `/api/:t/monitoring/kinds` | `monitoring.read` | `MonitorKindSpec[]` | ✅ BUILT (from the driver registry) |
| GET | `/api/:t/monitoring/maintenance` | `monitoring.read` | `MaintenanceWindow[]` | ✅ BUILT |
| POST | `/api/:t/monitoring/maintenance` | `monitoring.maintenance.create` | `{ id }` | ✅ BUILT (2026-09-02) |
| DELETE | `/api/:t/monitoring/maintenance/:id` | `monitoring.maintenance.delete` | `{ id }` | ✅ BUILT (2026-09-02) — hard delete, ends suppression early; no `deleted_at` column on this table |
| POST | `/api/monitoring/heartbeat/:token` | **unauthenticated by design** (token IS the credential) | `{ok:true}`, always | ✅ BUILT — NOTE the path has NO `:t`: there is no principal, so no tenant to scope by; the token identifies the row |
| GET | `/api/:t/monitoring/channels` | `monitoring.channel.read` | `MonitorChannel[]` | ✅ BUILT (2026-09-02) |
| POST | `/api/:t/monitoring/channels` | `monitoring.channel.manage` | `{ id }` | ✅ BUILT (2026-09-02) — not in the original PENDING list, added to close the create gap |
| PATCH | `/api/:t/monitoring/channels/:id` | `monitoring.channel.manage` | `MonitorChannel` | ✅ BUILT (2026-09-02) — not in the original PENDING list, added to close the edit gap |
| DELETE | `/api/:t/monitoring/channels/:id` | `monitoring.channel.manage` | `{ id, deletedAt }` | ✅ BUILT (2026-09-02) — soft delete; not in the original PENDING list |
| POST | `/api/:t/monitoring/channels/:id/test` | `monitoring.channel.manage` | `{ ok }` | ✅ BUILT (2026-09-02); delivery tracking (`lastDeliveryAt`/`lastDeliveryOk`/`failureCount`) DEV-VERIFIED (2026-09-03, CH) — sends a real `monitoring.alert` notification through `enqueueMail`, refuses (400) for any channel kind other than `email`, and now writes the channel's health columns on every attempt (see note 8) |
| GET | `/api/:t/monitoring/routes` | `monitoring.channel.read` | `MonitorRoute[]` | ✅ BUILT (2026-09-02) |
| POST | `/api/:t/monitoring/routes` | `monitoring.channel.manage` | `{ id }` | ✅ BUILT (2026-09-02) — not in the original PENDING list, added to close the create gap |
| PATCH | `/api/:t/monitoring/routes/:id` | `monitoring.channel.manage` | `MonitorRoute` | ✅ BUILT (2026-09-02) — not in the original PENDING list |
| DELETE | `/api/:t/monitoring/routes/:id` | `monitoring.channel.manage` | `{ id }` | ✅ BUILT (2026-09-02) — hard delete; `monitor_routes` has no `deleted_at` column; not in the original PENDING list |

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
   **DEV-VERIFIED 2026-09-03 (CH):** both writers of these columns — `runner.ts`'s `notifyIncidents`
   (real incident fan-out) and `POST /channels/:id/test` (test-send) — now write
   `lastDeliveryAt`/`lastDeliveryOk`/`failureCount` on every attempt, immediately after
   `migrations/202609030200_monitor_channel_delivery_columns_comment.sql` pinned the semantics in
   `COMMENT ON COLUMN`. **`lastDeliveryOk: true` means only "`enqueueMail()` handed this to the mail
   queue as `status: 'queued'`" — an ENQUEUE acknowledgement, never proof the provider accepted the
   send or the recipient received it.** `enqueueMail()` inserts one `mail_log` row and returns
   immediately; the actual SMTP/API handoff happens later in an async sender worker, and the
   provider's own delivered/bounced verdict later still, via an inbound webhook that updates that
   SAME `mail_log` row — but is not attributed back to which `monitor_channel` sent it (a single
   incident can fan out to several channels, and `mail_log` only records the monitor/channel it was
   enqueued for, not a link a later webhook event can resolve back to one specific channel). Wiring
   that stronger signal needs a schema change on `mail_log`, a table this module does not own — an
   explicit follow-up, not implemented here. A recipient matching `mail_suppressions` (prior hard
   bounce/complaint) comes back `status: 'suppressed'` and is recorded as a FAILURE (increments
   `failureCount`), because the sender worker deliberately never reaches such a row — a channel that
   will silently never deliver is exactly the false-confidence case this column exists to catch. An
   attempt is not recorded at all (columns untouched) when the whole mail subsystem is switched off
   (`config.mail.enabled=false`) — a platform-wide fact, not one about the individual channel.
9. **Public status pages (`/status/:slug`) are NOT in this section.** They are an unauthenticated
   surface with their own strict field allowlist (monitoring-program.md §3.5) and must not reuse
   these shapes — `target`, `config` and assertion strings are all forbidden there.
10. **Routes are authorized under `monitor_channel`, not a dedicated `monitor_route` Cerbos kind —
    there is no such kind, by design.** A route is a channel's own routing rule, not an
    independently-owned resource, and Cerbos denies unlisted kind/action pairs silently, so minting
    a sixth kind for it would be six more artifacts (policy + derived-role wiring + pinned count
    tests) for a resource with no ownership semantics of its own. `monitoring.channel.read` /
    `monitoring.channel.manage` gate BOTH channel and route endpoints.
11. **`monitoring.channel.manage` covers create, edit, delete AND test-send uniformly.** The
    permission catalog has no separate `channel.delete` or `route.*` key; delete reuses `manage`
    rather than inventing one, matching the Cerbos policy's own comment ("manage also covers the
    test-send").
12. **`POST /channels/:id/test` refuses (400) for any channel `kind` other than `email`.** Only
    `email` has a wired delivery driver (`runner.ts`'s `notifyIncidents` skips every other kind
    without erroring) — a test-send must not report a fake `{ok:true}` for a channel nothing can
    actually deliver through yet. Creating a non-email channel is still legal ahead of its driver
    landing ("absent, not silently inert" applies to drivers, not to channel rows).
13. **An email channel requires a plausible `destination` at write time.** `runner.ts`'s fan-out
    silently skips any channel with `!ch.destination`, so a channel that could never deliver would
    otherwise sit on the console looking like coverage — the exact failure `channelHealth` exists to
    surface. Non-email kinds accept any (or no) `destination`; it is an opaque display string.
14. **`monitor_routes` has no `deleted_at` column and neither does `monitor_maintenance`.** Their
    deletes are real `DELETE`s, unlike `monitors`/`monitor_channels`/`status_pages`, which soft-delete.
15. **`POST /maintenance`'s `scope` round-trips `GET /maintenance`'s own rendering** — `"all"` for a
    tenant-wide window, `"monitor:<uuid>"` for a monitor-scoped one — matching
    `platform-ui/src/lib/monitoringActions.ts`'s `scheduleMaintenance` form field exactly, so no
    second representation needs to stay in sync.
16. **MON-20 — `GET /monitors/:id/results?window` must 404 (or 403/405) when it genuinely does not
    exist, and return `200 []` (never a synthesized row) for a real monitor with zero checks in that
    window.** The UI (`lib/monitoring.ts`'s `listResults`) treats those as different states —
    `{available:false}` vs `{available:true, results:[]}` — and renders different copy for each. A
    500 or a network fault must still propagate (do not catch those into either shape).
17. **MON-20 — channel/route write bodies.** `POST`/`PATCH /channels[/:id]` accept
    `{kind, name, destination, enabled}` (all but `enabled` required on create; any subset on PATCH).
    `POST`/`PATCH /routes[/:id]` accept `{channelId, matchClientId?, matchSeverity?, matchKind?,
    enabled}` (`channelId` required on create, must reference an existing channel — 400 if not).
    `DELETE /channels/:id` should cascade-delete or reject-if-referenced routes pointing at it; the
    UI's DEMO_MODE fixture cascades (see `lib/demoMonitoring.ts`'s comment on that choice) but this is
    a UI-side guess, not a locked decision — pick whichever the real schema's FK constraint implies
    and update `lib/monitoringActions.ts`'s `deleteChannel` doc comment to match.
18. **MON-20 — `DELETE /maintenance/:id` cancels a window; it is not sensitive server-side** (ending
    suppression early is the opposite of concealing an outage — see monitoring-program.md §14's own
    reasoning for why `.create` and `.delete` are catalogued as two permissions, not one).
19. **Deleting a channel does NOT delete its routes.** `monitor_routes.channel_id` carries
    `ON DELETE CASCADE` (`0116_module_monitoring.sql`:198), but `DELETE /channels/:id` is a SOFT
    delete, so the FK cascade never fires and the route row survives its channel. Delivery is
    still safe — the runner's fan-out filters `ch.enabled = true AND ch.deleted_at IS NULL`
    (`runner.ts`:311), so nothing is ever sent to a deleted channel.
    **FIXED 2026-09-03 (FX):** `lib/demoMonitoring.ts` used to CASCADE-delete a channel's routes,
    which diverged from production's soft-delete-and-survive behaviour; the fixture now soft-
    deletes the channel (setting an internal `deletedAt`, filtered out of `GET /channels`/
    `PATCH`/`DELETE`/`test`) and leaves `ROUTES` untouched, exactly like the real controller.
    ⚠ **Doing this precisely surfaced a doc/code mismatch this note previously got wrong, still
    open for an owner call:** the sentence this replaced claimed the visible consequence was
    `RouteManager` rendering `r.channelName ?? r.channelId` (a raw uuid) for an orphaned route.
    That is NOT what `listRoutes` actually does — `monitoring.controller.ts`'s query is an
    **INNER JOIN** (`FROM monitor_routes r JOIN monitor_channels ch ... WHERE ch.deleted_at IS
    NULL`), so a route whose channel was soft-deleted is dropped from `GET /routes` entirely, not
    returned with a null `channelName`. `RouteManager.tsx`'s `?? r.channelId` fallback is
    therefore dead code against this endpoint as written, and no test in
    `monitoring.controller.test.ts` exercises the orphaned-route case either way. The fixture now
    mirrors the CODE (excludes the orphaned route from `GET /routes`, matching the INNER JOIN),
    not this note's older description — reported to the orchestrator as a backend
    defect/doc-drift needing a decision: either correct this note (routes silently disappear when
    their channel is deleted, full stop), or change `listRoutes` to a LEFT JOIN so an orphaned
    route stays visible with a raw id, as originally intended. See `platform-nest/src/modules/
    monitoring/monitoring.controller.ts:1119-1137`.
20. **A heartbeat monitor's grace period has exactly ONE source of truth: `MonitorDetail.config`
    (`graceSec`, part of the driver-validated config `POST`/`PATCH` already accept and persist to
    `monitors.config`).** `monitor_heartbeats.grace_sec` existed from `0116` through 2026-09-03 and
    LOOKED authoritative — same table as the heartbeat's `lastSeenAt`, same name as the value it
    appeared to gate — but it was written once at creation and never updated by `PATCH`, while the
    runner always evaluated grace from `config.graceSec`. Editing a heartbeat monitor's grace through
    the UI therefore changed the enforced value correctly the whole time; querying the DB column
    directly would have shown a stale number after the first edit. Migration `202609031200` removed
    the column outright — do not resurrect a heartbeat-specific grace field outside `config`, and if a
    future UI surface needs to read a heartbeat monitor's configured grace, read `config.graceSec` off
    `MonitorDetail`, never a `monitor_heartbeats` column.

### UI consumers (built 2026-08-13; MON-20 additions 2026-09-02)

- `/monitoring` — operations board: KPI tiles, worst-first monitor table, open incidents, explicit
  stale-monitor callout, explicit backend-absent state.
- `/monitoring/[id]` — monitor detail: uptime strip (one cell per check), incident history, recent
  checks, TLS/domain expiry tiles.
- `/monitoring/new` — monitor editor. The kind picker is rendered **from `GET /kinds`**, so a driver
  registered server-side appears here with no frontend change; a kind with `available:false` renders
  disabled rather than hidden.
- `/monitoring/channels` — notification channels + routes, surfacing three quiet failure modes:
  a channel failing its last 3 deliveries, an enabled channel with no route pointing at it, and a
  catch-all route that matches every event. MON-20: full create/edit/enable-disable/delete on
  channels (`ChannelManager.tsx`) and create/edit/delete on routes (`RouteManager.tsx`), gated on
  `monitoring.channel.manage`; a viewer without it sees the same tables read-only.
- `/monitoring/maintenance` (MON-20, new) — list + schedule + cancel maintenance windows, gated on
  `monitoring.maintenance.create`/`.delete` (`MaintenanceManager.tsx`).
- Writes: `lib/monitoringActions.ts` (`createMonitor`, `acknowledgeIncident`, `scheduleMaintenance`,
  `deleteMaintenance`, `testChannel`, `saveChannel`, `setChannelEnabled`, `deleteChannel`,
  `saveRoute`, `deleteRoute` — MON-20 added the last six).
- Nav: **Business → Monitoring** (`components/shell/nav.ts`, indexed in `docs/sidebar-nav-map.md`).
  `/monitoring/maintenance` is reached from in-page links (board page + channels page), not a new
  top-level nav entry.
- DEMO_MODE fixtures: `lib/demoMonitoring.ts` — seeded with a down/degraded/stale/maintenance/
  unknown/never-checked spread plus expiring cert and domain, so every branch is drivable with no
  backend. Wired into `demoFixtures.getDemoResponse`. MON-20: channels/routes/maintenance are now a
  writable `globalThis`-backed store (create/edit/delete persist for the session), and
  `/results?window=` actually filters by window so the 24h/7d/30d switcher has something to show.

---

## 23. LMS module — Learning · Certification (LMS L1, 2026-08-24) — `src/modules/lms/`, `platform-ui/src/lib/lms.ts` — **STATUS: BACKEND PROTOTYPED, UI READ SURFACE PROTOTYPED (writes not wired)**

Design: `docs/blueprints/lms-foundation.md`. Its own module key (`lms`), so every route below 404s
unless the company has `lms` enabled or served — **which no live company does yet**. All routes are
mounted under `/api/:tenantId/modules/lms`.

⚠ **`platformFetch(path, userId)` — that order.** `lib/lms.ts` had it swapped in every reader when
first written; both are `string`, so nothing failed and the pages rendered empty against a backend
that was never asked. `src/lib/lms-readers.test.ts` pins the paths.

| Method | Path | UI consumer | Status |
|---|---|---|---|
| GET | `/courses?track&unitNodeId&discipline&level&status` | `listCourses` — `/learning`, `/learning/catalogue` | ✅ BUILT · ✅ WIRED |
| POST | `/courses` | — (L3 authoring) | ✅ BUILT · ⬜ no UI consumer |
| GET | `/courses/:id` | `getCourse` — `/learning/courses/[id]` | ✅ BUILT · ✅ WIRED |
| PATCH | `/courses/:id` → `{id, versioned, version}` | — (L3) | ✅ BUILT · ⬜ no UI consumer |
| POST | `/courses/:id/publish` · `/retire` | — (L3) | ✅ BUILT · ⬜ no UI consumer |
| POST | `/courses/:id/modules` · `/modules/:id/activities` · DELETE `/activities/:id` | — (L3) | ✅ BUILT · ⬜ no UI consumer |
| GET | `/paths?track&mandatory` | `listPaths` | ✅ BUILT · ✅ WIRED |
| POST | `/paths` · `/paths/:id/courses` · `/paths/:id/publish` | — (L3) | ✅ BUILT · ⬜ no UI consumer |
| GET | `/me` → `{enrolments[], certifications[]}` | `getMyLearning` — `/me/learning` | ✅ BUILT · ✅ WIRED |
| GET | `/enrollments?subjectUserId&status` | `listEnrollments` | ✅ BUILT · ⬜ no page yet |
| POST | `/enrollments` · `/enrollments/:id/waive` | — (L3) | ✅ BUILT · ⬜ no UI consumer |
| POST | `/activities/:id/attempts` · `/attempts/:id/grade` | — (L5, needs the lab runner) | ✅ BUILT · ⬜ no UI consumer |
| GET | `/compliance` → `ComplianceRow[]` | `getCompliance` — `/learning/compliance` | ✅ BUILT · ✅ WIRED |

**Contract notes that have already mattered:**

- `PATCH /courses/:id` on a **published** course does not edit it — it forks a new draft version
  carrying the modules and activities across, and answers `{versioned: true, version, note}`. A UI
  that assumes an in-place edit will show the caller stale content.
- `/compliance` is aggregate **by path**, never a per-person score dump; the per-person register is
  `lms.enrollment.export` at the high-assurance tier. `waived` is its own count and must never be
  added to `completed`.
- `/me` takes **no subject**. The backend decides what "mine" means, which is the only arrangement
  in which the page and `resource_lms_enrollment.yaml`'s member arm cannot disagree.
- A path with zero required courses is misconfigured, not complete — `completionPct` returns
  `null`, and the UI renders a dash rather than 100%.

---

## 24. WebDesk console read model (WSK-23, 2026-08-27) — `src/modules/webdev/console-reads.{controller,service}.ts`, `platform-ui/src/lib/webdesk.ts` — **STATUS: BACKEND DEV-VERIFIED (Linux, see the ticket report); UI: no consumer yet (WSK-24)**

**§24 claimed at write time** — `webdesk-design.md` §09 calls the §15+ region of this doc "racing;
claim at ticket time". A `grep -n "^## 2[4-9]\."` immediately before writing this block found
nothing claimed; §23 (LMS) was the prior highest number.

Design: `docs/blueprints/webdesk-design.md` §08 ("Console UX") + §09 ("ERP integration points").
This is the BFF the console (WSK-24, not yet built) reads — **before this ticket there was no
route at all**, so every row below is newly reachable, not a status flip on something that already
existed. Its own module key is the EXISTING `webdev` (WSK-12/19/PRV-02 already own it); every route
404s unless the company has `webdev` enabled, same as every sibling `/modules/webdev/*` route.

| Method | Path | Returns | Cerbos |
|---|---|---|---|
| GET | `/api/:t/modules/webdev/console/sites` | `{ sites: SiteConsoleRow[], meta: DegradeMeta }` — reuses `GET .../provisioned-sites`'s row shape verbatim, plus `lastKnownDeployment`/`lastKnownPromotion`/`lastKnownRollback` (the latest `deploy.done`/`promote.done`/`rollback.done` fact per slug from `webdev_zoneb_event_log`, WSK-12's bridge ledger) | `webdev_provisioned_site:read` (existing kind/action, WSK-12) |
| GET | `/api/:t/modules/webdev/console/sites/:slug/releases` | `{ releases: ReleaseFact[], meta: DegradeMeta }` | `webdev_provisioned_site:read` |
| GET | `/api/:t/modules/webdev/console/sites/:slug/submissions[?formId=]` | `{ submissions: SubmissionFact[], meta: DegradeMeta }` — slim projection only (`submissionId, formId, hasAttachments, receivedAt`); Zone A never receives submission content over the bridge, so this is PII-aware by construction, not by filtering | `webdev_provisioned_site:read` |
| GET | `/api/:t/modules/webdev/console/contract-pins[?slug=]` | `{ pins: ContractPinStatus[] }` — WSK-19's pinned snapshot × the live-or-degraded "latest published" read | `webdev_contract_snapshot:read` (existing kind/action, WSK-19) |
| GET | `/api/:t/modules/webdev/console/portfolio` | `{ projects: PortfolioProject[], counts }` — the ESTATE portfolio, grouped by project with each environment (`production`/`staging`/`preview`/`development`) as its own row. **Reads Zone A tables only — no `DegradeMeta`, because there is no egress and nothing to be stale about.** Left-joins `search_properties` for hosting topology and the `crawlConsent` gate rather than duplicating either. Distinct from `console/sites` above, which answers "which Zone B tenants exist"; this answers "what does the estate consist of", including the sites we do not host and must not touch | `webdev_site:read` (M6-P3c; was `webdev_provisioned_site:read`, same reach) | **UI: `platform-ui/src/app/(app)/departments/[deptId]/sites/portfolio/page.tsx` (+ `[siteId]/page.tsx`, which resolves one row out of this same list read — there is no single-site GET) via `lib/webdeskPortfolio.ts`. As of 2026-09-03 this is Web Dev's ONLY site surface; `sites` `permanentRedirect`s here. See the `lastSeenAt`/`lastHttpStatus` warning below.** |

### ⚠ `lastSeenAt` / `lastHttpStatus` are returned and MUST NOT be rendered (2026-09-03)

`console/portfolio`'s row shape includes `lastSeenAt` and `lastHttpStatus`, selected straight from
`webdev_sites`. **Nothing in this program has ever written either column.** A repo-wide search
returns exactly two references: migration `202608301055_webdev_sites_environments_and_repo.sql`,
which adds them, and `portfolio-reads.service.ts`, which returns them. Their migration comment
promises MON-01 will fill them; MON-01 landed on `monitors`, not here.

They were rendered once, as the headline "Health (last recorded)" column of a second Web Dev tab
("Operations", `path: sites`). Every row read "Not checked" permanently and the tab's summary line
claimed "0 showing a problem" about an estate nobody was checking — absence of data presented as
calm, which is the exact failure the monitoring program exists to prevent. That tab is deleted
(owner decision) and `platform-ui/src/lib/webdeskPortfolio.ts` deliberately **omits both fields
from its `PortfolioSite` type**, so no UI can reach them by accident.

Site health has ONE owner: the monitoring module (`/monitoring` — live sweeps, uptime, incidents,
cert expiry, alert channels). A status column on the portfolio must be sourced from `monitors`,
never from these two columns and never from a null read.

**That column now exists, and it is joined in the BFF, not in the database.** `webdev_sites` and
`monitors` still have no link in either direction, and adding one would be the wrong fix: the two
modules are separately enabled, each with its own RLS module gate, and `app_module_allowed()`
returns **NULL** (not false) for a module that is off — so a cross-module join would silently yield
zero rows and read as an empty portfolio, which has already happened once on this endpoint. Instead
`platform-ui/src/lib/siteMonitoring.ts` joins the two reads on the thing they ALREADY share, the
domain, via `search_properties`: this endpoint left-joins that table on `(tenant_id, domain)` and
the monitoring sweep builds its probe allowlist from the same rows. No new endpoint, no new Cerbos
kind, no migration.

Two consequences worth recording here, because they are contract-shaped:

- **`GET /api/:t/monitoring/monitors` is read WITHOUT collapsing 404/403 into `[]`** for this
  purpose. `platform-ui/src/lib/monitoring.ts`'s own `listMonitors` does collapse them, which is
  correct for the monitoring board and wrong for the portfolio: it would print "No monitor" on
  every row whether nothing is watched or nobody was allowed to ask. `siteMonitoring-data.ts`
  carries availability explicitly — the same split MON-20 made for `listResults`.
- **`search_properties.client_id` is what makes a monitor creatable from the portfolio.**
  `POST /api/:t/monitoring/monitors` requires a client, and nearly every surveyed `webdev_sites`
  row has `client_id` NULL (attributing them would have been invention). But a CONSENTED domain has
  a `search_properties` row by definition — consent *is* `verified_at` on that row — and that row
  carries a client. So for exactly the sites a monitor is permitted on, the client is knowable
  rather than guessed. `/monitoring/new` accepts `?domain=&clientId=` to seed the form; the client
  id is validated against the pickable list client-side and ignored if it is not there, never
  posted verbatim.

### Probe consent — Web Dev asks, the search module's authority grants (2026-09-04)

| Method | Path | Returns | Cerbos |
|---|---|---|---|
| POST | `/api/:t/modules/webdev/console/probe-consent-requests` | `{ ok, approvalId, domain, attestation }` — files an `automation_approvals` row with `origin='search'`, `workflow_id='search:probe_consent'`. 400 on a missing/short/oversized reference note; 404 unknown property; **409** already-consented; **409** an open request for the same property | `webdev_site:request_probe_consent` (M6-P3c; was `webdev_provisioned_site:read`, same reach — its own action so it can diverge from `webdev_site:read` later) | **UI: `platform-ui/src/lib/probeConsentActions.ts`, rendered by `components/webdesk/ProbeConsentRequest.tsx`** |

Owner rulings: `docs/plans/2026-09-03-probe-consent-rulings.md`. `search_properties.verified_at` is
what the monitoring sweep builds its SSRF allowlist from, so setting it is the record that we may
reach out and touch a client's website. `PATCH /modules/search/properties/:id` could always set it;
this exists so that nobody sets it for themselves.

Four things about this are contract-shaped and easy to get wrong:

- **The requester is gated on a WEBDEV action, not a search one.** Web Dev reads consent and hosting
  topology *through* §24's portfolio, which authorizes `webdev_site:read` (so the request itself is `webdev_site:request_probe_consent`, M6-P3c — the same reach, its own action); requiring
  `resource_search_property:read` here would lock out exactly the people the flow is for. Filing
  grants nothing and mutates no domain state.
- **The APPROVER is gated on `resource_search_property:update`** — the exact gate that endpoint uses
  — checked by the decide path for `origin='search'` rows *in addition to* the generic `decide`, and
  applied to rejection as well. No new Cerbos action was minted: an authority that cannot drift from
  the write being approved beats a parallel one that can.
- **`origin='search'` can never auto-execute.** The decide path computes an executor only for
  `automation|agent`, so the grant is applied on the `automation_approval.decided` event by
  `modules/search/probe-consent.ts` — the same slot `origin='hr'` uses. Registering a
  consent-granting MCP tool in the D14 executable registry would create an agent-callable privilege
  surface for a compliance flag and must not be done.
- **A new origin must be added in FOUR places or the request is unfindable.** `ALL_ORIGINS` in
  `core/approvals.controller.ts`, `ORIGINS` in `core/approvals-decide.controller.ts`,
  `ORIGIN_BASE_WEIGHT`/`ApprovalOrigin` in `core/approvals-urgency.ts`, and the UI's mirror in
  `lib/approvalsShared.ts` + `ApprovalDecideOrigin`. `origin` is a plain text column, so nothing
  type-checks this: the first filed request was decidable by id and invisible in the inbox.

§24 additionally gains **`propertyId`** on each portfolio row (`sp.id`). NULL is not the same answer
as `crawlConsent: false` — no property row means there is nothing that could carry consent, so it
cannot be requested either, and the UI states that instead of offering a button.

**No new Cerbos resource kind.** The ticket's own warning ("a new kind costs six coupled
artifacts") was heeded by checking first: design §08's button matrix already gates registry/env-
status/submissions under ONE action, and both existing kinds this file authorizes against
(`webdev_provisioned_site`, `webdev_contract_snapshot`) already carry a `read` action with the
right role tiers wired by earlier tickets. Nothing here required a policy edit, a catalog edit, a
migration, or a Cerbos restart.

### ⚠ Every read here is `meta`/`latest`-wrapped — `stale: false` is the RARE case, not the default

`platform-ui/src/lib/webdesk.ts`'s own header states this at length; restated here because it is
the ticket's central finding, not a footnote. **Zone B's control plane (WSK-21) ships exactly three
`GET` routes today: `contract`, `jobs`, `jobs/:jobId`.** There is no live read endpoint for site/
environment status, releases, or form submissions — every other control-plane route is a write
command. So:

- **Site registry, releases, submissions** have no live upstream to proxy at all. They are built
  directly from Zone A's own facts (`webdev_provisioned_sites` + `webdev_zoneb_event_log`) and are
  **always** `meta.source: "facts"` (or `"unavailable"` when nothing is on file yet) — never
  `"live"`. Marking them live would be exactly the fabrication this contract exists to prevent.
- **Contract pin-vs-latest** is the one read with a genuine live upstream (WSK-19's own
  `getContractBundle`, reused verbatim — no new egress code anywhere in this ticket). It gets the
  full three-tier degrade: **live** (a real call succeeded this cycle) → **cache** (a short
  in-process TTL cache from an earlier live success, when the live call just failed) → **facts**
  (the last `contract.published` event-log fact on file) → **unavailable** (genuinely nothing).
  Proven with a real test that establishes a live cache entry and then kills the upstream mid-suite
  (`console-reads.service.test.ts`, `"THE REQUIRED TEST: kill the upstream..."`) — the degraded
  response keeps the LAST GOOD version and vocabulary, never nulls them out, and `source` is never
  `"unavailable"` when a cache or fact answer exists.
- `deploy.done` / `promote.done` / `rollback.done` / `contract.published` have **no real emitter
  yet** (WSK-10's `form.received` is the only DEV-VERIFIED one) — their event-log `payload` shape is
  therefore best-effort field-matched (`siteSlug`/`slug`/`webdeskTenantSlug`, `version`/
  `contractVersion`), flagged in the service file's own header as unpinned until a real emitter
  lands. Tests prove the AGGREGATION logic against synthetic rows this ticket inserts itself, not
  against a real emitter (none exists to test against).

### What §08/§09 asked for that this ticket did NOT build, and why

- **The real mTLS + Keycloak client-credentials + WS4-assertion control channel.** `config.ts`'s own
  `webdevControl` header names this "WSK-22/23's job" — but WSK-22 built the Zone B **verification**
  side only (no `webdesk-control` Keycloak client exists yet — an **owner action**, §09's own table)
  and this ticket's given scope was the BFF read/degrade surface, not channel hardening. The bearer-
  token stub WSK-19 shipped is unchanged; every proxy read in this ticket degrades cleanly through
  it exactly as it would through the real thing once WSK-22's owner-gated piece lands.
- **WS4 wiring.** Every route in this ticket is a pure read (§08's button matrix: 🟢, `webdesk:read`
  only) — WS4 gates writes (promote/rollback/keys), which are WSK-25/29's scope, not this one's.
  `refresh`'s own WS4 path (D14, automation-only) already existed from WSK-19 and is untouched.
- **Separate backend-env vs frontend-deployment columns, and a domain field**, on the site registry
  row (§08 v1.1: "the row splits into two columns"). `webdev_provisioned_sites` (0090) has neither
  column, and this ticket's constraints forbid improvising DDL — flagged for whichever ticket owns
  the next `webdev_provisioned_sites` schema change (senior-db/architect call).
- **Locale-coverage row** (§08 v1.1) — no locale data reaches Zone A over the bridge today (no
  `kind` in `webdev_zoneb_event_log`'s CHECK-enumerated vocabulary carries it); would need either a
  new bridge fact kind or a live Zone B endpoint, neither of which exists.

---

## IAM Phase 2 — employees + joiner/mover/leaver (P2-06, 2026-08-18)

**Status:** PROTOTYPED / DEV-VERIFIED against `gaiada-test-pg` + a restarted test Cerbos
(`src/admin/employees-jml.test.ts`, 14/14, driven through `app.inject()` — not by calling the
controller). No UI consumer exists yet; P2-10 (HR console) is the intended one.

Design: `docs/superpowers/plans/2026-08-13-iam-phase2-design.md` §4–§5. Backend:
`platform-nest/src/admin/employees.controller.ts`. Migration: `0111` (the joiner's natural key).

| Method + path | Cerbos (kind · action) | Notes |
|---|---|---|
| `GET /api/:tenantId/hr/employees?status=` | `employee · read` | `{ employees: Employee[] }`. `status` ∈ `pending_start`\|`active`\|`on_leave`\|`suspended`\|`terminated`; unknown ⇒ 400. |
| `GET /api/:tenantId/hr/employees/:employeeId` | `employee · read` | Employee + `seats[]` (`assignmentId`, `positionId`, `title`, `unitNodeId`, `validFrom`, `validTo`, `current`). |
| `POST /api/:tenantId/hr/employees` | `employee · create` **+ `position · assign`** when `positionId` is given | 201. Joiner. Body: `displayName` (required), `workEmail`, `legalName`, `personalEmail`, `phone`, `hireDate`, `notes`, `managerUserId`, `positionId`, `startDate`. Returns the employee plus `reconciled: {granted, revoked} \| null`. |
| `PATCH /api/:tenantId/hr/employees/:employeeId` | `employee · update` | Record edits only. `employmentStatus: "terminated"` is **refused** (400) — termination is a flow, not a field. |
| `DELETE /api/:tenantId/hr/employees/:employeeId` | `employee · delete` | Soft delete. **Refused (400) while the person holds an open seat** — terminate first. |
| `POST /api/:tenantId/hr/employees/:employeeId/transfer` | `employee · update` **+ `position · assign`** (incoming) **+ `position · unassign`** (every outgoing seat) | Mover. Body `{ toPositionId, effectiveDate?, reason? }`. Returns `closedAssignmentIds`, `assignmentId`, `reconciled`. Already-held seat ⇒ `{ ok: true, unchanged: true }`. |
| `POST /api/:tenantId/hr/employees/:employeeId/terminate` | `employee · update` **+ `position · unassign`** per open seat | Leaver. Body `{ lastDay?, reason? }`. Returns `closedAssignmentIds`, `revokedManualGrants[]` (the audited list §5.3 requires), `userDisabled`, `itFollowUp` (`"disable_login"` \| `null`). |

**Error shape** is the platform-wide `{ error: "<message>" }` (`http-error.filter.ts`) — **not**
`{ message }`. Two consumers have already been written against the wrong one; check this row first.

### ⚠ Three behaviours a consumer must render, not assume

1. **HR runs the whole flow (owner decision 2026-08-18) — but `hr_staff` does not.**
   `hr_people_ops` now holds `position.assign`/`.unassign` (`0112`), so an `hr_manager` can hire with
   placement, transfer and terminate. `hr_people_ops` resolves to **`hr_manager` alone**, so an
   `hr_staff` caller still gets **201 on a record-only hire and 403 the moment `positionId` is
   present**. Gate the placement fields on `position.assign` reach (via the IAM-05c effective-permission
   endpoint), never on "is this user in HR" — the two are not the same set.
   ⚠ ~~A dept head's assignment is slated to become a REQUEST rather than a direct write~~ — **SHIPPED,
   and P2-11/P2-12-FE are built around it (2026-08-19).** A dept head calling `assign` gets
   `assignment_request_required`; the UI treats that as GUIDANCE, not an error, and renders a "Propose
   instead" control aimed at `POST /positions/:id/assignment-requests` with the same person prefilled.
   Anyone building another placement surface must do the same: the refusal is the mechanism telling the
   operator what to do, and rendering it red teaches them the system is broken when it is working.
2. **No future-dated JML.** `startDate`/`effectiveDate`/`lastDay` in the future ⇒ 400. The reconciler
   resolves on `valid_to IS NULL` with no as-of axis, so a future date would apply *now* while the
   record claimed otherwise. Scheduled JML is deferred, not silently approximated.
3. **A candidate with no `positionId` gets NO `users` row** (`userId: null`, `pending_start`) — so a
   console must not assume every employee is a principal, and must not offer login actions for one.

### Events emitted

`employee.hired`, `employee.transferred`, `employee.terminated`, `employee.record_deleted`,
`position_assignment.created`, `position_assignment.closed`, plus `org_structure.updated` from the
shared blob pipeline. The position reconciler already consumes the `position_assignment.*` pair
(P2-05), and these flows are its first producer; the flows ALSO reconcile in-band so the HTTP
response reflects committed reality rather than an eventual one.

---

## IAM Phase 2 — positions + role grants (P2-12 backend, P2-08 part A, 2026-08-18)

**Status:** PROTOTYPED / DEV-VERIFIED (`positions-controller.test.ts` 11/11,
`role-grants-controller.test.ts` 14/14, both via `app.inject()` against real Postgres + Cerbos).
**CONSUMED as of 2026-08-19** by P2-11 (`/organization/access`) and P2-12-FE (`/organization/positions`).

Three things a future consumer of these endpoints must copy rather than re-decide, because each one is a
place the obvious implementation is wrong:

1. **`attachable-roles` is never filtered.** Unattachable roles come back WITH a reason and must render
   disabled-with-reason. The server owns the allow-list; a UI that drops the refusals turns a stated
   boundary into an invisible one and leaves "why can't I attach that role?" unanswerable.
2. **`scope: "subtree"` is not a label, it is a warning.** It means the server narrowed the list to the
   caller's own lead units. Render it as the whole company and you have told a department head that seats
   they cannot see do not exist. Both pages show a banner.
3. **A grant with `revocable: false` gets NO revoke control at all** — not a disabled one. The reconciler
   would restore it, and the operator would conclude the UI lied. Show its `source` instead.

### Positions — `platform-nest/src/admin/positions.controller.ts`

| Method + path | Cerbos | Notes |
|---|---|---|
| `GET /api/:tenantId/positions` | `position · read` | `{ positions[], scope: "tenant" \| "subtree" }`. A dept head (`org_unit_lead`) gets **only their subtree** and `scope: "subtree"`; each row carries `roleSet[]`, `currentHolders`, `orphaned`. |
| `GET /api/:tenantId/positions/attachable-roles` | `position · read` | The composer's option list: `{ roleId, role, attachable, reason }`. Unattachable roles are **returned with a reason**, not omitted — render them disabled. |
| `POST /api/:tenantId/positions` | `position · create` | `{ unitNodeId, title, isLead?, roles?: [{roleId, scopeKind}] }`. `unitNodeId` must exist in the org blob (400 otherwise). |
| `PATCH /api/:tenantId/positions/:positionId` | `position · update` | `{ title?, isLead?, unitNodeId? }`. Moving the unit re-reconciles every holder. |
| `POST /api/:tenantId/positions/:positionId/retire` | `position · retire` | Closes every open assignment and reconciles; a retired seat cannot be assigned (400). |
| `POST /api/:tenantId/positions/:positionId/roles` | `position · update` | Attach one role. Three bounds: denied-role registry, `uiGrantable` allow-list, and 0109's guard trigger. |
| `DELETE /api/:tenantId/positions/:positionId/roles/:roleId` | `position · update` | Detach — **revokes from every current holder** immediately, not at the next sweep. |
| `POST /api/:tenantId/positions/:positionId/assign` | `position · assign` | `{ userId, validFrom?, reason? }`. Idempotent. Self-assign is a **403** (structural Cerbos DENY). Target must be an active member. |
| `POST /api/:tenantId/positions/:positionId/unassign` | `position · unassign` | `{ userId }`. |

### Role grants — `platform-nest/src/admin/role-grants.controller.ts`

| Method + path | Cerbos | Notes |
|---|---|---|
| `GET /api/:tenantId/role-grants?userId=` | `role_grant · read` | Each grant carries `source` (`manual` \| `position` \| `service_assignment`), `expiresAt`, `originApprovalId`, `revocable`. |
| `POST /api/:tenantId/role-grants` | `role_grant · create` | `{ userId, roleId, scopeType?: "company"\|"org_unit", scopeId?, temporary?, expiresInDays?, reason? }`. `global`/`project` are refused on this surface. |
| `DELETE /api/:tenantId/role-grants/:grantId` | `role_grant · revoke` | Refused (400 `managed_grant_not_revocable`) for position- or service-managed grants. |

### ⚠ Refusal tokens a consumer must handle (all 400 unless noted)

`elevated_role_forbidden` · `not_ui_grantable` · `ceiling_exceeded` · `override_required` ·
`managed_grant_not_revocable` · `self_grant_forbidden` (self-target is normally a **403** from Cerbos,
which fires first) · `denied-role registry` on position role attach.

**`override_required` is the one to design for:** a dept head granting a role with above-baseline
sensitive permissions is refused, because the routed-override mechanism (`decide_override`) is not
built. The UI should offer "ask a company administrator", not a retry.

**Unplaced targets:** a member with no org-unit placement has empty ancestry, so only company_admin and
above can grant to them. That is fail-closed by design, not a bug — surface it as "place this person in
the org chart first".

### 20.1 Plane A admin console — `GET /api/admin/observability` — **BACKEND ✅ BUILT, UI ✅ WIRED (MON-09i, 2026-08-18)**

Shapes canonical in `platform-ui/src/lib/observability.ts`, mirrored by
`platform-nest/src/admin/observability.controller.ts`.

| Method | Path | Gate | Returns | Status |
|---|---|---|---|---|
| GET | `/api/admin/observability` | **platform admin** (`isElevated`) — NOT tenant-scoped | `ObservabilitySnapshot` | ✅ BUILT |

This is **Plane A** — our own box — and is the deliberate exception to §20's tenancy rules: there is
nothing per-tenant to scope, so it is admin-gated instead of Cerbos/RLS-scoped, and it must never be
exposed to a tenant. It exists because Plane A telemetry was collected for weeks and displayed
nowhere (all four Grafana dashboards are application-level; none reads a `node_*`, `container_*`,
`pg_*` or `redis_*` series), which is how a completely broken datastore exporter went unnoticed.

Contract notes:

1. **`available:false` is a first-class answer**, returned with a `reason` when `PROMETHEUS_URL` is
   unset or Prometheus is unreadable. The UI prints the reason. It must never be conflated with a
   healthy box.
2. **Every metric is a `Reading` with `value: number | null`** — `null` means "asked, got nothing"
   and renders as `—`. Do not coerce a missing series to `0`; a zeroed CPU reads as an idle server.
3. **`alerts` excludes `Watchdog`.** It always fires by design (D15), so including it would show a
   permanent red on a healthy box — the fastest way to teach operators to ignore the list.
4. **`targets.up` is scrape health, not check validity.** A target is "up" when the exporter answers;
   it says nothing about whether the thing being measured is reachable. That distinction is why the
   response carries `datastores` separately — `pg_up`/`redis_up` were 0 for weeks while both targets
   showed green.
5. **Disk queries must stay identical to the `DiskSpaceLow` alert expression.** The console and the
   pager reading different series is worse than having only one of them.

### 20.1a Estate view — multi-host Plane A (MSO program, 2026-08-21) — 🟡 PROTOTYPED (BACKEND MSO-05 + UI MSO-06, 2026-08-22) — design: `docs/plans/2026-08-21-multi-server-observability.md`

Supersedes §20.1's single-host response **via expand/contract** (note 6). Same route, same gate,
same plane: staff-only, never tenant-scoped, never merged with §20 Plane B.

| Method | Path | Gate | Returns | Status |
|---|---|---|---|---|
| GET | `/api/admin/observability` | **platform admin** (`isElevated`) — NOT tenant-scoped | `EstateObservabilitySnapshot` | 🟡 PROTOTYPED end-to-end — backend: `platform-nest/src/admin/observability.controller.ts` + `estate-observability.ts` (MSO-05); UI: `platform-ui/src/lib/observability.ts` + `components/systems/Observability{Console,HostTable,Drilldown}.tsx` (MSO-06, 2026-08-22) now consumes `hosts[]`/`estate`/`alerts` exclusively — no legacy §20.1 single-host field is read. Driven in DEMO_MODE against a 7-host fixture (`lib/demoFixtures.ts`) exercising every branch below; NOT yet driven against the live backend (no server involved in MSO-06). Promote to ✅ only after QA (MSO-07) |

**MSO-06 UI notes (what the console does with each field, 2026-08-22):**

- **Freshness is the lead cell**, rendered before health in both the per-host row and its own KPI
  strip (fresh/stale/dark/never counts from `estate.hosts`), and is never re-derived client-side —
  the UI only adds elapsed wall-clock time to the server's `lastSampleAgeSeconds` for the ticking
  "Xm ago" display (`liveSampleAgeSeconds`), never reclassifies `state`.
- **Expected-but-dark vs never-registered vs onboarding-pending are three distinct row treatments**
  (`hostAlarmState`): an `active`+`dark`/`never` host renders a board-level critical banner
  ("N expected hosts stopped reporting") plus a rust left-border on its row; an `onboarding`+`never`
  host renders as calm "expected-pending", no banner; a `registered:false` host renders its own
  warn-toned banner ("N unregistered hosts sending data") plus an amber left-border — both drift
  directions are visible simultaneously, neither is folded into the other.
- **`RemoteWriteStalled` (active, any host or unattributed) renders a whole-board critical banner**
  above everything else, independent of and stacked with the `available:false` banner (both can be
  true at once per note 9).
- **`containersRunning` is read from the field, not hardcoded** — the drilldown's "Per-container
  metrics" card prints `value` when non-null and otherwise `note` verbatim, so it will start
  showing real counts the day MON-09n closes (note 11) without a second UI edit.
- **`alertsActive`/`alertsSuppressed: null`** render as an em dash with the `alertsNote` reason in
  the KPI tile's hint, never as `0`.
- **`env` drives a real filter/grouping** in the host table (replacing the old "not tagged"
  placeholder that meant "the backend hasn't built this field yet") plus an `envDrift` badge when a
  host's own series report a different `env` than the inventory.
- Not rendered as a distinct UI element: the raw `role` string beyond a small italic label next to
  the host name — no dedicated column, kept dense per the table's existing density budget.

**MSO-04 (the `infra_hosts` inventory table) was built BY THIS TICKET**, not under its own MSO-04
ticket — it had not landed when MSO-05 started, and MSO-05's non-negotiable #3 (expected-but-dark
hosts must appear) cannot be satisfied without it. Migration
`platform-nest/migrations/202608211610_mso04_infra_hosts.sql` implements §3.1's schema **verbatim**
(no improvised columns), seeded with the two hosts verified live in the design doc's §1
(`gda-aicenter` / production / erp-core, `sumopod` / ops / observability-hub). No RLS — global
table, read via `withGlobal()`, same posture as `permissions`/`roles`. If a concurrent MSO-04
session lands the same table under a different migration file, one of the two must be deleted; do
not attempt to reconcile them by hand.

Shapes (canonical in `platform-ui/src/lib/observability.ts` once MSO-06 lands; `Reading`,
`HostHealth`, `TargetSummary`, `DatastoreHealth`, `HostSnapshot`, `EstateSummary`, `EstateAlert` are
now exported from `platform-nest/src/admin/estate-observability.ts` — the pure, unit-tested half of
this endpoint — and re-exported from `observability.controller.ts` for callers that only know the
old file path. `HostHealth` gains `cores: Reading` as ratified):

```ts
interface EstateObservabilitySnapshot {
  available: boolean;              // the central Prometheus (PROMETHEUS_URL) answered
  reason?: string | null;          // set when available:false
  grafanaHint: string;
  collectedAt: string;
  hosts: HostSnapshot[] | null;    // null only when available:false
  estate: EstateSummary | null;
  alerts: EstateAlert[] | null;    // [] = measured, none firing; null = Alertmanager unreadable
  alertsNote?: string | null;      // why alerts is null
  // Plus, for ONE release (expand phase): §20.1's legacy host/targets/datastores fields, derived
  // from the gda-aicenter row. New consumers must not read them (note 6). `alerts` above IS the
  // legacy field's replacement, not an addition alongside it — see note 8 for why.
}

interface HostSnapshot {
  key: string;                     // = `host` series label = infra_hosts.key; never ""
  displayName: string;             // = key when unregistered
  env: "production" | "staging" | "ops" | "dev" | null;  // from inventory; null when unregistered
  role: string | null;
  registered: boolean;             // false ⇒ series exist but no infra_hosts row — render visibly abnormal
  status: "active" | "onboarding" | "decommissioned" | null;  // null when unregistered
  envDrift: boolean;               // series `env` label ≠ inventory env — render a drift badge
  freshness: {
    state: "fresh" | "stale" | "dark" | "never";
    lastSampleAgeSeconds: number | null;   // null ⇔ state "never"
  };
  host: HostHealth | null;         // null when dark/never (instant vectors empty past staleness)
  targets: TargetSummary | null;   // null = no target data for this host — NOT {up:0, down:0}
  containersRunning: Reading;      // today ALWAYS {value:null, note:"…MON-09n…"} — see note 2
  datastores: DatastoreHealth | null;  // null = host ships no pg/redis exporters; ≠ measured-down
}

interface EstateSummary {
  hosts: { total: number; fresh: number; stale: number; dark: number; never: number };
  alertsActive: number | null;     // null when Alertmanager unreadable — never 0
  alertsSuppressed: number | null;
}

interface EstateAlert {
  name: string;
  severity: string;
  state: "active" | "suppressed";  // Alertmanager v2 vocabulary; suppressed = silenced or inhibited
  host: string | null;             // null = not attributable to one host (app-level alerts)
}
```

Contract notes:

1. **Freshness is first-class and gates rendering.** Thresholds: `fresh` ≤ 90 s since the host's
   last sample, `stale` ≤ 600 s, `dark` > 600 s — deliberately the same 10 m boundary as the
   `RemoteWriteStalled` alert, so the console and the pager cannot disagree — and `never` = no
   sample in the 48 h lookback. When state ≠ `fresh` the UI MUST render that host's readings as
   historical ("as of Xm ago") and muted; a `dark` host must be impossible to read as green. A
   stale feed is the most dangerous state on this board precisely because it looks calm.
2. **Measured-zero vs not-measured, field by field** (this console class has shipped null-as-0
   repeatedly; every consumer renders `null` as unknown-with-reason, never as `0`):
   - `containersRunning` — `{value: null, note}` **estate-wide today**: cAdvisor per-container
     discovery is broken under the containerd snapshotter (MON-09n;
     `count(container_last_seen{name!=""})` verified empty). A count of `0` would mean "measured:
     nothing runs", which is false on every host.
   - `targets: null` = no scrape data for this host (dark/never) — never emitted as `{up:0,down:0}`.
   - `datastores: null` = nothing to measure (no exporters shipped) — distinct from
     `{…, up:false}`, which is measured-and-down.
   - `alerts: []` = Alertmanager answered and nothing fires; `alerts: null` = Alertmanager
     unreadable (`alertsNote` says why). Same for the two `EstateSummary` counters.
   - `freshness.lastSampleAgeSeconds: null` only with `state:"never"`.
3. **Alerts come from Alertmanager (`ALERTMANAGER_URL`), not Prometheus's `ALERTS` series**, so
   silence/inhibition is visible — a silenced alert rendered as firing teaches operators to
   distrust the board, and the reverse hides a mute. No fallback to Prometheus when AM is down:
   two sources that can disagree are worse than one honest `null`. `Watchdog` stays excluded
   (§20.1 note 3). **`RemoteWriteStalled` is never excluded**: the UI renders it as a whole-board
   banner — "estate feed dark; everything below is UNKNOWN, not healthy" — matching the alert's
   own description.
4. **`hosts[]` is inventory-driven, both drift directions visible.** It contains every
   non-decommissioned `infra_hosts` row *even when no series exist* (`freshness: "never"`;
   `status:"onboarding"` renders as expected-pending rather than alarming), decommissioned rows
   muted until their series age out, **plus** unregistered hosts derived from series
   (`registered:false`, visibly abnormal). Host key `""` (pre-label legacy series) is never
   emitted. A host list derived only from series would silently drop a fully-dark host — the exact
   failure this § exists to kill.
5. **`available` covers only the central Prometheus.** Per-host reachability is `freshness`;
   Alertmanager failing does not flip `available` (it nulls `alerts` per note 2).
6. **Expand/contract migration.** The BE ships `hosts[]`/`estate`/`alerts` alongside §20.1's legacy
   single-host fields for one release; the UI switches; the legacy fields then drop and §20.1's
   response shape is retired. Releases on this estate do not land atomically across FE/BE waves —
   do not build anything new against the legacy fields.
7. §20.1 notes **2** (Reading discipline), **4** (target-up ≠ check-valid) and **5** (disk
   expressions stay identical to `DiskSpaceLow`/`DiskWillFillIn24h`) carry over unchanged, now per
   host.

**Corrections made against reality during MSO-05's build (trust-reality clauses, per the ticket
that built this):**

8. **The `alerts` field name collision in this design is unbuildable literally — resolved, not
   guessed around.** The fenced interface above defines ONE `alerts: EstateAlert[] | null`, and its
   own prose two lines above says the expand phase ALSO carries forward "§20.1's legacy
   host/targets/datastores/**alerts** fields" — but a JSON object cannot hold two fields both named
   `alerts` with different shapes. `host`/`targets`/`datastores` don't collide and are kept verbatim
   (derived from the `gda-aicenter` `HostSnapshot`, not re-queried). For `alerts`, the build keeps
   the ONE field as the new Alertmanager-sourced `EstateAlert[]` shown above: it is a structural
   superset of the old `{name, severity}` shape for any reader that only touches those two fields,
   and — unlike re-deriving a second list from Prometheus's `ALERTS` series — it cannot render a
   silenced alert as firing, which is exactly what note 3 above exists to prevent. No second,
   differently-named legacy alerts field was invented.
9. **Alertmanager is fetched INDEPENDENTLY of Prometheus's own reachability**, not gated behind
   `available`. Note 5 says a down Alertmanager doesn't flip `available` — read the other direction
   too: a down *Prometheus* does not blind an operator to Alertmanager's currently-firing alerts if
   Alertmanager itself still answers, so `alerts`/`alertsNote`/`estate.alertsActive`/
   `alertsSuppressed` can be populated even when `available:false` and `hosts`/`estate.hosts` are
   null. This is a real behavior choice the design text didn't specify explicitly; recorded here so
   it isn't re-litigated as a bug.
10. **The by-host disk queries and the live `DiskSpaceLow`/`DiskWillFillIn24h` alert rules are NOT
    byte-identical today** (note 7 above says they must stay identical). `infra/observability/
    prometheus/rules/alerts.yml`'s rules have not been generalized to `by (host)` as of this ticket
    — that is MSO-02, not built yet. The controller's queries already carry the `by (host)` shape
    the rules will need; they converge automatically once MSO-02 lands the host label onto the
    rule file. Flagged rather than silently assumed complete, per this ticket's own "trust reality"
    instruction.
11. **containersRunning is hardcoded, not queried.** Since `count(container_last_seen{name!=""})`
    is verified empty estate-wide (MON-09n), the controller does not spend a Prometheus round trip
    proving that on every request — it returns the constant `CONTAINERS_RUNNING_UNAVAILABLE` reading
    (`estate-observability.ts`) for every host unconditionally. Revisit this the day MON-09n closes.
12. **`hosts[]`'s unregistered-host detection unions every host-keyed metric map**, not only the
    freshness map, so a host is never dropped just because one particular query didn't happen to
    mention it that round (the ordinary case is that every host contributing to `up` also
    contributes to the freshness subquery, since it derives from the same metric — this is a
    defensive widening, found while writing the live-DB test for exactly this case).

**Observe-only tier addendum (2026-08-22 owner ruling; design: MSO plan §12) — ⛔ PENDING
(schema MSO-09 / backend MSO-10 / probes MSO-11; UI under the MSO-06 amendment):**

13. **`monitoring_tier` becomes part of the contract.** `helios`/`delphi` are observe-only — no
    agent may ever be installed on them — so an absent node-signal there is BY DESIGN, not a
    fault. Additive fields (expand/contract as ever):
    - `HostSnapshot.tier: "agent" | "blackbox" | null` — from `infra_hosts.monitoring_tier`;
      `null` iff `registered:false`.
    - `HostSnapshot.probes: { total: number; up: number; down: number; failing: { target:
      string; kind: "icmp"|"tcp"|"http"|"tls" }[]; rttMsWorst: Reading; tls: { target: string;
      daysToExpiry: number }[] | null } | null` — the blackbox tier's PRIMARY signal block, from
      `probe_success` / `probe_duration_seconds` / `probe_ssl_earliest_cert_expiry` by `host`
      label. Top-level `null` = no probes configured for this host (the normal state for
      agent-tier hosts today) — never `{total:0,…}`; `tls: null` = no TLS probes configured,
      distinct from measured expiry.
    - `EstateSummary.hosts.byTier: { agent: number; blackbox: number }`.
    - For `tier:"blackbox"`: `host`, `targets`, `datastores` are `null` and `containersRunning`
      is `{value:null, note}` **with a tier-reason note** ("not collected: observe-only host —
      owner ruling 2026-08-22; signal requires an on-host agent"). The UI renders these as
      "not collected (observe-only)" — a THIRD visual state, distinct from both the dark-host
      treatment (expected signals stopped: alarming) and healthy. Absence of node signals on a
      `blackbox` host must produce ZERO fault indications; the identical absence on an `agent`
      host stays alarming.
    - **Reachability is `probe_success` only, never `up`.** A blackbox scrape job's `up`
      measures the exporter answering the hub, so it stays `1` while the probed host is down;
      deriving reachability from it renders a dead host green forever. `freshness` for a
      `blackbox` host therefore means "probe results are arriving" (pipeline liveness) — a host
      can be `fresh` and unreachable at once and must render as DOWN — and the strongest
      renderable state for the tier is **"reachable — internals unknown"**, never "healthy".

---

## IAM Phase 2 — the routed override (P2-08 part B, 2026-08-19)

**Status:** PROTOTYPED / DEV-VERIFIED (`override-request-decide.test.ts` 16/16 through `app.inject()`
against real Postgres + a restarted Cerbos). Migration `0115`. **CONSUMED as of 2026-08-19 by P2-11**
(`platform-ui/src/app/(app)/organization/access/page.tsx` + `components/iam/PersonAccess.tsx`). The
override request is offered TWO ways there, deliberately: attached to a refused direct grant (the server
returns `ceiling_exceeded`/`override_required` and the UI renders the follow-up rather than an error), and
standalone — somebody who already knows the grant is above their ceiling should not have to trip over the
wall to find the door.

| Method + path | Cerbos | Notes |
|---|---|---|
| `POST /api/:tenantId/role-grants/overrides` | `role_grant · create` (on the TARGET, with server-derived ancestry) | `{ userId, roleId, scopeType?, scopeId?, expiresInDays?, justification }`. **`justification` is required** — 400 without it. Returns `{ approvalId, routedTo, expiresInDays, decideVia }`. |
| `POST /api/:tenantId/automation-approvals/:id/decide` | `automation_approval · decide_override` (for `origin='iam'` rows) | The EXISTING inbox endpoint — no new decide route. On `approved`, response gains `override: { grantId, expiresAt }`. Non-IAM approvals are byte-unchanged and carry no `override` key. |

### What a consumer must render

- **`routedTo`** is `"hr_manager"` or `"company_admin"` — tell the requester who it went to, because
  they cannot decide it themselves and will otherwise wait on the wrong person.
- **The direct-grant refusal now names this route.** `POST /role-grants` returns
  `override_required: … Route it as an override request instead: POST /api/:t/role-grants/overrides
  with a justification`. Offer that action, not a retry.
- **An override never widens SCOPE.** The requester still needs `role_grant · create` on the target, so
  a dept head cannot request one for somebody outside their subtree (403), and a non-member target is a
  400. It routes past the sensitivity bound only.
- **Requester ≠ decider is a 403 from Cerbos**, including for `platform_admin`. If your UI shows a
  decide button on the requester's own row, it will 403 — hide it.
- **Expiry**: default 90 days (`§12 Q4`), max 365, refused (not clamped) outside that. The granted row
  carries `expires_at` and `origin_approval_id`, and `assemblePrincipal()` stops resolving it the
  moment it expires — so a UI listing "temporary access" can trust the timestamp.
- ⚠ **A `company_admin` cannot approve an `hr_manager` override** — they genuinely lack three
  `hr_people_ops`-only appraisal keys, so the ceiling refuses at execution with `ceiling_exceeded`.
  That is why routing exists; surface `routedTo` rather than letting an admin try and fail.

### Dept-head assignment requests (§11.2's owner end-state, 2026-08-19)

| Method + path | Cerbos | Notes |
|---|---|---|
| `POST /api/:tenantId/positions/:positionId/assign` | `position · assign` | **Behaviour change:** a DEPT HEAD now gets `400 assignment_request_required` naming the request path. HR (`hr_people_ops`) and `company_admin` still assign directly. |
| `POST /api/:tenantId/positions/:positionId/assignment-requests` | `position · assign` (same reach, including the self-assign DENY) | `{ userId, justification }` — justification required. Returns `{ approvalId, decideVia }`. |
| decide (existing inbox) | `automation_approval · decide_assignment` (**not** `decide_override` — split 2026-08-19) | On approve the response carries `iam: { kind: "position_assign", assignmentId, reconciled }`. |

⚠ The decide response's `override` key was renamed to **`iam`** when overrides and assignment requests
started sharing one execution seam — `iam.kind` is `"override"` or `"position_assign"`. Non-IAM
approvals still return `{ id, status }` with no `iam` key at all.

**For the dept-head page (P2-11):** render "Request placement" rather than "Assign" when the caller
lacks tenant-wide `position · assign`, and surface the returned `approvalId` so the lead can follow it.
A stale request whose position was retired before approval fails at decide time with a `stale` message
— show that to the approver, not to the requester.

### 20.2 Implementation notes that change how a caller should read these (2026-08-19)

* **`uptime24h` / `uptime30d` are `null`, not `0`.** MON-12's runner has not landed, so nothing has
  computed them. The UI renders null as `—` and 0 as `0.00%` — "not computed" must never read as "down
  all day".
* **`lastSweepAt` is `null` until the runner reports.** The board prints "the runner has not reported a
  sweep yet" rather than implying freshness it cannot vouch for.
* **`MonitorDetail.config` is always `null` today.** It can hold secret *references* and
  `monitoring.read` is a broad grant, so it is redacted at the boundary rather than filtered per-field.
* **An unknown `kind` filter is a 400, not an empty list.** `[]` would look like "no monitors of that
  type" and hide the typo.
* **The heartbeat endpoint always answers `{ok:true}`, matched token or not.** A 404 on a bad token
  turns it into an oracle for enumerating valid ones. It compares SHA-256 hashes with
  `timingSafeEqual`, and the token is only ever stored hashed — a plain SQL `=` on a secret is a
  timing oracle, and clear storage would make a DB read equivalent to forging any job's liveness.
* **A heartbeat arriving CLOSES an open incident.** The ping *is* the recovery signal; leaving it open
  would make a human close something that already resolved itself.

---

## IAM Phase 2 — IT accounts (P2-13 backend, 2026-08-19)

**Status:** PROTOTYPED / DEV-VERIFIED (`it-accounts.test.ts` 25/25 — 8 pure-judgement cases plus 17 via
`app.inject()` against real Postgres + Cerbos, with Keycloak stubbed at the `fetch` boundary so the real
admin client and its token cache are exercised). The consumer is **P2-14** (`/it/accounts`), BUILT
2026-08-19 (`Alpha 01.054.0107a`).

### `platform-nest/src/admin/it-accounts.controller.ts`

| Method + path | Cerbos | Notes |
|---|---|---|
| `GET /api/:tenantId/it/accounts` | `it_account · read` | `{ accounts[] }`, one row per staff member (`kind='employee'` — service accounts never appear). Each row: `userId`, `email`, `name`, `employmentStatus`, `keycloakId`, `enabled`, `emailVerified`, `linked`, `linkVerified`, `state`, `actionable`. |
| `POST /api/:tenantId/it/accounts/:userId/provision` | `it_account · provision` | 201 `{ keycloakId, initialPassword, adopted }`. **`initialPassword` is shown ONCE and is never stored or audited** — if the UI loses it, the only path forward is `reset-password`. `adopted:true` ⇒ the account already existed and `initialPassword` is **null**. |
| `POST /api/:tenantId/it/accounts/:userId/disable` | `it_account · disable` | `{ ok, alreadyDisabled }`. |
| `POST /api/:tenantId/it/accounts/:userId/enable` | `it_account · enable` | `{ ok, alreadyEnabled }`. |
| `POST /api/:tenantId/it/accounts/:userId/reset-password` | `it_account · reset_password` | `{ ok, initialPassword }`. Body `{ reason? }` — the reason IS audited, the password is not. |

### The five `state` values, and which ones the console must surface

| `state` | Meaning | `actionable` |
|---|---|---|
| `missing` | Staff member with no Keycloak account — the joiner case. | ✅ |
| `leaver_still_enabled` | Employment is `terminated` and the login is still enabled. **The finding this worklist exists for.** | ✅ |
| `unverified_link` | Account and link exist, but the person never proved control of it. | ✅ |
| `disabled` | Login disabled. Actionable **only** when the person is NOT terminated (they cannot work); for a leaver this is the done state. | conditional |
| `enabled` | Nothing to do. | ❌ |

`actionable` is computed server-side deliberately — two implementations of "needs attention" drift, and
the direction they drift in is a leaver the UI quietly stops flagging. **Filter on `actionable`, do not
re-derive it.** `leaver_still_enabled` outranks `unverified_link`: a security finding beats paperwork.

### Refusal tokens (the typed token LEADS the `error` string)

| Token | Status | What a consumer should do |
|---|---|---|
| `keycloak_admin_not_configured` | **503** | Render "account management unavailable in this environment". **Never** an empty worklist — see below. |
| `keycloak_admin_failed` | **502** | Upstream Keycloak problem, not our wiring. Offer retry. |
| `not_a_member` | 404 | The target is not an active staff member of this company. |
| `no_keycloak_account` | 400 | `disable`/`enable`/`reset-password` need an account; provision first. |

**⚠ The 503 is load-bearing, not a degradation nicety.** When the admin client is unconfigured this
endpoint refuses rather than returning `[]`, because an empty worklist asserts "everyone has a login" —
the single most dangerous claim this surface can make while blind. A consumer must therefore distinguish
"no findings" (200 with an empty array) from "cannot see" (503) and must never render them the same way.

### Two behaviours a consumer should rely on

* **Provision converges.** It looks the address up first and treats Keycloak's own 409 as "adopt",
  including the race between lookup and create. Double-clicking Provision cannot produce two logins for
  one address (which would be an authentication ambiguity, not untidiness) — the second call returns
  `adopted:true`.
* **The identity link is created UNVERIFIED.** An admin creating an account is not the person proving
  control of it, so a freshly provisioned row shows `linked:true, linkVerified:false` and lands in
  `unverified_link` until the person actually logs in. That is the expected sequence, not a defect.

### Not HR-module-gated

Deliberate (design §5.4): IT provisioning is not an HR capability, and gating it on the `hr` module would
make login management vanish for a company with HR switched off while its people still need logins. Only
the employment-status read is module-scoped, so a company without `hr` gets `employmentStatus: null` and
**never** a `leaver_still_enabled` claim — that verdict is only ever made from real data.

### P2-15 (backfill) adds NO endpoint

It is a CLI (`npm run iam:backfill`), dry-run by default, and deliberately not an HTTP surface: applying
it is a reviewed one-time operation, and an endpoint would invite a button. See PERMISSION-CONTRACT §13.

## 21. Command palette tier-3 live search (UI redesign Phase 2, 2026-08-22) — `platform-ui/src/app/api/search/palette/route.ts` — **NO new backend endpoint; a browser-reachable BFF route only**

`docs/design/2026-08-22-ui-redesign-ia-and-migration.md` §4.1 flagged tier-3 (live-record) palette
results as a possible contract addition, "architect's call whether it fans out to existing list
endpoints or gets a dedicated search endpoint." Resolved here, in the direction the spec itself
named as available and lower-risk: **fans out to existing list endpoints**, via the SAME aggregator
the pre-existing `/search` page already calls (`platform-ui/src/lib/search.ts::globalSearch`, itself
built on `lib/entities.ts`'s `listCompanies/listProjects/listTasks/listCampaigns/listMembers`). No
new platform-nest route, no new Cerbos policy — this is a second, keystroke-driven UI onto reads that
already exist and are already RBAC-narrowed by the backend calls those readers make.

- `GET /api/search/palette?q=<string>` (platform-ui internal route, not platform-nest) — session-
  authed (`getSessionUserId`), resolves the active tenant the same way `/search` does, returns `{
  groups: SearchGroup[] }` (same shape as `lib/search.ts`'s `SearchGroup[]`, each group's `hits`
  capped to 5 for a keystroke-responsive list). `q.length < 2` short-circuits to `{ groups: [] }`
  with no read at all, matching `globalSearch`'s own floor.
- No session → `401` with an empty `groups` array (never a throw — the palette degrades to its
  static tiers 1/2, which need no network call at all).
- If/when a dedicated `/api/:t/search` backend endpoint is ever built (better relevance, cross-
  entity ranking, pagination beyond what a client-side aggregator can do), this route becomes a
  one-file swap — `CommandPalette.tsx` and the `/search` page both already consume a stable
  `SearchGroup[]` shape and neither needs to change.

## 22. Client-centric ERP — the client hub + the `clientId` list facet (CC-* program, 2026-08-24) — `platform-ui/src/lib/clientHub.ts`, `core/client-filter.ts` — **STATUS: DEV-VERIFIED (CC-1/CC-2/CC-3, slice 1 only)**

Design: `docs/plans/2026-08-24-client-centric-erp-design.md`. Owner ask: everything shown and filtered
to the client, so the ERP can be read client-first. Slice 1 only — Overview + Work tabs. Slices 2-5
(Commercial, Requests, Delivery, People, the staff timeline, and the `<ClientPicker>` on the
object-first lists) are **PLANNED, not built**.

### 22a. The `clientId` list facet (CC-1)

One parameter, one vocabulary, on every staff list that can be narrowed to a client:

| Value | Means |
|---|---|
| absent | every row — **unchanged behaviour, no existing caller is affected** |
| `<uuid>` | that client's rows |
| `internal` | rows belonging to NO client (own-brand, IT, HR, platform work) |

⚠ **This is a CONVENIENCE FILTER, NOT an authorization boundary.** `core/client-filter.ts`; the
distinction from `core/portal-scope.ts` (which IS a boundary) is spelled out in both files' headers.
Consequences that are deliberate and must not be "hardened": on the default (fail-open) lists a
malformed value resolves to **every row** (the PV3-03 lists below are strict and answer 400 instead; neither ever denies as a boundary would) — a filter that fails closed silently hides work and is indistinguishable from
"there is nothing here"; and passing another client's id is not an escalation and must not 403, since
the same caller could already read the list unfiltered. Staff isolation stays RLS (tenant) + Cerbos
(action). Ids compare **as text**, so a hand-edited query string misses rather than 500ing.

`internal` resolves to `client_id IS NULL`, **not** `is_internal = true`. The two disagree on the live
estate (9 clientless projects, only 7 flagged), and keying on the flag would leave the other 2
reachable from no scope at all. `is_internal` stays a data-quality signal, not the predicate.

| Status | Method | Path | Notes |
|---|---|---|---|
| ✅ NEW | GET | `/api/:t/projects?clientId=` | `core/core.controller.ts`. Was unfiltered; the client page used to fetch the tenant and narrow in the browser. |
| ✅ NEW | GET | `/api/:t/pm/tasks?clientId=` | `modules/pm/pm.controller.ts`. Joins through `projects` — there is no `pm_tasks.client_id`, by decision (one source of truth, no backfill, no sync trigger). Cheap: the task CTE already joins `projects`. **`pm_tasks.project_id` is `NOT NULL`, so no clientless-task branch is needed and adding one would be dead code.** |
| ✅ NEW | GET | `/api/:t/invoices?clientId=` | `modules/invoice/invoice.controller.ts`. This list previously accepted no query parameters at all. |
| ✅ PV3-03 | GET | `/api/:t/{deliverables,pipeline/runs,meetings/recordings,webdev/change-requests,invoice-payments}?clientId=` | Honour the full vocabulary (uuid / `internal` / absent) in **strict** mode. `core/client-work.controller.ts`, `pipeline.controller.ts`, `meetings.controller.ts`, `webdev-change-requests.controller.ts`, `contracts.controller.ts` (`invoice-payments` only). `internal` = `client_id IS NULL`. **Deliverables key on the PROJECT's client** (PV3-07 follow-up), the way the portal reaches them: `<uuid>` = the deliverable's project belongs to that client, `internal` = its project has no client. `deliverables.client_id` does not decide the facet: a deliverable on a client's project with no `client_id` of its own is that client's, and one naming a client but sitting on an internal project is `internal`. |
| ✅ PV3-03 | GET | `/api/:t/modules/social/{engagements,accounts}?clientId=` | Same strict facet. `social_engagements.client_id` and `social_accounts.client_id` are NOT NULL, so `internal` is a valid, always-empty selection there. There is no staff "post-review list" endpoint: the per-variant `GET variants/:id/client-review` (§16h) takes no list parameters. |
| PV3-01 | GET | `/api/:t/contracts?clientId=` | Same strict facet; owned by PV3-01, not this ticket. |

**Strict mode (PV3-03).** `parseClientFilter(raw, true)`: the lists above answer a non-uuid that is not
`internal` with **400**, not with every row. A hub page asking for one client must never silently get a
different list. Authorization still runs first (a denied caller gets 403, not 400). This changes the
earlier behaviour of these lists, which was a 500 (deliverables, meetings: uuid cast) or a silent empty
list (pipeline, change requests: text compare), and `internal` previously selected nothing on all of
them. The three original users (`projects`, `pm/tasks`, `invoices`) keep the fail-open mode above:
changing that is out of scope. Still PENDING: `time-entries`, and an `/approvals` list endpoint (none
exists).

### 22b. The hub aggregate (CC-2)

| Status | Method | Path | Notes |
|---|---|---|---|
| ✅ NEW | GET | `/api/:t/clients/:clientId/overview` | The staff mirror of `/portal/overview` (§16b). Authz: `client` read. 404 for a client outside the tenant. Runs with `{ modules: ["social"] }` — the post-review join carries the `social` third wall, and without the scope that SELECT returns **zero rows and raises nothing**, so the hub would report "no post reviews outstanding" for a client with ten. `projects.active`/`done` use the same definition: finished = completed, archived, cancelled (PV2-09). **Additive (PV4-06):** `conversationsAwaitingReply: number`, and `needsUs[]` gains `kind: 'conversation'` items for threads waiting for our reply (§29d). |

Response: `{ client, projects{total,active,done,percent}, tasks{total,open,overdue,blocked},
deliverables{total,delivered,overdue}, nextMilestone, money{byCurrency[],primary}, needsUs[],
needsClient[] }`.

**`needsUs` is the point of the endpoint.** `needsClient` is what §16b already tells the client (sign
this, decide that); `needsUs` is its mirror and **nothing in the ERP rendered it before CC-2** — which
is exactly how a client-recorded payment sat `pending` with no screen ever saying someone had to
confirm it. Both lists answer one question: who is holding the ball. `needsUs` sources: a `pending`
`invoice_payments` row · a `changes_requested` post review · a `new` change request · a `draft`
contract never sent. Items carry `{kind,id,label,context,href,since,clientVisible}`; `since` is rendered as an AGE,
and our side marks anything ≥7 days stale (one finance cycle). `clientVisible` is §22d's flag (PV3-07). The
`payment` and `contract` items (both lists) link to `/clients/:id/billing` (PV3-08's page); they used to
point at `/invoices/:id` and the nonexistent `/clients/:id/commercial`.

`money` mirrors `portal-workspace.controller.ts:finance` — **per currency, never summed across them** —
with one deliberate difference: `draft` invoices are included as their own `drafted` figure. The portal
hides drafts (a client must not see a number the agency has not committed to); staff are precisely the
people who need to know one is sitting unsent. `outstanding` counts **confirmed** payments only, so an
unverified client claim does not move the balance.

### 22c. UI (CC-3)

`/clients/[clientId]` is now a tabbed hub — `layout.tsx` fetches the aggregate ONCE (Next dedupes it
for the Overview tab, so tab badges cost nothing extra) and owns the header, breadcrumbs and the
client-level Delete action. Tabs are ROUTES, not client state, so a tab is linkable.

| Route | Tab | Reads |
|---|---|---|
| `/clients/[id]` | Overview | the aggregate — both ball lists first, tiles second |
| `/clients/[id]/work` | Work | `projects?clientId=` + `pm/tasks?clientId=`, tasks grouped under their project |
| `/clients/[id]/details` | Details | **the former `/clients/[id]` page, moved verbatim** — contacts, portal access, deliverables, meetings. Nothing was deleted; slice 3 splits it into People/Delivery. |

Unlike the portal layout (which `.catch(() => null)`s so an external client always gets chrome), this
layout lets a failure **throw** to the error boundary: a hub rendering zeroes tells a manager their
client has no work, nothing outstanding and no money owed, and this is the screen people act on.

The Work tab renders a "tasks outside this client's projects" card that **should always be empty** —
both reads apply the same server-side predicate, so a row there means the two filters disagree.
Surfaced rather than dropped, because a dropped row is invisible. Demo fixtures mirror the facet
(including `internal`) for the same reason: a fixture that ignored `?clientId=` would make every
client-scoped surface look correct in DEMO_MODE while showing the whole tenant.

### 22d. `clientVisible` on staff payloads (PV3-07, 2026-10-12) — **STATUS: PROTOTYPED**

Every row of the staff readers below carries `clientVisible: boolean`. It means exactly one thing:
**a client-wide contact of the row's client can read this row in the client portal.** The backend
computes it in SQL from the portal's own predicates (`core/portal-visibility.ts`, PV3-02), as
`<client>.client_id IS NOT NULL AND <portal row-state builder>`, so the staff marker and the portal
cannot drift (plan trap 9). Consumers render it ("Client sees this" / "Internal", PV3-09) and must
**never derive it in the browser**. `client-visible-parity.db.test.ts` proves, per kind, that the staff
ids marked `true` equal the ids the portal returns to a client-wide signer.

⚠ **A project-scoped contact may see less.** Such a contact sees only rows of their own projects, plus
the project-less contracts and change requests (a master agreement, a client-wide request); they do
not see a project-less run. `clientVisible: true` therefore says "the client's people can see this",
not "every contact of the client can". There is no per-contact flag.

| Method | Path | `clientVisible` is | Builder (`portal-visibility.ts`) |
|---|---|---|---|
| GET | `/api/:t/projects` | client set, not deleted | `projectClientVisible` |
| GET | `/api/:t/deliverables` | through the deliverable's **project**: the project has a client and is not deleted, and the deliverable is not deleted. `deliverables.client_id` is ignored (the portal reads deliverables by project). The `?clientId=` facet uses the same project rule (§22a), so every row of `?clientId=<uuid>` reads `true` and every row of `?clientId=internal` reads `false`. | `staffDeliverableClientVisible` |
| GET | `/api/:t/contracts`, `/contracts/:id` | client set, not deleted, not `draft` | `contractClientVisible` |
| GET | `/api/:t/invoices`, `/invoices/:id` | client set, not deleted, not `draft` (so `approved`, `sent`, `paid` and `void` all read `true`, as the portal shows them) | `invoiceClientVisible` |
| GET | `/api/:t/invoice-payments` | through the **invoice** ("detail" context: the invoice's payment history, where pending and rejected claims show too): the invoice is client-visible and the payment is not deleted | `staffInvoicePaymentClientVisible` |
| GET | `/api/:t/pipeline/runs` (and `include=gates`), `/pipeline/runs/:id` | run: client set, not deleted. Gate: through the run, and `actor_side = 'client'`. Stage (detail only): through the run, and not the `report` track. | `runClientVisible`, `staffGateClientVisible`, `staffRunStageClientVisible` |
| GET | `/api/:t/webdev/change-requests` | client set, not deleted (a staff-logged request with no client reads `false`) | `changeRequestClientVisible` |
| GET | `/api/:t/meetings/recordings` | always `false` (no portal read of meetings exists) | `NEVER_CLIENT_VISIBLE` (`meeting`) |
| GET | `/api/:t/pm/tasks` | always `false` (the portal lists no tasks) | `NEVER_CLIENT_VISIBLE` (`task`) |
| GET | `/api/:t/clients/:id/contacts` | listed in the portal People area: not revoked | `clientContactClientVisible` |
| GET | `/api/:t/clients/:id/overview` → `needsUs[]`, `needsClient[]` | per item kind: `payment` through its invoice, `gate` through its run, `contract`, `request` and `review` on their own row (a post review is always visible to its client) | as above, plus `postReviewClientVisible` |

Notes:
- **No staff post-review list exists**, so post reviews carry the flag only through the overview items.
- Notes (`comments`) and history (`activities`) are in `NEVER_CLIENT_VISIBLE` too; their staff readers are
  not part of PV3-07, and PV3-09 styles the Internal area instead of marking rows.
- **Detail reads carry the flag too** (PV3-07 follow-up). `GET /projects/:id`, `/deliverables/:id`,
  `/webdev/change-requests/:id`, `/meetings/recordings/:id` and `/pm/tasks/:id` compute `clientVisible` with the
  same builder as their list (project: `projectClientVisible`; deliverable: `staffDeliverableClientVisible`,
  through its project; change request: `changeRequestClientVisible`; meeting and task: always `false`), so a
  detail row always agrees with its list row. The parity test pins detail == list == portal. Not covered: the
  legacy core `GET /tasks/:id` and the PM module's `GET /pm/projects/:id` (a different payload from the
  project row); neither has a list that carries the flag. The flag stays optional in the UI types for older servers.
- PV3-08's new `lib/contracts.ts` types should declare `clientVisible?: boolean` on the contract and
  payment rows; this ticket added it to the existing types only.

---

## Finance & Accounting — `/api/:tenantId/finance/*`

**BUILT** in `platform-nest/src/modules/finance/finance.controller.ts`. Consumed by
`platform-ui/src/lib/finance.ts` and `/finance`. Design:
`docs/blueprints/finance-accounting-foundation.md`. Authorization: PERMISSION-CONTRACT §17–§24.

| Method | Path | Returns | Cerbos |
|---|---|---|---|
| GET | `/finance/accounts?q=` | `Account[]` | `finance_config:read` |
| | | ⚠ **PV5-04 — tax on every line comes from a TAX CODE** (`POST /finance/ar/invoices`, `/ap/bills`, `/ar/credit-notes`, `/ap/vendor-credits`). A taxed line names `taxCode`; the server computes the tax with `finance_tax_compute()` from the code's effective-dated rate and base multiplier on the document date, rounded to the currency's minor unit. A positive `taxRate` with no `taxCode` is **400**; a code with no rate in force on that date is **400** naming the date; a `taxRate` sent with a code must equal the code's rate (**400** otherwise). Tax codes are per-company data (`finance_tax_codes`); until Finance sets them up, taxed entries are refused. | |
| GET | `/finance/periods` | `FiscalPeriod[]` | `finance_period:read` |
| GET | `/finance/trial-balance?asOf=&from=` | `{ rows, totalDebit, totalCredit, balanced }` | `finance_statement:read` |
| GET | `/finance/profit-and-loss?from=&to=` | `StatementRow[]` — **both bounds required** | `finance_statement:read` |
| | | **UI consumers:** `/finance/reports` and — since GM-09 — the GM console's money tier (`components/departments/gm/GmMoneyCard.tsx` via `lib/gmMoney.ts`). ⚠ Two rules a consumer must not get wrong: ① the statement carries its OWN totals as `section: "total"` rows keyed `TOTAL_REVENUE` / `TOTAL_EXPENSE` / `NET_PROFIT` (from Postgres `finance_profit_and_loss()`, with a DB test pinning `NET_PROFIT = TOTAL_REVENUE - TOTAL_EXPENSE`) — **read those codes, never re-sum the line rows**, or the surface will agree with the ledger only until the first contra-revenue account and a GM will have two different net-profit figures with no way to tell which is the books; ② amounts are decimal STRINGS and an absent or malformed one must render as unknown, **never as 0** — "we earned nothing" is the most expensive wrong answer this surface can give. `lib/gmMoney.ts` implements both and pins them in `gmMoney.test.ts`. | |
| | | ⚠ **Gate on `listPeriods`, not on this read.** `getProfitAndLoss` folds 403 and 404 into `[]` (`financeData`), so on its own it cannot tell "no finance access" from "no books". `listPeriods` is the one finance reader that distinguishes them (`null` = forbidden, `[]` = no fiscal calendar / module not enabled for this tenant — it is `ModuleEnabledGuard("finance")`-gated per company). | |
| GET | `/finance/balance-sheet?asOf=&fyStart=` | `{ rows, assets, liabilities, equity, balanced }` — **`fyStart` required** | `finance_statement:read` |
| GET | `/finance/general-ledger/:code?from=&to=` | GL rows with a running balance | `finance_statement:read` |
| GET | `/finance/journals?limit=` | `JournalSummary[]` | `finance_ledger:read` |
| GET | `/finance/journals/:entryId` | `JournalDetail` incl. lines + hash | `finance_ledger:read` |
| POST | `/finance/journals` | `{ id }` | `finance_ledger:post` |
| POST | `/finance/journals/:entryId/reverse` | `{ id }` | `finance_ledger:reverse` |
| GET | `/finance/ledger/verify` | `{ problems, clean }` | `finance_ledger:verify` |
| GET | `/finance/ar/aging?asOf=` · `/finance/ap/aging?asOf=` | aging rows | `finance_ar\|ap:read` |
| GET | `/finance/ar/reconcile` · `/finance/ap/reconcile` | `{ position, problems, clean }` | `…:reconcile` |
| GET | `/finance/ap/vendor-credits?status=` | vendor-credit rows (incl. `unapplied`, `requiresBupotAmendment`) | `finance_ap:read` |
| POST | `/finance/ap/vendor-credits` | `{ id, creditNo, subtotal, taxTotal, total, amountPayable, requiresBupotAmendment }` — raises AND posts | `finance_ap:credit_note` |
| POST | `/finance/ap/vendor-credits/:creditId/apply` | `{ applicationId, amount }` — subledger only | `finance_ap:credit_note` |
| POST | `/finance/ap/vendor-credits/:creditId/bupot-amended` | `{ ok, creditNo, amendmentRef }` — `amendmentRef` REQUIRED | `finance_tax:file` |
| GET | `/finance/ap/bupot-exceptions` | credits whose bukti potong still needs amending | `finance_tax:read` |
| POST | `/finance/ap/bills/:billId/write-off` | `{ writeOffId, billNo, amount }` — `confirm` must equal the bill number | `finance_ap:write_off` |
| | | ⚠ **The AP pair is NOT the AR pair with the signs flipped, and a consumer presenting it that way will mislead the user about their tax position.** A vendor credit reverses **INPUT** VAT (`1170`, an asset the company CLAIMED), not output VAT, and in Indonesia the reversal is validated by a **nota retur the BUYER issues** (PMK 65/2010) — hence `notaReturNo`, which has no AR counterpart. An AP write-off credits **OTHER INCOME (`7300`)**, not an expense: released debt is taxable income, so it *increases* taxable profit — the opposite of the AR write-off. | |
| | | ⚠ `withholdingRate` on a vendor credit is a **RATE** (`0.02`), matching the bill's own column, while `taxRate` on its lines is a **PERCENT** (`12`). The two differ because the underlying columns differ; guessing either way is wrong by a factor of a hundred. Copy withholding FROM THE BILL rather than re-deriving it — the rate in force when the bill was approved is the rate that must be unwound. | |
| | | ⚠ A credit that unwinds withholding sets `requiresBupotAmendment` and raises `AP_BUPOT_AMENDMENT_PENDING` on `/finance/ap/reconcile`. Owner ruling 2026-08-27 option (c): the credit is NOT blocked and the filing is NOT auto-amended. Do not render that problem row as a ledger fault — the books tie out; a filing does not. | |
| | | ⚠ `/finance/ap/reconcile`'s `position` gained a FOURTH field, `unappliedCredits`. The identity is `open bills − payments on account − unapplied vendor credits = the AP control balance`. A consumer still computing `open − onAccount` disagrees with the ledger the moment a credit is issued and not yet applied. | |
| GET | `/finance/fiscal-years` | `{ id, code, startDate, endDate, status, periodCount, openPeriods }[]` | `finance_period:read` |
| | | Added 2026-08-27 because closing a year was reachable only by somebody who already held the uuid — nothing returned one, and `/finance/periods` carries the year CODE but not its id. `openPeriods > 0` means the year is NOT closeable; show it on the row and disable the control, rather than letting the user type a confirmation and then be refused. | |
| GET | `/finance/ar/credit-notes?status=` | credit-note rows (incl. `unapplied`) | `finance_ar:read` |
| POST | `/finance/ar/credit-notes` | `{ id, creditNoteNo, subtotal, taxTotal, total }` — raises AND posts. **PV5-04:** lines take `taxCode` (see the tax note below the table) | `finance_ar:credit_note` |
| POST | `/finance/ar/credit-notes/:noteId/apply` | `{ applicationId, amount }` — subledger only, posts nothing | `finance_ar:credit_note` |
| POST | `/finance/ar/invoices/:invoiceId/write-off` | `{ writeOffId, invoiceNo, amount }` — `confirm` must equal the invoice number | `finance_ar:write_off` |
| | | ⚠ **A credit note and a write-off are NOT two flavours of one adjustment, and a consumer that presents them as one will cause a real tax error.** A CREDIT NOTE means the customer never owed it (return, over-bill, agreed discount): it debits contra-revenue AND **reverses output VAT** (a 2140 debit). A WRITE-OFF means they owed it and will not pay: it debits bad-debt expense (6950) or the allowance (1131) per `finance_company_settings.bad_debt_method`, and posts **NO VAT line at all** — Indonesian PPN gives no relief for a bad debt, so reversing it reclaims tax the company is not entitled to and shows up in a Coretax reconciliation. They also carry different rights (`credit_note` vs the step-up-gated `write_off`), though both bind to the same SoD duty `ar_writeoff_approve`. | |
| | | ⚠ `/finance/ar/reconcile`'s `position` gained a FOURTH field, `unappliedCredits`. The identity is `open invoices - payments on account - unapplied credit notes = the AR control balance`: an unapplied credit note credits the control account exactly as an unallocated receipt does. A consumer that still computes `open - onAccount` will disagree with the ledger the moment any credit note is issued and not yet applied — which is its normal state. | |
| GET | `/finance/tax/returns?year=&kind=` | filed/draft return rows | `finance_tax:read` |
| POST | `/finance/tax/returns` | `{ id, status, computed:{output,input,net} }` — idempotent per period | `finance_tax:prepare` |
| POST | `/finance/tax/returns/:returnId/file` | `{ id, status, filed:{…} }` — needs `filingReference` + `confirm`; `amend:true` to re-file | `finance_tax:file` |
| GET | `/finance/tax/returns/drift` | `{ problems, clean }` — filed returns the ledger no longer agrees with | `finance_tax:read` |
| | | ⚠ Filed figures are a SNAPSHOT taken at filing and are never recomputed. `filed*` is what was told to DJP; the summary endpoints are what the data says today. They diverge the moment a journal lands in a filed period, and `/drift` is the endpoint that measures it — do not "helpfully" refresh `filed*` from the live summary, that destroys the only evidence of the gap. | |
| GET | `/finance/tax/ppn?from=&to=` | PPN summary | `finance_tax:read` |
| GET | `/finance/tax/efaktur-exceptions?from=&to=` | exception rows | `finance_tax:read` |
| GET | `/finance/periods/:periodId/close-readiness` | `{ blockers, ready }` | `finance_bank:reconcile` |
| GET | `/finance/events/backlog` · POST `/finance/events/process` | event queue | `finance_posting_rule:read\|process` |

### Three contract rules a consumer must not "simplify"

1. **`fyStart` on the balance sheet is REQUIRED, not defaulted.** "Profit so far" is meaningless
   without knowing when the fiscal year began, and not every company's starts in January. A default
   would silently render a wrong sheet.
2. **A P&L needs BOTH bounds.** It is flow, not stock — "as at a date" is a category error and the
   endpoint 400s.
3. **The verdict endpoints must not degrade to `[]`.** `ledger/verify`, `ar|ap/reconcile` and
   `close-readiness` all mean *"problems found; empty = pass"*. A consumer that folds a 403/404 into
   an empty list renders a green tick for a check that never ran. `lib/finance.ts` splits its
   readers into `financeData` (may degrade) and `financeVerdict` (returns `null`) for exactly this.

### Errors

`FINANCE_*` refusals are mapped by `FinanceErrorFilter` to `{ error, code }` with 400 (malformed),
404 (unknown) or **409** (well-formed but the books refuse — a locked period, an immutable journal,
a control account). Unrecognised `FINANCE_*` codes default to 409 with their own message, so a
refusal added by a later migration is mapped by construction.

### Finance — cap table and settings (UI-01a / UI-02a)

| Method | Path | Returns | Cerbos |
|---|---|---|---|
| GET | `/finance/settings` | `{ functionalCurrency, presentationCurrency, fiscalYearStartMonth, isPkp, npwp, coaTemplateKey }` | `finance_config:read` |
| POST | `/finance/settings` | `{ ok }` | `finance_config:update` |
| GET | `/finance/ownership?asOf=` | `{ edges[], problems[] }` | **`finance_ownership:read`** |
| POST | `/finance/ownership` | `{ id }` | **`finance_ownership:create`** |
| POST | `/finance/ownership/:edgeId/end` | `{ ok }` | **`finance_ownership:update`** |

Three contract rules a consumer must not simplify:

1. **`finance_ownership` is NOT `finance_config`.** An ownership edge is an authorization fact —
   `finance_owner_company_ids()` resolves a person's visibility from it, and a `holding` edge
   reaches every descendant company. `finance_manager` may READ the cap table and may **not** write
   it; `finance_staff` may not read it at all. Proved against the live PDP.
2. **`problems[]` travels WITH the edges.** A cap table totalling 140% (or 60%) must be visible on
   the surface that renders it, not discoverable by asking a second question. Rendering `edges`
   without `problems` shows a register that looks authoritative and is not.
3. **There is no DELETE.** Removing a holder is `POST /ownership/:id/end` with an `effectiveTo` —
   ownership is effective-dated and last year's statements were true under last year's cap table.
   Ending an already-ended edge is a **404**, never a silent success.

`fiscalYearStartMonth` is returned but **not accepted** on write: the database refuses to move it
once a calendar exists, and offering a field that will be rejected implies it is editable.

---

## Agency Discovery Intake — `/api/:tenantId/agency/leads*` and `/api/:tenantId/intake/*` (AD-1…AD-7, 2026-09-05) — **STATUS: PROTOTYPED**

Design: `docs/superpowers/plans/2026-09-05-agency-discovery-intake-design.md`.
Migration `202609050857_agency_discovery_intake.sql` (DEV-VERIFIED: applies clean, RLS + composite
FKs + CHECKs + partial uniques driven under a NOBYPASSRLS role). The endpoints below are
**PROTOTYPED** — typechecked and unit-tested, wired into `app.module.ts`, not yet driven end to end
against the running estate.

A prospect fills a structured discovery questionnaire through a link we send them; the agency
reviews it in the ERP and declines, nurtures, or converts — where converting mints the client, the
project, the delivery run seeded from their own answers, and the delegation tasks.

### The one thing a consumer must understand before using any of this

**`/intake/*` is the only surface in the estate that a caller reaches without a platform session.**
It carries no `AuthGuard`. It is not unauthenticated — it is authenticated by a **capability token**
(`X-Intake-Token`), and the caller is a prospect who has no `users` row, no membership, no derived
role, and is **not a principal**. `authorize()` is never called on that path; a prospect satisfies
no Cerbos policy at all, which is deliberate and preserves the `0072:32-36` invariant.

### Prospect surface (token-guarded, NOT for platform-ui)

| Method | Path | Returns | Guard |
|---|---|---|---|
| GET | `/api/:tenantId/intake/questionnaire` | `{ schemaVersion, sections[] }` | `IntakeTokenGuard` |
| POST | `/api/:tenantId/intake/submissions` | `{ id, status }` | `IntakeTokenGuard` |

- The token travels in the **`X-Intake-Token` header**, never a query parameter — a `?token=` lands
  in nginx access logs, in the `Referer` of every outbound link, and in browser history. The
  prospect-facing page reads it from the URL **fragment** and strips it from the address bar.
- `:tenantId` in the path is **not an authorization fact** (design §2.3). It only scopes which
  tenant's rows the hash lookup can see; a valid token against the wrong tenant resolves nothing and
  is indistinguishable from an unknown hash. It is in the path because `agency_intake_tokens` ships
  FORCE RLS with no `principal_lookup` bypass, so a tenant-blind lookup returns zero rows always.
- **Refusals are typed, and the code leads.** `{ statusCode, reason, message }` where `reason` is
  one of `token_missing` · `token_invalid` · `token_expired` · `token_used` · `token_revoked` (401),
  or `open_intake_not_enabled` (403, names AD-9). A consumer must render off `reason`, never by
  matching `message`.
- **A replayed POST returns 200 with the EXISTING submission id, not a conflict.** This differs
  deliberately from convert below: a prospect is not an operator who can act on a 409, and a dropped
  response is far likelier than a real double submission. Do not "make them consistent".

### Staff surface (platform-ui)

| Method | Path | Returns | Cerbos |
|---|---|---|---|
| GET | `/api/:tenantId/agency/leads` | queue rows + `ageSeconds`, `hasSubmission`, and (M5-P1) `stage`, `dealValue`, `dealCurrency`, `stageEnteredAt` | `agency_lead:read` |
| GET | `/api/:tenantId/agency/leads/:leadId` | lead + latest submission + (M5-P1) `stage`, `dealValue`, `dealCurrency`, `stageEnteredAt` | `agency_lead:read` |
| GET | `/api/:tenantId/agency/leads/:leadId/submissions` | full history (`supersedes_id` chains) | `agency_discovery_submission:read` |
| POST | `/api/:tenantId/agency/leads` | `{ id, status: "new" }` (staff-entered, `source='staff'`) | `agency_lead:create` |
| POST | `/api/:tenantId/agency/leads/:leadId/invite` | `{ tokenId, token, expiresAt }` — **the token is returned ONCE** | `agency_lead:update` |
| POST | `/api/:tenantId/agency/leads/:leadId/invite/:tokenId/revoke` | `{ revoked }` (idempotent) | `agency_lead:update` |
| POST | `/api/:tenantId/agency/leads/:leadId/open` | `{ ok }` — `submitted → in_review` | `agency_lead:triage` |
| POST | `/api/:tenantId/agency/leads/:leadId/decline` | `{ id, status: "declined" }` — `reason` REQUIRED. **From any open status** (new, invited, submitted, in_review, nurturing); sets stage `lost` | `agency_lead:triage` |
| POST | `/api/:tenantId/agency/leads/:leadId/nurture` | `{ ok }` | `agency_lead:triage` |
| POST | `/api/:tenantId/agency/leads/:leadId/convert` | `{ id, status, clientId, projectId, runId, delegations, dealValue, dealCurrency }`. Body gains an optional `deal: {value, currency}` (M5-P1); sets stage `won` | **`agency_lead:convert`**, plus `agency_lead:update` when `deal` is sent |
| GET | `/api/:tenantId/agency/leads/:leadId/stage-history` | M5-P1. `[{ id, fromStage, toStage, dealValue, dealCurrency, actorId, actorName, viaAgent, occurredAt }]`, newest first; 404 when the lead is invisible | `agency_lead:read` (with the lead id) |
| GET | `/api/:tenantId/agency/pipeline/reference` | M5-P1. `{ stages: [{ key, position, kind: open\|won\|lost, label }], currencies: [{ code, symbol, minorUnit }] }` — the six stages in order and the ACTIVE currencies | `agency_lead:read` |
| POST | `/api/:tenantId/agency/leads/:leadId/stage` | M5-P1. Body `{ stage, deal? }` → `{ id, stage, changed, stageEventId? }`. Open stages only; same-stage move is `200 changed:false` and writes nothing | `agency_lead:triage`, plus `agency_lead:update` when `deal` is sent |
| POST | `/api/:tenantId/agency/leads/:leadId/deal` | M5-P1. Body `{ value, currency }` or `{ value: null, currency: null }` (clear) → `{ id, changed, dealValue, dealCurrency }`. Any status; emits no stage event | `agency_lead:update` |
| GET | `/api/:tenantId/agency/web-leads/:siteSlug` | M5-L6. `{ leadIntakeEnabled, truncated, leads: [{ id, orgName, contactName, originForm, createdAt, status, stage, attribution: { landing, formPage, referrer, utmSource, utmMedium, utmCampaign, clickIds }, marketingConsent }] }`. **PROTOTYPED.** See "Website leads" below | `agency_lead:read` (tenant-wide, no new kind) |

### Website leads (M5-L6, 2026-10-12) — the Website workspace's Leads tab

`GET /api/:t/agency/web-leads/:siteSlug` lists the leads filed from a WebDesk site: `source = 'web' AND web_site_slug = :siteSlug`, `deleted_at IS NULL`, newest first, at most 200 (`truncated: true` when more exist). `:siteSlug` is the WebDesk **tenant** slug (the one `form.received` carries as `siteSlug` and `web_site_slug` stores), so a tenant with several sites lists them together. It is a path segment rather than a `?webSiteSlug=` filter on the queue route because the MCP hub forwards only path parameters on a GET; the queue route and its shape are unchanged.

- **Authz:** `agency_lead:read` on the path's tenant, checked BEFORE the slug is looked at (an over-long slug is a 400 for an authorised caller only). The read runs under `withTenants([t])` with no `{ modules }` option, so another company's leads never appear even for an identical slug; a caller outside the company gets 403.
- **`leadIntakeEnabled`** is `AGENCY_WEB_LEADS_ENABLED === "1"` as a boolean. The env value itself is never exposed. `false` with an empty list means intake is off, not that nobody submitted.
- **Privacy projection** (`summarizeAttribution`): an allow-list. `attribution` carries the landing and form-page paths, the referrer host and the three UTM columns; `clickIds` is the list of click-id NAMES that are present (`gclid`, `gbraid`, `wbraid`, `fbclid`, `msclkid`, `li_fat_id`), never a value. `fbp`/`fbc`, `utm_term`/`utm_content`, `sections_seen` and anything unknown are not returned. `marketingConsent` is `true` / `false` from `visitor_consent.marketing`, or `null` = unknown, which a consumer must treat as no consent and show as its own state.
- **Contact PII** (`orgName`, `contactName`) is returned under the existing `agency_lead:read`, as the queue already does. No email or phone is returned here.
- **MCP tool:** `agency_intake.listWebLeads` (read, no impact class), `GET /api/:tenantId/agency/web-leads/:siteSlug` with `tenantId, siteSlug`.
- **platform-ui:** Website tab **Leads** (`/departments/:deptId/website/leads[/:tenant/:site]`), `lib/websiteLeads.ts` -> `lib/websiteLeadsModel.ts#parseWebLeads` (STRICT: a click-id entry that is not one of the six names, or an off-shape body, is `contract_drift`, never rendered). Read-only; each row links to `/agency/leads/:leadId`. States: refusal notice (never an empty table), the empty-state sentence, and an "intake is off" hint when `leadIntakeEnabled` is false.

### The invite token is shown once and never again

`POST …/invite` returns the plaintext token in its response body, and that is the **only** time it
exists anywhere — the database stores `sha256(token)` (design §2.2), so a lost link is re-minted,
never recovered. A UI that renders it must therefore treat it like a generated password: show it
once, offer copy, and say plainly that navigating away loses it.

Build the link with the token in the **fragment** — `https://…/discovery#t=<token>` — never
`?t=<token>`. A query parameter is written to nginx access logs, sent in the `Referer` header of
every outbound link on the page, and kept in browser history; a fragment is never transmitted to
any server. The prospect page reads it, strips it from the address bar, and replays it as
`X-Intake-Token`.

Minting also advances the lead `new → invited` in the same transaction, which is what moves it out
of the queue's "we still owe them the form" tier. Re-minting for an expired link is safe and keeps
the lead; it will not drag a lead that has already **submitted** backwards out of the review queue.

### Six contract rules a consumer must not "simplify"

1. **The queue sorts by whose move it is, not by recency.** `submitted`(0) → `new`(1) →
   `invited`(2) → everything else(3), oldest-first within each. `new` outranks `invited` on purpose:
   `new` means we created the lead and never sent the form — ours, and the easiest thing in an
   agency pipeline to drop. A consumer that re-sorts by `createdAt` destroys the one signal the
   queue exists to carry.
2. **`convert` is a distinct Cerbos action from `triage`, and is narrower.** It mints a client, a
   project and a delivery run. Currently `company_admin` only — flagged as a business call, not an
   authz one. A UI that shows the Convert button on `agency_lead:triage` will render a control most
   users get a 403 from.
3. **A denial is never an empty list.** The reader deliberately does not fold 403/404 into `[]` —
   the estate has a live defect from exactly that (`2026-08-03-agentic-native-erp-plan.md`,
   cross-cutting item 3). Render the refusal; an empty queue and a forbidden queue must not look
   alike.
4. **`answers` is JSONB keyed by the questionnaire's stable field ids, and "key absent" ≠ "answered
   empty".** The detail read returns it raw and never defaults it. A reviewer's first question is
   *what did they not tell us*, so a consumer must render an unanswered field as visibly absent, not
   as a blank string. The id set and `schemaVersion` come from
   `core/agency-discovery-questionnaire.ts`; `SCHEMA_VERSION` is pinned per submission because a
   stored answer set is meaningless without the question set that produced it.
5. **Branch on `reason`, not on `error` text.** `HttpErrorFilter` forwards `reason` alongside
   `error` (added for this feature — it was being silently dropped, so the documented field was one
   no caller could actually read). `error` carries the same string today, but it is the human
   message and is free to change wording; `reason` is the machine code and is not.
6. **A submission is INSERT-only.** There is no update endpoint and no `update` action on
   `agency_discovery_submission` — the row is the evidentiary record of what the client actually
   said, and it is the basis of scope. Corrections arrive as a NEW submission with `supersedes_id`
   set; both are kept and the compare view is the intended surface for the difference.

### The lead pipeline (M5-P1, WSK-D69) — **STATUS: PROTOTYPED**

Design: `docs/plans/2026-10-11-m5-lead-pipeline-design.md`. A lead has two state machines that meet only at the
ends: `status` (the intake lifecycle above) and `stage` (the sales position, from the global reference table
`agency_lead_stages`): `enquiry` → `contacted` → `qualified` → `proposal` (open), then `won` or `lost`. **Won
⇔ converted and lost ⇔ declined, enforced by CHECKs.**

- **Won only through Convert, lost only through Decline.** `POST …/stage` with `won` or `lost` is
  `400 {reason:"stage_terminal"}`. Moves go in any direction between open stages (deals regress). A converted
  or declined lead is `409 {reason:"lead_closed"}`. An unknown key is `400 {reason:"stage_unknown"}`.
- **Authorization needs no new Cerbos action.** A move is `triage`, a value is `update`, won is `convert`. When
  a `deal` rides on a move or a convert, the route ALSO authorizes `update`, after the first check and before
  any validation, so a caller with `triage` or `convert` but not `update` gets a `403` for the deal part. Every
  route authorizes before it validates, so a denial is never a validation 400.
- **Deal value.** `dealValue` is a decimal **string** (Postgres `numeric(20,4)`, for example `"15000000.0000"`),
  never a JSON number: do no float arithmetic on it. The request may send a decimal string (preferred) or a
  finite number, matched by `^\d{1,16}(\.\d{1,4})?$`. The value must be exact at the currency's `minorUnit`
  (from `…/pipeline/reference`): IDR (0) refuses `1500.5`, USD (2) accepts `10.25` and refuses `10.255`. Value and
  currency are set together or not at all; the clear is the explicit pair of nulls (a body that omits both is
  incomplete, so `{}` can never wipe a value). There is no default currency: pre-select the one most recently
  used and always send the code.
- **Typed `reason` codes** (branch on `reason`, rule 5 above): `stage_unknown`, `stage_terminal`, `lead_closed`,
  `deal_incomplete`, `deal_value_invalid`, `deal_currency_unknown`, `deal_value_precision`.
- **`stageEnteredAt`** is the latest history `occurredAt`; else `triagedAt` for a won or lost lead; else
  `createdAt`. The queue **keeps its whose-move-it-is order**: `stage` and `dealValue` are for filter chips and
  columns, and a consumer must not re-sort by them (rule 1 above).
- **History** holds no personal data and is append-only. A lead's entry into `enquiry` is its `createdAt`; the
  history starts at the first move.
- **Event.** Every stage change emits `agency.lead.stage_changed` v1 (ids, stages, value; no names, emails,
  phones, reasons, attribution or consent). It is not a notification topic and not on the n8n allow-list.
- **MCP.** `agency_pipeline.reference` and `agency_pipeline.stageHistory` (reads); `agency_pipeline.moveStage`
  and `agency_pipeline.setDealValue` (impact `low`). `agency_intake.convert` gains the optional `deal`.
  `agency_intake.decline` now works from every open status.

### Data-subject requests and lead retention (M5-G5, G5b) — **STATUS: BUILT (PROTOTYPED; the DB suites need the Linux gate)**

Addendum: `legal/website-visitor-addendum.md` §5 and §9.3 items 3, 7, 8, 9. Code: `core/agency-privacy.*`,
`core/agency-lead-retention.ts`, migration `202610121835_agency_lead_privacy_retention.sql`. No UI consumes these yet;
they are an operator/agent surface (WebDesk's WSK-38 privacy commands, mirrored for the ERP's lead data).

| Method | Path | Returns | Cerbos |
|---|---|---|---|
| POST | `/api/:tenantId/agency/privacy/find` | Body `{ email?, phone?, approvalId? }` (G5b: with an `approvalId`, email and phone may be omitted). Executed: `{ outcome:"executed", requestId, counts, outOfScope, leads:[{ leadId, status, stage, source, createdAt, statusChangedAt, erasedAt, deleted, directMatch, submissionCount, tokenCount, convertedClientId }] }`, no contact data | `agency_lead:convert` |
| POST | `/api/:tenantId/agency/privacy/export` | Same body. Executed: the `find` fields plus `orgName`, `contactName`, `contactEmail`, `contactPhone`, `originForm`, `submissionRef`, `webSiteSlug`, `attribution`, `visitorConsent`, `declinedReason`, `submissions:[{ submissionId, schemaVersion, createdAt, erasedAt, answers }]`, `intakeTokens:[{ tokenId, kind, createdAt, expiresAt, usedAt, revokedAt }]` | `agency_lead:convert` |
| POST | `/api/:tenantId/agency/privacy/erase` | Same body. Executed: `{ outcome:"executed", replayed, requestId, erasedAt, counts:{ leadCount, submissionCount, tokenCount, outOfScopeCount, suppressionCount }, outOfScope:[{ leadId, convertedClientId, reason:"client_record_retention" }] }` | `agency_lead:convert` |

- **WS4 per call, for every principal (the SM-21 shape).** Without `approvalId` the route files a HIGH approval and
  returns `202 { outcome:"suspended", requestId, approvalId }`, reading nothing. A DIFFERENT company admin decides it
  in the approvals inbox. The requester then repeats the call with the SAME identifiers and the `approvalId`: it runs
  exactly once (G5b: the identifiers are optional on that call; omit them and the person is rebuilt from the hashes the
  approval was filed with). Typed refusals: `202 awaiting_approval`, `400 subject_invalid | approval_id_invalid |
  privacy_request_mismatch` (other identifiers or another command than were approved), `403 privacy_request_not_requester
  | self_approved | user_required`, `404 privacy_request_not_found`, `409 approval_rejected | approval_already_used`.
  An erase called again with its used approval returns the stored counts with `replayed:true`; a find/export re-use is
  409 (its response is personal data and is never stored).
- **Identifiers.** Email is trimmed and lower-cased; phone keeps 7-15 digits with a leading `+`/`00` dropped and a
  national leading 0 NOT rewritten (WebDesk's normalisation, byte for byte). Never put them in a URL: POST only.
- **Erase scrubs, never deletes.** Lead: `orgName` `(erased)`, contact fields and attribution null, a decline reason
  `(erased)`; status, stage, client link, value and the consent snapshot are kept. AD-1: the person answers become
  `"[erased]"`, business answers stay. Unused intake tokens are revoked. A converted lead's CLIENT record is out of
  scope and is listed under `outOfScope`. The contact is added, hashed, to the suppression list: the web intake then
  answers `422 { reason:"subject_suppressed" }` and stores nothing.
- **Ledger.** `agency_dsr_requests` is append-only and holds SHA-256 hashes only (the same hash WebDesk's
  `dsr_requests` computes, so one person's two ledgers correlate). The approval row holds the command and which keys
  were given, never the values (G5b: plus the subject hashes and a display hint, see the next bullet).
- **Unattended callers (M5-G5b).** An agent or workflow is suspended by the mcp-hub (`high`) and files its approval
  through `POST /api/:tenantId/automation-approvals` with the call's args. For these three tools that filing path
  (`core/approval-filing.ts`, policy in `core/approval-arg-minimisers.ts`) first replaces `email` and `phone` with the
  G5 subject hashes (`SHA-256` of `webdesk:privacy:subject:` + the normalised value, the ledger's own hash) and a hint,
  and drops every other key; a malformed identifier is `400 subject_invalid` and nothing is stored; and filing needs
  `agency_lead:convert` (the route's own gate), so `403` for anyone without it. The stored `tool_args` are
  `{ minimised:"agency-privacy.v1", kind, identifiers:["email"|"phone"], tenantId?, approvalId?, requestId?,
  subject:{ emailHash?, phoneHash?, emailHint?, phoneHint? } }`: `emailHint` is `***@<domain>`, `phoneHint` is `***` plus
  the last two digits, and they appear only in the approval row (the approver's detail view). The `reason` is generated
  (the caller's text is replaced), the `automation_approval.decided` event carries the hashes without the hints, and the
  notification and activity rows carry ids and the generated sentence only. The same transaction writes the ledger's
  `filed` row, so a hub-filed approval is bound exactly like a route-filed one. After a DIFFERENT admin approves it, the
  requester runs it with `POST .../privacy/:kind { approvalId }` (still attended: an unattended re-call is suspended
  again). `resolve-and-execute` compares the re-run's args after the same reduction, so the runner finds its own
  approval (`not_executable`, because the tools are barred) instead of re-filing it.
- **Retention.** A scheduled purge (dark until `AGENCY_LEAD_RETENTION_PURGE_ENABLED=1`) hard-deletes an UNCONVERTED lead
  with its AD-1 submissions, tokens and stage history `AGENCY_LEAD_RETENTION_MONTHS` (default 24) after its last status
  or stage change (`status_changed_at`, kept by a DB trigger), unless a token or submission arrived after the cutoff.
- **MCP.** `agency_privacy.find`, `agency_privacy.export`, `agency_privacy.erase`: impact `high`, barred from D14
  auto-execution (the route is its own WS4 gate). Since G5b an unattended agent may call them: the hub suspends it and
  the approval it files holds hashes, never the identifier (the bullet above). They are still two-person and never
  auto-run; `execution_status` stays `not_applicable` and the ledger is the record that a request ran.

#### Consented website-visitor profiles (M5-V3-h) — **STATUS: BUILT (PROTOTYPED; the DB suites need the Linux gate)**

Additive to the three routes above; nothing existing changes shape. Design `docs/plans/2026-10-12-m5-phase5-design.md`
§4.7 and §8 V3-h; addendum §9.1. Code: `core/agency-privacy.*`, `modules/search/visitor-erase.ts`; migration
`202610131900_agency_dsr_visitor_subjects.sql`.

- **Body.** `{ email?, phone?, visitorId?, consentId?, approvalId? }`. `visitorId` is the consented visitor id the
  site's privacy page shows the person; `consentId` is their consent log id. Each is a uuid (lower-cased); any one of
  the four keys is enough; a present but malformed one is `400 subject_invalid`. Content binding covers them: an
  approval filed for a visitor id does not run for another one, nor with a key added. Visitor keys never reach a
  lead's contact data (leads are found by email or phone only).
- **Who is in scope.** The profiles whose visitor id or consent id was given, the profiles under the consent id
  snapshotted on every lead that matched the email/phone DIRECTLY (`visitor_consent.consentId`), and, closed over
  shared ids, any profile sharing a visitor or consent id with one of those. Only this company's profiles.
- **find.** Adds `visitorProfiles:[{ profileId, propertyId, matchedBy:["visitor_id"|"consent_id"|"lead"|"linked"],
  firstSeenAt, lastSeenAt, visits, pageviews, eventCount }]` (no ids) and `counts.profileCount`,
  `counts.profileEventCount`.
- **export.** Adds `visitorProfiles:[{ …the find fields, propertyDomain, visitorId, consentId, device, country, city,
  firstSource, network, company, interests, score, scoreParts, createdAt, updatedAt, events:[{ occurredAt, kind, path,
  name, data }] }]`, every event, oldest first.
- **erase.** Deletes the profiles (their events cascade) under the visitor jobs' per-property lock, tombstones BOTH the
  visitor id and the consent id (`reason:'erase'`, SHA-256 only) on every property of the company, strips `consentId`
  from every lead snapshot that holds an erased consent id (the rest of the snapshot is kept as evidence), and sends
  the collector `forget mode:"erase"`. `counts` gains `profileCount, profileEventCount, tombstoneCount,
  collectorForget, collectorForgetCalls, collectorDeletedEvents`, and the response gains `collector` (the outcome in
  words). `collectorForget`: `delivered` | `queued` (the collector was unreachable or refused: the ERP side is erased
  and committed, the forget is retried by the visitor jobs; NOT confirmed) | `not_configured` | `id_not_held` (an id
  known only by its hash: blocked in the ERP, the collector is told when its buffered events next arrive) |
  `not_needed`. A replay returns the same stored counts and words.
- **New refusal.** `503 { reason:"visitor_store_busy" }`: a visitor job held a property lock for over a minute;
  nothing was read or changed and the approval is still unused, so the same call can be repeated.
- **Ledger.** `agency_dsr_requests` gains `visitor_id_hash`, `consent_id_hash` (hex SHA-256 of the lower-case uuid,
  i.e. the tombstone hash), the profile and tombstone counts and `collector_forget` (required on an executed erase).
- **Hub filing.** The minimiser also reduces `visitorId` / `consentId` to `subject.visitorIdHash` / `consentIdHash`
  (no hint), and `identifiers` may list `"visitor_id"`, `"consent_id"`. The MCP tools gain both optional inputs.

### Convert — what it spawns, and the one thing it must never do

One transaction: `clients` → `client_contacts` (`capability='signer'`, because a viewer-only contact
would leave the `prd_sign` gate open onto nobody who could ever sign it) → `projects` →
`pipeline_runs` → two `done` extraction stages whose `artifact_ref` is rendered from the prospect's
own answers → the open client `prd_sign` gate → `pm_tasks` for delegation → `emitEvent
pipeline.run.created`, which is what the shipped `pipeline-fanout` n8n workflow triggers on
(`automation/workflows/pipeline-fanout.json:11`, verified) to open `scope_signoff` and notify the PM.

**Event payload (M5-P1-g, a removal recorded on purpose).** Convert's `pipeline.run.created` carries exactly
`{ sourceMeetingId: null, actorId }`. It used to carry `title: <org_name>`, but for `/contact/` and `/audit/` web
leads `org_name` is the person's full name, and no personal data goes on the bus (design 2026-10-11, §10 risk 6).
`createRun` and the webdev mini-run still send `title` (a meeting or change-request title). The event's readers, all
checked: the `pipeline-fanout` n8n workflow reads only `tenantId` and `entityId` off the envelope and fetches the run
over the hub; the work-activity consumer used `title` and now looks it up from `pipeline_runs` when the payload has
none; the knowledge-graph bridge labels the node `name ?? title ?? label ?? entityId`, so a convert-born run is
labelled by its id there. Consumers must treat `title` as optional. No response shape changes.

**It never pre-seeds a signed gate.** The hard build gate requires PRD-signed AND scope-dual-signed,
and a converted run satisfies that the same way every run does — by real client signatures.
Pre-seeding would forge what a client signed.

### The agent path to Convert (corrected 2026-10-11)

`convert` is medium-impact, so an unattended agent call **suspends** at the hub and files an approval. An older
version of this section said the D14 resume path was broken estate-wide and that convert was therefore
human-driven only. That predates convert's executor entry: `core/approval-executables.ts` registers
`agency_intake.convert` (a lock key per lead and a precondition that the lead is still open), so when a human
approves the filed request the executor re-drives the call. D14's execution half is built estate-wide (see
`automation-approvals` above), and registered tools execute on approval.

What is NOT verified: an approve-then-executed round trip for this tool has not been driven against a running
hub, Cerbos and platform (**PROTOTYPED**; the suspension itself is proven in `mcp-hub/src/agency-intake-tools.test.ts`).
Until it is, treat an agent-initiated convert as "files an approval", and expect a human to be able to run the
same convert directly. A `deal` in the tool arguments rides along to the re-driven call, which is authorized
for `update` as well as `convert`.

## 25. Client Centre — CMC's layout/categorisation as native ERP pages (CC-D1…D7, 2026-09-29) — `src/modules/clients/centre/`, `src/core/portal-centre.controller.ts` — **STATUS: PROTOTYPED (backend only — typechecked + unit-tested; DB-backed proofs written, not yet run on the Linux gate)**

Design: `docs/plans/2026-09-29-client-centre.md` (decision log CC-D1..D7, data model, full API
contract). This section is the backend's record of the SHIPPED shape; the plan doc is the spec and
takes precedence if the two ever disagree.

> **Numbering note:** the plan asked for "§23"; that number was already taken (LMS module, added
> concurrently by another session — see §23/§24 above). This lands as §25, the next free number.

### The registry

`src/modules/clients/centre/registry.json` (mirrored byte-for-byte at
`platform-ui/src/lib/clientCentreRegistry.json`, parity-tested) is the single source for every
field/connection/department id this feature validates against — see the plan doc's own "The
registry" section for its shape. Nothing below hand-lists a field or department id; the validator
(`validation.ts`) derives every allow-list from this file at import time.

### Data model

`client_centre_profiles` (migration `202609281655_client_centre_profiles.sql`) — one row per
`(tenant_id, client_id)`. **Deliberately NOT `app_module_allowed('clients')`** — this table is
client-reachable (the portal routes below read/write it directly), and the `0072:214` / `0075:242`
/ `202609050857` doctrine is that a client-reachable table is never module-walled: a portal contact
must never lose access to their own company's profile because their agency's tenant happens not to
have the `clients` staff module enabled. **The staff routes ARE module-gated**
(`ModuleEnabledGuard("clients")`) — that gate is an app-layer concern orthogonal to the table's RLS
shape, exactly like the `clients` table itself. A missing row means an empty profile; the GET routes
synthesise registry defaults and the first accepted PATCH inserts the row.

### Endpoints

| Method + path | Authz | Notes |
|---|---|---|
| `GET /api/:t/clients/centre` | `client` read | Staff, `ModuleEnabledGuard("clients")`. Every non-deleted client: `[{clientId, clientName, clientStatus, businessType, city, fieldsFilled: {filled,total}, connectionsConnected: {connected,total}, updatedAt}]` — `fieldsFilled` is against the registry's fixed Company-settings field keys (23); `connectionsConnected`'s `total` is the union of every connection id reachable across all sections for that client's business type (varies by business type + custom connections) — both computed by `sections.ts`, a byte-for-byte port of platform-ui's own `allSections`/`connectionIdsFor` so the two surfaces cannot disagree about what "N of M" means. Registered as a STATIC route — verified by test that it is never captured by the `:clientId` route below. |
| `GET /api/:t/clients/:clientId/centre` | `client` read | Staff. Returns `CentreProfile`; `canEdit` = would `client` **update** be allowed (checked via `rbac/cerbos`'s non-throwing `check()`, not authorize+catch). |
| `PATCH /api/:t/clients/:clientId/centre` | `client` update | Staff. Returns the merged `CentreProfile`. |
| `GET /api/:t/portal/centre` | `portal` read + portal scope | Client. The caller's own client(s): `[{clientId, clientName, canEdit}]`. |
| `GET /api/:t/portal/centre/:clientId` | `portal` read + `clientId ∈ scope.clientIds` | Client. `CentreProfile`; a clientId outside scope is **404**, never 403 (no existence oracle — matches every other portal route). |
| `PATCH /api/:t/portal/centre/:clientId` | `portal` **`edit_company_profile`** + scope + CC-D4 | Client. Returns `CentreProfile`; on a real change, best-effort notifies the client's project owners (`client.centre_updated`, href `/client-centre/<clientId>`, which the UI redirects to `/clients/<clientId>/profile` since CC-D8). |

`CentreProfile` / `CentrePatch` are exactly the shapes in the plan doc's "API contract" section —
not repeated here to avoid the two copies drifting; that document is normative for the wire shape.

### CC-D4, enforced once, called from both routes

`canEditCentre(c, userId, clientId)` (`src/core/portal-centre.controller.ts`) is the ONE function
both the GET's `canEdit` and the PATCH's authorization gate call — an active, client-wide
(`project_id IS NULL`) `client_contacts` row with `capability = 'signer'` for that exact client, OR
the legacy `clients.portal_user_id` whole-client signer. A **project-scoped** signer reads fine
(`canEdit:false`) but is refused the PATCH with a plain-English 403. This is narrower than
`portal-scope.ts`'s own `canSign` (a per-caller union across every client/project the caller
touches) — CC-D4 asks the sharper per-CLIENT question, so it is its own query, never a reuse of
`canSign`.

### Validation (`src/modules/clients/centre/validation.ts`) — one function, both routes

`applyCentrePatch(current, patch)` is shared by the staff PATCH and the portal PATCH — the two
surfaces cannot validate differently. Rules exactly as specced: unknown top-level/profile/
connection/department/section keys are refused 400 naming the field; strings capped at 5,000
characters, the whole body at 256KB; `null`/`""` deletes a profile key or a connection sub-key (an
entry with every sub-key deleted is pruned, not persisted as `{}`); `null` on a whole connection or
a department key deletes it; `customConnections[section]` REPLACES that section's list (not
merged); custom connection ids match `/^x[a-z0-9]{4,40}$/`, names are 1..120 chars; `method`/
`status` must be one of the registry's own value lists; `businessType` must be a registry id.
**Credential-looking values are refused anywhere a string appears — including inside `connections.*
.creds` and `.notes`** (a PEM block, `AKIA…`, `sk-…`, `ghp_…`/`github_pat_…`, `xox[abp]-…`, a JWT, or
a `password=`/`pwd:` pair), per CMC-SEC-1 follow-up 3 — `creds` documents WHERE a credential lives,
never the credential itself, and the scanner does not trust the field name to enforce that.

Every ACCEPTED write (i.e. `changes.length > 0` after validation): increments `revision`, sets
`updated_by`/`updated_at`, writes exactly ONE `activities` row (`entity_type: "client"`,
`id = clientId`, `metadata: {via: "client-centre" | "portal", changes: [{path, before, after}]}`,
values truncated to 200 characters), and emits `client.centre_updated` in the **same transaction**
as the row write (transactional outbox). A PATCH that changes nothing (every key already had the
patched value) still returns 200 with the current profile and writes **no** activity and **no**
event — verified by DB test.

### IAM: the new `portal.edit_company_profile` action (CC-D4)

A full chain, not a YAML-only change — touched: `permission-catalog.json` (+1 grantable, 406 pairs/
391 grantable), `permission-groups.json` (+1 group `portal_edit_company_profile`, 151 groups),
`derived_roles.yaml` (`perm_portal_edit_company_profile`, company-scope-only — faithfully mirrors
`client`'s own reach, never the generic "global || company" shape every other perm-arm mirror uses,
matching the other 7 `perm_portal_*` mirrors' own precedent), `resource_portal.yaml` (added to the
`client` role-arm rule's action list + its own perm-arm rule), a migration
(`202609281704_iam_client_centre_edit_company_profile.sql`, mirroring `0106`'s `portal.approve_post`
idiom exactly — one permission row, one `(client, portal.edit_company_profile)` bundle row, nobody
else), and `role-permission-bundles.json` (regenerated — only `client` and `platform_admin`'s
wildcard changed; `owner`/`company_admin`/every other role holds zero `portal.*` keys, unchanged).
Every pinned test that names the portal action set was updated deliberately (`PORTAL_ACTIONS` in
`iam-04-b7-portal.{test,db.test}.ts` and `mon00i-portal-root-anchor.db.test.ts`; the wired-action pin
in `iam-04-b6-social-portal.test.ts`; the catalog headline counts in `cerbos-catalog-alignment.test.ts`,
`permission-groups-catalog-parity.test.ts` and `ui-grantable-catalog.test.ts`). `uiGrantable: false`,
matching every other `portal.*` key (no one can self-grant a portal permission through the UI role
editor). `permission-arm-hazard-scan.test.ts` and `scope-constrained-roles.json` needed no change
(the hazard-scan gate re-derives from disk every run and the scope-constrained map is keyed by
ROLE, not by action — `client`'s own condition is unchanged).

### Open items for the frontend lead

- `platform-ui`'s `rbac-capability-parity` test (if it enumerates portal permissions) may need
  `portal.edit_company_profile` added to its own mirror — **not edited here**; grep
  `platform-ui/src -l "portal.approve_post\|portal.update_profile"` to find every file that mirrors
  the portal action set.
- No staff nav change is part of this piece — the sidebar row, `/client-centre` pages and the portal
  `Company` tab are the frontend agent's own piece (§3 of the plan).


## 26. Client edit, owner, notes and history (CC-D10, 2026-09-29) — `src/modules/clients/clients.controller.ts`, `client-input.ts` — **STATUS: PROTOTYPED**

Design: `docs/plans/2026-09-29-client-centre.md` (CC-D10). Migration `202609290551_client_owner.sql`
adds `clients.owner_user_id`. Notes reuse the core `comments` table (`target_entity_type = 'client'`),
which no client/portal role can read (`resource_comment.yaml`). No new Cerbos kind or action: every
route below uses the existing `client` resource.

| Method + path | Authz | Notes |
|---|---|---|
| `GET /api/:t/clients` · `GET /api/:t/clients/:id` | `client` read | **Additive:** each row now carries `owner_user_id` and `owner_name` (both null when unassigned), and (PV3-04) `groupCompany: {id, name} \| null`. |
| `POST /api/:t/clients` | `client` create | Body `{name, businessType, status?, contact?, ownerUserId?, groupCompanyId?, customFields?}`. **Fix:** `status` is now stored (it was dropped, so every client was born `active`). **PV3-04: `businessType` is REQUIRED** (see "PV3-04" below); `groupCompanyId` is platform-operator only. |
| `PATCH /api/:t/clients/:id` | `client` update | **Behaviour change:** `contact` is a key-level MERGE: a string sets that key, `null`/`""` deletes it, an omitted key is untouched. It used to replace the whole object. `ownerUserId`: omitted = unchanged, `null` = clear, a user id must be ACTIVE STAFF of this tenant (400 otherwise; checked through the tenant-scoped connection, so another tenant's user is refused). `name` must not be blank; `status` must be a lowercase token. The activity row carries `{changes: [{field, before, after}]}`. **PV3-04:** also accepts `businessType` (omitted = unchanged; it can be changed, never cleared) and `groupCompanyId` (omitted = unchanged, `null` = clear; platform-operator only). |
| `GET /api/:t/clients/:id/notes` | `client` read | Newest first, max 200: `[{id, body, authorId, authorName, createdAt}]`. |
| `POST /api/:t/clients/:id/notes` | `client` update | Body `{body}` (1–5,000 chars, trimmed). Returns `{id}`. Writes activity `noted`. |
| `DELETE /api/:t/clients/:id/notes/:noteId` | own note: `client` update · anyone else's: `client` delete | Soft delete. Writes activity `note_deleted`. |
| `GET /api/:t/clients/:id/history?limit=` | `client` read | Activity rows targeting this client, newest first (default 50, max 200), `authz.*` excluded: `[{id, verb, metadata, occurredAt, actorId, actorName}]`. |

UI mirror: capabilities `client.write` (company_admin, manager, member, owner) and `client.delete`
(company_admin, manager, owner) in `platform-ui/src/lib/rbac.ts`, matching `resource_client.yaml`.

### PV3-04: a required business type and a group-company link (2026-10-11) — **STATUS: PROTOTYPED**

Tickets: `docs/plans/2026-10-11-pv3-hub-symmetry-tickets.md` PV3-04. Rulings: PV-D1 (business type), PV-D2
(a group company the agency serves is a client of the agency), PV-D13 (no company names or ids in code).
Migration `202610111322_clients_group_company.sql` adds `clients.group_company_id uuid NULL REFERENCES
companies(id)`, `CHECK (group_company_id IS DISTINCT FROM tenant_id)` and a partial index
`(tenant_id, group_company_id) WHERE group_company_id IS NOT NULL`. No backfill; no RLS or grant change.

**Business type** (`businessType`, one of `src/modules/clients/centre/registry.json` `businessTypes`: hotel,
restaurant, hospital, spa, agency, services, retail, ecommerce, saas, other):

| Call | Result |
|---|---|
| `POST` without `businessType` (or `""`/`null`) | `400 {error:"business_type_required", field:"businessType"}`; no client written |
| `POST` / `PATCH` with a value not in the registry | `400 {error:"business_type_invalid", field:"businessType"}` |
| `POST` with a valid type | `201 {id}`. The client AND its `client_centre_profiles` row (`business_type`, `revision 1`) are written in ONE transaction through the Client Centre store, so a new client is never "not set". The `client.created` event payload carries `businessType` |
| `PATCH` with a type that differs | `200 {id}`. Upserts the profile row in the same transaction, bumps its `revision`, emits `client.centre_updated` (`{changes:["businessType"]}`, the same event the centre PATCH emits) and the History entry carries `{field:"businessType", before, after}`. A client with no profile row ("not set") records `before: null` |
| `PATCH` with the same type | `200`; nothing written, no event, no History entry |

Order of checks, both routes: Cerbos `client` create/update first (403), then the group-company authority
(below), then shape validation, then the target company, then the transaction. Lead conversion
(`agency-lead-convert.service.ts`) is unchanged: leads carry no type, so converted clients read `other` and
land on the Clients list's review filter ("Business type: Other or not set"). The read side is unchanged
too: `GET /clients/centre` and `GET /clients/:id/centre` report `other` for a client with no row; the
centre read's `revision: 0` is how a caller tells "not set" from an explicit "other".

**Group company** (`groupCompanyId`; reads return `groupCompany: {id, name} | null`, `null` also when the
linked company has been deleted):

| Caller | Result |
|---|---|
| `platform_admin` (global), or the owner of the ROOT company (`isPlatformOperator`) | may set, change or clear it (`null`) |
| anyone else (member, manager, `company_admin`, the owner of a child company) sending the key at all, even `null` | `403 "linking a client to a group company needs a platform operator"`, checked BEFORE the target is validated, so the answer never reveals whether a company exists; the row is unchanged |
| operator, value is not a uuid | `400 group_company_invalid` |
| operator, the client's own company | `400 group_company_self` (the table CHECK is the backstop) |
| operator, no such company or a soft-deleted one | `400 group_company_not_found` |
| operator, a live company of ANOTHER root | `400 group_company_other_root` |
| operator, a live company under the same root as the client's tenant | accepted; History records `{field:"groupCompany", before, after}` (company NAMES, not ids) |

`companies` is global with no RLS, so the same-root rule is enforced in the application
(`modules/clients/group-company.ts`, through `withGlobal`, the `resolveGithubOrgTenant` precedent), not by
the FK. PV3-Q1 (who may link) is open for the owner; the default above is the lead's, and widening it is one
condition in `assertMayTouchGroupCompany`.

**MCP** (`mcp-hub/src/platform-write-tools.ts`): `clients.create` requires `businessType` (enum of the
registry ids) and accepts `groupCompanyId`; `clients.update` accepts both (`groupCompanyId: null` clears).
A platform 400 now surfaces its typed code in the tool error (`platform /api/.../clients 400: business_type_required`).

**UI**: New client has a required Business type select (no default); Edit preselects the current type, or
nothing for a client with no profile row (centre `revision` 0) and will not submit until one is chosen
("Other" is a valid explicit choice). The Group company select is shown only to a platform operator. The
hub header and the Clients list show the group company. The Clients list has a "Business type: Other or
not set" filter (`?review=business-type`) over the centre list it already loads; if that read fails, or
comes back empty for a company that has clients, the page says so and withholds the filter.

## 27. WebDesk content BFF — the "Website" editor's backend (WSK-59, 2026-10-10) — `src/modules/webdev/webdesk-content.{controller,service}.ts`, `platform-ui/src/lib/webdeskContent.ts` (WSK-44) — **STATUS: BACKEND DEV-VERIFIED (Linux, see the ticket report); UI: WSK-44 builds against this section; UI RE-VERIFIED against the real controller by WSK-44b (see "Re-verified" below)**

**§27 claimed at write time** (`grep -n "^## 27"` found nothing; §26 was the last). Design:
`docs/plans/2026-10-10-webdesk-write-plane-design.md` §12 WSK-59 (routes, tools, done-when), §3.2 and §4 (the
shapes Zone B returns, which this BFF passes through), §6 (publish), §10 (the states the UI renders). Rulings:
`docs/blueprints/webdesk-design-v2.md` §14 WSK-D45/D46/D47. Every route is under
`/api/:tenantId/modules/webdev/content/` and 404s unless the company has `webdev` enabled.

**The BFF adds no data of its own.** It authorizes the caller, proves the site belongs to the caller's company,
signs an editorial assertion as the caller, forwards to WebDesk over the control channel, and passes the answer
back. Response bodies are WebDesk's own (`webdesk/api/src/control/content/*`), so the shapes below are the real
ones, not a restatement. The caller is identified by the BFF's normal auth (session / OBO); the **editorial
assertion's `sub` is the same ERP user id**, which is what WebDesk stores as `created_by`.

### Routes (all `AuthGuard` + `ModuleEnabledGuard("webdev")`; the first statement of every handler is Cerbos, phase 1 of the two-phase gate since M5-W1c: see "The two-phase gate" below. The "Cerbos (as the caller)" column names the REAL action, which is phase 2)

`:ts` = `:tenantSlug` (the WebDesk tenant slug), `:site` = `:siteId` (uuid). Both come from `GET …/content/sites`.

| Method | Path (after `/api/:tenantId/modules/webdev/content`) | Cerbos (as the caller) | Success |
|---|---|---|---|
| GET | `/sites` | `webdesk_collection:read` (M5-W1c: asked **per site** for a writers' room grant, see below) | 200 `{tenants:[{slug,status,defaultLocale,locales,sites:[{siteId,name,kind,environments:[{envId,name,domain,status}]}]}]}`: only THIS company's tenants, and for a writers' room grant only the sites Cerbos lets it read (a tenant with none left is dropped; none readable is 403, never `[]`). Staff tiers: unchanged, the whole list |
| GET | `/sites/:ts/:site/collections` | `webdesk_collection:read` | 200 `{collections:[{key,composition,vocabularyVersion,counts:{items,byLocale,live,pendingChanges},updatedAt}]}` |
| GET | `/sites/:ts/:site/collections/:collectionKey/items?locale&state&q&includeDeleted&cursor&limit&slug` | `webdesk_content_item:read` | 200 `{items:[ItemSummary],page:{cursor,hasMore,limit}}`, editor order (slug, locale, id). `state` = draft·live·scheduled·unpublished·deleted·pending; `limit` 1..100. **`slug=` (BFF-side)** returns only the EXACT-slug matches (all locales, or the one `locale` asks for): WebDesk has no slug filter, so the BFF asks for `q=<slug>` at limit 100 and keeps the exact matches, following the cursor up to 5 pages; `page.hasMore:true` with no match means *not found yet*, never *does not exist*. Not combinable with `q` |
| GET | `/sites/:ts/:site/items/:itemId[?version=head\|live\|<n>]` | `webdesk_content_item:read` | 200 `{item,version:{n,version,contentHash,createdAt,createdBy,attribution,note,blocks,seo},live,group,lint,editorial?,allowed?}`. **`allowed`** (M5-W1c, BUILT): `{read,update,submit,comment,request_changes,seo_signoff,approve,assign,request_publish,unpublish,delete: boolean}`, what THIS caller may do with THIS item, from ONE Cerbos batch on the resource the real handlers ask with (see "The two-phase gate"). Advisory: every action is checked again. **Absent (never `false`) when Cerbos could not answer or the call is delegated (`actFor`)**, and never sent on the client portal route |
| GET | `/sites/:ts/:site/items/:itemId/versions?cursor&limit` | `webdesk_content_item:read` | 200 `{versions:[{version,contentHash,createdAt,createdBy,attribution,note}],page}`, newest first |
| GET | `/sites/:ts/:site/items/:itemId/versions/:n` | `webdesk_content_item:read` | 200 one full version (`blocks`, `seo`, …) |
| GET | `/sites/:ts/:site/media?mime&q&tag&includeDeleted&cursor&limit` | `webdesk_media_asset:read` (**WSK-43b**: was `webdesk_content_item:read`; same tiers, see "The media library") | 200 `{assets:[MediaAsset],page:{cursor,hasMore,limit},capabilities?:{read,upload,update,delete}}`, newest first. **`capabilities`** (WSK-359): what the caller may do here, from ONE Cerbos `checkResources` request (one resource, the four actions); advisory, so the UI disables the matching control up front, and the per-action check stays the authority (a 403 is still handled). Absent when Cerbos could not answer the batch (unknown, never "denied": every control stays on). |
| GET | `/sites/:ts/:site/media/:assetId/usage` (**WSK-43b**, BUILT) | `webdesk_media_asset:read` | 200 `{assetId,url,total,items:[{itemId,collectionKey,locale,slug,in}]}` (at most 50 items) |
| POST | `/sites/:ts/:site/media/upload-token` (**WSK-43b**, BUILT) | `webdesk_media_asset:upload` | **201** `{uploadUrl,expiresAt,maxBytes,allowedMimes}`; `Cache-Control: no-store` |
| PATCH | `/sites/:ts/:site/media/:assetId` (**WSK-43b**, BUILT) | `webdesk_media_asset:update` | 200 `{asset}` |
| DELETE | `/sites/:ts/:site/media/:assetId` (**WSK-43b**, BUILT) | `webdesk_media_asset:delete` | 200 `{assetId,deletedAt,purgeAfter,alreadyDeleted}`, or **409 `media-in-use`** (below) |
| POST | `/sites/:ts/:site/collections/:collectionKey/items` | `…:create` | **201** `ItemWriteResult` |
| PUT (and `PATCH`, the MCP hub's alias) | `/sites/:ts/:site/items/:itemId` | `…:update` | 200 `ItemWriteResult` |
| POST | `/sites/:ts/:site/items/:itemId/restore` | `…:update` | 200 `ItemWriteResult` |
| POST | `/sites/:ts/:site/publish-requests` | `…:request_publish` | **202** `{approvalId,command,itemCount}`; **409 `review-not-approved`** (M5-W2c, BUILT) when an item's collection requires editorial review and the requested version is not the approved one: nothing is filed |
| GET | `/sites/:ts/:site/publish-requests?status=pending` (WSK-44b) | `…:request_publish` (the right that filed it) | 200 `{requests:[{approvalId, status, createdAt, itemIds:[…], items:[{itemId,version}], executionStatus\|null}]}`: the CALLER'S OWN `origin='webdesk'` publish/schedule approvals for THIS site, newest first, at most 100. `status` = `pending` (default) · `approved` · `rejected` · `cancelled` · `all`; anything else is 400 `invalid_request`, as is any other query key. `items` carries the requested version per item (what the editor shows after a reload). `executionStatus` is the approval's `execution_status` (`not_applicable` while pending or withdrawn, then `pending`·`executing`·`executed`·`failed`). Behind the same cross-company wall (`resolveEditableSite`): a foreign site is the uniform 404 `site-not-found`. Only `requested_by = caller` rows are ever returned, so it reveals no other user's request |
| POST | `/sites/:ts/:site/publish-requests/:approvalId/withdraw` | `…:request_publish` (the right that filed it) | 200 `{approvalId, status:"cancelled"}` |
| POST | `/sites/:ts/:site/items/:itemId/unpublish` | `…:unpublish` | 200 `{item,replayed}` |
| POST | `/sites/:ts/:site/items/:itemId/delete` | `…:delete` | 200 `{item,replayed}` |
| POST | `/sites/:ts/:site/items/:itemId/preview` (WSK-46, 2026-10-11) | **`…:update`** (a preview link discloses a draft, so it is gated as the right to change it; no new Cerbos action or kind) | 200 `{previewUrl, expiresAt, version}`. See "Draft preview" below |

`ItemWriteResult` = `{item:ItemState, version:{version,contentHash,createdAt}, unchanged, lint, replayed}`
(`ItemState` = `{itemId,collectionKey,locale,slug,localizationGroupId,headVersion,publishedVersion,publishState,publishAt,unpublishAt,deletedAt,updatedAt}`).
`ItemSummary` = `{itemId,slug,locale,localizationGroupId,title,headVersion,publishedVersion,publishState,publishAt,unpublishAt,deletedAt,updatedAt,headCreatedAt,headCreatedBy,pendingChanges}`.

**Request bodies** (strict: an unknown key is 400 `invalid_request`):

| Route | Body |
|---|---|
| create | `{locale, slug, twinOf?, fields?, blocks?, seo?, note?}`. `collectionKey` comes from the PATH; a `collectionKey` in the body is accepted only if it equals the path's |
| update | `{baseVersion, fields?, blocks?, seo?, note?}` (full replacement) |
| restore | `{version, baseVersion, note?}` |
| publish-requests | `{items:[{itemId,version}] (1..1000), note?}` **or** `{items, publishAt?, unpublishAt?}` for a scheduled publish/takedown (no note) |
| unpublish | `{expectedPublishedVersion}` |
| delete | `{baseVersion}` (a non-live item only) |
| preview | `{version?}` (an integer >= 1; omitted = the item's head). An absent body is `{}`. Nothing else is accepted (the token lifetime is WebDesk's default, one hour) |

Writes accept an optional `Idempotency-Key` header (8..200 printable ASCII); without one the BFF generates a fresh
uuid. **A retry of the same logical write must resend the SAME key**: WebDesk then answers `replayed:true` instead of
writing twice. Route params `tenantSlug`/`siteId`/`itemId` never appear in a body.

### Draft preview (WSK-46, owner ruling WSK-D52, 2026-10-11)

`POST …/items/:itemId/preview` `{version?}` -> `200 {previewUrl, expiresAt, version}`. An **instant preview page on the site itself**: WebDesk mints a
short-lived token for ONE version of ONE item (`POST /control/v1/tenants/:ts/sites/:site/content/items/:itemId/preview-token`, command
`content.previewToken`, MEDIUM, editorial assertion + Idempotency-Key, like the other writes), and the site's own `/preview/` page reads it and fetches the draft from
WebDesk's public `GET /v1/t/:tenant/preview/:token`. No preview build.

* **`previewUrl` = `<the site's staging base>/preview/#t=<token>`. The token is in the URL FRAGMENT, never a query string**: a browser never sends a fragment to any
  server and never puts it in a Referer. The staging base is `https://<domain>` of the site's `environments[]` entry named `staging` that has a domain (case-insensitive,
  the first such), from `GET …/content/sites`: **the same source as the editor's "View on staging" link, not a second configuration.** The domain must be a bare public
  hostname (no scheme, port, path, userinfo, IP literal or `localhost`), else it counts as not configured, because the server makes a request to it.
* **The token is a one-time secret.** It is in WebDesk's response and in the returned `previewUrl`'s fragment, and nowhere else: not the `activities` rows, not a log line,
  not an error body. WebDesk never stores it (it keeps a hash), so a replay of the same `Idempotency-Key` is WebDesk's typed `409 idempotency-response-withheld`; mint again
  under a NEW key (the editor always does). `expiresAt` is ISO; the link works until then (default one hour) or until revoked.
* **Honest states: never a dead link, and each of these mints NOTHING.** The checks run before the mint, and before the item read:
  * the site has no usable staging address: **`409 {error:"Preview isn't set up for this site yet", reason:"preview_not_configured"}`**;
  * the site has no `/preview/` page yet: the server asks `HEAD <staging>/preview/` (redirects not followed, 5 s timeout, no credential), cached **5 minutes** per origin
    for a DEFINITE answer only; a **404 or 410** is **`409 {error:"This site doesn't have a preview page yet", reason:"preview_page_missing"}`**. Any other 4xx (401/403/405) is
    not a 404, so the page is assumed present; 2xx and 3xx are present. **Today gaiada.com's staging site has no `/preview/` page, so this is the correct live answer until the
    site owner builds it** (and it can take up to 5 minutes after they do for the cached "missing" to expire);
  * the site did not answer (a 5xx, a timeout, no connection): **`502 {error:"The site didn't answer, so a preview link can't be made right now", reason:"preview_site_unreachable"}`**, not cached.
* **WebDesk refusals map exactly as the other writes do:** 404 `item-not-found` / `version-not-found` and 409 `item-deleted` (also checked before the mint from the item read) pass through as
  `application/problem+json`; 503 `editorial_unavailable` / `webdesk_not_configured`; 502 `webdesk_ambiguous` (a mint that may have landed is not reconciled: there is nothing to read back,
  so the caller simply mints again); 502 `webdesk_refused` / `webdesk_error` (`preview_shape` when WebDesk's 2xx lacked a token); the cross-company 404 `site-not-found`.
* **Ledger:** two `activities` rows, verb `webdesk.content.previewToken` (`attempted` then `succeeded`|`refused`|`failed`|`ambiguous`), identifiers only (`tenantSlug`, `siteId`, `itemId`,
  `collectionKey`, `locale`, `requestedVersion`), never the token. Nothing is written when a site check above refuses (nothing was attempted).
* **UI:** `platform-ui/src/components/webdesk/content/PreviewCard.tsx` (a "Preview" card in the item editor's side panel, beside "View on staging"), through the server action
  `previewItemAction` in `lib/webdeskContentActions.ts` and the STRICT parser `parsePreviewLink` in `lib/webdeskContent.ts` (the answer is opened in a new tab, so anything but an https link to a
  `/preview/` page with the token in `#t=` and no query string is `contract_drift` and nothing is opened). The button opens `previewUrl` with `window.open(…, "_blank", "noopener,noreferrer")`, shows
  "Link valid until …", and keeps an "Open the preview again" anchor (a blocked pop-up cannot be detected with `noopener`). It is disabled exactly when Save is (read-only, stale, unconfirmed), and
  says when it shows the last saved version rather than unsaved edits. The two 409s are plain-words notices; the rest say what to do. A preview is not a write: a failure never flips the editor to stale.

### Publish is a request, never an action (WSK-D46)

`publish-requests` reads each requested item version from WebDesk (it must exist on this site and not be deleted:
typed 404 `item-not-found`/`version-not-found`, 409 `item-deleted`), authorizes `request_publish` with the item's REAL
`collectionKey`/`locale` (from WebDesk, never the body), then files **exactly one** HIGH WS4 approval through
`fileWebdeskCommandApproval` (origin `webdesk`, workflow `content.publish`, or `content.schedule` when `publishAt`/
`unpublishAt` is given) and returns **202 `{approvalId}`**. It **never calls WebDesk's publish**. Execution happens at
`decide()` in the Approvals inbox, as the decider (maker ≠ checker; a publisher may approve their own single-item,
non-scheduled publish, R4); see §9 row `automation-approvals` (WSK-66). The UI shows "Awaiting approval #…" and polls the approval.

**The editorial review gate (M5-W2c, BUILT; writers' room design `docs/plans/2026-10-11-m5-writers-room-design.md` 4.5).**
On a collection where review is ON, WebDesk publishes only the EXACT approved version (`editorial.approvedVersion` on
`item.get`), checked inside `content.publish` / `content.schedule` after the WS4 claim and D62's client check, and again
by the scheduler before a queued version swap; a refusal is **409 `review-not-approved`** for the whole batch, the claim
rolls back, and the approval row ends `failed` with `webdesk_refused: 409 review-not-approved`. `publish-requests` refuses
EARLY with the same problem, after authorization and before anything is filed:
`{type:"…/errors/review-not-approved", title, status:409, detail, items:[{itemIndex,itemId,version,approvedVersion|null}], total}`.
A takedown-only schedule (`unpublishAt` without `publishAt`) is not gated, and review OFF (the default) changes nothing.
The early check is advisory (the review state can move before `decide()`, and the M1 importer files without it); WebDesk's
gate is the authority. The approvals detail page (`WebdeskPublishSummary`) shows per item whether the requested version is the
approved one and warns before the approver decides; an `item.get` without the `editorial` member reads as "unknown".

**The two-phase gate (M5-W1c, 2026-10-12 — STATUS: PROTOTYPED (backend): typechecked, and the service-free suite `webdesk-content-two-phase.unit.test.ts` run locally; the real-Cerbos HTTP suite `webdesk-content-two-phase.test.ts` is written and needs the Linux gate; UI: M5-W2e).**
Design `docs/plans/2026-10-11-m5-writers-room-design.md` §2.3; attribute provenance: PERMISSION-CONTRACT §27.2. Every content and media route above:
- **Phase 1, the handler's first statement:** Cerbos `webdesk_collection:read` on `{tenantId, module:"webdev", siteId}` (the route's `:siteId`). A caller no rule matches is 403 here, with no WebDesk call at all. A principal that holds no writers' room grant (and is not delegating) is ALSO asked the old attribute-free question for the real action, so a denied staff caller is refused exactly as before, before any egress. `GET sites` has no site: staff get the old company-level question; a writers' room grant is filtered site by site (`check`, no denial rows for the sites it may not read).
- **Phase 2, before ANY body or query validation:** the real action, with `siteId` (the route's, after the cross-company wall), and `collectionKey`, `locale`, `ownerId` (WebDesk's `editorial.authorSub`), `reviewState` (`editorial.state`), `published` (`publishedVersion !== null`) from WebDesk's `item.get`. `create`: the route's collection (proven by `collection.get`), the body's `locale`, and for a locale twin the SOURCE item's state and `published`. A body or query that names any of these is a 400 AFTER the check and changes nothing the check saw. A denied caller is 403 for any body, and WebDesk receives no write. **A WebDesk that sends no `editorial` member reads as ownerId `""`, reviewState `""`: the writers' room rules fail closed, the staff tiers are unaffected.**
- Read order changes you may see: `item.get` is read once for the head (the attribute source) and a second time, after the check, only when `?version=` is given; the preview route reads the item before it probes the site (a denied caller triggers no probe); `publish-requests` reads the items its body names before it validates the body.
- A scoped `webdesk_editor` files publish requests (the filer re-checks `request_publish` on the same attribute-carrying resources, `itemResources`), and lists/withdraws its OWN requests under phase 1 plus the own-rows filter; no policy change.

| Route group | Phase 1 | Phase 2 |
|---|---|---|
| `GET sites` | company-level `webdesk_collection:read`, or per site for a writers' room grant | — |
| `GET …/collections` | `webdesk_collection:read`+siteId | the same question (phase 1 IS the action) |
| `GET …/collections/:key/items` | `webdesk_collection:read`+siteId | `webdesk_content_item:read`+siteId+route `collectionKey` |
| `GET …/items/:id`, `/versions`, `/versions/:n` | same | `webdesk_content_item:read` with the item's attributes (`item.get`); `item.get` also asks one `CheckResources` for `allowed` |
| `GET …/media`, `/media/:a/usage`; `POST …/media/upload-token`; `PATCH`, `DELETE …/media/:a` | same | `webdesk_media_asset:read`/`upload`/`update`/`delete`+siteId |
| `POST …/collections/:key/items` | same | `webdesk_content_item:create`+siteId+route key+body locale (+ twin source state) |
| `PUT`/`PATCH …/items/:id`, `POST …/restore`, `POST …/preview` | same | `webdesk_content_item:update` with the item's attributes |
| `POST …/publish-requests` | same | `request_publish` per distinct (collection, locale, author, state, live) tuple of the items the body names; a malformed body is asked at site level |
| `GET …/publish-requests`, `POST …/publish-requests/:a/withdraw` | same | none beyond phase 1 (and, for staff tiers, the old `request_publish` question); own rows only |
| `POST …/unpublish`, `POST …/delete` | same | `webdesk_content_item:unpublish`/`delete` with the item's attributes |

### Withdrawing a request, and the approvals façade

`…/publish-requests/:approvalId/withdraw` lets the REQUESTER cancel their own PENDING publish/schedule approval. The row becomes
`status:"cancelled"` (the loan-withdraw precedent: nobody with authority refused it; `rejected` would say they did), `execution_status`
stays `not_applicable`, and one `activities` row (`cancelled`, `outcome:"withdrawn_by_requester"`) is written. Nothing is sent to
WebDesk. Another user's row is **403**, an id that is not a publish request for THIS site (unknown, another site, another origin) is
**404 `approval_not_found`**, and a row no longer pending is **409 `approval_not_pending`**. **The UI's approval-status parser must
accept `cancelled`** (the CHECK admits `pending|approved|rejected|cancelled`); since WSK-44b it does, and renders it as "Withdrawn".

`POST /api/:t/approvals/:id/decide` (the unified façade) now accepts `origin:"webdesk"`, and `GET /api/approvals` lists webdesk rows. For a
webdesk row the response is `{ok:true, webdesk:{command, executionStatus:"executed"|"failed", error?, …}}` (WSK-66's in-band outcome;
every other origin is byte-unchanged `{ok:true}`). The editor used to read its "pending request after reload"
from `GET /api/:t/automation-approvals?origin=webdesk&status=pending`, which needs `automation_approval:read` (company_admin/manager): a
`webdev_staff`/`webdev_manager` caller got **403**. WSK-44b added `GET …/publish-requests` (above) for exactly that, and the editor now uses it.
**Still true, and pinned by a test, not widened:** `GET /api/:t/automation-approvals/:id` (the DETAIL, which `/approvals/[id]` and the
editor's poll read) has no requester carve-out either, so a `webdev_staff` requester gets 403 on the detail of their own approval. The editor's
poll therefore falls back to `…/publish-requests?status=all` on a 403 (it still learns approved/rejected/cancelled and the execution status, but
not the decider's name or the failure reason); the `/approvals/[id]` page itself still refuses that requester. Giving requesters read of their own
rows is a Cerbos change (`resource_automation_approval.yaml`), which is the architect's call.

### Re-verified against the real controller (WSK-44b, 2026-10-10)

`platform-nest/src/modules/webdev/webdesk-content-ui-contract.test.ts` drives the Website editor's own code (`platform-ui/src/lib/webdeskContent.ts`
readers, `webdeskContentActions.ts` server actions, the real `platformFetch`) over a real socket against the real controller, Postgres, Cerbos and the
strict Zone B fake, and pipes every real body through the UI's `parse*` validators and `problemOf`. It found four drifts, all fixed in the UI:

| Real body | What WebDesk/the BFF sends | What the UI assumed | Fix |
|---|---|---|---|
| approval `status` after Withdraw | `cancelled` | `pending\|approved\|rejected` only: `contract_drift` | accepted; phase `withdrawn`, shown as "Withdrawn" |
| `ItemSummary.headCreatedAt` | `null` for a pre-0009 row (no version row) | non-null string: `contract_drift` | nullable; rendered as "—" |
| `environments[].domain` (`GET …/sites`) | `null` while an environment has no hostname | non-null string: `contract_drift` on the WHOLE sites list | nullable; a null-domain environment never becomes `https://null` |
| 404 `version-not-found` | typed problem (`?version=live` on a draft, an unknown `n`) | read as `not_enabled/not_served` ("not available on this deployment yet") | `not_found` |

`GET …/sites/:ts/:site/build-status` and `POST …/sites/:ts/:site/rebuild-requests` are WSK-60's (built 2026-10-10; see the automation-approvals row above):
build-status answers `{build, stagingStale}`, and a rebuild request answers `202 {approvalId}`, or `503 {reason:"webdesk_not_configured"}` when the site has no
staging rebuild target. On a deployment without those routes the BFF answers a plain Nest 404, which the UI still maps to `not_enabled/not_served`
("rebuild status isn't available on this deployment yet"), never to a fabricated build.
The UI reads nothing from `GET …/media` (it has no media reader; the Media tab is WSK-43c); its pre-WSK-43b shape is asserted in the same test. A `502 webdesk_ambiguous` reaches the UI as
`unavailable/upstream_error` with the machine reason (`not_observed` / `reconcile_failed`) kept. Since 2026-10-11 the editor renders it as its own UNCONFIRMED
state (`webdeskContentModel.ts#isOutcomeUnknown`): "We couldn't confirm the save. Reload to see what happened." (per action: the save, the new item, the
delete, the unpublish, the restore, the publish request, the withdrawal, the rebuild request, the `<locale>` twin), never "saved" and never "failed"; edits
are kept and writes stay off until a successful re-read. `item.get`'s `lint.unavailable` (a reason string: the lint could not RUN) is carried as
`Lint.unavailable`, and the editor and the approval summary then say "couldn't check" instead of the all-clear. A rebuild request refused with
`503 {reason:"webdesk_not_configured"}` reads "Staging rebuild isn't set up for this site." The parsed result shapes are unchanged (rendering decisions).

### The media library (WSK-43b, 2026-10-11 — BACKEND BUILT; UI: WSK-43c)

Design: `docs/plans/2026-10-11-webdesk-m3-plan.md` "WSK-43 · The media library"; rulings WSK-D53 (a library image reaches a static site through its build)
and WSK-D54 (an image still used by content cannot be deleted), `docs/blueprints/webdesk-design-v2.md` §14. The routes proxy WebDesk's WSK-43a control
commands `media.list` · `media.usage` · `media.uploadToken` · `media.update` · `media.delete` (`webdesk/api/README.md` "Media library (WSK-43a)"). Code:
`webdesk-media.service.ts` (the use cases) and the routes in `webdesk-content.controller.ts`. Same wall, same typed errors, same two-row ledger as the content
writes. The three writes are MEDIUM: they carry the editorial assertion (signed as the caller) and an `Idempotency-Key` (optional on the BFF; generated when
absent). Replace-all semantics on `update`: `alt` is the COMPLETE locale -> text map (`{}` clears), `tags` the COMPLETE list (`[]` clears), `title` a string or `null`.

**Capabilities (WSK-359).** `GET …/media` also answers `capabilities: {read, upload, update, delete}` (booleans) for the caller on that site: one Cerbos `checkResources` request carrying the exact resource the handlers
authorize with (`{kind: webdesk_media_asset, tenantId, module: "webdev"}` + `clientId` in client mode), with `request.principal` from the same `principalPayload`. Per tier today: an editor (`webdev_staff`) or a company-scope `manager` → read/upload/update true, delete false; a publisher
(`webdev_manager`) or `company_admin` → all four; a role holding none of them gets no list at all (403). The test `webdesk-media.test.ts` pins every boolean to the per-action `check()` for each tier, so the batch cannot drift from the handlers. The UI (`MediaLibrary`,
and through it `MediaDetail` and the picker) turns a control off from it on first paint with the reason ("You can't upload images here."), and a later 403 still turns it off as before.

`MediaAsset` (WebDesk's own row, passed through): `{assetId,bucketKey,mime,sizeBytes,scanStatus,createdAt,title,alt,tags,originalFilename,width,height,createdBy,url,updatedAt,deletedAt}`.
`url` is the canonical `/v1/t/<tenant>/media/<assetId>`: what the editor writes into a media field and what the in-use scan looks for.

**Request bodies** (strict: an unknown key is 400 `invalid_request`, after authorization):

| Route | Body |
|---|---|
| upload-token | `{bucket: "media"\|"video", maxBytes?, mime?}` (`mime` a type or an array, a subset of the bucket's allowlist; `maxBytes` defaults to and is capped by the platform maximum). WebDesk validates; its typed 400 passes through |
| update | `{title?, alt?, tags?}`, at least one |
| delete | none (a DELETE sends no body; the MCP hub's `{}` is accepted) |

**`POST …/media/upload-token` and where the bytes go.** The answer is exactly `{uploadUrl, expiresAt, maxBytes, allowedMimes}`. `uploadUrl` is the **public WebDesk URL**
`<WEBDESK_PUBLIC_BASE_URL>/v1/t/<tenantSlug>/media/upload/<token>`: the browser `POST`s the raw file to it with `Content-Type` set to the file's type, and **the bytes never
pass through the ERP**. The URL carries a **one-time secret** (valid about ten minutes, single use, bound to this site, bucket, size cap and types): never log it, store it
or put it in a link. The BFF drops everything else WebDesk answers (`token`, `tokenId`, `bucket`) and writes the token to no ledger row, approval row, outbox row, log line
or error. A replay of one `Idempotency-Key` is WebDesk's **409 `idempotency-response-withheld`** (mint again under a new key). The browser upload is allowed only from the origins
in WebDesk's `WEBDESK_UPLOAD_CORS_ORIGINS`: the ERP origin must be listed there.
**New config: `WEBDESK_PUBLIC_BASE_URL`** (platform-nest, `config.webdeskPublic.baseUrl`): the PUBLIC origin of the WebDesk api (the host that serves `/v1`, e.g. the site build's
`WEBDESK_API_URL`), not the internal mTLS control vhost. No default: unset (or not `https://`, or carrying credentials, a query or a fragment) the route answers **503
`{error:"webdesk_not_configured", reason:"webdesk_public_url_not_configured"|"webdesk_public_url_invalid"}` before anything is minted**. It must be passed through the api's
`environment:` block in compose (`${WEBDESK_PUBLIC_BASE_URL:-}`); a value only in `.env` never reaches the container.

**`DELETE …/media/:assetId` and `media-in-use` (WSK-D54).** A soft delete: the asset leaves the library and its stored object is purged after its retention. While any live or
draft item (or a pending scheduled swap) names the asset, WebDesk refuses with **409 `application/problem+json`**, which the BFF passes through untouched so the UI can show where the asset is used:

```json
{ "type": "https://webdesk.gaiada.online/errors/media-in-use", "title": "…", "status": 409, "detail": "…", "total": 2,
  "items": [{ "itemId": "…", "collectionKey": "service", "locale": "en", "slug": "service.seo", "in": "live" }] }
```

(`items` lists at most 50; `total` is the full count.) `GET …/media/:assetId/usage` returns the same list on demand. Deleting an already-deleted asset is a no-op answered with the
original instants (`alreadyDeleted: true`). Other typed problems: 404 `media-asset-not-found` (unknown, malformed, or another site's or company's asset: one answer), 409 `media-asset-deleted`
(an update of a deleted asset), 400 `invalid-request`. A write whose link died after it was sent is the 502 `webdesk_ambiguous`; **retry with the SAME `Idempotency-Key`** (WebDesk replays
by key). No reconcile read is attempted for the media writes.

**Cerbos kind `webdesk_media_asset`** (`resource_webdesk_media_asset.yaml`), module `webdev`, authorized as the caller with only the tenant and the module (no per-asset attribute, no approval).
`read` (list, usage), `upload` (mint a token), `update`, `delete`. Editor tier (`webdev_staff`, `manager`, `webdev_manager`, `company_admin`): read/upload/update. Publisher tier (`webdev_manager`,
`company_admin`): also delete. `platform_admin` all four. `member`, `client` and `group_executive` nothing. Every role that can upload can also list. Permission keys
`webdev.webdesk_media_asset.{read,upload,update,delete}`; authoring group `webdesk_media_library`.

**Ledger.** Verbs `webdesk.media.uploadToken` · `webdesk.media.update` · `webdesk.media.delete`, `target_entity_type` `webdesk_media_asset` (`target_entity_id` = the asset id for update and delete),
metadata `{outcome: attempted → succeeded|refused|failed|ambiguous, status, problem?, tenantSlug, siteId, assetId?, bucket?, maxBytes?, fields?, idempotencyKey}`: the CHANGED FIELD NAMES, never a title or alt text; never the token.

**MCP tools** (`modules/webdev/index.ts`; each calls the same BFF route as the table above): `webdesk.media.list` · `webdesk.media.usage` (reads, free); `webdesk.media.uploadToken` ·
`webdesk.media.update` · `webdesk.media.delete` (`write:true, impact:"medium"`: an unattended caller suspends for approval, an attended human does not). `update` and `delete` are D14
executables (`core/approval-executables.ts` + `resource_mcp_tool.yaml`, both) and re-drive as the original requester. **`uploadToken` is deliberately NOT a D14 executable**: its result is a
one-time upload URL, and a re-drive would store it in `automation_approvals.execution_result`; so an unattended agent or n8n call suspends and never receives a token, and only an attended
human is handed one. Hub limitation (as for the content tools): a GET tool passes only path args, so `webdesk.media.list` returns the default first page with no filter, and a WebDesk
problem reaches an agent as the hub's generic `platform … <status>` error: an agent should call `webdesk.media.usage` before a delete to see where an asset is used. The older
`webdesk.content.listMedia` tool still exists on the same route; `webdesk.media.list` supersedes it.

### Errors the UI must render (each a distinct state, §10 of the design)

| Status + body | Meaning | UI state |
|---|---|---|
| **503 `{error:"editorial_unavailable", reason}`** | The control channel's circuit breaker is open (`reason:"circuit_open"`), WebDesk is unreachable (`webdesk_unreachable`) or the token endpoint failed (`webdesk_token_unavailable`). **On reads AND writes.** | Full-page "Editing is unavailable"; never an empty list; Save/Publish disabled |
| **503 `{error:"webdesk_not_configured", reason}`** | No control channel (`control_channel_not_configured`) or no editorial signer (`editorial_signer_not_configured`/`_failed`) is configured on this deployment. Writes are refused before anything is sent; nothing was attempted. | Same as unavailable, with the cause |
| **502 `{error:"webdesk_ambiguous", reason}`** | A write may have landed and its outcome could not be established (`not_observed`, `reconcile_failed`). **Never retry blind**: re-read the item, and retry only with the SAME `Idempotency-Key`. | "Couldn't confirm the save": re-read, then offer retry |
| 502 `{error:"webdesk_refused"\|"webdesk_error", reason}` | WebDesk refused OUR credentials or signing (its 401/403) or answered 5xx. A platform fault, so it is **never forwarded as 401/403** (the UI would read that as a session expiry). | "Something is wrong on our side" |
| **Zone B problems, passed through untouched** (`application/problem+json`, WebDesk's own body, same status) | 400 `invalid-request` · 404 `item-not-found`/`collection-not-found`/`version-not-found` · **409** `version-conflict {currentHeadVersion,currentContentHash,updatedAt}` · `slug-taken` · `twin-locale-taken` · `singleton-exists` · `item-is-live` · `item-deleted` · `not-live` · `published-version-changed` · `contract-major-change` · 413 `payload-too-large` · **422** `composition-violation {issues:[{path,message,expected}]}` | conflict dialog · inline errors by JSON pointer |
| **404 problem `…/errors/site-not-found`** | `(tenantSlug, siteId)` is not an ACTIVE site of THIS company: unknown slug, another tenant's site, **another company's** tenant, or an archived tenant. One answer for all (no existence oracle), and the SAME problem type WebDesk itself uses, so the UI has one not-found shape. | not-found page |
| 403 `{error:"not authorized: …"}` · 401 | Cerbos denied the caller (or no/expired session) | `ReadRefusal` / sign-in |
| 400 `{error:"invalid_request: …", reason:"invalid_request"}` | Strict body/query validation (after authorization) | inline |

**Reconciliation.** When the link dies after a write was fully sent, the BFF does NOT resend (a single-use editorial
`jti` makes a resend unsafe) and does NOT guess: it READS WebDesk (`item.get`, or the collection list for a create) and
returns the write's real result with an extra **`reconciled:true`** (200/201, same shape) when it provably landed
(update/restore: the head moved to `baseVersion+1` authored by the caller, and a restore's hash equals the source
version's; create: that slug at v1 authored by the caller; unpublish/delete: the item is now unpublished/deleted).
Anything else is the 502 above.

### Tenancy, authorization, audit

* **The wall.** Every `:ts/:site` route resolves the pair through WebDesk's `tenant.list?companyRef=<this company>`
  (filtered in WebDesk's SQL; cached 60 s, a miss re-reads once the answer is 5 s old). Company A's user addressing company
  B's site gets 404 on all 12 routes; B's admin on A's company path is 403 before any lookup.
* **Cerbos kinds** `webdesk_content_item` (`read create update request_publish unpublish delete`; `publish`/`schedule` only at
  decide()) and `webdesk_collection` (`read`, `apply_schema`), module `webdev`, as the caller. Editor tier (`webdev_staff`):
  read/create/update/restore/request_publish. Publisher tier (`webdev_manager`, company_admin): also unpublish/delete.
  Item-targeted writes authorize twice: generically first, then with the `collectionKey`/`locale` read from WebDesk.
  The media library is its own kind, `webdesk_media_asset` (see "The media library").
* **Ledger.** Every write that reaches WebDesk writes two `activities` rows around the call, verb `webdesk.content.<cmd>`
  (`create`/`update`/`restoreVersion`/`unpublish`/`delete`/`previewToken`, and `webdesk.schema.apply`/`webdesk.site.provision`), actor = the ERP user
  (the same id as the editorial `sub`), `target_entity_type` `webdesk_content_item` (or `webdesk_site`), metadata
  `{outcome: attempted → succeeded|reconciled|refused|failed|ambiguous, status, problem?, tenantSlug, siteId, itemId?, collectionKey?, locale?, idempotencyKey}`;
  never content values. Reads write nothing.

### MCP tools (impact classes) — the same capabilities for a human, n8n and an agent

Declared in `modules/webdev/index.ts` and aggregated by the hub from `GET /mcp/tool-defs` (nothing hub-side). Reads:
`webdesk.content.listSites` · `listCollections` · `listItems` · `getItem` · `listVersions` · `getVersion` · `listMedia`
(free). Writes: `webdesk.content.create` · `update` (PATCH) · `restoreVersion` · `requestPublish`, `write:true, impact:"low"`
(never suspend: a draft, or only files an approval); `webdesk.content.unpublish` · `delete`, `write:true, impact:"medium"`:
an unattended caller (agent / n8n) **suspends** into an approval and is re-driven as the original requester on approval
(D14: `core/approval-executables.ts` + `resource_mcp_tool.yaml`, both). `webdesk.content.preview` (WSK-46, `POST …/items/:itemId/preview`, input `{version?}`) is also
`write:true, impact:"medium"`: it creates a capability link that exposes a draft, so an unattended caller **suspends**; unlike unpublish/delete it is deliberately NOT on the D14 executable list (the link is a
one-time secret that must not be parked in an approval row), so approving that suspension re-drives nothing and an unattended agent cannot hold a preview link. An attended human runs it directly: it is the same
BFF route the editor's button calls. **There is no publish tool.** Hub limitation: a GET tool
passes only path args, so the list tools return the default first page with no filter or cursor over MCP.

### Control routes re-pointed (WSK-31 stubs → real; same paths, same Cerbos `webdev_provisioned_site` gate)

| Method | Path | Now |
|---|---|---|
| GET | `/api/:t/modules/webdev/control/sites` | **LIVE**: same answer as `…/content/sites` (was 501) |
| POST | `/api/:t/modules/webdev/control/sites` | **LIVE**: body `{tenantSlug, kind: astro\|node\|wp, name}` provisions a site on one of THIS company's tenants (was 501) |
| POST | `/api/:t/modules/webdev/control/schema/apply` | **LIVE**: body `{tenantSlug, siteId, collectionKey, schema}`; WebDesk validates (422) and refuses a MAJOR change (409 `contract-major-change`) (was 501) |
| POST | `/api/:t/modules/webdev/control/contract/regenerate` | **M6-P4c (2026-10-12), new, PROTOTYPED** (typechecked + unit-tested locally; HTTP/DB suite `webdesk-contract-regenerate.test.ts` for the Linux gate). Body `{slug?: string}` (an absent body is `{}`), optional `Idempotency-Key`. WebDesk `contract.regenerate` (MEDIUM): queues a fresh contract-codegen run, after which `POST contracts/refresh` mirrors the new `latest.json`. `slug` given: ONE tenant, which must be an active tenant of THIS company (else `404` problem+json `…/errors/site-not-found`), Zone B's typed answers pass through. `slug` omitted: every ACTIVE tenant of THIS company, one per-tenant command each (never another company's, never WebDesk's platform-wide route); a tenant that fails is reported, the others still run. → `200 {scope: "tenant"\|"company", tenants: [{tenantSlug, outcome: "queued"\|"failed", replayed?: boolean, enqueue?: object, error?: string}]}`. `403` = Cerbos `operate` on `webdev_provisioned_site` (first statement; a member is 403 for any body); `400 {reason:"invalid_request"}` for an unknown key or a non-string/empty `slug`; `503 {error:"editorial_unavailable"\|"webdesk_not_configured", reason}`. MCP tool `webdesk.contract.regenerate` (`write:true, impact:"medium"`): an unattended caller suspends into a D14 approval and is re-driven as itself (registry + `resource_mcp_tool.yaml`). |

The other `control/*` routes remain honest 501s.

### API keys: "Request an API key" (filing) and the approver's once-only reveal (2026-10-11 — BUILT; UI: `platform-ui` Website workspace + `/approvals/[id]`)

| Method | Path | Body → Response |
|---|---|---|
| POST | `/api/:t/modules/webdev/control/sites/:siteId/keys` | `{tenantSlug, envId (uuid), scope: "read"\|"write"}` → **`202 {approvalId}`** for a NEW request, or **`202 {approvalId, alreadyPending: true}`** when a pending request for the same (site, environment, scope) already exists (it returns that one). **Nothing is minted at filing**: it files ONE `key.mint` approval (HIGH impact); a DIFFERENT authorised user approves it (maker ≠ checker, the requester deciding their own is `403`). `403` = Cerbos `promote` on `webdev_provisioned_site` (company_admin, manager, module_manager; a member and a webdev editor are `403` for BOTH scopes); `400 {reason:"invalid_request"}`; `404` problem+json `…/errors/site-not-found` (another company's site) or `…/errors/environment-not-found` (the env is not on this site); `503 {error:"editorial_unavailable"\|"webdesk_not_configured", reason}` from the site read. There is **no `409`**. |

UI consumer: `platform-ui/src/lib/webdeskContentActions.ts#requestKeyAction` → `lib/webdeskContent.ts#parseKeyRequest` (STRICT: a body with any key other than `approvalId`/`alreadyPending`, or an `alreadyPending` that is not exactly `true`, is `contract_drift`, never "filed"). `environment-not-found` joins the not-found slugs in `resultFromError`; every existing shape is unchanged. The control renders on the site overview (`…/website/content/:tenant/:site`) only for a user holding the UI capability **`webdev.promote`** (the mirror of `promote`, company_admin + manager, in `lib/rbac.ts` / `rbac-capability-map.ts`, permission key `webdev.provisioned_site.promote`); everyone else sees nothing, not a disabled button. Environments come from the existing `GET …/content/sites` read (`environments[{envId,name,domain,status}]`), no second read.

The approver's side is the **existing** `POST /api/:t/approvals/:id/decide {origin:"webdesk", decision}` façade, which already answers `{ok:true, webdesk:{command:"key.mint", executionStatus:"executed"\|"failed", apiKeyId, envId, scope, plaintextOnce, error?}}` (see the automation-approvals row). **`plaintextOnce` is the API key in plaintext and this response is the ONLY place it ever exists** (WebDesk keeps a hash; never in the approval row, activities, outbox or logs). The UI parses it with `parseKeyMintDecision` (names a bad field by path and type, never by value) and holds it only in the approver's component state; `executed` with `plaintextOnce: null` is "created, not returned" and shows no key.

### Site archive: "Archive site" (filing) and the approver's decide (2026-10-12 — owner ruling; PROTOTYPED: typechecked + unit-tested locally, DB/Cerbos/WebDesk suites for CI; UI: `platform-ui` Website workspace site page + `/approvals/[id]`)

Archiving a WebDesk site TAKES an approval (HIGH, always WS4, never self-approvable). `POST …/control/sites/:siteId/archive` was the WSK-31 always-501 stub; it now files ONE WSK-66 approval, exactly like the key route above.

| Method | Path | Body → Response |
|---|---|---|
| POST | `/api/:t/modules/webdev/control/sites/:siteId/archive` | `{tenantSlug}` (nothing else; an unknown key is `400 invalid_request`) → **`202 {approvalId}`** for a NEW request, or **`202 {approvalId, alreadyPending: true}`** when a pending request for the same site exists (one open request per site). Authz: Cerbos `webdev_provisioned_site` · `promote` (company_admin, manager, module_manager) is the FIRST statement, so a member or a webdev editor gets `403` before any validation. `404 site-not-found` for a site that is not one of THIS company's (the cross-company wall); `409 site-archived` when the wall's answer already shows the site archived. It never archives: it files `automation_approvals` `origin:'webdesk'`, `workflow_id:'site.archive'`, `tool_name:'webdesk.site.archive'`, `impact:'high'`, `tool_args:{command, tenantSlug, siteId, summary, commandHash}` (no `rebuild`, no editorial assertion). |

The approver's side is the **existing** `POST /api/:t/approvals/:id/decide {origin:"webdesk", decision}` façade: a DIFFERENT authorised user (requester ≠ decider is enforced in code: `403 … a site archive may not be approved by the principal who requested it`, the row stays `pending`). On `approved`, decide() sends the ONE WS4-asserted `site.archive` to WebDesk and the answer gains `webdesk:{command:"site.archive", executionStatus:"executed", siteId, status:"archived"}` or `{executionStatus:"failed", error}` (`webdesk_refused: <status> <slug>`, or `webdesk_ambiguous: the archive may have committed…` which is NOT reconciled by reading and never resent). No secret is returned, so the generic decide form is used. **Irreversible:** WebDesk has no un-archive. WebDesk's `GET /control/v1/tenants` sites gain an additive `status: "active"|"archived"` (UI: `isSiteArchived`; an older WebDesk without it reads as active).

The MCP tool `webdesk.site.archive` stays (HIGH, ALWAYS WS4, input now `{tenantId, siteId, tenantSlug}`, same path); its D14 registry entry and `resource_mcp_tool.yaml` pairing are unchanged, its precondition went from always-refusing to structural (`tenantSlug`, `siteId`). An approved hub suspension re-drives to the filing route, which files the second, maker-checker approval (as for `webdesk.key.mint`).

UI consumer: `platform-ui/src/lib/webdeskContentActions.ts#requestSiteArchiveAction` → `lib/webdeskContent.ts#parseArchiveRequest` (the key request's strict parser); `components/webdesk/content/ArchiveSitePanel.tsx` (confirm step, "Archive requested — waiting for approval."), `WebdeskArchiveRequestSummary.tsx` on the approval page.

### Writers' room grants (M5-W1b, 2026-10-11 — STATUS: PROTOTYPED (backend): typechecked + unit-tested locally; the DB/Cerbos/HTTP suites are written and need the Linux gate; UI: M5-W2e `writers/people`)

Design: `docs/plans/2026-10-11-m5-writers-room-design.md` §2.6; PERMISSION-CONTRACT §27.1. Code: `webdesk-editorial-grants.{controller,service}.ts`, the
writes in `admin/grant-write.service.ts` (`grantEditorialRole` / `revokeEditorialRole`). Grants one of the four writers' room roles on ONE site, with its
collections and locales. Same guards as the content routes (`AuthGuard` + `ModuleEnabledGuard("webdev")`); **the first statement of every handler is
Cerbos `webdesk_collection` · `manage_editorial`** (company_admin, owner, webdev_manager, platform_admin): everyone else, including a scoped
`webdesk_editor`, gets **403 for any body**, and nothing is read from WebDesk or the database for them.

| Method | Path | Body → Response |
|---|---|---|
| GET | `/api/:t/modules/webdev/content/sites/:tenantSlug/:siteId/editorial/grants` | → `{tenantSlug, siteId, grants: [{grantId, userId, name, email, role, tenantSlug, siteId, allCollections, collections, allLocales, locales, expiresAt, grantedBy, updatedAt}]}`: every UNEXPIRED grant with a scope row on this site in this company. ERP rows only (no WebDesk call). An empty `grants` means none. |
| POST | same | `{userId (uuid), role: "webdesk_writer"\|"webdesk_translator"\|"webdesk_seo_reviewer"\|"webdesk_editor", collections: string[] \| allCollections: true, locales: string[] \| allLocales: true, expiresAt?: ISO\|null}` (strict: an unknown key is 400 `invalid_request`, after authorization) → **200** `{userId, role, tenantSlug, siteId, grantId, allCollections, collections, allLocales, locales, expiresAt, changed, createdGrant}`. Granting the same role on the same site again REPLACES that site's scope; identical = `changed:false` (no audit row, no session bump). One grant per (person, role, company) carries every site. |
| DELETE | `…/editorial/grants/:userId/:role` | no body (the hub's `{}` is accepted) → **200** `{userId, role, siteId, changed, removedGrant}`. Removes this site's scope; `removedGrant:true` when that was the grant's last site. Revoking what is not held is `changed:false`. **No WebDesk call**: works while WebDesk is down and for a site WebDesk no longer lists. |

**Rules a consumer must not "simplify".** An empty list never means "all": send `allCollections: true` / `allLocales: true`. Lists are de-duplicated and
sorted in the answer. `collections` must exist on the site (WebDesk `collection.list`) and `locales` must be the tenant's (`tenant.list`), else
**400 `unknown_collection`** / **`unknown_locale`**. The target must be an active **employee** with an active membership of THIS company (**400
`editorial_target_not_eligible`**; freelance contributors are not built yet). **400 `self_grant_forbidden`** for yourself. The expiry belongs to the
person's grant across all sites: a different `expiresAt` for an existing grant is **409 `editorial_grant_expiry_mismatch`** (revoke, then grant again).
A site that is not this company's is the uniform **404 problem `…/errors/site-not-found`**. WebDesk unavailable on a POST: the typed **503
`editorial_unavailable` / `webdesk_not_configured`** of this section. Every change bumps the target's session (they re-authenticate) and writes one
`activities` row (`webdesk.editorial.role_granted` / `role_revoked`, `target_entity_type user_role`, identifiers only).

**The generic grant surfaces refuse these four roles** with **400 `editorial_role_dedicated_path`**: `POST /api/:t/users/:u/roles` (legacy admin),
`POST /api/:t/role-grants` (and its overrides), `POST /api/:t/positions` role sets (the composer lists them `attachable:false, reason:"editorial_role_dedicated_path"`).

**MCP tools** (`modules/webdev/index.ts`, same routes): `webdesk.editorial.listGrants` (read) · `webdesk.editorial.grantRole` (`write:true, impact:"high"`) ·
`webdesk.editorial.revokeRole` (`write:true, impact:"medium"`), `minAssurance: "verified"`. An unattended caller suspends for approval; both writes are D14
executables and re-drive as the original requester.

### WebDesk form definitions (M5-L1d, 2026-10-12 — STATUS: PROTOTYPED (backend): typechecked + unit-tested locally; the DB/Cerbos/HTTP suites are written and need the Linux gate; UI: none yet)

Before this, a WebDesk `form_defs` row could only be created by raw SQL. Code: `webdesk-forms.service.ts` + three handlers in `webdesk-content.controller.ts`; WebDesk side:
`webdesk/api/src/control/forms/*` (README "Form definitions"). Same guards as the content routes; **the first statement of every handler is `authorizeSite(…, siteId, "webdesk_collection", …)`**
(M5-W1c phase 1: `read` on the route's site). The write then asks `webdesk_collection` · **`apply_schema`** with `siteId` set (company_admin, webdev_manager, platform_admin; a writers' room grant
does not carry it) before any body validation, and the reads need `read` on the site, so a denied caller gets **403 for any
body** and nothing reaches WebDesk. No new kind. The wall is the content routes' (a site that is not this company's is the uniform 404 `…/errors/site-not-found`).

| Method | Path | Body → Response |
|---|---|---|
| GET | `/api/:t/modules/webdev/content/sites/:tenantSlug/:siteId/forms` | → `{forms: [{formId, key, siteId, schema, notify, retentionDays, consentNoticeVersion, createdAt, updatedAt}]}` ordered by key (WebDesk `forms.def.list`) |
| GET | `…/forms/:formKey` | → `{form: {…}}`; unknown key 404 problem `…/errors/form-not-found` (WebDesk `forms.def.get`) |
| PUT | `…/forms/:formKey` | `{schema: {fields: [{key,type,required?,maxLength?,min?,max?,options?}], honeypotField?, consentNotice: {text}, attachments?}, notify?, retentionDays (1..3650), consentNoticeVersion}` (strict: an unknown or route-parameter member is 400) → **200** `{form, created, consentNoticeChanged, replayed}` (WebDesk `forms.define`, MEDIUM; an upsert by (site, key), **redefining keeps `form.formId`**). Optional `Idempotency-Key`. |
| PATCH | `…/forms/:formKey` | alias of the PUT (the MCP hub's method union has no PUT) |

Field types: `text`, `textarea`, `email`, `tel`, `number`, `boolean`, `date`, `select` (needs `options`). WebDesk's typed problems pass through untouched as
`application/problem+json`: **422 `form-definition-invalid`** (`issues: [{path, message}]`, every problem at once: bad field key or type, an email- or phone-looking field typed
`text`, a honeypot that is also a field key, an empty consent notice, retention outside 1..3650, an unknown member) and **409 `consent-version-unchanged`** (the notice text
changed but `consentNoticeVersion` did not: every submission snapshots both). The write writes two `activities` rows (`webdesk.forms.define`: attempted, then the outcome;
tenant slug, site id, form key and notice VERSION only, never the notice text); the reads write none. WebDesk unavailable: the typed 503s of this section.

**MCP tools** (`modules/webdev/index.ts`, same routes): `webdesk.forms.list` (read) · `webdesk.forms.get` (read) · `webdesk.forms.define` (`write:true, impact:"medium"`, PATCH),
`minAssurance: "low"`. An unattended caller suspends for approval; `forms.define` is **not yet a D14 executable** (see PERMISSION-CONTRACT §27.3), so approving that suspension re-drives nothing and
only an attended human can define a form today. The three gaiada.com definitions are data: `webdesk/sites/gaiada-com/forms/{contact,audit,onboard}.json` (its README has the field-id table and how to apply them).

### Writers' room review flow (M5-W2d, 2026-10-12 — STATUS: PROTOTYPED (backend): typechecked + unit-tested locally; the DB/Cerbos/HTTP suite `webdesk-editorial.test.ts` is written and needs the Linux gate; UI: M5-W2e)

Design: `docs/plans/2026-10-11-m5-writers-room-design.md` §4.3, §4.4, §8; PERMISSION-CONTRACT §27.4. Code: routes in `webdesk-content.controller.ts`, logic in `webdesk-editorial.service.ts`. All under
`/api/:t/modules/webdev/content/sites/:tenantSlug/:siteId/…`. **Order of every item command:** `authorizeSite` (phase 1) → the cross-company wall → WebDesk `item.get` → the REAL Cerbos action with the item's attributes (phase 2) →
only then the body is validated → the command is forwarded with a signed editorial assertion (as the caller) and the `Idempotency-Key` (optional on the wire: one is generated when absent; a retry must reuse it) → notifications. A denied
caller is **403 for any body** and WebDesk receives no write. WebDesk's typed problems (409 `review-not-enabled`, `review-state-conflict`, `review-version-mismatch`, …) pass through byte for byte as `application/problem+json`;
403/401 from WebDesk are never forwarded (502 `webdesk_refused`). 503 `editorial_unavailable` / `webdesk_not_configured` as elsewhere in this section. A replayed key answers WebDesk's `replayed: true` and notifies nobody.

| Method | Path | Body → Response | Cerbos action (phase 2) |
|---|---|---|---|
| POST | `…/items/:itemId/editorial/submit` | `{version}` → 200 `{itemId, editorial, replayed}` | `submit` on the item |
| POST | `…/editorial/withdraw` | `{}` → 200 | `submit` (design §2.1) |
| POST | `…/editorial/request-changes` | `{version, note (1..2000)}` → 200 | `request_changes` |
| POST | `…/editorial/seo-signoff` | `{version}` → 200 | `seo_signoff` (automation and bots refused) |
| POST | `…/editorial/approve` | `{version}` → 200 | `approve`, with `creatorId` = creator of the SUBMITTED version from WebDesk's read, never the body (maker != checker; automation, bots, contributors refused). An item not in review is 403 (no known creator). |
| POST | `…/editorial/assign` | `{authorSub?, dueAt?, plannedPublishAt?, briefRef?}` (at least one; null clears the three optional ones) → 200 | `assign` |
| POST | `…/editorial/comments` | `{version, body (1..4000), anchor? (JSON pointer)}` → WebDesk's 201 | `comment` |
| POST | `…/editorial/comments/:commentId/resolve` | `{}` → 200 | `comment` |
| PUT / PATCH | `…/collections/:collectionKey/editorial-policy` | `{reviewRequired: boolean, seoSignoffRequired?: boolean}` → 200. PATCH is the hub alias (no PUT in its method union). | `webdesk_collection:manage_editorial` on `{siteId, collectionKey}` |
| GET | `…/editorial/board` | query `state, collection, authorSub, dueBefore, cursor, limit` → WebDesk's `{items, counts, policies, page}` | phase 1 `webdesk_content_item:read`, then per (collection, locale) `read`. A company-level reader (staff tier) gets the answer untouched. A caller with a scoped grant gets only the rows and policies it may read, **`counts` is omitted and `countsWithheld: true` is added**. |
| GET | `…/items/:itemId/editorial` | → the item's state, events, comments, SEO snapshot | `read` on the item |

Item commands take the item's phase-1 gate as `webdesk_content_item:<action>`; `approve` and the policy route are the exceptions (`webdesk_collection:read`, and `webdesk_collection:manage_editorial`), because an attribute-free `approve` is denied
for everyone. **Notifications** (after WebDesk confirmed, fail-soft, `notifications` rows with ids and the item title only, never a note or comment text): `webdesk.editorial.submitted` → holders of an unexpired `webdesk_editor` grant whose
scope rows cover the item's site, collection and locale, plus `webdev_manager` at company scope (read through the tenant wall, so no other company's editor); `webdesk.editorial.changes_requested` and `.approved` → the item's author
(`ownerId`). The actor is never notified of their own action. **MCP tools** (`modules/webdev/index.ts`, same routes, `minAssurance: "low"`): `webdesk.editorial.submit / withdraw / requestChanges / assign / comment / resolveComment` (`write:true, impact:"low"`) ·
`seoSignoff / approve / setPolicy` (`write:true, impact:"medium"`; not D14 executables, like `webdesk.content.preview`: an unattended caller suspends and approving the suspension re-drives nothing) · `board`, `history` (reads; the hub drops a GET's query, so `board` returns the default first page).

**UI consumer (M5-W2e, PROTOTYPED: tsc + vitest locally; the Playwright drive and `next build` run on the Linux gate).** `platform-ui/src/lib/webdeskEditorial{,Model,Actions}.ts` (readers + strict parsers, client-safe types and plain-words copy, writes), `components/webdesk/editorial/*` (the editor's Review panel, comments, the board, the grants page), pages `…/website/writers[/[tenant]/[site]]` and `…/website/writers/people[/[tenant]/[site]]`. What a caller may do comes ONLY from the item read's `allowed` (absent = nothing offered, said in words); the publisher tier of `people` is the BFF's 403 on the grants read, not a role guess. One contract note found while building it, and a change that closed another: (1) **the BFF item list now accepts `reviewState`** (`draft | in_review | changes_requested | approved`; checked after the phase-2 read check, so a denied caller is 403 for any value and an unknown value is a 400; forwarded to WebDesk's `item.list` under the same name), so the UI's review-state filter narrows the whole collection. (2) a comment's field reference is the wire member **`anchor`** (an RFC 6901 pointer), not `fieldPath`.

### Writers' room AI assist (M5-W6, 2026-10-12 — STATUS: PROTOTYPED (backend): typechecked + unit-tested locally; the DB/Cerbos/HTTP suite `webdesk-assist.test.ts` is written and needs the Linux gate; UI: the editor's assist drawer, a later W2e follow-up)

Design: `docs/plans/2026-10-11-m5-writers-room-design.md` §5 (W6). Code: the route in `webdesk-content.controller.ts`, logic in `webdesk-assist.service.ts` (gate, budget, gateway), pure rules in `webdesk-assist.ts`, the budget in `webdesk-assist-budget.ts`.
**Suggestions only: assist WRITES NOTHING.** It sends WebDesk no command (the testkit sees only `item.get`/`tenant.list`), signs no assertion, and a human applies each suggestion and saves it through the normal `PUT …/items/:itemId` (`content.update`, with `baseVersion`).
Approval, SEO sign-off and publishing are untouched. Only the ERP calls `ai-gateway-go` (through the shared `completeViaGateway` client; no provider key in platform-nest).

| Method | Path | Body → Response |
|---|---|---|
| POST | `/api/:t/modules/webdev/content/sites/:tenantSlug/:siteId/items/:itemId/assist` | `{kind, version?}` (strict: any other member is 400) → **200** `{kind, itemId, version, headVersion, locale, advisory: true, suggestions: [...], notice?, provider, usage}` |

**Authorization:** `authorizeSite` (phase 1) → the cross-company wall → WebDesk `item.get` → **`update` on the item** with the item's own attributes (phase 2, M5-W1c) → only then the body. No new Cerbos kind or action. A writer may assist only on an item they may edit (their own draft, not in review); a staff editor on any item; a denied caller is **403 for any body** and neither the budget nor the gateway is touched. **Bots, automation and agents are allowed on the same rule** (assist writes nothing and returns text to the caller; saving a suggestion is their own gated `content.update`); they get a smaller daily budget.

**Kinds and suggestion shapes** (each suggestion has an `id` `s1…`; a UI accepts them one by one). Limits are W3's (`webdesk/api/src/control/content/lint-rules/config.ts` defaults; a parity test fails on drift):

| `kind` | Reads (and sends to the model) | `suggestions[]` | Validated |
|---|---|---|---|
| `meta_description` | title, primary keyword, a head (<= 2500 chars) of the main text | one: `{target: "/seo/description", text, length}` | 120 to 155 chars, plain text; a too-long answer is cut at a word boundary only if it stays in range |
| `outline` | title, keyword, existing headings, <= 600 chars of opening text | one: `{target: null, headings: [{level: 2\|3, text}], markdown}` | 3 to 15 headings, H2/H3 only, first is H2 |
| `faq` | title and <= 6000 chars of text (needs >= 200) | 3 to 8: `{target: null, question, answer}` | question ends `?` (<= 160), answer 20 to 600, no duplicates |
| `translate_draft` | the item's prose string fields (<= 12 fields, 4000 each, 8000 total), English source only | per field: `{target: null, sourcePath, field, locale: "id", text, status: "first_draft_needs_human", notice}`; the response also carries `notice: "First draft — needs a human"` | keys limited to those sent; a UI must show the notice and apply it to an ID twin (`content.create` with `localizationOf`, then `content.update`) |
| `alt_text` | per markdown image with NO alt text (<= 10): file-name stem and the line it sits on | per image: `{target: "/blocks/<n>/props/<key>", index, imageRef, alt}` | 4 to 125 chars, no "image of" lead-in |

**Typed answers** (RFC 9457, `…/errors/<slug>`): **422 `assist-not-applicable`** `{reason}` (`no_text`, `not_enough_text`, `source_not_english`, `no_image_without_alt`; no spend) · **429 `assist-budget-exceeded`** `{scope: "principal", limits, used, retryAfterSeconds}` ·
**503 `assist-unavailable`** `{reason: not_configured | gateway_unavailable | gateway_busy | no_provider}`: the AI service could not serve it, **nothing is suggested** and the call is refunded · **502 `assist-output-invalid`** `{reason}`: the model answered but the answer failed the kind's validator (the call is spent) ·
409 `item-deleted` · 404 `version-not-found` / `site-not-found` · 403 · 400 `invalid_request`.

**Budget:** per principal and company, per UTC day: **40 calls and ~120k estimated tokens** for a person, **15 and ~40k** for a bot, automation account, n8n or an agent (`WEBDESK_ASSIST_DAILY_CALLS`, `…_TOKENS`, `…_CALLS_AUTOMATED`, `…_TOKENS_AUTOMATED`; an empty or invalid value falls back to the default). Tokens are ESTIMATES (chars/4; ai-gateway-go's `/complete` reports no usage), and `usage.tokensAreEstimates` says so. The count is the ERP's own `activities` ledger (verb `webdesk.content.assist`, two rows per call, taken under a per-principal advisory lock so concurrent calls cannot overshoot), not the gateway's global cap.
**No content in logs or rows:** one log line per call with ids, kind, outcome, latency and estimated token counts; ledger rows carry the same. Never a prompt, completion, title or field text.

**MCP tool** (`modules/webdev/index.ts`, same route, `minAssurance: "low"`): `webdesk.content.assist` (`write: true, impact: "low"`: a POST is a write by the registry's rule, but it changes nothing on the site; an unattended caller runs it directly and the budget is the control on spend).

**What the editor's assist drawer needs (BUILT 2026-10-12 in `platform-ui/src/components/webdesk/content/AssistDrawer.tsx`, M5-W6 UI):** the item read's `allowed.update` decides whether to offer it (absent = not offered, as for every action); call with `{kind}` (and `version` only to assist on a version other than the head); show `suggestions` as a list with Accept per suggestion and never auto-apply; on accept, put the text into the editor's own draft (`target` is a JSON pointer into the version for `meta_description` and `alt_text`; `faq` and `outline` have `target: null` and the human chooses where they go) and save through the normal save, so `baseVersion`, the lint and the version history behave as for any edit; if `headVersion` is greater than `version`, say the suggestions were made from an older version; show `notice` with a translated draft; map 429 to "budget used until `retryAfterSeconds`", 503 to "AI is unavailable right now, nothing was changed", 502 to "try again", 422 to the reason in plain words.

### Writers' room briefs (M5-W4, 2026-10-12 — STATUS: PROTOTYPED (backend): typechecked + unit-tested locally; the DB/Cerbos/HTTP suite `webdesk-briefs.test.ts` is written and needs the Linux gate; UI: M5-W5 shows briefs; see "Writers' room calendar")

Design: `docs/plans/2026-10-11-m5-writers-room-design.md` §5 (W4); PERMISSION-CONTRACT §27.5 (**no new Cerbos kind**: `assign` manages, `comment` on the linked item reads). Code: `webdesk-briefs.controller.ts`, `webdesk-briefs.service.ts`,
`webdesk-brief-store.ts`; migration `202610122300_search_content_briefs_webdesk_link.sql`. A brief is a row of the EXISTING `search_content_briefs` (0046) with a WebDesk link: site, collection, locale, optional item, assignee, and the search facts a writer needs
(`targetQuery`, `searchIntent`, `aiQuestions`, `contentGaps`). WebDesk's `editorial_items.brief_ref` holds the brief id (set through the existing `editorial.assign` command; no WebDesk change). All under
`/api/:t/modules/webdev/content/sites/:tenantSlug/:siteId/…`, same two-phase gate as the content routes (`authorizeSite` first; the real question before any body or query is validated; a brief of another site or company is a uniform 404; WebDesk's typed problems pass through).

| Method | Path | Body → Response | Cerbos (phase 2) |
|---|---|---|---|
| POST | `…/briefs` | `{collectionKey, locale, topic \| fromBriefId, targetQuery?, searchIntent? (informational\|commercial\|transactional\|navigational), aiQuestions? (≤50×300), contentGaps? (≤50×300), outline?, body?, geoNotes?, propertyId?, fromBriefId?}` → 201 the brief (manager view). `collectionKey` is proven by WebDesk `collection.get`, `locale` must be one of the tenant's. Nothing is written to WebDesk. | `webdesk_content_item:assign` on `{siteId, collectionKey, locale}` **named by the body** (a scoped editor passes only inside its scope); `propertyId` / `fromBriefId` additionally `resource_search_property:read` on that property (403 and no row otherwise) |
| GET | `…/briefs` | query `collectionKey, locale, status, linked (true\|false), cursor, limit (1..100, default 50)` → `{briefs:[summary], page:{limit, hasMore, cursor}}`; summary = `{id, status, topic, targetQuery, searchIntent, collectionKey, locale, itemId, assigneeId, linkedAt, createdAt, updatedAt, canManage}` (no body). A page may hold fewer rows than `limit`. | per row: `assign` on the row's (collection, locale) (asked once per pair), else `comment` on the linked item decided on WebDesk's facts now (`ownerId`, `briefRef`); a WebDesk failure is 5xx, never a shorter list |
| GET | `…/briefs/:briefId` | → the brief: `{id, status, topic, targetQuery, searchIntent, aiQuestions, contentGaps, outline, body, geoNotes, collectionKey, locale, siteId, tenantSlug, itemId, linkedAt, assigneeId, createdAt, updatedAt, provenance?}` (`provenance {propertyId, sourceBriefId, createdBy}` for managers only) | manager: `assign`; else the brief must be linked and `comment` on its item must pass and WebDesk's `briefRef` must equal the id (else 404). An unlinked brief is 403 for a non-manager |
| GET | `…/items/:itemId/brief` | → the same view; 404 `this item has no brief` | `comment` on the item (the writer's path) |
| PATCH | `…/briefs/:briefId` | any of `{topic, status (draft\|approved), outline, body, geoNotes, targetQuery, searchIntent, aiQuestions, contentGaps}` (at least one; a link field is a 400) → 200 | `assign` on the brief's scope |
| POST | `…/briefs/:briefId/assign` | `{itemId, authorSub?, dueAt?, plannedPublishAt?}` → 200 `{brief, assign}`. Links the brief to an EXISTING item of the SAME collection and locale (else 409 `brief_item_mismatch`); 409 `item_has_another_brief` / `brief_already_linked`. Calls `editorial.assign {briefRef: <brief id>, …}` (Idempotency-Key) then records the link | `assign` on the brief's scope, then `assign` on the item (WebDesk's author and state) |
| POST | `…/briefs/:briefId/create-draft` | `{slug, fields?, blocks?, seo?, note?, authorSub?, dueAt?, plannedPublishAt?}` → 201 `{brief, item, version, replayed}`. The item's collection and locale are the BRIEF's (a body naming either is 400). Sequence: `content.create` (the caller's Idempotency-Key) → `editorial.assign {briefRef, …}` (derived key) → link. 409 `brief_already_linked`; WebDesk's `slug-taken` 409 and `composition-violation` 422 pass through and leave the brief unlinked | `assign` on the brief's scope, then `create` on the collection and locale (the ordinary create gate), then `assign` on the new item |

`authorSub` is an ERP user id (uuid). **Notification** (`webdesk.brief.assigned`, after the writes succeeded, fail-soft): the assignee, when the assignee changed; payload ids and the brief's title only (`entityType: search_content_brief`, `entityId`, `tenantSlug`, `siteId`, `collectionKey`, `locale`, `itemId`), never the query, notes or body; the actor is never notified of their own action.
The generic `…/items/:id/editorial/assign` also keeps the linked brief's `assigneeId` equal to the item's new author (a list filter and notification target only; it grants nothing). Audit rows (`created`, `updated`, `linked`, `draft_created` on `search_content_brief`) name ids only.
**Not idempotent on the wire for `POST …/briefs`** (an ERP row; a retry files another brief). **MCP tools** (`modules/webdev/index.ts`, `minAssurance: "low"`): `webdesk.briefs.create / update / assign / createDraft` (`write:true, impact:"low"`: an ERP row or a WebDesk DRAFT; nothing a production key sees changes) · `webdesk.briefs.list / get / forItem` (reads; the hub drops a GET's query, so `list` returns the default first page).
**The SEO department's surface is unchanged:** `search_content_briefs.property_id` is now nullable; the `search` routes that address a brief by id treat a property-less row as not found (they authorise against the parent property).

### Writers' room dashboard (M5-W8, 2026-10-12 — STATUS: PROTOTYPED (backend + UI): typechecked + unit-tested locally; the DB/Cerbos/HTTP suite `webdesk-writers-dashboard.test.ts` is written and needs the Linux gate; the Playwright drive `e2e/webdesk-dashboard.spec.ts` runs against the stub on the Linux gate)

Design: `docs/plans/2026-10-11-m5-writers-room-design.md` §5 (W8). Code: `webdesk-writers-dashboard.service.ts` (gate, WebDesk reads, Cerbos pair checks, paging), `webdesk-writers-dashboard.ts` (the pure rules), `webdesk-writers-dashboard-sources.ts` (the four data sources), route in `webdesk-content.controller.ts`, MCP tool `webdesk-writers-dashboard-mcp-tools.ts`. **Counts only: a lead is a number, never a name, an address, a phone or an id; no visitor-level data leaves.**

| Method | Path | Response |
|---|---|---|
| GET | `/api/:t/modules/webdev/content/sites/:tenantSlug/:siteId/writers/dashboard` | query `period` (`7d` \| `28d` default \| `90d`), `collection`, `locale`, `mine` (`true`\|`false`), `cursor`, `limit` (1..100, default 25) → `{tenantSlug, siteId, period:{key,days}, windows:{traffic:{current,previous}, search:{current,previous}}, scope, sources:{umami,search,leads,decay}, items[], page:{cursor,hasMore,limit}}` |

**Authorization (the two-phase gate, unchanged).** `authorizeSite` (phase 1, `webdesk_collection:read` on the route's site) is the handler's first statement. Then, before the query is validated: the cross-company wall, WebDesk `collection.list`, and the real question: a company-level `webdesk_content_item:read` on the site (a staff tier: every row) or, for a scoped caller, Cerbos `read` and `assign` on each (collection, language) pair that has published items, asked in groups of at most 50 (the batch limit; today one `checkActions` call per pair, at most 50 in flight, since `rbac/cerbos.ts` exports no multi-resource batch). A caller that may read none of the site's collections is **403** (never `[]`); an unknown query parameter is a 400 only for a caller that was let in. **Whose articles:** a row is listed when its pair is readable AND (the caller is staff-tier, OR holds `assign` on the pair (the editor tier), OR is the item's author: WebDesk's `editorial.authorSub`, never the request). So a writer (and a translator or SEO reviewer, who hold no `assign`) sees their own work; an editor, a publisher and staff see everything in scope. `?mine=true` narrows anyone to their own. Cerbos or WebDesk failing is a **503** (WebDesk's typed answer, or `authorization_unavailable`), never a shorter list. The route is not `@ContributorRoute()`: a contributor is refused at the AuthGuard fence.

**Items.** Published, undeleted items only (WebDesk `item.list?state=live`, re-checked in the BFF). Collections in key order, one WebDesk page of one collection per request (up to 5 pages are read while every row of them is filtered out, so a page is not blank for no reason); `page.cursor` carries on exactly where the page stopped. Each item: `{itemId, collectionKey, locale, slug, title, publishedVersion, mine, pagePath, pagePathReason, metrics, decay}`.

**`pagePath`** comes from the composition: `composition.ui.routePattern` (vocabulary **1.4.0**, M5-W8b), resolved with the vocabulary's own `routePatternProblem` / `pagePathFor` (`"/blog/{slug}/"`, `"/{locale}/insights/{slug}/"`: literal `[a-z0-9-]` segments, `{slug}` exactly once, `{locale}` at most once, whole segments). The tenant's default language drops the `/{locale}` segment. One rule is the dashboard's own: a localized collection whose pattern has no `{locale}` has no address for a non-default language. **No pattern, a malformed one, an unusable slug or a language with no address is `pagePath: null` with `pagePathReason {code, text}`** (`no_route_pattern`, `bad_route_pattern`, `slug_not_routable`, `locale_not_routable`), and every figure of that item carries the same reason: a guessed path would attach another page's numbers to it. Collections that have a pattern list first. Until a tenant's compositions carry the key (a schema apply), its items report `no_route_pattern`.

**`metrics`** (each is `{value, reason}`: a value, or `value: null` with `reason: {code, text}`, **never 0 for a figure that could not be read**):
- `views` and `avgSeconds`: Umami (A4's GET-only client). Views per path from `metrics?type=path` (limit 500) for the period and the one before; a page absent from a complete list is a measured zero, absent from a truncated one is `umami_truncated`; no visits at all is `umami_no_data`. **Small cells (R-V6): a view count under 5 is `"<5"`** with no trend. `avgSeconds` is `totaltime / visits` for visits that include the page, from `metrics/expanded?type=path` (best effort, trusted only when its page views agree with `views`; under 5 visits is `small_cell`). Upstream states as A4: `umami_not_configured`, `umami_not_bound`, `umami_unreachable`, `umami_rejected`. **Unverified against a live Umami 3.4.0:** `metrics/expanded` (its absence only costs `avgSeconds`, reason `umami_no_time`).
- `clicks`, `impressions`, `topQueries`: our own `search_gsc_performance` rows (`simulated = false`), for the search property whose domain matches an environment domain of the site (production first, `www.` ignored). The Search Console windows end 3 days before today (the decay job's lag); a window is measurable with rows on at least half its days (3 to 14). Covered with no row for the page is a measured 0; not covered is `gsc_no_data`; no property is `no_search_property`; a failed read is `search_unavailable`. `topQueries`: at most 3 by clicks, only queries with at least 5 impressions in the period (counts only).
- `leads`: a COUNT of `agency_leads` (`source = 'web'`, this WebDesk site slug, not removed, not erased) whose `attribution.landing` or `attribution.form_page` is this page (a lead counts once per page; `sections_seen` holds section ids, not paths, so it cannot match). The SQL selects `created_at` and those two attribution members only, so no id, name, address, phone, note or consent flag is ever read. Exact numbers (not suppressed: a lead is not an anonymous cell). Failed read: `leads_unavailable`.
- Each count figure is `{current, previous, trend}`; `previous` is the period before (null when it could not be measured), `trend` is `up`\|`down`\|`flat` (more than 5 % of the earlier figure) only when both are real numbers.

**`decay`**: `{value: "none"}` when the V4 detector runs (`SEARCH_DECAY_ENABLED` is exactly `1`) and no live finding exists for the page, or a finding `{findingId, status, reason, detectedAt, briefId}` (the V4 words, counts only). Detector off: `decay_off` (a missing alert would not mean healthy); failed read: `decay_unavailable`.

**`sources`**: `umami`, `search`, `leads`, `decay` each `{state: "ok"}` \| `{state: "unavailable", reason}` \| `{state: "not_asked"}` (no item on the page had a page path, so nothing was asked), for one banner; every figure also carries its own reason. `scope` is `all_site` (a company-level read) or `scoped`.

**Why the search and lead reads are not gated by `resource_search_property` / `agency_lead`.** The dashboard's authority is the WebDesk read above; what leaves is counts for the caller's own site's pages. The search tables are reached through `withTenants([tenant], …, { modules: ["search"] })` (the module scope is a property of the TABLE, as in `webdesk-brief-store.ts`); `agency_leads` through the plain tenant wall (as `listWebLeads`). A lead's identity still needs `agency_lead:read`, which no editorial role holds.

**MCP tool** (`modules/webdev/index.ts`, same route): `webdesk.writers.dashboard` (read, `minAssurance: "low"`; the hub drops a GET's query, so it returns the default view: 28 days, the first page). **UI consumer (M5-W8):** `platform-ui/src/lib/webdeskDashboard{,Model}.ts` (the STRICT parser: a figure with both or neither of `value`/`reason`, a raw view count under 5, a trend without two numbers, or a path without its reason is `contract_drift`), `components/webdesk/editorial/WritersDashboard.tsx`, pages `…/website/writers/dashboard[/[tenant]/[site]]` (cards per article, arrows with words, "Unavailable" in words, the decay badge linking to the finding on the card, filters: period, collection, language, my articles / all I can see). The board page gains a "Writer dashboard" link.

### Writers' room calendar and workflow board (M5-W5, 2026-10-12 — STATUS: PROTOTYPED (backend): typechecked + unit-tested locally; the DB/Cerbos/HTTP suite `webdesk-calendar.test.ts` is written and needs the Linux gate; UI: `writers/calendar` and the board of `writers/[tenant]/[site]`)

Design: `docs/plans/2026-10-11-m5-writers-room-design.md` §5 (W5). Code: `webdesk-calendar.service.ts` (the read), `webdesk-calendar.ts` (pure rules), the route in `webdesk-content.controller.ts`, `getBriefsByIds` in `webdesk-brief-store.ts`. No new Cerbos kind or action, no migration, no WebDesk change.

| Method | Path | Query → Response |
|---|---|---|
| GET | `/api/:t/modules/webdev/content/sites/:tenantSlug/:siteId/editorial/calendar` | `from`, `to` (UTC days `YYYY-MM-DD`, given together or not at all, `to >= from`, at most 100 days), `collection`, `locale`, `authorSub` (uuid); anything else is 400 → `{tenantSlug, siteId, from, to, truncated, entries:[Entry], policies:[{collectionKey, reviewRequired, seoSignoffRequired}], counts? \| countsWithheld: true}` |

`Entry` = `{itemId, collectionKey, locale, slug, title, headVersion, publishState, publishAt, unpublishAt, reviewState, reviewRequired, inFlow, authorSub, dueAt, plannedPublishAt, submittedVersion, approvedVersion, openComments, briefRef, brief:{id,topic,status,assigneeId}\|null, briefHidden, requests:[{approvalId, command: content.publish\|content.schedule, status:"pending", publishAt, unpublishAt, createdAt, requestedByMe}], placement:{kind, at}\|null}`.

**What it joins.** WebDesk's `editorial.board` (every page, `limit 100`, at most 20 pages); WebDesk's `item.list state=scheduled` per collection (the only source of `publish_at`; it also lists scheduled items of review-off collections, which are `inFlow: false` and are NOT on the workflow board); the site's PENDING `origin='webdesk'` publish/schedule approvals (all requesters, at most 500); the W4 briefs the rows point at.
**Placement: one date per item, and `placement.kind` says which:** `publish_at` (a scheduled or published item's own date) > `requested_publish` (the earliest requested time of a pending request; a request with no time has no date) > `planned` (`plannedPublishAt`) > `due` (`dueAt`). With `from`/`to`, an entry is listed when its placement is inside the window (UTC days, both inclusive), or when it has none and is not live ("unscheduled"); without a window every entry is listed (the workflow board's call). The answer carries instants; days are UTC days and the UI says so.
**Authorization (same two phases as the board).** `authorizeSite` first; the cross-company wall (a foreign site is the uniform 404); the query is validated; then every row is filtered by Cerbos: a company-level reader (`read` on the site: the staff tiers) keeps every row and gets WebDesk's `counts`; a scoped writers' room grant keeps the rows whose (collection, locale) it may `read`, gets `countsWithheld: true` and no `counts`, and a caller that may read none of them gets the ordinary 403, never `[]`. Only AFTER that are requests and briefs joined, and only to the rows kept. A request shows `requestedByMe`, never the filer. A brief shows only to someone who could read it through `GET …/briefs` (`assign` on the pair, or `comment` on the item with WebDesk's facts); otherwise `brief: null, briefHidden: true`. A `briefRef` whose brief row does not name this item attaches nothing (`brief: null, briefHidden: false`).
**Batch limit.** Every Cerbos question here is ONE resource per request (`probeAllowed`), per distinct (collection, locale) pair, with at most 8 in flight, so the 50-resource batch limit cannot be crossed however many rows there are.
**A failed read is a 503, never a shorter list:** `503 {error:"calendar_unavailable", reason:"<part>_unreadable"}` (the part is the reason's prefix; the global error filter keeps `reason` and drops other members) with the part = `board` · `scheduled` · `requests` · `briefs` · `authorization` (Cerbos itself failing). A WebDesk answer that is not the contract shape, a board that promises another page without a cursor, and a company-level reader whose board carries no `counts` are the same 503. **`truncated: true`** means a cap cut a read (more than 20 board pages, a collection with more than 100 scheduled items, more than 500 pending requests): rows may be missing, and the UI says so. Known gaps: WebDesk's board does not send `publishedVersion` or any pending version swap, so neither is shown; a pending request for an item neither the board nor the scheduled list carries (an untouched live item in a review-off collection) is not shown.
**MCP tool** (`modules/webdev/index.ts`, same route, `minAssurance: "low"`): `webdesk.editorial.calendar` (read; no impact class). The hub drops a GET's query, so the tool returns every row with no date window.

## 28. Website analytics from Umami (M5-A4, 2026-10-11) — `platform-nest/src/modules/search/search-analytics.controller.ts`, `umami-client.ts`, `umami-reads.ts`; `platform-ui/src/lib/websiteAnalytics*.ts` — **STATUS: PROTOTYPED (typechecked + unit-tested locally; the DB-backed route test is written but needs the Linux gate; no live Umami exists yet)**

The ERP reads gaiada.com's analytics from Umami 3.4.0 over WireGuard through the GET-only read gate (`infra/runbooks/umami-sumopod.md`) with a team view-only user's API key. Two env vars, read by `umami-client.ts` on every call: `UMAMI_BASE_URL` (e.g. `http://10.88.0.2:18743`) and `UMAMI_API_KEY` (Bearer); optional `UMAMI_TIMEOUT_MS` (default 10000). Compose must pass both through `environment:`. A property is bound to its Umami website by `search_properties.umami_site_id` (migration 0034).

| Status | Method | Path | Authz / notes |
|---|---|---|---|
| PROTOTYPED | GET | `/api/:t/modules/search/properties/:propertyId/analytics/:kind?from=YYYY-MM-DD&to=YYYY-MM-DD` | Cerbos `resource_search_property · read` (existing kind and action, no policy change), then `withTenants([t],{modules:['search']})`: another company's property id is 404, a principal outside the tenant is refused. `kind` is `summary \| pages \| sources \| sections \| ctas \| forms \| vitals` (else 404). `from`/`to` are UTC days, inclusive, default the 30 days ending today, at most 400 days (else 400). |
| PROTOTYPED | GET | `/api/:t/modules/search/properties/:propertyId/analytics/:kind/range/:from/:to` | Same read, range in the path (the MCP hub forwards only path params on a GET). |

**Response (always 200 for these four states):** `{ state, kind, range:{from,to}, message?, data? }`. `state` is `ok` (carries `data`), `not_configured` (env unset), `not_bound` (property has no `umami_site_id`), `unreachable` (timeout, network, 5xx), `rejected` (Umami 401/403/404). Every non-ok state carries a plain-words `message` and no `data`: the UI must show it, never an empty dashboard.

**Small-cell suppression (visitor addendum R-V6):** every count under 5 is the string `"<5"`, never the number. `bounceRate`, `avgVisitSeconds` and `reachPct` are `null` when their cell is suppressed. Suppression happens in `umami-reads.ts`, so the BFF, the MCP tools and the UI all inherit it.

**`data` by kind:** `summary` `{visitors,visits,pageviews,bounceRate,avgVisitSeconds}`; `pages` `[{label,count}]` (top 20); `sources` `{referrers:[{label,count}], aiSearch:{total, hosts:[{label,count}]}}` (AI search = referrer host or subdomain of chatgpt.com, perplexity.ai, gemini.google.com, copilot.microsoft.com, claude.ai); `sections` `[{sectionId,views,reachPct}]` (`section_view` by `section_id`, reach = views / page views); `ctas` `[{label,count}]` (`cta_click` by `link_location`); `forms` `[{formId,lead_form_start,lead_form_step,lead_form_send,generate_lead}]` (by `form_id`); `vitals` `{byMetric:[{label,count}], byRating:[{label,count}]}` (`web_vitals` by `metric_name` and, separately, `metric_rating`; Umami's values endpoint groups one property at a time, so rating is not split per metric). The event names and parameters are the site's contract, `gaiada-web-revamp/src/scripts/tracking/events.ts`.

**MCP tools (read-only, no `impact` field, same as the other search reads):** `search.analyticsSummary`, `analyticsPages`, `analyticsSources`, `analyticsSections`, `analyticsCtas`, `analyticsForms`, `analyticsVitals`, each `GET .../analytics/<kind>/range/:from/:to` with `tenantId, propertyId, from, to`.

**Umami v3.4.0 endpoints used** (source read at tag v3.4.0): `GET /api/websites/:id/stats?startAt&endAt` (`{pageviews,visitors,visits,bounces,totaltime,comparison}`), `GET /api/websites/:id/metrics?type=path|referrer&startAt&endAt&limit` (`[{x,y}]`), `GET /api/websites/:id/event-data/values?eventName&propertyName&startAt&endAt` (`[{value,total}]`, top 100). Times are epoch milliseconds.

**platform-ui:** Website workspace tab **Analytics** (`/departments/:deptId/website/analytics[/:tenant/:site]`, `?from&to`). The site's environment domains are matched to a search property's `domain` (`www.` ignored); no match is said in words. `lib/websiteAnalytics.ts` validates every body (`parseAnalyticsRead`); a raw number under 5 or an off-shape body is contract drift, shown as a defect notice, never as data.

## 28a. Content-decay findings (M5-V4, 2026-10-12) — `platform-nest/src/modules/search/content-decay*.ts`, migration `202610122200_search_decay_findings.sql` — **STATUS: PROTOTYPED (typechecked + unit-tested locally; the DB-backed suite `content-decay.db.test.ts` is written and needs the Linux gate; the job has never run against a live property)**

Pages of a verified, active search property that are losing Search Console clicks / impressions / position or Umami page views, found by a daily job and kept as rows (`search_decay_findings`, FORCE RLS, `search` module scope). No UI here: the writer dashboard (M5-W8) shows them. Authz is the existing `resource_search_property` kind (no new kind, no policy change); rows are reached through `withTenants([t],{modules:['search']})`, so another company's property or finding id is 404 and a principal outside the tenant is 403.

| Status | Method | Path | Authz / notes |
|---|---|---|---|
| PROTOTYPED | GET | `/api/:t/modules/search/properties/:propertyId/decay[?status=live\|all\|open\|acknowledged\|resolved\|refresh_brief_filed]` | `resource_search_property · read`. Default `live` = open, acknowledged and refresh-brief-filed (newest first, at most 200). Unknown `status` is 400. |
| PROTOTYPED | POST | `/api/:t/modules/search/properties/:propertyId/decay/:findingId/acknowledge` | `resource_search_property · update`. open to acknowledged; idempotent on acknowledged; a resolved or brief-filed finding is 409. Impact LOW. |
| PROTOTYPED | POST | `/api/:t/modules/search/properties/:propertyId/decay/:findingId/refresh-brief` | `resource_search_property · update`. Creates one `search_content_briefs` row (status `draft`, `drafted_via` `fallback`: a fixed template from the page path and the reason, no AI call; `grounding.source = "content_decay"`) and sets the finding to `refresh_brief_filed` with `brief_id`. Idempotent: a second call returns the same `briefId` with `created:false`. A resolved finding is 409. Does not touch M5-W4's WebDesk draft-link columns. Impact LOW. |

**Finding:** `{ id, pagePath, status, reason, reasons:[{metric, basis, recent, baseline, drop, dropPct}], window:{from,to,days}, briefId, detectedAt, acknowledgedAt, resolvedAt }`. `pagePath` has no host, query string or fragment. `metric` is `clicks | impressions | position | views`; `basis` is `prior_period` (last 28 days vs the 28 before, confirmed against the same window last year when that exists, so a seasonal dip is not flagged) or `year_ago` (slow decay). `reason` is the same in words with counts only. **Small cells (R-V6):** a `views` figure under 5 is `"<5"` (`recent`) with `drop` and `dropPct` null, and the words say "fewer than 5". A page keeps at most one live finding; a recovered page is moved to `resolved` by the job.

**MCP tools:** `search.listDecayFindings` (read, `GET .../decay`), `search.acknowledgeDecayFinding` (write, impact `low`), `search.fileRefreshBrief` (write, impact `low`); writes are `minAssurance: verified` like every search write.

**The job (`content-decay-job.ts`):** runs only when `SEARCH_DECAY_ENABLED` is exactly `1` (compose passes it through `environment:` with an empty default; empty or anything else is OFF). `SEARCH_DECAY_INTERVAL_MS` (empty, junk or under 60000 falls back to one day). It reads our own `search_gsc_performance` rows (real data only, `simulated = false`; a window needs rows on at least 14 of its days) and Umami `metrics?type=path` through the existing GET-only client (three reads per Umami-bound property). A window the source cannot measure is null and never alerts. Thresholds are named constants in `content-decay.ts` (`DECAY_THRESHOLDS`). New findings ring one bell (`search.decay.found`) per property owner per window with finding ids, page paths and the reason; a failed bell never loses a finding.

## 28c. AI-crawler log and AI-visibility panels (M5-P5b, 2026-10-13) — `platform-nest/src/modules/search/ai-crawler*.ts`, migration `202610131500_search_ai_crawler_log.sql` — **STATUS: PROTOTYPED (typechecked + unit-tested locally; the DB-backed suite `ai-crawler.db.test.ts` is written and needs the Linux gate; nothing has ever been shipped from a real server)**

Daily counts of AI-crawler requests (GPTBot, ClaudeBot, PerplexityBot, ...) read from a site's web-server access log, and the SM-16 AI-visibility results (`search_ai_visibility`, already written by `ai-visibility.ts`), shown on the Website workspace's Analytics tab. Authz is the existing `resource_search_property` kind (no new kind, no policy change); rows are reached through `withTenants([t],{modules:['search']})` (tables `search_ai_crawler_daily`, `search_ai_crawler_chunks`, FORCE RLS, `search` scope), so another company's property is 404 and a principal outside the tenant is 403.

**Privacy.** Only requests whose User-Agent contains a token of the allow-list (`ai-crawler-bots.ts`, with each vendor's documentation source) are kept; every other line is dropped. What is stored per row: UTC day, bot id, URL path (no query string, no fragment, at most 512 chars), HTTP status, a verification flag, a hit count. The raw line, the IP, the User-Agent string and the referrer are never stored or returned or logged; the IP is used in memory, only to ask the verifier. Robots-only tokens (Google-Extended, Applebot-Extended) are never a User-Agent, so they are listed but cannot appear in a log.

| Status | Method | Path | Authz / notes |
|---|---|---|---|
| PROTOTYPED | POST | `/api/:t/modules/search/properties/:propertyId/ai-crawlers/ingest` | body `{log: string}` (non-empty, at most 900000 characters; nginx/Apache combined or Caddy JSON lines) → 200 `{chunk: "new"\|"duplicate", rows, stats: {linesSeen, malformed, dropped, kept, outOfRange, overflow} \| null, verification: "claimed"\|"ranges"}`. `resource_search_property · update`. Impact MEDIUM. Idempotent: the SHA-256 of the chunk (CRLF/blank lines normalised) is recorded per property in the same transaction as the upsert, so the same chunk again is `duplicate` and changes nothing. Bad body or id 400, unknown property 404. |
| PROTOTYPED | GET | `/api/:t/modules/search/properties/:propertyId/ai-crawlers/summary[?from=&to=]` | `resource_search_property · read`. Default range: the 30 days ending today (UTC); at most 400 days; a bad date is 400. |
| PROTOTYPED | GET | `/api/:t/modules/search/properties/:propertyId/ai-crawlers/summary/range/:from/:to` | Same read with the range in the path (the MCP hub forwards only path params on a GET). |
| PROTOTYPED | GET | `/api/:t/modules/search/properties/:propertyId/ai-visibility-summary` | `resource_search_property · read`. The newest `search_ai_visibility` row per (engine, query) and whether it changed against the one before. |

**Summary body.** `{state: "ok", range, coverage:{firstDay,lastDay}, totalHits, byDay:[{day,bot,hits}], byBot:[{bot,hits,verified,unverified,claimed}], topPaths:[{path,hits}] (20), statusMix:[{status,hits}]}`; or `{state: "no_data", message, range, coverage}` (nothing ever ingested for the property) or `{state: "no_data_in_range", message, range, coverage}` (data exists, none in the range): words, and no numbers at all. A day with no row is absent from `byDay` (the UI shows it as a measured 0 only inside the log's coverage and says so). `verification` is `claimed` (verification off, or no published ranges for that bot), `verified` (the request's address is inside the vendor's ranges) or `unverified` (named the bot, came from outside them).

**Visibility body.** `{state: "ok", lastCapturedAt, anySimulated, engines:[{engine,queries,mentioned,cited,changed}], latest:[{engine,query,brandMentioned,cited,citedUrl,prominence,capturedAt,simulated,changed}]}` or `{state: "no_data", message}`. Rows from the simulated provider mode carry `simulated: true`; the UI badges them and never hides them (the SM-16 law). Note: the existing raw-history route `GET properties/:id/ai-visibility` is gated on `resource_search_audit`; this summary is gated on `resource_search_property · read`, as the Website workspace's other reads are.

**Verification (pluggable).** `AI_CRAWLER_RANGES_FILE` names a JSON file `{ "<bot id>": ["<CIDR>", ...] }` that ops builds from the vendors' published lists (not bundled: they change). Unset or unreadable = verification off (every row `claimed`). A bot absent from the file stays `claimed`. A different strategy (reverse DNS, a vendor API) is another `CrawlerVerifier` passed to `aggregateAiCrawlerLog`; the pure function is also what a cron can call. Shipping recipe: `infra/runbooks/ai-crawler-log.md`.

**MCP tools** (`ai-crawler-mcp-tools.ts`): `search.aiCrawlers.ingest` (write, impact `medium`, `minAssurance: verified`), `search.aiCrawlers.summary` (read, the path-range route), `search.aiVisibility.summary` (read). **UI consumer:** `platform-ui/src/lib/aiVisibility{,Model}.ts` (the STRICT parser: a count that is not a whole number, an unknown state or a mistyped row is a defect shown as such, never an empty panel), `components/webdesk/analytics/AiVisibilityView.tsx`, page `…/website/analytics/[tenant]/[site]/ai-visibility`, linked from the Analytics page. Panels: hits over time by bot (stacked days with the table behind it), by bot (verified / unverified, `n/a` when verification is off), most crawled pages, what the site answered (served / redirected / blocked 401-403-429 / other 4xx / 5xx), AI-answer mentions and citations by engine and the latest result per query. The two reads are independent: one failing says so in its own section only.

## 28b. Ad-platform conversion uploads for lead stage changes (M5-P2, 2026-10-13) — `platform-nest/src/modules/search/conversions*.ts`, migrations `202610131200_search_conversion_uploads.sql` and `202610131210_automation_approvals_origin_search.sql` — **STATUS: PROTOTYPED (typechecked + unit-tested locally, including a driven consumer loop with an in-memory Redis; the DB-backed suite `conversions.db.test.ts` is written and needs the Linux gate; only SIMULATE has ever run, nothing has been sent to Google)**

When a lead changes stage, the search module can upload that conversion to Google Ads (click conversions for a `gclid` / `gbraid` / `wbraid`, and enhanced conversions for leads from a hashed email or phone). Design: `docs/plans/2026-10-11-m5-lead-pipeline-design.md` §8. The flow has no UI endpoint that uploads anything: `agency.lead.stage_changed` (ids and stages only) reaches `searchModule.eventHandlers` through the `agency_lead` stream (main.ts lists it), the handler **plans** (gate, ledger claim, ONE WS4 approval per claim), and a human's decide on the approval **executes** it in-band as the decider. Authz is the existing `resource_search_property` kind (no new kind, no policy change). Rows are reached through `withTenants([t],{modules:['search']})`, so another company's property is 404 and a principal outside the tenant is 403.

| Status | Method | Path | Authz / notes |
|---|---|---|---|
| PROTOTYPED | GET | `/api/:t/modules/search/properties/:propertyId/conversion-targets` | `resource_search_property · read`. `{propertyId, targets:[{id, propertyId, webSiteSlug, platform, stage, conversionKey, conversionAction, sendValue, enabled, mode, updatedAt}]}`. `mode` is `simulate` unless the platform is in `SEARCH_CONVERSIONS_LIVE_PLATFORMS`. |
| PROTOTYPED | POST | `/api/:t/modules/search/properties/:propertyId/conversion-targets` | `resource_search_property · update`; authorized BEFORE the body is read. Idempotent upsert on (site slug, platform, stage): body `{webSiteSlug, platform:"google_ads"|"meta_capi"|"linkedin_capi", stage, conversionKey, conversionAction, sendValue?:false, enabled?:true}` returns 200 `{target, created}`; `conversionAction` is per platform (see 28b.1). Typed 400 `reason`: `web_site_slug_invalid`, `platform_unknown`, `platform_unsupported` (a platform without an adapter; none today), `stage_unknown`, `conversion_key_invalid`, `conversion_action_invalid`, `send_value_invalid`, `enabled_invalid`. 404 for a property outside the tenant. 409 `target_owned_by_other_property`. Impact LOW: it sends nothing by itself. |
| PROTOTYPED | GET | `/api/:t/modules/search/properties/:propertyId/conversion-uploads[?leadId=&status=&limit=]` | `resource_search_property · read`. The ledger, newest first, at most 200. Unknown `status` or malformed `leadId` is 400. |
| PROTOTYPED | GET | `/api/:t/modules/search/leads/:leadId/conversion-uploads` | `resource_search_property · read` (tenant level). **This is what the pipeline card's empty "Ad platform uploads" slot reads** (the UI is a later ticket). |

**Upload row (ledger):** `{id, propertyId, platform, leadId, stageEventId, stage, conversionKey, dealValue, dealCurrency, status, reason, mode, approvalId, outcome, occurredAt, createdAt}`. `status`: `pending_approval | executing | simulated | uploaded | failed | rejected | skipped`. `reason` is a typed token (why skipped or how it failed). `outcome` is `{platform, conversionKey, conversionAction, orderId, conversionDateTime, identifierFields, identifierKinds, valueSent, currency, consent, partialFailure}`: kinds and field names, never a value. **Nothing returned here, stored in the ledger, put in the approval's `tool_args` / `reason` / `execution_result`, emitted in an outbox event, written to the activity log or logged is an email, phone, name, hash of either, or click id.** Skip reasons: `lead_not_found`, `lead_deleted`, `consent_not_given` (marketing false), `consent_unknown` (absent, null, malformed or `"true"`: only the boolean `true` is consent), `suppressed` (G5's `ad_upload` scope), `no_identifier`, `already_claimed` (the same submission and conversion key already hold a claim), `target_disabled`; a refused approval closes its row `rejected` with `approval_rejected`.

**The approval (WS4).** One `automation_approvals` row per claimed upload: `origin: "search"`, `workflow_id` and `tool_name` `search.conversions.upload`, impact `high`, `requested_by` the person (or agent principal) who moved the stage, `tool_args` exactly `{ledgerId, propertyId, leadId, stageEventId, platform, conversionKey, stage, dealValue, dealCurrency, contentHash}` (the hash binds the ids, platform, key, value and currency; a changed ledger row or a stray key refuses at execution). The existing `POST /api/:t/automation-approvals/:id/decide` decides it. The decider needs the generic `decide` AND `resource_search_property · update` on the row's property (rejecting needs the same). On `approved`, the response gains `conversionUpload: {ledgerId, platform, mode, status: "simulated"|"uploaded"|"failed"|"skipped", reason?, identifierKinds?}` (additive; absent for every other approval). The gate runs again under a lock at that moment; a lead whose consent was withdrawn, who was suppressed or erased, or whose record is gone since is `skipped` and nothing is sent. A send is made at most once per approval: after an ambiguous answer the row is `failed` and D14's Retry sends nothing (that executor refuses any origin outside automation|agent; `search.conversions.upload` is also BARRED in `core/approval-executables.ts`).

**Inbox.** `search` is an existing inbox origin (probe consent); it now also carries these rows (`platform-ui/src/lib/approvalsShared.ts` relabels the chip "Consent & ad uploads"). The DB CHECK on `automation_approvals.origin` did not list `search`; migration `202610131210` adds it with the `202610101500` catalog-read idiom (nothing re-declared).

**Mode.** `SEARCH_CONVERSIONS_LIVE_PLATFORMS` (default empty = every platform simulates; e.g. `google_ads`), separate from `SEARCH_ADS_WRITE_MODE`. Boot refuses a listed platform with no registered live uploader, and an unknown token. Live also needs the Google Ads developer token, a linked Ads account on the property, gate G2 and the O-8 access audit, none of which exist yet.

**MCP tools:** `search.listConversionTargets` (read), `search.setConversionTarget` (write, impact `low`, `verified`), `search.listConversionUploads` (read), `search.listLeadConversionUploads` (read).

### 28b.1 Meta Conversions API and LinkedIn Conversions API (M5-P3 and M5-P4, 2026-10-13) — `conversions-meta.ts`, `conversions-linkedin.ts`, `conversions-uploaders.ts` — **STATUS: PROTOTYPED (typechecked + unit-tested locally; the DB-backed suite `conversions-meta-linkedin.db.test.ts` is written and needs the Linux gate; SIMULATE-ONLY: nothing has ever been sent to Meta or LinkedIn, and neither has a live uploader)**

Both are adapters on the P2 framework above: same event, same gate, same ledger and claim, same ONE WS4 approval per claimed upload, same in-band execution at decide(). No new route, MCP tool, Cerbos kind, permission or migration (the `platform` CHECKs of `search_conversion_targets` and `search_conversion_uploads` already admitted `meta_capi` and `linkedin_capi`). What changed on the wire is additive: the config route and `search.setConversionTarget` accept the two new `platform` values, and the ledger `outcome` for them is the summary below.

**Config (`POST .../conversion-targets`).** `conversionAction` per platform, typed 400 `conversion_action_invalid` otherwise:
- `google_ads`: a conversion action id or `customers/{id}/conversionActions/{id}` (unchanged).
- `meta_capi`: the Meta **event name**: a letter, then letters, digits and underscores, at most 50 (`Lead`, `Purchase`, `qualified_lead`).
- `linkedin_capi`: the conversion **rule** id, or its URN `urn:lla:llaPartnerConversion:{id}` (a bare id is expanded).

**Identifier rules (the gate, design §8.4).** Consent first (strictly `visitor_consent.marketing === true`), then suppression, then a usable identifier, per platform: **Meta** needs an email (`em`), a phone with a country code (`ph`), `attribution.fbc` or `attribution.fbp`; **LinkedIn** needs an email or `attribution.li_fat_id`. None usable is `skipped` with `no_identifier`. `fbc`, `fbp` and `li_fat_id` are browser identifiers: they count, and ride, only with marketing consent (the builders re-check it even though the gate already did). Google's click ids are never Meta or LinkedIn identifiers.

**Meta request (what simulate records and a live call would send).** `{data:[{event_name, event_time (unix seconds), event_id, action_source:"website", user_data:{em:[sha256], ph:[sha256], fbc, fbp}, event_source_url?, custom_data?:{value, currency}}]}`. `em` is trimmed and lower-cased (no gmail dot rule); `ph` is digits only with the country code, no `+`, no leading zeros, and a national number ("0812...") is never guessed at; both SHA-256 hex. `fbc`/`fbp` are NOT hashed and must match `fb.<0-2>.<ms>.<value>`. **`event_id`** is the bare submission id when the event is the platform's own Lead (event name `Lead` AND conversion key `lead`: the browser Pixel's `Lead` carries eventID = submission id, so Meta merges the two), otherwise `${submissionRef}:${conversionKey}`. `event_source_url` is the property's `site_url` origin plus `attribution.form_page` (a path), omitted when either is missing. `custom_data` rides only when the target's `sendValue` is true AND the stage is `won` AND the ledger row has a value; `currency` is the ISO code lower-cased.

**LinkedIn request.** One `conversionEvents` element: `{conversion:"urn:lla:llaPartnerConversion:{id}", conversionHappenedAt (epoch ms), eventId, user:{userIds:[{idType:"SHA256_EMAIL", idValue}, {idType:"LINKEDIN_FIRST_PARTY_ADS_TRACKING_UUID", idValue:li_fat_id}]}, conversionValue?:{currencyCode, amount (decimal string)}}`. Email is trimmed, lower-cased, SHA-256 hex; `li_fat_id` is passed as the site captured it. `eventId` is the bare submission id for conversion key `lead`, else `${submissionRef}:${conversionKey}`. `conversionValue` rides only on `won` with `sendValue` and a ledger value, as for Meta.

**Ledger `outcome` for these platforms** (names and kinds, never a value, never a hash): Meta `{platform, conversionKey, eventName, eventId, eventTime, actionSource, identifierFields, identifierKinds, valueSent, currency, eventSourceUrlSent, mergesWithPixelLead}`; LinkedIn `{platform, conversionKey, conversion, eventId, conversionHappenedAt, identifierFields, identifierKinds, valueSent, currency, mergesWithInsightTag}`. `identifierKinds` values: `email`, `phone`, `fbc`, `fbp`, `li_fat_id` (plus Google's `gclid`, `gbraid`, `wbraid`). A target whose stored action the platform cannot take is `skipped` with the new typed reason `conversion_request_invalid` (nothing sent, claim released). The approval, its `tool_args`, the outbox and the logs are unchanged and still carry no personal data.

**Mode.** SIMULATE-ONLY. `SEARCH_CONVERSIONS_LIVE_PLATFORMS` listing `meta_capi` or `linkedin_capi` makes boot REFUSE to start (no live uploader is registered; the error says SIMULATE-ONLY). Live Meta also needs Business Verification (plan O-7), a dataset (pixel) id and an access token; live LinkedIn needs an OAuth token with `rw_conversions` for the ad account. Where those credentials live is an open contract question (see the report on this ticket); until it is answered neither platform can be switched on.

**UNVERIFIED until staging acceptance:** every request shape and field name above is from the vendors' documentation, not from a live call. Two known doubts: Meta documents `client_user_agent` as required for `action_source: "website"` and this system stores no user agent; and the lower-case currency.

**The LinkedIn Insight tag (SITE work, NOT built here; this is the contract the site must meet).** The tag is the browser half that gives the ERP a `li_fat_id` to send and lets a form-submit conversion merge with the server copy.
1. Load `snap.licdn.com/li.lms-analytics/insight.min.js` and set `_linkedin_partner_id` **only after the visitor grants MARKETING consent** (the banner's `marketing` category, the same gate as the Meta Pixel; not on analytics consent, not before any choice, and not at all when consent is later withdrawn: stop the tag and clear the `li_fat_id` cookie, as the Pixel path does).
2. On a form submit, read the `li_fat_id` first-party cookie and put it in the submission's `attribution.li_fat_id` (the contract in the common M5 brief: `<= 200` chars, present only with marketing consent; WebDesk stores it in `submissions.attribution`). Without marketing consent the member is absent.
3. To merge a browser-side conversion with the ERP's, fire `window.lintrk('track', {conversion_id: <rule id>, event_id: <submission id>})` on the successful submit (the same bare submission id the ERP uses as `eventId` for conversion key `lead`). The ERP's own `lead_won` and later-stage conversions use `${submissionId}:${conversionKey}` and never collide with it.
4. Nothing else about the visitor goes to LinkedIn from the site beyond what the Insight tag itself collects once consented.

## 28d. IndexNow on publish and the Bing Webmaster connector (M5-P5a, 2026-10-12) — `platform-nest/src/modules/search/indexnow*.ts`, `bing-*.ts`; migrations `202610130200_search_indexnow_bing.sql`, `202610130210_integration_connections_bing_provider.sql` — **STATUS: PROTOTYPED (typechecked + unit-tested locally; `indexnow.db.test.ts` is written and needs the Linux gate; nothing has been run against api.indexnow.org, a real site or a real Bing account)**

When WebDesk publishes (or takes down) pages of a site whose `search_properties` row is verified and has IndexNow enabled, the page URLs are posted to IndexNow; a property with only a Bing key linked is submitted through Bing's URL Submission API instead. Bing Webmaster stats (query and page rows) are pulled into `search_bing_performance`. Authz is the existing `resource_search_property` kind (no new kind, no policy change); rows are reached through `withTenants([t],{modules:['search']})`, so another company's property id is 404 and a principal outside the tenant is 403. Authorization runs before the body is read.

| Status | Method | Path | Notes |
|---|---|---|---|
| PROTOTYPED | GET | `/api/:t/modules/search/properties/:propertyId/indexnow` | `resource_search_property · read`. `{propertyId, platformEnabled, enabled, propertyVerified, hasKey, keyVerifiedAt, keyLocation, bingConnected, last7Days:{<status>:n}, recent:[{id, engine, url, transition, status, attempts, errorCode, sentAt, createdAt, simulated}]}` (20 most recent). |
| PROTOTYPED | GET | `…/indexnow/key` | `read`. The key file the site build must serve: `{propertyId, key, fileName, location, fileBody, contentType, enabled, verifiedAt}`. 404 `indexnow_key_missing` until generated. The key is public by protocol design (it is served in clear), so this read needs no more than `read`. |
| PROTOTYPED | POST | `…/indexnow/key` | `update`. Body `{rotate?: boolean}`. Idempotent: 201 `{created:true, …key}` the first time, 200 `{created:false}` after; `rotate:true` replaces the key (`rotated:true`) and switches IndexNow OFF until the new key file is proven. Impact LOW. |
| PROTOTYPED | PATCH | `…/indexnow` | `update`. Body `{enabled: boolean}`. Enabling needs the server flag, an active verified property, a key, an https site_url, and **fetches `https://<host>/<key>.txt` back from the site** (https only, public host, no redirects). Refusals are 409 with `reason`: `indexnow_platform_disabled`, `property_not_verified`, `indexnow_key_missing`, `site_url_invalid`, `indexnow_key_file_unreachable` (`existing:{check, location, httpStatus?}`; `check` is `site_url_not_https`, `host_not_public`, `host_unresolvable`, `unreachable`, `timeout`, `redirected`, `not_found`, `bad_status`, `too_large` or `key_mismatch`), `indexnow_key_changed`. Disabling always works. Impact LOW. |
| PROTOTYPED | POST | `…/indexnow/submit` | `update`. Body `{urls: string[]}` (1..100): paths or absolute URLs on the property's own origin. `{propertyId, engine, accepted, duplicates, rejected:[{index, reason}], dispatch:{sent, retrying, rejected, gaveUp, deferred}}`. 400 `url_not_on_property` (`existing.rejected`) when none belong; 409 `indexnow_platform_disabled` / `no_submission_channel`; **429 `rate_limited` beyond 300 URLs per property per hour**. Idempotent within the UTC hour. Impact LOW. |
| PROTOTYPED | POST | `…/indexnow/notify` | `update`. Body `{transition: "publish"\|"unpublish", ref?: string(<=80), items:[{slug, locale, defaultLocale, routePattern?, localized?, version?}]}` (1..200). The route twin of the in-process hook, for callers that learn of a publish elsewhere (the unpublish BFF, the scheduler, n8n). Each item's page URL is `site origin + pagePathFor(routePattern, …)`; an item with no usable route pattern is **skipped with a reason** (`no_route_pattern`, `bad_route_pattern`, `slug_not_routable`, `locale_not_routable`). `{status, propertyId, engine, urls, skipped:[{itemIndex, reason}], duplicates, dispatch?}`; `status` is `disabled`, `no_property`, `property_not_verified`, `not_enabled`, `nothing_to_send` or `queued`. Idempotent per (property, engine, url, version) where version is `<transition>:v<N>:<ref>`: replaying a `ref` sends nothing twice (with no `ref` the UTC hour is used, so a retry within the hour is a duplicate and a later call is a new fact). Impact LOW. |
| PROTOTYPED | GET | `…/bing` | `read`. `{propertyId, connected, mode:"live"\|"simulate", lastPulledAt, rows:{real, simulated}}`. |
| PROTOTYPED | POST | `…/bing` | `update`. Body `{apiKey}` (16..128 letters/digits). The key is sealed in the credentials vault (`integration_connections`, provider `bing_webmaster`, owner_kind `client`, owner_id = the property's client) and **never returned or logged**. `{propertyId, connectionId, mode, verifiedWithBing}`. Live mode proves the key first (the site must be listed and verified in that Bing account): 409 `bing_key_rejected` / `bing_site_not_in_account` / `bing_site_not_verified`, 502 `bing_unreachable`; nothing is stored on a refusal. 400 `bing_key_malformed`. **Impact MEDIUM** (it stores a credential). |
| PROTOTYPED | DELETE | `…/bing` | `update`. Unbinds the property; revokes the vault row (token nulled) when no other property of the client still uses it. `{propertyId, disconnected, revoked}`. Impact LOW. |
| PROTOTYPED | POST | `…/bing/pull` | `update`. Body `{days?: 1..180}` (default 28). Idempotent per row (re-pulling a window converges). 409 `bing_not_connected`, `bing_key_rejected`; 502 `bing_unreachable`, `bing_bad_response`. `{propertyId, mode, simulated, window:{from,to}, fetched, written}`. Impact LOW. |
| PROTOTYPED | GET | `…/bing/performance[?kind=query\|page&from&to&limit]` and `…/bing/performance/:kind/:from/:to` | `read`. `kind` is `query`, `page` (or `all` in the path form; the hub forwards only path params on a GET). `{propertyId, window, mode, totals:{clicks, impressions}, rows:[{date, kind, key, clicks, impressions, avgClickPosition, avgImpressionPosition, simulated}]}`; default window 28 days, `limit` 1..500 (default 100). Every row carries `simulated`; read it before trusting a figure. |

**Typed errors.** The app's error filter forwards `error`, `reason` and `existing` only, so a refusal's structured detail travels under `existing`.

**The trigger.** A CORE event handler for `automation_approval.decided` (registered from `main.ts` by `registerIndexNowEventHandlers()`, beside the core approval executor; the `automation_approval` stream is already drained). It is deliberately not in `searchModule.eventHandlers`: the search module registers NO `automation_approval.decided` handler (pinned by `search-sem-apply.test.ts` and `probe-consent.test.ts`, because its other approval path spends a client's ad budget). A core handler is not gated by the module registry, so it checks the tenant has `search` on itself. It acts only on an APPROVED `content.publish` approval of origin `webdesk`, and the event is a hint, not data: it waits for the approval's `execution_status` to be `executed` (throws while pending/executing so the bus redelivers), re-reads each item from WebDesk (`item.get`: live at the approved version), reads the collections' `ui.routePattern` (`collection.list`), the tenant's default locale and the site's environment domains (the cross-company wall), then calls `notifyContentChange`. **Not covered by that event, and so not wired in this ticket:** an unpublish (BFF) and a scheduled publish or takedown (`schedule.fired`). They reach the same pipeline through `POST …/indexnow/notify` or an in-process `notifyContentChange` call from `webdev/` (see the ticket report).

**The ledger (`search_indexnow_submissions`).** One row per (property, engine, url, version), inserted `ON CONFLICT DO NOTHING`; only rows inserted by an event are sent by it, so a redelivered event sends nothing. `status`: `pending`, `sent`, `failed`, `gave_up`, `rejected`. Batches of 500 URLs; a rolling cap of 5000 accepted URLs per property and engine per 24 h (beyond it rows stay `pending` and are deferred an hour, never dropped). 200/202 = accepted; 429, 408, 5xx and network failures retry with backoff 60 s x 2^attempts (cap 6 h; `Retry-After` honoured) up to 6 attempts, then `gave_up`; 400/403/422 and other 4xx are `rejected` (a retry cannot fix them). A claim is a 5-minute lease (`FOR UPDATE SKIP LOCKED`), so the event handler and the sweep never send the same rows. `error_code` is a typed token; a response body is never stored or logged.

**Flags.** `SEARCH_INDEXNOW_ENABLED` must be exactly `1` (compose passes it through `environment:` with an empty default; empty or anything else is OFF). Off, no entry point reads a row or sends a byte; the routes that would send answer 409 `indexnow_platform_disabled`. The retry sweep (`startIndexNowRetryLoop`, every 5 minutes) starts only with the flag on. `SEARCH_BING_MODE`: only `live` calls Bing; anything else is SIMULATE (synthetic, deterministic rows stamped `simulated = true`, no network). The Bing API key is never an env var.

**What the site build must do.** At build or deploy, call `GET …/indexnow/key` (service token) and write `fileBody` (exactly the key; one trailing newline is tolerated) to `<publicDir>/<fileName>` so it is served at `location` (`https://<host>/<key>.txt`, over https, 200, no redirect, `text/plain`). Only then does `PATCH …/indexnow {enabled:true}` succeed. The site's `site_url` in `search_properties` must be the canonical origin the site answers on (a `www` redirect makes the proof fail with `redirected`).

**Egress.** Two new approved files in `egress-inventory.test.ts`: `indexnow.ts` (POST `https://api.indexnow.org/indexnow`; GET the property's own key file) and `bing-client.ts` (`https://ssl.bing.com/webmaster/api.svc/json/…`; the key is a query parameter, so no error or log line is ever built from the URL).

**MCP tools** (`indexnow-mcp-tools.ts`): reads `search.getIndexNowStatus`, `search.getIndexNowKey`, `search.getBingStatus`, `search.listBingPerformance`; writes `search.generateIndexNowKey`, `search.setIndexNow`, `search.submitUrls`, `search.notifyContentChange`, `search.disconnectBing`, `search.pullBing` (impact `low`) and `search.connectBing` (impact `medium`); every write is `minAssurance: verified`.

**Unverified (no real counterpart was available):** the Bing Webmaster field names and the `{d: …}` envelope (taken from Microsoft's published reference), IndexNow's 200/202/400/403/422/429 meanings, and Bing's `SubmitUrlBatch` quota semantics. The first live pull and the first live ping are the real test.

## 28e. A/B experiments — pre-registration, results gated by the horizon (M5-V5-c, 2026-10-13) — `platform-nest/src/modules/search/experiments*.ts`, migration `202610131800_search_experiments.sql` — **STATUS: PROTOTYPED (typechecked + unit-tested locally, 69 pure tests; the DB-backed HTTP suite `experiments.db.test.ts` is written and needs the Linux gate; no test has run against a real Umami or WebDesk)**

The ERP side of the design's §5 (docs/plans/2026-10-12-m5-phase5-design.md). WebDesk holds the arms (the `experiment` block, vocabulary 1.5.0), the site counts exposures and conversions in Umami (`exp_exposure` / `exp_convert`, one property `ev = "<key>:<arm>:<c|s>"`), the ERP holds the pre-registration and the decision. Authz is the existing `resource_search_property` kind: `read` for the reads, `update` for every write (no new kind, no policy change). Rows are reached through `withTenants([t],{modules:['search']})`: another company's property or experiment is 404, a principal outside the tenant is 403; authorization runs before body validation. Nothing here writes to WebDesk or Umami, so every write is impact LOW; each public change (publish the block, remove it, merge the winner) stays a normal WebDesk content flow with its own review and WS4 approval. **No UI yet (V5-d).**

Base: `/api/:t/modules/search/properties/:propertyId/experiments`.

| Status | Method | Path | Notes |
|---|---|---|---|
| PROTOTYPED | GET | `…/experiments[?status=all\|draft\|running\|stopped\|aborted\|decided]` | `read`. `{propertyId, experiments: Experiment[]}`, newest first, at most 200. No results in the list. Bad status 400. |
| PROTOTYPED | POST | `…/experiments` | `update`. **Register = the pre-registration** → **201** `{experiment}` (status `draft`). Body: `{key, hypothesis, webdesk:{tenantSlug,siteId,itemId}, sectionId, target?: "fields"\|{block:n}, enrolment?: "consented", goal:{event, match?}, arms:[{key,weight}], baselineRate?, relativeMde}`; unknown members are 400 `unknown_field` (alpha and power are fixed at 0.05 and 0.8). Reads the item from WebDesk (through the cross-company wall) and the last 28 days from Umami (the tested section's `section_view` a day, and the goal's count for a suggested baseline). |
| PROTOTYPED | GET | `…/experiments/:experimentId` | `read`. `{experiment}`. |
| PROTOTYPED | PATCH | `…/experiments/:experimentId` | `update`. Edit a **draft** (`hypothesis, sectionId, target, enrolment, goal, arms, baselineRate, relativeMde`; `baselineRate:null` asks for a fresh suggestion). The plan is recomputed and re-checked. `key` and `webdesk` never change (400 `field_not_editable`). After start: **409 `pre_registration_locked`** (and a trigger refuses the UPDATE in the database). |
| PROTOTYPED | POST | `…/experiments/:experimentId/sync` | `update`. Detects "running" from WebDesk: the item's LIVE version carries the registered block. 200 `{state, differences?, experiment}`; `state` = `started` (`started_at` = the publish: the item's `updatedAt` when nothing was saved since, else the moment of the sync, never before the registration) \| `already_running` \| `not_live` \| `plan_mismatch` (the live block's key/target/enrolment/goal/arms-and-weights differ from the registration: NOT started, `differences` names the members). A closed test is 409 `experiment_closed`. |
| PROTOTYPED | GET | `…/experiments/:experimentId/results` | `read`. See below. |
| PROTOTYPED | POST | `…/experiments/:experimentId/stop` | `update`. Only at the horizon (or the 56-day inconclusive end); before it **409 `horizon_not_reached`**: use abort. 200 `{experiment, results, replayed}`. Then the human removes the block (or merges the winner's override into `fields`) through the normal content flow. |
| PROTOTYPED | POST | `…/experiments/:experimentId/abort` | `update`. Any time before the decision (draft, running, stopped). Records that the test ended; **no outcome is computed**. 200 `{experiment, replayed}`; a decided test is 409 `already_decided`. |
| PROTOTYPED | POST | `…/experiments/:experimentId/decide` | `update`. Body `{note?}` (<= 500). Only a **stopped** test (409 `not_stopped`) whose block is no longer live (409 `experiment_still_live`). Appends the decision snapshot (counts, analysis, decision, who) and closes the test. 200 `{experiment, results, replayed}`; idempotent. |

**Experiment:** `{id, propertyId, key, status, hypothesis, item:{tenantSlug,siteId,itemId,collectionKey,locale}, sectionId, target, enrolment, goal, arms:[{key,weight}], preRegistration:{baselineRate, baselineSource: "supplied"|"umami_28d", relativeMde, alpha, power, nPerArm, dailyUnits, projectedDays, locked}, startedAt, stoppedAt, createdAt, updatedAt}`. `status`: `draft` -> `running` -> `stopped` -> `decided`, or `aborted`. The pre-registration is INPUTS (fixed before the test), not results. `locked` is true from the moment the test leaves draft.

**Refusals (typed: the token leads `error` and is in `reason`):** 400 `unknown_field`, `key_invalid`, `hypothesis_required`, `webdesk_invalid`, `section_id_invalid`, `target_invalid`, `enrolment_invalid`, `enrolment_all_not_enabled` (O6: `all` waits for counsel on F9; switched on only by `SEARCH_EXPERIMENTS_ENROL_ALL=1`), `goal_*_invalid`, `arms_invalid`, `baseline_rate_invalid`, `mde_invalid`, `empty_patch`, `field_not_editable`, `note_*`; **422 `underpowered`** (the projection at the last 28 days' traffic exceeds 56 days; `existing` carries `{projectedDays, maxDays, nPerArm, dailyUnits}`, `projectedDays` null when there was no traffic), 422 `mde_out_of_range`, 422 `baseline_unavailable`; 404 `item_not_found`; 409 `key_taken`, `item_already_registered`, `item_deleted`, `item_already_has_experiment` (a test cannot be pre-registered after it started), **`too_many_running`** (a property keeps at most 10 tests in draft or running; a trigger also refuses an 11th running), `pre_registration_locked`, `horizon_not_reached`, `not_running`, `not_stopped`, `experiment_still_live`, `experiment_closed`, `already_decided`, `analytics_not_bound`; 503 `analytics_not_configured`, `analytics_unreachable`, `analytics_rejected` (a write that needs Umami and cannot reach it refuses rather than guess).

**Results, the horizon rule.** The horizon is reached when EVERY arm has at least `nPerArm` exposures AND at least 14 whole days have passed since `startedAt`; 56 days without it is "inconclusive, keep `a`".
- `{state:"ok", phase:"collecting"|"inconclusive", horizonReached:false, progress, srm, decision?, warnings, window}`: `progress = {perArm:[{key, exposures, target, fraction}], elapsedDays, minDays, maxDays, exposuresReached, minDaysReached}`; `srm = {evaluable, mismatch, message}` (sample ratio mismatch, a data-quality alarm; the chi-square and its p are never returned). **No rate, difference, interval, p-value or conversion count, for any principal**: the body is built field by field, and Umami's `exp_convert` is not even requested before the horizon. `decision` appears only for `inconclusive` (`{action:"keep_control", reason:"inconclusive_at_max_duration"}`).
- `{state:"ok", phase:"horizon", horizonReached:true, progress, srm, analysis, warnings, window}`: `analysis = {control:{key,units,conversions,rate}, comparisons:[{key, units, conversions, rate, difference, ciLower, ciUpper, ciLevel, method:"z"|"fisher", pRaw, pAdjusted, significantWinner}], decision:{action:"ship",arm}|{action:"keep_control",reason}, alpha}` (95 % Newcombe interval, pooled z or Fisher's exact when an expected cell < 5, Holm over the k - 1 comparisons; ship iff adjusted p < 0.05 and the lower bound > 0). A decided test returns its stored snapshot with `decided:{decision, decidedAt, note}` and calls no Umami.
- `{state:"unavailable", reason: "not_configured"|"not_bound"|"unreachable"|"rejected"|"truncated", message}`: Umami down, unbound or a full 100-row page; **never zeros**, no progress. `{state:"not_started"}` for a draft, `{state:"aborted"}` for an aborted test (no outcome ever).
- Every envelope also has `experimentId, key, status, startedAt, stoppedAt`. **Small cells (R-V6):** an exposure or conversion count under 5 is `"<5"`, and a rate whose conversions are suppressed is null.

**MCP tools** (`experiments-mcp-tools.ts`): `search.experiments.list | get | results` (reads, `minAssurance: low`, path params only), `search.experiments.create | update | sync | stop | abort | decide` (writes, impact `low`, `verified`). `update` and `sync` are additions to the design's seven.

**Data** (migration `202610131800`, FORCE RLS with the search wall): `search_experiments` (the pre-registration columns are frozen by a trigger once the test leaves draft, a status machine, a cap of 10 running per property under an advisory lock, one live registration per item) and `search_experiment_results` (append-only; one row per experiment: `decided` with counts/analysis/decision, or `aborted` with nothing). **Known gap:** WebDesk's `item.get` does not expose `last_published_at`, so `started_at` is the item's `updatedAt` only while nothing has been saved since the publish; exposing it is a WebDesk follow-up.
## 28f. Consented visitor profiles — list, detail, interest rules, status (M5-V3-g, 2026-10-13) — `platform-nest/src/modules/search/visitors.{controller,service}.ts`, `visitors-mcp-tools.ts` — **STATUS: PROTOTYPED (typechecked + unit-tested locally; the DB-backed suite `visitors.db.test.ts` is written and needs the Linux gate; the jobs behind it (V3-e) are dark by default and have never run against a real collector)**

Design: `docs/plans/2026-10-12-m5-phase5-design.md` §4.8. The profiles are written only by the V3-e jobs, from the collector's events for visitors whose WebDesk consent log says `analytics:true`. Every route is on `api/:t/modules/search/properties/:propertyId/` and resolves the property through `withTenants([t], {modules:['search']})`, so another company's property id is **404** and a principal outside the tenant is **403**. The recordings routes are V6's and are not here.

**Rules that hold on every route**
- **Cerbos** kind `resource_search_property`, passing `module: "search"` and `tenantId`: `read_visitors` for the reads (V3-f: `module_manager` and `company_admin`; plain `module_staff` keeps aggregate `read` only and gets **403**), `update` for the rules write.
- **Authorize before validating.** A denied caller gets 403 whatever the query or body; an allowed caller with a bad one gets 400 `{error, reason}` (typed `reason`, listed per route).
- **403 and 404 are distinct.** 404 `property not found`, and 404 `visitor_not_found` for a visitor id that is not a consented profile of this property.
- **A score orders a list; nothing acts on it** (R-V1: no decision about a person; manual review before any outreach). The UI must say so.

| Status | Method | Path | Notes |
|---|---|---|---|
| PROTOTYPED | GET | `…/visitors[?minScore&facet&tag&hasLead&seenFrom&order&limit&cursor]` | `read_visitors`. `{propertyId, visitors:[row], nextCursor}`. `order` `score` (default: score, last seen, id, all descending) or `recent`; `limit` 1..50 (default 25). Rows keep the server order: **do not re-sort**. `cursor` is opaque and tied to the `order` that issued it. `facet` `industry`\|`service`, `tag` `[a-z0-9-]{1,40}` (with no facet, either), `hasLead` `true`\|`false`, `seenFrom` an ISO date or time. Reasons: `order_invalid`, `min_score_invalid`, `facet_invalid`, `tag_invalid`, `has_lead_invalid`, `seen_from_invalid`, `limit_invalid`, `cursor_invalid`. |
| PROTOTYPED | GET | `…/visitors/filter/:minScore/:order` | `read_visitors`. The same list, first page, with the two filters in the path: the MCP hub forwards only path params on a GET (`search.visitors.list` binds here). |
| PROTOTYPED | GET | `…/visitors/:visitorId` | `read_visitors`. `{propertyId, visitor}`: the row plus `scoreParts {recency, frequency, depth, intent}`, `scoreMax {25,15,30,30}`, `events` (the latest **200**, newest first: `{occurredAt, kind, path, name, data}`) and `eventsTruncated`. 400 `visitor_id_invalid` for a malformed id (after authorization). |
| PROTOTYPED | GET | `…/visitors/interest-rules` | `read_visitors`. `{propertyId, rules:[{id, match, pattern, facet, tag, weight}], note}`. No rules means no interests, never a guess (the note says so). |
| PROTOTYPED | PUT | `…/visitors/interest-rules` | `update`. Body `{rules:[{match: "path_prefix"\|"section_prefix", pattern (1..200), facet: "industry"\|"service", tag, weight 1..10}]}`: the **complete** set (at most 100; a rule left out is removed; an empty array clears them; a changed weight updates in place). `{propertyId, rules, removed, note}`. Interests and scores follow at the next daily refresh. Reasons: `rules_invalid`, `rules_too_many`, `rule_match_invalid`, `rule_pattern_invalid`, `rule_facet_invalid`, `rule_tag_invalid`, `rule_weight_invalid`, `rule_duplicate`. Writes an activity row (`search_interest_rules`). |
| PROTOTYPED | POST | `…/visitors/interest-rules` | `update`. The same handler as the PUT (the hub has no PUT); `search.visitors.rules.set` binds here. |
| PROTOTYPED | GET | `…/visitors/status` | `read_visitors`. Always 200 with a `state` and words. See below. |

**The row.** `{visitorId, firstSeenAt, lastSeenAt, visits, pageviews, device, country, city, network, company, interests, score, lead}`. `visitorId` is the browser-minted uuid (the UI shows its first 8 characters). `network` and `company` are the latest resolver results with `kind`, `confidence`, `source` and `version`; show Network or Company by `kind`. `interests` is `{industry:[{tag,score}], service:[{tag,score}]}`, the top three per facet.

**The lead link.** A profile's consent id is matched to `agency_leads.visitor_consent->>'consentId'` in the same tenant (the newest lead wins), inside the one `withTenants`. **List rows** carry only `lead: {state:"linked"}` or `{state:"none"}`: no lead id, and no per-row Cerbos probe (a probe per row would write up to 50 denial audit rows per page). **Detail** has `lead` as `{state:"none"}`, `{state:"readable", id}` or `{state:"restricted", message:"a lead you cannot open"}`; the id is returned **only** when the principal may `read` that `agency_lead` (one Cerbos probe on kind `agency_lead`, module `agency`; an acting-for human is intersected too), so one audit row per opened visitor. Otherwise the id appears nowhere in the body. `hasLead` filters on the existence of a link and never reveals who the lead is.

**Status.** `{state, message?, configured, enabled, lastOkIngestAt, lastRunAt, lastOutcome, bots}`. `state` is `ok` or, each with `message` in words and `bots: null`, `not_configured` (the collector address or keys are missing), `disabled` (`SEARCH_VISITORS_ENABLED` is not exactly `1`), `no_website` (the property has no collector website id), `unreachable` (the collector did not answer) or `rejected` (it refused the key or does not know the website). `lastOkIngestAt`, `lastRunAt` and `lastOutcome` (words) come from `search_visitor_ingest_state` whatever the state. `bots` (when `ok`) is `{from, to, days:30, total, byReason}` from the collector's `GET /ops/v1/bots`, counts only. **An empty visitor list is only ever a claim about a working pipeline: show the status first, and never render a non-ok state as "no visitors".**

**MCP tools** (`visitors-mcp-tools.ts`, all on the search module): reads `search.visitors.list` (minScore + order, first page), `search.visitors.get`, `search.visitors.rules.list`, `search.visitors.status`; write `search.visitors.rules.set` (impact **low**: it changes how interests are derived and sends nothing to anyone).

**Egress.** No new class: `readBotCounts` was added to `insights-client.ts`, the one file that talks to the collector (`egress-inventory.test.ts`).

## 28g. Session recordings — list and chunk stream behind `view_replay` (M5-V6-b, 2026-10-13) — `platform-nest/src/modules/search/replays.{controller,service}.ts`, `replays-mcp-tools.ts` — **STATUS: PROTOTYPED (typechecked + unit-tested locally; the DB-backed suite `replays.db.test.ts` is written and needs the Linux gate; the recorder (V6-d) and the collector's replay channel (V6-a) have never run against a real site)**

Design: `docs/plans/2026-10-12-m5-phase5-design.md` §6.3 and §4.8. The ERP keeps **no** copy of a recording: the content lives on the collector (30 days) and is paged through the BFF; the browser never talks to the collector and there is no link, no file and **no download route**. Two routes on `api/:t/modules/search/properties/:propertyId/`, both resolved through `withTenants([t], {modules:['search']})`:

**Rules that hold on both routes**
- **Cerbos** kind `resource_search_property`, action **`view_replay`** (V3-f: `module_manager` and `company_admin`; NOT `read_visitors`, NOT plain `module_staff`), passing `module: "search"` and `tenantId`. The UI hides the Recordings list and the Play buttons for a principal without it (V6-c decides how its `rbac.ts` mirror asks; the server is the authority and answers 403).
- **Authorize before validating.** A denied caller gets **403** whatever the ids or `from`; an allowed caller with a bad one gets 400 `{error, reason}`.
- **403 and 404 are distinct.** 404 `property not found`; 404 `visitor_not_found` (list: no live consented profile for this visitor on this property: never consented, withdrawn, erased or another property's); 404 `recording_not_found` (chunks: unknown, another company's, **or** the recording's visitor has no live profile with that very consent id. These are one answer on purpose, so a recording id reveals nothing).
- **A later page without its opening is 409** `{error, reason:"not_opened"}` with no content (see "The opening" below). The order of checks is fixed: authorize (403), validate (400), live-profile check (404), opening check (409).
- **A collector that cannot answer is a typed 503** `{error, reason}`, with the sentence in `error`, never an empty list. `reason`: `collector_unreachable` (no answer, timeout, 5xx, a body off-contract), `collector_rejected` (it refused the ERP's key or does not know the website), `not_configured` (address or keys missing), `no_website` (the property has no collector website id). Show the sentence; offer Retry. **An empty `recordings` array means the collector answered and there are none.**
- Both responses carry `Cache-Control: no-store`.

| Status | Method | Path | Notes |
|---|---|---|---|
| PROTOTYPED | GET | `…/visitors/:visitorId/recordings` | `view_replay`. METADATA ONLY (MCP `search.replays.list`). 400 `visitor_id_invalid` after authorization. |
| PROTOTYPED | GET | `…/recordings/:recordingId/chunks[?from=N][&opening=<openingId>]` | `view_replay`. The content, one page per call (up to 20 chunks of about 10 s). `from` is the **first chunk seq wanted** (absent or empty = 0; whole number 0..999, else 400 `from_invalid`). `opening` is REQUIRED when `from` > 0 (409 `not_opened` otherwise) and ignored when `from` is absent or 0. 400 `recording_id_invalid`. No MCP tool (O7). |

**List response (200).** `{propertyId, visitorId, recordings:[{recordingId, startedAt, lastChunkAt, durationSeconds, pages:[string], chunks}]}`, newest first. `pages` are origin + path only. No consent id, no byte size, no content. A recording filed under a live visitor with a consent id that is not the profile's is not listed (and is forgotten at the collector by consent id).

**Chunks response (200).** `{propertyId, recordingId, from, chunks:[{seq, receivedAt, events:[<rrweb event>]}], more, nextFrom, opened, openingId}`. Feed `events` of each chunk, in order, to the rrweb replayer. `more:true` means ask again with `from = nextFrom` **and `opening = openingId`** (from page 1); `nextFrom` is `null` when `more` is `false`. `opened` is `true` when this call was an opening (`from` 0 or absent); then `openingId` is the id of the activity row just written, which the player keeps for this Play. On every later page `opened` is `false` and `openingId` is `null`. Every page re-checks the profile, so a visitor withdrawing mid-replay turns the next page into **404** `recording_not_found`: stop the player and say the recording is no longer available. A page is at most about 8 MB of events.

**The activity row.** Opening a recording (`from` absent or 0) writes **one** activity row **before** any content is returned: verb `opened`, entity type `search_replay_recording`, entity id the recording id, actor the viewer, metadata exactly `{propertyId, recordingId}`. No content, no visitor id, no consent id, no page paths. Later pages (`from` > 0) write nothing; a second Play (from 0 again) is a second opening and a second row. If the row cannot be written, the request fails and nothing is returned. The player must therefore request page 1 with `from` absent or `0` exactly once per Play, and page on with `from = nextFrom&opening=<openingId>`.

**The opening (closes the audit seam).** A later page (`from` > 0) is served only if an activity row exists with exactly the `opening` id sent, verb `opened`, entity type `search_replay_recording`, entity id = this recording, actor = the caller, this tenant, and `occurred_at` within the last **60 minutes**, read in the same transaction as the live-profile check. A missing, malformed, unknown, another user's, another recording's, wrong-kind or older opening is **409** `{error: <sentence>, reason: "not_opened"}` and no content. After 409 (for example a paused Play older than an hour), restart the recording from the start: that is a new opening and a new row. Reading a recording therefore always leaves exactly one row per Play, whatever `from` a caller asks for.

**Forgetting.** The collector's `forget` deletes a visitor's recordings with their events, and V3-e's ingest and sweep already send it for every withdrawn visitor, absent consent id and tombstoned id; a withdrawn visitor's recording is therefore gone from the collector at the next sweep (and at once if the banner's `/f` call reached it), and is never listed or streamed meanwhile (no live profile). See the Known gap below for what the ERP cannot see.

**MCP tool** (`replays-mcp-tools.ts`): `search.replays.list` (a read, `minAssurance: low`, path params only). **No tool returns recording content (O7)**; `replays.test.ts` pins that no search tool's path reaches the chunk route.

**Egress.** No new class: `readReplaySessions` and `readReplayChunks` were added to `insights-client.ts`, the one file that talks to the collector (`egress-inventory.test.ts`).

**Known gaps.** (1) The collector lists recordings only per visitor id, so a recording whose visitor never gets a profile (a forged id that never sends an event) cannot be enumerated for forgetting by the ERP; it is unreachable from the ERP and the collector's 30-day retention removes it. (2) The opening id is a bearer of the viewer's own opening only (same actor, same recording, 60 minutes); it is not a secret and is not a second authorization check, since `view_replay` and the live-profile check run on every page.

## 29. Conversation — client and staff (PV4-03, 2026-10-12) — `platform-nest/src/core/{portal-conversation,conversation}.controller.ts`, `conversation-core.ts`; predicates in `portal-visibility.ts` — **STATUS: BACKEND BUILT, PROTOTYPED (HTTP suite `conversation.controller.test.ts` runs against real Postgres + Cerbos on the Linux CI gate; portal UI BUILT by PV4-08, PROTOTYPED (vitest, a demo-mode Playwright spec and a stub-BFF Playwright spec; not run against a live platform-nest); staff UI is PV4-09)**

Plan: `docs/plans/2026-10-12-pv4-conversation-tickets.md` (PV4-03). Rulings PV-D22 (a thread per project plus ONE client-wide "general" thread per client), PV-D23 (agents draft, staff send), PV-D24 (every contact who can see a project takes part, viewers included). Tables: migration `202610122330_pv4_conversation_data_model.sql`. Cerbos: `resource_conversation.yaml` (staff kind) and `resource_portal.yaml` `converse` (client).

**Rules that hold on every route below**
- **Portal isolation** (§16 "Isolation model"): `portal` `read` for GETs, `portal` `converse` for writes, then `resolvePortalScope`, then the thread predicate `conversationThreadInPortalScope` (client AND project). A message, its edit/retract and its attachments are admitted **through their thread**. Outside scope = **404**, never 403 (no existence oracle). A revoked or invited contact is refused by the kernel (403 "not a portal client").
- **PV4-Q1 (default in force):** the client-wide thread (`project_id IS NULL`) is visible **only to client-wide contacts**. Unlike contracts and change requests, a project-scoped contact is NOT admitted to project-less rows here.
- **PV-D24:** no route calls `requireSigner`; a `viewer` contact opens threads and posts.
- **Server-derived fields:** `author_id` (the principal), `author_side` (`client` on portal routes, `staff` on staff routes), `client_id` (from the admitted project/thread, or the caller's own client) and `tenant_id` (the route) never come from the body. Body fields `authorId`, `authorSide`, `author_side`, `clientId` (except to choose among the caller's OWN clients), `status`, `tenantId` are ignored.
- **Plain text only** (design decision 7): `body` 1..10,000 characters (also a DB CHECK), PAN/national-id scrubbed like change requests, never interpreted as HTML or Markdown. **The UI must render it as text** (links may be made clickable on render).
- **Edit / retract (PV4-Q2 default):** own messages only, within **15 minutes** of `createdAt` (DB clock), both sides. Past the window or already retracted: **409**. Someone else's message: **403** on staff routes, **404** on portal routes. A retracted message is returned to BOTH sides as `{body: null, retracted: true, attachments: []}`; the old body is never returned again, and its files are refused by the portal download route.
- **Closed thread:** posting (either side) is **409** until staff reopen it.
- **Drafts are staff-only by table** (`conversation_drafts`): no portal route or portal helper names the table (static guard `conversation-portal-guard.test.ts`).
- **"Client sees this"** (plan trap 9): every staff thread and message row carries `clientVisible: true` computed in SQL from `staffConversationThreadClientVisible` / `staffConversationMessageClientVisible`; every draft row carries `clientVisible: false` from `staffConversationDraftClientVisible`. The UI shows the marker from this field, never from its own logic.
- **Attachments:** `attachments?: [{filename, contentType, content /* base64 */}]`, **at most 5 per message and at most 10 MB in total per message** (lead decision; the ticket's 5 x 10 MB was reduced). Text types are scrubbed like payment proofs. Stored as `files` rows with `target_entity_type = 'conversation'` and `target_entity_id` = the MESSAGE id. **Request-body limit (PV4-03b, per route, never app-wide):** the app's Fastify default stays 1 MiB, but the four routes that take attachments (portal `POST /api/:t/portal/conversation` and `.../:threadId/messages`, staff `POST /api/:t/conversation` and `.../:threadId/messages`) and the payment-proof route (§16b) each get `bodyLimit = ceil(cap × 4/3) + 64 KiB` = **14,046,550 bytes** (cap = the handler's own 10 MiB; table and derivation in `src/core/upload-body-limits.ts`, installed in `buildApp()` before the routes register, and `buildApp()` throws at boot if any table entry does not match exactly one registered route). So a message with attachments totalling up to the 10 MB cap is accepted, and one byte over is refused by the handler with `400 {error: "attachments too large (max 10 MB per message in total)"}`; only a body past ~14 MB gets the body-limit `413 {error: "payload too large", code: "payload_too_large"}` (Fastify's FST_ERR_CTP_BODY_TOO_LARGE). The draft routes (`.../drafts`) carry no files and keep the 1 MiB default. The edge proxy must also admit a ~14 MB body on these paths (nginx `client_max_body_size`) or the browser sees the proxy's 413 first.
- **Downloads:** portal `GET /api/:t/portal/files/:fileId` (§16b) admits `conversation` files through message -> thread -> `conversationThreadInPortalScope`, and only while the message is not retracted. Staff use `GET /api/:t/files/:fileId/content`, which authorizes `{kind: 'conversation'}` `read` with no change there.
- **Unread counts:** messages on the thread written by the **other side**, not retracted, newer than the caller's `conversation_reads.last_read_at`. Opening a thread (GET detail) marks it read; posting marks it read for the poster.
- **Events** (transactional outbox, entity type `conversation`; every payload carries `clientId`, `threadId` and ids only, never text): `conversation.thread.opened`, `conversation.message.posted`, `conversation.message.edited` (`change: edited|retracted`), `conversation.thread.updated`. Drafts emit `conversation.draft.created` on the `conversation_draft` stream, which is NOT mapped to any portal topic.
- **Live updates:** portal topic **`conversation`** (§16d), narrowed to the thread's client. Staff screens poll (20 s while a thread is open; design decision 6); there is no staff live channel.

### 29a. Portal — `src/core/portal-conversation.controller.ts`

| Status | Method | Path | Cerbos | Payload / notes |
|---|---|---|---|---|
| PROTOTYPED | GET | `/api/:t/portal/conversation[?projectId]` | `portal` · `read` | `{threads: PortalThread[], canUseGeneral: boolean}`. `PortalThread` = `{id, clientId, clientName, projectId, projectName, general, subject, status:'open'\|'closed', createdSide, lastMessageAt, createdAt, unreadCount}`, newest activity first, max 200. `canUseGeneral` = the caller is a client-wide contact (may post to, and so lazily create, the general thread). |
| PROTOTYPED | GET | `/api/:t/portal/conversation/:threadId` | `portal` · `read` | `{thread: PortalThread (no unreadCount), messages: Message[]}`, oldest first (newest 500). Marks the thread read. `Message` = `{id, threadId, authorId, authorName, authorSide:'client'\|'staff', body: string\|null, retracted, edited, editedAt, createdAt, editableUntil: string\|null, mine, attachments:[{id, filename, contentType, byteSize}]}`. No `draftedBy` on the portal: the sender shown is the named person (design decision 4). |
| PROTOTYPED | POST | `/api/:t/portal/conversation` | `portal` · `converse` | `{projectId?, clientId?, subject?, body, attachments?}` -> **201** `{threadId, messageId, created, attachmentIds}`. With `projectId` (one of the caller's projects; otherwise 404): a NEW thread on that project. Without: the client's ONE general thread, created on first post (race-safe: concurrent first posts land in one thread via the partial unique `ux_conv_threads_client_wide`); a project-scoped contact gets 404; a client-wide contact of several clients names one with `clientId` (validated against their scope, else 400). |
| PROTOTYPED | POST | `/api/:t/portal/conversation/:threadId/messages` | `portal` · `converse` | `{body, attachments?}` -> **201** `{id, threadId, createdAt, attachmentIds}`. 404 outside scope, 409 closed. |
| PROTOTYPED | PATCH | `/api/:t/portal/conversation/messages/:messageId` | `portal` · `converse` | `{body}` -> `{id, edited: true, editedAt}`. Own client-side message only (else 404); 409 past 15 minutes or retracted. |
| PROTOTYPED | DELETE | `/api/:t/portal/conversation/messages/:messageId` | `portal` · `converse` | -> `{id, retracted: true, retractedAt}`. Same ownership and window rules as PATCH. |

### 29b. Staff — `src/core/conversation.controller.ts` (Cerbos kind `conversation`)

| Status | Method | Path | Cerbos | Payload / notes |
|---|---|---|---|---|
| PROTOTYPED | GET | `/api/:t/conversation[?clientId&projectId&status=open\|closed&awaitingReply=true\|false]` | `conversation` · `read` | `{threads: StaffThread[]}`. `StaffThread` = the PortalThread fields + `{createdBy, updatedAt, awaitingReply, pendingDrafts, clientVisible: true, unreadCount}`. `awaitingReply` = the last non-retracted message is the client's and the thread is open (the client Overview's "waiting for our reply" count). `unreadCount` counts CLIENT messages. |
| PROTOTYPED | GET | `/api/:t/conversation/:threadId` | `conversation` · `read` | `{thread: StaffThread, messages: (Message & {draftedBy: string\|null, clientVisible: true})[]}`. Marks read. |
| PROTOTYPED | GET | `/api/:t/conversation/:threadId/drafts[?status=pending\|all]` | `conversation` · `read` | `{drafts: [{id, threadId, body, draftedBy, draftedByName, status:'pending'\|'sent'\|'discarded', decidedBy, decidedAt, sentMessageId, createdAt, clientVisible: false}]}`. Default pending only. |
| PROTOTYPED | POST | `/api/:t/conversation` | `conversation` · `post` | `{clientId, projectId?, subject?, body, attachments?}` -> **201** `{threadId, messageId, created, attachmentIds}`. With `projectId`: a new thread (the project must belong to `clientId`, else 400). Without: the client's general thread (lazy, race-safe). The internal client is refused (400). |
| PROTOTYPED | POST | `/api/:t/conversation/:threadId/messages` | `conversation` · `post` | `{body, attachments?}` -> **201** `{id, threadId, createdAt, attachmentIds, clientVisible: true}`. **Refused to `bot`/`automation` principals by Cerbos** (403 `cerbos denied post on conversation`, PV-D23). 409 closed. |
| PROTOTYPED | PATCH | `/api/:t/conversation/:threadId` | `conversation` · `manage` | `{status?: 'open'\|'closed', subject?}` -> `{id, status, subject, updatedAt}`. Emits `conversation.thread.updated`. Refused to agents. |
| PROTOTYPED | PATCH | `/api/:t/conversation/messages/:messageId` | `conversation` · `post` | `{body}`. Own staff message only (403 otherwise); 409 past 15 minutes or retracted. |
| PROTOTYPED | DELETE | `/api/:t/conversation/messages/:messageId` | `conversation` · `manage` | Retract one's own staff message (same rules). |
| PROTOTYPED | POST | `/api/:t/conversation/:threadId/drafts` | `conversation` · `draft` | `{body, idempotencyKey?}` -> **201** `{id, threadId, status, replayed, clientVisible: false}`. **Allowed to agents** (PV4-07's tool calls this). `drafted_by` = the caller. Idempotent on `(tenant, idempotencyKey)`: a replay returns the same draft (`replayed: true`); the same key on another thread is 409. 409 on a closed thread. |
| PROTOTYPED | PATCH | `/api/:t/conversation/drafts/:draftId` | `conversation` · `draft` | `{body}` -> `{id, status: 'pending', clientVisible: false}`. 409 unless pending. |
| PROTOTYPED | POST | `/api/:t/conversation/drafts/:draftId/send` | `conversation` · `post` | -> **201** `{id (the message), threadId, draftId, draftedBy, createdAt, clientVisible: true}`. ONE transaction: the message is authored by the SENDER (`author_id` = the caller, `author_side = 'staff'`) with `drafted_by` = the draft's author; the draft becomes `sent` with `sent_message_id`, `decided_by`, `decided_at`. Already sent or discarded: 409. Refused to agents by Cerbos. |
| PROTOTYPED | POST | `/api/:t/conversation/drafts/:draftId/discard` | `conversation` · `draft` | -> `{id, status: 'discarded', clientVisible: false}`. 409 unless pending. |

### 29d. Notifications, both ways (PV4-06, 2026-10-13) — `src/core/conversation-notify.ts`, `src/mail/intake.ts` — **STATUS: BACKEND BUILT, PROTOTYPED (HTTP suite `conversation-notify.test.ts` runs against real Postgres + Cerbos on the Linux CI gate; portal UI BUILT by PV4-08, PROTOTYPED (vitest, a demo-mode Playwright spec and a stub-BFF Playwright spec; not run against a live platform-nest); staff UI is PV4-09)**

No new route. Every write route in §29a/§29b calls into `conversation-notify.ts` **after its transaction commits**. The call is best-effort and never throws: a failure in the thread lookup, the recipient queries, or any one `notify()` is logged (`[conversation-notify]`, `[client-notify]`) and swallowed, so a notification problem can never fail or roll back the message. Edit, retract, close and reopen notify nobody.

| Fires on | Recipients | Type | Title | `href` |
|---|---|---|---|---|
| a CLIENT posts (portal `POST /portal/conversation`, `.../:threadId/messages`) | staff recipients (below) | `conversation.message.client` | `New message from <client name>` | `/clients/<clientId>/work/conversation/<threadId>` |
| STAFF post (`POST /conversation`, `.../:threadId/messages`) or a draft is SENT (`POST .../drafts/:id/send`) | every active contact in the thread's scope | `conversation.message.staff` | `You have a new message` | `/portal/conversation/<threadId>` |
| a draft is CREATED (`POST .../:threadId/drafts`; a replay of the same `idempotencyKey` does not notify again) | staff recipients | `conversation.draft.created` | `A draft reply is waiting` | `/clients/<clientId>/work/conversation/<threadId>` |

Payload (stored in `notifications.payload`, plus `actorId`): `{title, href, entityType: 'conversation', entityId: <threadId>}`. **It never contains the message text** (asserted on the stored row); the text stays in the thread. A staff href is a page PV4-09 builds; the portal href `/portal/conversation/<threadId>` is the thread page PV4-08 built (`platform-ui/src/app/(portal)/portal/conversation/[threadId]/page.tsx`, in the Projects area's Conversation sub-tab); the deep-link ledger (`portal-links.guard.test.ts` `AWAITING_PAGE`) is empty again.

**Staff recipients** (design decision 5; there is no project-team table): the thread's staff participants (distinct `author_id` of its non-retracted `author_side = 'staff'` messages) ∪ the project's owner (`projects.owner_id`, project threads only) ∪ the client's account manager (`clients.owner_user_id`); deduplicated, the **actor excluded**, users that are not `active` (or soft-deleted) dropped. An **empty set notifies nobody and is not an error**: the thread still shows as awaiting reply (§16b `needsUs`), so a missed notice never hides it.

**Contact recipients**: `resolveClientRecipients(kind: 'general')` with the thread's own `project_id`: active contacts that are client-wide or scoped to **that** project, never a contact scoped to another project. For a client-wide thread (`project_id` NULL) that is **client-wide contacts only** (PV4-Q1: a project-scoped contact cannot open that thread, so they are not told about it). Signers, admins and viewers alike (PV-D24); the actor is excluded.

**Mail to client contacts** (`conversation.message.staff` is the third type on the mail allow-list, with its own template `conversation.message.staff`): the mail has no message text, a fixed subject `You have a new message`, no reply token, and its **only link is the plain deep link** (`<MAIL_LINK_BASE_URL>/portal/conversation/<threadId>`), never a token or a session.
- **Throttle: at most one mail per contact per thread until that contact has read the thread.** A mail is skipped when `mail_log` already holds a `conversation.message.staff` row for this (contact, thread) newer than the contact's `conversation_reads.last_read_at`, or any such row at all when the contact has no read marker. Every status counts (queued, sent, suppressed, failed). The thread is recorded in the mail row's `payload.threadId`.
- **Flag, default OFF: `CONVERSATION_CLIENT_MAIL_ENABLED=1`** (`config.mail.conversationClientMailEnabled`; only the exact string `1` enables it). It is separate from the master `MAIL_ENABLED` because this is the one mail type that reaches people outside the company. Off means `mailIntake` returns before any lookup: **no `mail_log` row and no enqueue**; the in-app notification above still lands. Turn it on only once a real client-delivery sender exists (the board's "Before real clients use the portal"). The compose file does not pass the variable through yet, so it cannot be turned on by accident.

**Counts (additive)**
- `GET /api/:t/portal/overview` (§16a) gains **`conversationUnread: number`**: the number of threads in the caller's scope with at least one unread message from STAFF. It is the same predicate (`conversationThreadInPortalScope`) and the same unread rule (`unreadCountSql`) as the per-thread `unreadCount` on `GET /portal/conversation`, so it equals the number of rows in that list with `unreadCount > 0`. A project-scoped contact does not count the client-wide thread. The portal nav's Projects badge adds it to the open gates (PV4-08).
- `GET /api/:t/clients/:clientId/overview` (§16b) gains **`conversationsAwaitingReply: number`**, and `needsUs[]` gains items **`{kind: 'conversation', id: <threadId>, label: 'A client message is waiting for our reply', context: <subject | project name | 'General conversation'>, href: '/clients/<clientId>/work/conversation/<threadId>', since: <time of the last client message>, clientVisible}`**. A thread is awaiting when it is open and its last non-retracted message is the client's (`awaitingReplySql`, the same rule as the staff list's `awaitingReply`). The UI's `needsUs` item `kind` union grows by `'conversation'` (PV4-09).

## 29c. Meeting minutes shared with the client (PV4-05, 2026-10-12) — `platform-nest/src/core/meetings.controller.ts` (staff), `portal-workspace.controller.ts` (portal); predicates in `portal-visibility.ts` — **STATUS: BACKEND BUILT, PROTOTYPED (HTTP suite `meeting-minutes.controller.test.ts` and the Cerbos matrix run against real Postgres + Cerbos on the Linux CI gate; portal UI BUILT by PV4-08, PROTOTYPED (vitest, a demo-mode Playwright spec and a stub-BFF Playwright spec; not run against a live platform-nest); staff UI is PV4-09)**

Plan: `docs/plans/2026-10-12-pv4-conversation-tickets.md` (PV4-05; finding 8; design decisions 8 and 9). Cross-referenced from §16a. Rulings PV-D23 (nothing an agent writes reaches a client until a staff member approves it), PV4-Q1 (default: minutes of a meeting with NO project are visible only to client-wide contacts).

**What a client can read of a meeting: the minutes, and nothing else.** `meeting` STAYS in `NEVER_CLIENT_VISIBLE`: the recording, `transcript`, `transcript_ref`, `audio_ref`, `local_hint`, `drive_*`, the participants and the pipeline run are internal and no portal read names them. Minutes are a separate object (`meeting_minutes`, PV4-01): one row per meeting, written as a **draft**, then deliberately **shared** by a person. Once shared they are **frozen** (a save is 409) and there is **no unshare route** (once a client has read something, taking it back is a conversation, not a button).

**Visibility rule (one predicate, shared by the portal and the staff marker).** `meetingMinutesInPortalScope(minutesAlias, meetingAlias, params)` in `portal-visibility.ts`: the **meeting's** `client_id` is one of the caller's clients, `meeting_minutes.status = 'shared'`, the meeting is not soft-deleted, and for a project-scoped contact the **meeting's** `project_id` is one of theirs. **No NULL-project admission** (same shape as runs and conversation threads, `allowNullProject = false`). Minutes carry **no `client_id`/`project_id` of their own** (design decision 8): both come from the meeting, so re-linking a meeting moves its minutes with it and removing its client takes them out of every portal.

### Staff — `src/core/meetings.controller.ts` (Cerbos kind `meeting_recording`)

| Status | Method | Path | Cerbos | Payload / notes |
|---|---|---|---|---|
| PROTOTYPED | GET | `/api/:t/meetings/:id/minutes` | `meeting_recording` · `read` | `{meetingId, clientId, projectId, title, shareable, minutes: null \| {id, bodyMd, status:'draft'\|'shared', draftedBy, updatedBy, createdAt, updatedAt, sharedAt, sharedBy, sharedByName, clientVisible}}`. `minutes` is `null` until one was ever saved. `shareable` = a non-blank draft on a meeting that has a client (state only; the action decides who). `clientVisible` is computed in SQL from `staffMeetingMinutesClientVisible` (the meeting has a client AND the minutes are shared on a live meeting), never retyped (plan trap 9). 404 for an unknown, deleted or non-uuid meeting id. |
| PROTOTYPED | PUT | `/api/:t/meetings/:id/minutes` | `meeting_recording` · `update` | `{bodyMd: string}` (0..100,000 chars) -> the same view as GET. **Saving keeps `draft`.** `updated_by` = the caller always; `drafted_by` is set **only** when the caller's `principal.kind` is `bot` or `automation`, and is kept when a person later edits the text. **409** once shared. Authorization runs before validation (a denied caller never sees a 400). **Allowed to agents** (an agent may draft minutes). Emits `meeting.minutes.saved` (ids and size, never the text). |
| PROTOTYPED | POST | `/api/:t/meetings/:id/minutes/share` | `meeting_recording` · **`share_minutes`** (new) | no body -> **200** `{id (the minutes), meetingId, status:'shared', sharedAt, sharedBy, notified}`. **Refused to `bot`/`automation` principals by Cerbos** (403 `cerbos denied share_minutes on meeting_recording`; PV-D23). **409** when the meeting has no `client_id`, when there are no minutes or they are blank, and when they are already shared (including the loser of a concurrent double share). ONE UPDATE stamps `status='shared'`, `shared_at`, `shared_by` guarded `WHERE status = 'draft'`. See "On share". |

There is no `DELETE`, `PATCH` or `unshare` route on minutes.

### Portal — `src/core/portal-workspace.controller.ts` (`portal` · `read`, then `resolvePortalScope`)

`GET /api/:t/portal/meetings[?projectId]` and `GET /api/:t/portal/meetings/:minutesId` are listed in §16a. **Payload (pinned by a key-set test, never widened by a new column):**

```
{ id, title, meetingDate, bodyMd, sharedAt, sharedBy }
```

`title` falls back to `"Meeting"`; `meetingDate` = `started_at`, else `scheduled_at`, else `created_at`; `bodyMd` is Markdown (render it sanitised, or as text); `sharedBy` is the sharer's display name only (never an email or an id). **Not in the payload, on purpose:** `transcript`, `transcript_ref`, `audio_ref`, `local_hint`, `drive_*`, participants, the pipeline run, `clientId`, `projectId`.

### On share

- **Outbox event** `meeting.minutes.shared` (entity type `meeting_minutes`, entity id = the minutes id), payload `{clientId, projectId, meetingId, minutesId, actorId}` (ids only, never text). Mapped in `portal-live.service.ts` to the **existing portal topic `projects`**; `meeting_minutes` is added to `TAILED_ENTITY_TYPES`. `clientId` narrows the frame to that client's connections (§16d). No new topic, so `PortalTopic` in `platform-ui/src/lib/portal.ts` is unchanged.
- **Notification** (in-app, best-effort, after the commit) to the client's contacts **in scope**: `resolveClientRecipients(kind: "general")` for the meeting's client and project (client-wide contacts, plus contacts of that project; a project-less meeting reaches client-wide contacts only; viewers included), type `meeting.minutes.shared`, title `Meeting minutes shared: <title>`, **href `/portal/meetings/<minutesId>`**. This is a NEW portal path used in a notification: `platform-ui/src/lib/portal-links.guard.test.ts` lists it in its `AWAITING_PAGE` ledger until **PV4-08** builds the page and gives it a portal area (PV4-08 must delete that ledger entry; a test fails the moment the page exists). The notice carries no minutes text.
- Mail: not sent (the mail allow-list is two types; PV4-06 owns client mail).

### Authorization summary

`share_minutes` reaches exactly the roles that hold `update` on `meeting_recording` (`company_admin`, `manager`, `member`; perm mirror `perm_meeting_recording_share_minutes`), and is **denied to `kind` `bot`/`automation`** (PV-D23). See `PERMISSION-CONTRACT.md` §34.

## 30. Billing profiles, issue readiness, issue and void (PV5-04, 2026-10-13) — `platform-nest/src/modules/invoice/{issue.ts,billing-profile.controller.ts,invoice.controller.ts}`, migrations `202610130400` (data model) and `202610131850` (the invoice CHECK; its guard trigger reuses 1820's `pv5_legacy_flag_guard()`) — **STATUS: PROTOTYPED (HTTP suite `src/modules/invoice/issue.test.ts` and DB suite `src/db/pv5-invoice-enforcement.db.test.ts` on the Linux CI gate; not driven live — PV5-13)**

Ruling PV-D7: the finance ledger is the invoice of record. `invoices` stays the drafting stage (lines from logged hours,
maker/checker approve); **issuing** numbers it and posts the matching ledger AR invoice in one transaction, after which
both are immutable except `status → paid | void`. Plan: `docs/plans/2026-10-12-pv5-contracts-billing-tickets.md`.

| Status | Method | Path | Authz | Notes |
|---|---|---|---|---|
| PROTOTYPED | GET | `/api/:t/billing-profile` | `finance_config` · `read` | `{ legalName, address, invoicePrefix, defaultPaymentTermsDays, currencyCode, bank: {bankName, accountName, accountNo} \| null, bankLedgerAccountCode, defaultRevenueAccountCode, signatureThreshold, updatedBy, updatedAt }`. **404** before one exists. Not module-gated (readiness must be able to say "finance module off" separately). |
| PROTOTYPED | PUT | `/api/:t/billing-profile` | `finance_config` · `update` for any non-bank field; **`set_bank_details`** when the body has a `bank` key (owner or finance_manager GRANT on this company, or platform_admin; HIGH assurance for everyone; bots never) | Upsert; omitted fields are kept. A new profile needs `legalName`, `address`, `invoicePrefix` (`^[A-Z0-9-]{1,16}$`). `defaultPaymentTermsDays` 0–365, `currencyCode` a known ISO code, account codes are free codes resolved at issue time (readiness names a missing one), `signatureThreshold` positive or null (PV-D8). `bank: {bankName, accountName, accountNo}` sets the block clients pay into (all three or `null` to clear). Both authorizations run before validation; a body touching only `bank` needs only `set_bank_details` (so an owner can change it). A bank change writes an activity row `bank_details_changed` (account masked to the last 4) and notifies EVERY owner of the company (`billing.bank_details_changed`, warning; the number is never in the notification) — PV-D26. |
| PROTOTYPED | GET | `/api/:t/billing-profile/masked` | `finance_config` · `read` | PV5-12, the agent view (tool `billingProfile.read`): the profile as above but `bank: {bankName, accountName, accountNoMasked} \| null`, where `accountNoMasked` is `••••` plus the last 4 characters. The full number is never returned, to any caller. **404** before a profile exists. Agent tools of this section: `invoices.issueReadiness` (read), `invoices.issue` and `invoices.voidIssued` (HIGH, D14; an approved call re-runs as the human the agent acted for, who must hold `invoice` `issue` / `void_issued`; a bot or automation principal is refused 403), `billingProfile.read`. No tool sets bank details, certifies a contract or creates a checkout. |
| PROTOTYPED | GET | `/api/:t/invoices/:invoiceId/issue-readiness` | `invoice` · `read` | See §4. One row per blocker; `ready: true` with `[]` when issuable. |
| PROTOTYPED | POST | `/api/:t/invoices/:invoiceId/issue` | `invoice` · `issue` | See §4 for the shapes. |
| PROTOTYPED | POST | `/api/:t/invoices/:invoiceId/void` | `invoice` · `void_issued` | See §4. |

**What one issue does, in one `withFinance` transaction** (`issue.ts`): lock the invoice row → re-check readiness on it
(refuse with every blocker, nothing written) → find or create the client's AR customer (`code CL-<client id>`, terms from
the profile; a group client's customer carries `counterparty_company_id = clients.group_company_id`, decision 20) → take
`next_document_no(tenant, 'invoice', year)` (row-locked: a rollback returns the number, concurrent issues serialise) →
compute each line's tax with `finance_tax_compute(code, line amount, issue date)` rounded to the currency's minor unit,
all in `numeric` → insert the AR invoice + lines (revenue account from the profile) and `finance_ar_issue_invoice()` →
write `invoice_no`, `issue_date` (today), `due_date` (+ the customer's terms), `subtotal`, `tax_total`, `total`, the
frozen `issuer` snapshot and `ar_invoice_id`, status `sent` → emit `invoice.issued` and an `issued` revision. Other
series: receipts `{prefix}/RC/{yyyy}/{nnnn}`, credit notes `{prefix}/CN/{yyyy}/{nnnn}`.

**Rules a consumer must not get wrong**
- `sent` = **Issued**. Label it so; there is no other way into `sent`, and `paid` is never set by a person.
- The books are kept at exchange rate 1, so an invoice in a currency other than the company's functional currency is
  refused (`CURRENCY_NOT_FUNCTIONAL`) rather than booked at face value.
- A taxed invoice (`taxCode` set at create) is refused until Finance records the company as PKP (`PKP_NOT_CONFIRMED`,
  owner, PV-D7) and the code has a rate in force.
- Legacy invoices (sent/paid before PV-5, `legacyUnissued: true`) are exempt from the CHECK, take no new payment
  claims, and keep the old confirm rule.
- Agent tools for these routes are PV5-12; the screens are PV5-09.
