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
| ⛔ | GET/PUT | `/api/:t/org-structure` | `OrgStructure` | **See [`memory/org-structure-contract`].** JSONB blob per company; kinds `holding\|company\|department\|division\|role\|person` (migrate legacy `team`→`division`). PUT elevated/`org.edit`. Emit `org_structure.updated`. UI currently persists to a per-browser cookie — **replace with real storage** (a real org exceeds the 4 KB cookie cap). |

## 3. People / employees & admin — `lib/adminData.ts`, `lib/people.ts`
| Status | Method | Path | Body → Response | Notes |
|---|---|---|---|---|
| ⛔ | GET | `/api/:t/users` | → `UserRow[]` (incl. real `status` + `roles`) | UI falls back to `/members` with fabricated `status:"active"`/no roles — build this to stop the fabrication. |
| ⛔ | POST | `/api/:t/users` | `{name,email,title?,roleId?}` → `{id}` | Invite/onboard. `admin.access`. Emit `user.invited`. |
| ⛔ | PATCH | `/api/:t/users/:id` | `{title?,status?,name?}` → `{ok}` | Edit profile / deactivate. `admin.access`. |
| ⛔ | GET | `/api/roles` | → `RoleRow[]` | Assignable roles (drives the invite + role pickers). |
| ⛔ | POST | `/api/:t/users/:id/roles` | `{roleId,scopeType,scopeId?}` → `{ok}` | Assign role. Emit `role.assigned`. |
| ⛔ | DELETE | `/api/:t/users/:id/roles/:grantId` | → `{ok}` | Revoke role. |
| ⛔ | GET / POST(verify) / DELETE | `/api/:t/identity-links[/:id[/verify]]` | → `IdentityLink[]` | WA/TG identity links. |
| 🟡 | GET/POST/PATCH/DELETE | `/api/:t/custom-fields[?entityType][/:id]` | → `FieldDef[]` | **POST exists**; GET/PATCH/DELETE pending. |
| ⛔ | GET/PATCH | `/api/:t/compliance-gates[/:id]` | → `ComplianceGate[]` | UI shows a hardcoded 6-gate template until this lands; PATCH persists status/evidence. |
| ⛔ | PATCH | `/api/:t/company/modules` | `{module,enabled}` → `{ok}` | Enable/disable modules. |
| 🟡 | GET | `/api/:t/audit?verb&actorId&entityType&since&until&limit` | → `AuditEntry[]` | Falls back to `/api/:t/activity` (✅) + client-side filter. Build a real filtered/paginated audit endpoint (+ export). |

## 4. Work management — `lib/entities.ts`, `lib/data.ts`
| Status | Method | Path | Notes |
|---|---|---|---|
| ✅ | GET/POST | `/api/:t/projects`, `/api/:t/projects/:id` | list + detail + create + PATCH exist. **No delete/archive endpoint — add one.** |
| ✅ | GET | `/api/:t/tasks?assignee=me` | base task list. |
| ✅ | GET/POST | `/api/:t/projects/:pid/tasks` | list + create. |
| ⛔ | PATCH | `/api/:t/tasks/:id` | base task update is **pending** (UI edit form degrades). |
| ✅/⛔ | Agency | `/api/:t/modules/agency/campaigns[/:cid/briefs]`, `/approvals/pending`, `/approvals/:id/decide` | campaigns + approvals ✅; **briefs POST ⛔**; **no campaign detail/edit/delete, no creative-asset review endpoints**. |
| ⛔ (UI built) | GET/POST/DELETE | `/api/:t/clients[/:id]` | UI: `/clients` list + `/clients/new` + `/clients/[id]` detail. Create/delete gated `pm.manage`. |
| ⛔ (UI built) | GET/POST | `/api/:t/deliverables[?projectId]` | UI: `/deliverables` list + `/deliverables/new`. |
| ⛔ (UI built) | GET/POST | `/api/:t/time-entries` | UI: `/timesheets` (totals + billable rollup + log). POST body `{minutes,projectId?,taskId?,billable,entryDate,notes}`. |
| ⛔ (UI built) | GET/POST | `/api/:t/invoices[/:id]` (+`PATCH` status) | **Billing** UI: `/billing` list + `/billing/new` (generate from billable time in a period × rate) + `/billing/[id]` (line items, mark sent/paid). `Invoice` shape in `lib/billing.ts`. `company.manage` only. Backend computes line items from billable `time-entries`. |
| ⛔ (UI built) | GET | `/api/:t/modules/agency/approvals/decided` | Decided-approval **history** (Approvals page "Recently decided"). Add `campaignId` to pending items so the UI deep-links to the campaign. |
| — | (pure UI) | Calendar `/calendar` | Agenda + workload built entirely from existing task/deliverable/project due dates — no new endpoint. |
| ⛔ (UI built) | GET/POST/DELETE | `/api/:t/files[?entityType&entityId][/:id]` | **Attachments** on project + task detail. POST body today is a **reference** `{entityType,entityId,filename,url?}` → `{id}`. **TODO: true binary/multipart upload** (`multipart/form-data` with the file part) — UI attaches references for now. |
| ⛔ (UI built) | GET/POST | `/api/:t/comments?entityType=&entityId=` | **Generic threaded comments** — task comments (via `lib/pm`) + **project "Discussion"** (via `lib/entities.postComment`). Any `entityType`. POST body `{body}`. |
| ✅ | GET/POST | `/api/rollups?period`, `/api/:t/rollups/recompute` | Add drill-down (records behind a metric) + period history for the reporting UI. |
| 🟡 | GET/POST | `/api/:t/notifications[?unread]`, `/api/:t/notifications/:id/read` | list ✅; per-item read ⛔. **Add `payload.href`** (deep-link target) so notifications become clickable. |

## 5. Project management (Repsona-style) — `lib/pm.ts`, `lib/pmActions.ts`  — **ALL ⛔**
**See [`memory/pm-ai-tracker-contract`].** Today the entire PM workspace runs only on the in-memory
demo store `lib/demoPm.ts`. Implement:
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

## 6. IT: devices & n8n — `lib/it.ts`  — **ALL ⛔**
**See [`memory/it-device-contract`].** `GET/POST /api/:t/it/devices`, `GET /api/:t/it/devices/:id`,
`GET /api/:t/it/events`, `GET /api/admin/automation/workflows`, `GET /api/admin/automation/workflows/:id`.
Emit `device.registered|online|offline|degraded|alert`. Heartbeat ingest
(`POST /api/:t/it/devices/:id/heartbeat`) is backend-only (UI reads).

## 7. Systems & Intelligence consoles — `lib/admin.ts`  — **ALL ⛔**
This is the program's own top backend gap ("no AdminController yet"). Build:
- `GET /api/admin/:system/status`, `GET/PUT /api/admin/:system/config` for `system ∈
  {bot,gateway,hub,agents,knowledge,automation}`.
- Extra reads: `GET /api/admin/gateway/egress-audit`, `GET /api/admin/hub/tools`,
  `GET /api/:t/agents/goals`, `GET /api/:t/knowledge/sources` (+ `POST …/:id/review`).

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

_Cross-references:_ `memory/org-structure-contract`, `memory/it-device-contract`,
`memory/pm-ai-tracker-contract`, `memory/ui-rbac-and-company-scope`. Type shapes are canonical in
`platform-ui/src/lib/{platform,entities,adminData,org,organization,pm,it,admin}.ts`.
