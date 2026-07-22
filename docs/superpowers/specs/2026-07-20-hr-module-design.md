# HR Module ('hr') — Design (WSD-1 / GATE-3)

**Date:** 2026-07-20
**Status:** APPROVED DESIGN (architect GATE-3 output). Supersedes the ORG-CORE spec's §0025_module_hr
sketch and absorbs ORG-5 / ORG-10 / ORG-11 into the WS-D ticket list (§7). Backend prerequisite
state: ORG-1/2/3/6/7/7b complete on `backbone/org-core-checkpoint` (289 tests); migrations through
`0027_service_assignment_unit_guard.sql`; **`SERVICE_ASSIGNMENTS_ENABLED` still OFF**;
**module_staff/module_manager derived roles NOT built yet** (ORG-7b scoped `service_assignment:read`
to admin roles and flagged the gap — closed here as WSD-2).
**Owner decisions honored:** payroll OUT of v1 (export hook only, WSG-6); HR is a tenant-gated
module per the confirmed core-vs-module split; approvals ride the unified inbox (UX-2).
**Inputs:** `2026-07-17-org-core-shared-services-design.md` (+GATE-1/GATE-2 amendment rulings),
`2026-07-17-backbone-program-plan.md`, `docs/FRONTEND-BFF-CONTRACT.md`, Cerbos policy repo,
`src/modules/{contract,registry}.ts`, `src/rbac/principal.ts`, migrations 0025–0027.

---

## 1. Scope

**IN (v1):**
- **Leave**: requests (vacation | sick | unpaid | other; date range; day/half-day granularity as
  minutes), balances per subject/year/type, approval via the unified approvals surface
  (`origin='hr'`), cancellation of own pending requests.
- **Attendance**: lightweight per-day log (present | remote | absent | leave), one row per
  subject/day, staff-editable, auto-stamped `leave` on approved leave days.
- **Onboarding/offboarding checklists**: tenant-scoped templates → instantiated as `hr_cases`
  (kind `onboarding`/`offboarding`) with a checklist in `details`; auto-instantiated on
  `user.invited` when the module is enabled/served.
- **Review-lite**: `hr_cases` kind `review` with goals + period + outcome in `details`. No cycles
  engine, no calibration — deliberately lite.
- **HR records**: contract/document/note references per subject (`hr_records`, files linkage).
- **Employee HR cards** on `/people/[id]` (leave balance, onboarding progress, review status) and
  HR workspace with the shared-service **scope pill (A | B | C | ALL)** + inclusion Envelope.

**OUT (v1):** payroll (export hook only — WSG-6), benefits, shift scheduling/rostering, grievance
workflow beyond a generic `hr_case`, e-signing, subject self-service reading of `hr_records`
(v1.1 decision: subjects can read own `document|contract` record types; **notes never**), finer
record-level scoping (the unused `scope_type='record'` hook remains the future path).

---

## 2. The linchpin: `module_staff` / `module_manager` derived roles (absorbs ORG-5)

### 2.1 How a reconciler-materialized grant resolves
Verified against code: `assemblePrincipal` (src/rbac/principal.ts) builds
`principal.attr.grants = [{role: roles.name, scopeType, scopeId}]` (role **names**, via
`user_roles JOIN roles`) and `principal.attr.companies` from **active, non-deleted memberships**.
The ORG-6 reconciler materializes, for HR staffer u2 under an active assignment (unit d-hr of
provider A → target B, module 'hr'):
- `company_memberships(B, u2, kind='service', managed_by=asg)` → **B ∈ principal.companies** →
  `variables.inTenant` passes for B-scoped resources, and `withTenants([B])` passes the ORG-3
  choke-point (B is in the authorized set).
- `user_roles(u2, hr_staff, scope company:B, managed_by=asg)` → grant
  `{role:"hr_staff", scopeType:"company", scopeId:B}` in the principal.

So Cerbos needs exactly one new generic pair that string-composes the role name from the
resource's module attribute — a byte-level sibling of the existing `module_approver`
(derived_roles.yaml:97-106), which is the proven pattern:

```yaml
# derived_roles.yaml additions (gaiada_scopes)
- name: module_staff
  parentRoles: ["user"]
  condition:
    match:
      expr: >-
        has(request.resource.attr.module) && request.resource.attr.module != "" &&
        request.principal.attr.grants.exists(g,
          g.role == (request.resource.attr.module + "_staff") && (
            g.scopeType == "global" ||
            (g.scopeType == "company" && g.scopeId == request.resource.attr.tenantId)))

- name: module_manager
  parentRoles: ["user"]
  condition:
    match:
      expr: >-
        has(request.resource.attr.module) && request.resource.attr.module != "" &&
        request.principal.attr.grants.exists(g,
          g.role == (request.resource.attr.module + "_manager") && (
            g.scopeType == "global" ||
            (g.scopeType == "company" && g.scopeId == request.resource.attr.tenantId)))
```

ONE pair serves hr/finance/legal/it-as-a-service — no per-module policy explosion. Every HR
handler passes `resource.attr = {kind, tenantId: <URL tenant>, module: "hr", ...}`; the tenantId
is the SERVED company, so:
- u2 acting on B: grant `(hr_staff, company, B)` matches → allow; RLS runs `withTenants([B])`
  under `app.current_tenant_ids` → only B's rows exist.
- u2 acting on D (not served): no `(hr_staff, …, D)` grant → `module_staff` fails; no membership →
  `inTenant` fails; choke-point rejects `[D]`; RLS would return zero rows anyway. **Three
  independent walls.**
- B's own company_admin: `company_admin` derived role, inTenant(B) → allow — sees only B (their
  session never carries A or C).
- `hr_staff` matches **no other resource policy** (same isolation trick as the `client` role), so
  a served-company grant lights up ONLY the HR surface in that company — "each company sees only
  its slice" holds in nav and API alike.

### 2.2 Resource policies (new files)

**`resource_hr_case.yaml`** (leave requests inherit these via their own policy, §2.3):
| action | allowed | condition |
|---|---|---|
| read, create, update | module_staff, module_manager, company_admin | `inTenant && notLow` |
| read (own), create (own leave/case), cancel (own pending) | member | `inTenant && notLow && resource.attr.subjectUserId == principal.id` |
| delete | module_manager, company_admin | `inTenant && notLow` |
| export | module_manager, company_admin | `inTenant && principal.attr.assurance == "high"` (first real use of the high tier) |
| * | platform_admin | — |
| read/…/export | group_executive | `notLow` (global role, cross-company by design) |

**`resource_hr_record.yaml`**: read/create/update → module_staff, module_manager, company_admin
(`inTenant && notLow`); delete → module_manager, company_admin; export → assurance `high`. NO
subject self-read in v1 (see Scope).

**Extensions to existing policies (same release):**
- `resource_service_assignment.yaml`: `read` (and ONLY read) gains module_staff + module_manager —
  per ORG-7b's own header note — so HR staff see their unit's serving edges (workspace header,
  scope pill source).
- `resource_member.yaml`: `read` gains module_staff **when `resource.attr.module` is passed**
  (the members controller passes `module:'hr'` only on the HR-workspace directory path) — HR staff
  may read the served company's directory; other modules' staff don't inherit it.
- `resource_automation_approval.yaml`: `read`/`decide` gain module_manager **when
  `resource.attr.module == 'hr'`** (hr-origin approval rows carry `module:'hr'`), so the served
  company's admin AND the providing unit's manager can decide leave — both sides of the
  shared-service relationship can unblock people.

### 2.3 Regression gate
- Re-run the existing 13-case Cerbos parity suite with ZERO assignments in the DB and assert
  bit-identical decisions (proves the additions are inert — the cheapest ecosystem regression gate).
- New parity cases: module_staff hit/miss per tenant; module_manager ⊃ staff actions;
  `hr_staff` matches no non-HR resource kind; member self-read; export assurance gate.

### 2.4 The third wall: module-sliced RLS (`app.scopes`)
ORG-3 already ships `withTenants(tenants, {modules})` setting the second GUC `app.scopes` (CSV of
module keys authorized for THIS request). 0028 defines the predicate once:

```sql
CREATE OR REPLACE FUNCTION app_module_allowed(mod text) RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT mod = ANY(string_to_array(NULLIF(current_setting('app.scopes', true), ''), ',')) $$;
```

Every hr_* table's single `tenant_isolation` policy (sweep-compatible name) is:
`USING (tenant_id = ANY(app_current_tenants()) AND app_module_allowed('hr'))` — same for
WITH CHECK. Fail-closed: any code path that reaches hr tables WITHOUT declaring the hr module
scope gets zero rows, even with a correct tenant set. Legacy tables are untouched (no sync-engine
contract change; hr tables do not sync in v1 — sync-phase TODO).
**Consequences encoded in tickets:** the rollups engine must invoke each module's RollupProvider
with that module's scope set, and the event consumer must dispatch module eventHandlers under the
module scope — otherwise served-tenant rollups/handlers read zero rows (WSD-4 AC).

---

## 3. Schema — migration `0028_module_hr.sql` (rebased numbering; 0027 = unit guard)

All tables: `tenant_id` = **the SERVED company** (data never re-homes; on revoke the target keeps
its HR data); FORCE RLS; ONE `tenant_isolation` policy per table composed from
`app_current_tenants()` AND `app_module_allowed('hr')` (§2.4); `origin_site` default 'central';
soft-delete `deleted_at`; timestamps. Runtime grants via the external RUNTIME_GRANTS_SQL pass, no
sync_app grants.

```sql
-- app_module_allowed() as in §2.4 (defined here; first consumer)

CREATE TABLE hr_cases (            -- generic container: onboarding|offboarding|review|grievance|other
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  subject_user_id uuid REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('onboarding','offboarding','review','grievance','other')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','done','cancelled')),
  title text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',      -- checklist {items:[{label,done,doneBy,doneAt}]} / review {period,goals,outcome}
  custom jsonb NOT NULL DEFAULT '{}',       -- D17
  created_by uuid NOT NULL REFERENCES users(id),
  origin_site text NOT NULL DEFAULT 'central',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE hr_records (          -- contract|document|note references per subject
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  subject_user_id uuid NOT NULL REFERENCES users(id),
  record_type text NOT NULL CHECK (record_type IN ('contract','document','note')),
  data jsonb NOT NULL DEFAULT '{}',
  file_id uuid REFERENCES files(id),        -- same-tenant file (RLS makes cross-tenant refs unreadable)
  created_by uuid NOT NULL REFERENCES users(id),
  origin_site text NOT NULL DEFAULT 'central',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE hr_leave_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  subject_user_id uuid NOT NULL REFERENCES users(id),
  leave_type text NOT NULL CHECK (leave_type IN ('vacation','sick','unpaid','other')),
  starts_on date NOT NULL, ends_on date NOT NULL CHECK (ends_on >= starts_on),
  minutes int NOT NULL CHECK (minutes > 0),           -- canonical unit (day=480 by convention)
  note text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','denied','cancelled')),
  approval_id uuid,                                    -- automation_approvals row (origin='hr')
  decided_by uuid REFERENCES users(id), decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX ix_hr_leave_subject ON hr_leave_requests(tenant_id, subject_user_id, starts_on);

CREATE TABLE hr_leave_balances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  subject_user_id uuid NOT NULL REFERENCES users(id),
  year int NOT NULL,
  leave_type text NOT NULL CHECK (leave_type IN ('vacation','sick','unpaid','other')),
  allocated_minutes int NOT NULL DEFAULT 0,
  used_minutes int NOT NULL DEFAULT 0 CHECK (used_minutes >= 0),
  UNIQUE (tenant_id, subject_user_id, year, leave_type)
);

CREATE TABLE hr_attendance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  subject_user_id uuid NOT NULL REFERENCES users(id),
  day date NOT NULL,
  status text NOT NULL CHECK (status IN ('present','remote','absent','leave')),
  note text,
  recorded_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, subject_user_id, day)
);

CREATE TABLE hr_checklist_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  kind text NOT NULL CHECK (kind IN ('onboarding','offboarding')),
  name text NOT NULL,
  items jsonb NOT NULL DEFAULT '[]',        -- [{label}]
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

-- Unified approvals surface learns the hr origin:
ALTER TABLE automation_approvals DROP CONSTRAINT automation_approvals_origin_check;
ALTER TABLE automation_approvals ADD CONSTRAINT automation_approvals_origin_check
  CHECK (origin IN ('automation','agent','hr'));
```

Balance semantics: `used_minutes` increments on APPROVAL (not filing); deny/cancel of an approved
request decrements symmetrically; over-allocation is a warning surfaced to the approver in the
approval payload, never a hard DB constraint (HR reality beats arithmetic).

---

## 4. HR as a module (absorbs ORG-11)

**ModuleContract (key `'hr'`), per the agency pattern:**
- `migrations: ["0028_module_hr.sql"]`
- `permissions`: `hr:case:read|write`, `hr:leave:file|decide`, `hr:record:read|write`,
  `hr:record:export`.
- `customFieldTargets: ["hr_case","hr_record"]` (D17).
- `mcpTools` (aggregated to the hub automatically via `GET /mcp/tool-defs`):
  `hr.listCases` (GET, `minAssurance:"verified"`), `hr.listLeave` (GET, verified),
  `hr.fileLeave` (POST, `write:true`, `impact:"medium"`, verified — D14 gates automation writes).
- `rollupProviders`: `hr.open_cases`, `hr.leave_pending`, `hr.onboarding_active` (counts, sum).
- `uiManifest`: HR Workspace `/hr`, Leave `/hr/leave`, Attendance `/hr/attendance`,
  Onboarding `/hr/onboarding` (consumed by WSA-4's manifest-driven nav).
- `eventHandlers`: `automation_approval.decided` (origin=hr → apply leave decision + balance +
  notify subject with href); `user.invited` (instantiate default onboarding checklist case).

**Enablement — the ONE framework change (and where it lives):** extend
**`isModuleEnabled(tenantId, key)` in `src/modules/registry.ts`** — NOT just the guard — to:
`key ∈ companies.enabled_modules OR EXISTS active service_assignment(target_tenant_id=tenantId,
module_key=key)`, executed under `withTenants([tenantId])` (target side of the per-command RLS
matches). Verified consumers that inherit it for free: `ModuleEnabledGuard`, the event consumer
(`consumer.service.ts:72`), and the rollups engine (`rollups/engine.ts:64`) — putting the
OR-clause only in the guard would silently break served-tenant event handling and rollups.
Enablement provenance stays clean: serving never mutates `enabled_modules`; revoke needs no array
surgery; the module goes dark for the target the moment its last active assignment ends.

**Approvals integration (unified inbox, UX-2):** filing leave creates the `hr_leave_requests` row
(`pending`) AND an `automation_approvals` row (`origin:'hr'`, payload `{leaveRequestId,
subjectName, range, minutes, balanceAfter, href:"/hr/leave/<id>"}`, resource attrs incl.
`module:'hr'`) in the same transaction + outbox event. Decision flows through the EXISTING decide
endpoint (no fork); the hr eventHandler applies the outcome. Deciders: target company_admin,
module_manager (§2.2), group_executive.

**RBAC UI mapping (`platform-ui/src/lib/rbac.ts`):** roles `hr_staff`/`hr_manager` → new caps
`hr.view`/`hr.manage` (company-scoped); `company_admin` gets both in own company; nav lights up
via the module manifest + caps; scope pill companies come from `me.serviceScopes` (already live,
ORG-7b).

---

## 5. WSD-7 — the owner's acceptance scenario, walked end-to-end

Setup: holding D & A Syrowatka → Gaia Digital Agency (A), Viceroy (B), third seeded company (C).
A's org blob has department `d-hr` (lead u1, staff u2, u3). `SERVICE_ASSIGNMENTS_ENABLED=ON` in
the test env (flip choreography = WSD-8). Module 'hr' is in A's `enabled_modules`; B and C get it
ONLY via serving.

1. **Connect.** Exec (global) uses the OrgBuilder "Connect service" button on d-hr → confirm sheet
   (dryRun lists u1–u3; lead picker = u1) → targets B+C, module hr → assignments `active` →
   reconciler (outbox-driven) materializes: memberships kind='service' + `hr_manager`(u1)/
   `hr_staff`(u2,u3) grants scoped company:B and company:C + claims rows; session bumps batched
   per user. Audit lands both sides; `service_assignment.activated` on the bridge.
2. **Module lights up.** `isModuleEnabled(B,'hr')` = true via assignment → `/api/<B>/hr/*` alive;
   B's nav (module manifest) shows HR to B's admin; B's `enabled_modules` unchanged.
3. **u2 works B.** `/api/me` → companies ⊇ {A,B,C}, serviceScopes hr:[A,B,C]; switcher badges;
   scope pill A|B|C|ALL. u2 files leave FOR a B employee → `withTenants([B], {modules:['hr']})`;
   Cerbos `hr_case create` via module_staff(B) → allow. Approval row (origin hr) appears in B's
   unified inbox; u1 (module_manager) or B's admin decides; eventHandler applies + balance + href
   notification.
4. **Slicing (server-proven, curl not UI).** B's admin token: `/api/<B>/hr/cases` → only B rows;
   `/api/<C>/hr/cases` → 403/empty (no membership). u2 with scope B: only B. u2 ALL: BFF fan-out
   A+B+C, Envelope tags any excluded leg `{included:false, reason}` — never silent. u2 against a
   non-served D: Cerbos deny + choke-point reject + RLS zero — all three walls exercised. u2
   calling a NON-hr endpoint in B (e.g. projects): deny — hr_staff matches no other policy.
5. **Reorg mid-flight.** Move u3 out of d-hr in A's chart → org PUT → reconcile event → u3's B/C
   claims/grants/memberships removed (last-claim rule), session bumped → u3 loses access within
   one request; u3's decided history in B intact (`decided_by` survives). Orphan d-hr (delete
   node) → assignments freeze (`unit_status='orphaned'`, banner) → TTL auto-suspend if unresolved.
6. **Drag-undo.** Revoke B's assignment → reconciler strips claims-backed grants/memberships →
   u2's principal drops B; `isModuleEnabled(B,'hr')` false → `/api/<B>/hr/*` 404 for everyone;
   **B keeps every hr_* row** (tenant-owned); reconnect (same or different provider) finds the
   data in place.
7. **Second wall proof.** A deliberately mis-scoped test handler with tenant=[B] but NO hr module
   scope reads hr tables → zero rows (`app_module_allowed` fails) — the sliced-RLS wall holds even
   when Cerbos/choke-point are bypassed in-process.

Acceptance = the scripted e2e (committed, repeatable) passes all seven beats + the adversarial
probes, with UI-independent curl proofs for every denial.

---

## 6. Flag flip choreography (where pre-flag QA fits)

`SERVICE_ASSIGNMENTS_ENABLED` flips ON (dev/staging) only when ALL of: ORG-12 (rbac scopeCovers
fix + serviceScopes UI) merged; ORG-13 (connect UI) merged; ORG-14 (pre-flag adversarial QA)
signed; WSD-2 parity replay green; the A1 CI grep-lint green (GATE-1 carried requirement). HR
(WSD-9) is the acceptance test the flip hides behind; production flip only after WSD-9 sign-off.
**Rollback note (must be documented in WSD-8):** flag OFF after materialization hides surfaces but
does NOT revoke grants — correct rollback is revoke-assignments-then-flag-off.

---

## 7. WS-D ticket list (updated; supersedes plan §8; absorbs ORG-5/ORG-10/ORG-11)

Model·effort: seat default (seniors/medior/qa/devops = Sonnet, junior = Haiku) unless tagged.

| ID | Seat | Size | Model·effort | Deps | Ticket + "done when" |
|---|---|---|---|---|---|
| WSD-1 | architect | M | — | ORG-7b, UX-2 | **GATE-3 = this document.** Done on merge. |
| WSD-2 | senior-be | M | **opus·high** — cross-tenant authz linchpin; subtle CEL string-composition + policy extensions where one wrong condition = cross-company HR leak; a failed cheap attempt costs a full re-run | — (policies inert until WSD-4) | **Cerbos release (ex-ORG-5).** §2.1 derived pair verbatim; `resource_hr_case.yaml` + `resource_hr_record.yaml` per §2.2 tables; the three policy extensions (service_assignment read; member read w/ module attr; automation_approval hr-origin decide). **Done when:** zero-assignment 13-case parity replay bit-identical; new parity cases (§2.3) green; Cerbos loads clean; `hr_staff` proven to match no non-HR resource kind. |
| WSD-3 | senior-db | M | **opus·medium** — first-of-class in-DB module wall (`app.scopes` predicate) on 6 new tables; RLS mistakes unacceptable, but bounded + pattern-composed | WSD-1 | **Migration 0028_module_hr (ex-ORG-10) per §3.** Incl. `app_module_allowed()`, origin CHECK extension, balances/attendance uniques. **Done when:** RLS tests prove right-tenant+module-scope → rows, right-tenant WITHOUT module scope → zero rows, wrong tenant → zero; rls.test.ts sweep green (all 6 tables have tenant_id); full suite green with migration applied. |
| WSD-4 | senior-be | L | default (Sonnet·high) | WSD-2, WSD-3 | **HR module backend (ex-ORG-11).** registerModule per §4; **`isModuleEnabled` OR-extension in registry.ts** + rollups-engine/consumer module-scope wiring; HrController (cases, records incl. export gate, leave file/cancel + balance math, attendance upsert, checklist templates + instantiation, review-lite); approvals filing origin='hr' + decided eventHandler; `withTenants([t],{modules:['hr']})` on every handler; events `hr.case.*`, `hr.leave.*` (+ bridge allowlist); notifications with hrefs. **Done when:** endpoint tests green incl. approve-updates-balance, deny-then-refile, guard dark/alive per assignment, served-tenant rollup computes non-zero, `user.invited` spawns onboarding case; hr tools appear in `/mcp/tool-defs`; contract doc updated. |
| WSD-5 | senior-fe | M | default | WSD-4, ORG-12, UX-3 | **HR workspace UI.** `/hr` (workspace + scope pill + Envelope partial-view states), `/hr/leave` (my-leave + team queue + request form), `/hr/attendance`, `/hr/onboarding` (checklist board); `rbac.ts` hr caps (§4); nav via module manifest; unified approvals inbox renders hr-origin rows with context. **Done when:** e2e (DEMO_MODE + live) green; each/all switch renders per-company slices with envelope tags; leave filed in UI lands in the inbox and back. |
| WSD-6 | medior | M | default | WSD-4 | **Employee-360 + calendar integration.** HR cards (leave balance, onboarding progress, review status) on `/people/[id]` Cerbos-gated; people-directory service badging (via ORG-7b members shape); approved leave rendered on `/calendar`; demo fixtures for HR. **Done when:** cards render from real endpoints; unauthorized viewer sees no HR card; leave shows on calendar. |
| WSD-7 | junior | S | default (Haiku) | WSD-4 | **Seeds + docs.** Default onboarding/offboarding templates, seeded balances for the 15-person Gaia roster + Viceroy skeleton staff, leave demo rows; `FRONTEND-BFF-CONTRACT.md` HR section; module README. **Done when:** fresh seed → HR workspace populated; docs pass WS0-4-style verification. |
| WSD-8 | devops | S | default | ORG-12, ORG-13, ORG-14, WSD-2 | **Flag flip choreography (§6).** Pre-flag checklist verified (incl. A1 grep-lint in CI); `SERVICE_ASSIGNMENTS_ENABLED=ON` in dev/staging; rollback runbook (revoke-then-flag-off) written. **Done when:** flag ON in staging; checklist artifacts linked; runbook merged. |
| WSD-9 | qa | L | default (Sonnet·high) | WSD-5, WSD-6, WSD-8 | **THE OWNER'S ACCEPTANCE SCENARIO (§5), scripted.** All seven beats + adversarial probes, curl-proven denials, committed as a repeatable e2e. **Done when:** script passes on a live stack twice in a row (fresh seed + re-run); sign-off recorded → production flag flip authorized. |

**Not in WS-D:** payroll export stub stays WSG-6; deeper record-level scoping stays the
`scope_type='record'` future hook; multi-provider-same-module conflict UX beyond the unique-index
rule stays v1.1.

---

## 8. Open items for the coordinator
- UX-3 delivery state gates WSD-5's visual layer only — if UX-3 lags, WSD-5 builds on the existing
  design system and takes a UX review pass after (do not block the spine on it).
- ORG-12/ORG-13 (scopeCovers fix + connect UI) are pre-flag blockers per §6 and are NOT WS-D
  tickets — keep them on the ORG board and sequence before WSD-8.
- `memory/org-structure-contract` + plan-doc migration numbers: junior doc sweep (ORG-15/WS0-4
  follow-through) should note 0028 as the HR migration number.
