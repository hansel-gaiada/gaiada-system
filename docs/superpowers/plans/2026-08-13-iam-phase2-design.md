# IAM Phase 2 — positions drive access (design)

**Status:** PLANNED (design only — no code, no migrations, no policies changed by this doc).
**Date:** 2026-08-13. **Author:** architect seat.
**Parents:** `2026-08-10-identity-rbac-program.md` (the program; D-1..D-11 locked owner decisions) ·
`docs/PERMISSION-CONTRACT.md` (frozen Phase 1 contract) · `2026-08-10-iam-04-rollout-scan.md`
(perm-mirror doctrine) · `2026-08-12-iam-04c-ruling.md` (bypass + owner-envelope ruling) ·
`2026-08-03-agentic-native-erp-plan.md` (the seven-criterion bar, binding).

**The owner's ask, verbatim:**

> "The staff (employee), client, roles, permission should be flexible and can be setup in ui and the
> system will follow. And while we are doing this, we will handle the IT side of it as the it will
> handle the account and logins. The department head / manager will handle the permission for
> employee under that department. The HR will handle the staff / employee related."

**What this wave is, against the program's own phase map:** the program doc's Phase 2 remainder
(IAM-11 positions, IAM-12 position reconciler — HIER-1/2/3 already landed the org_unit scope +
closure + `org_unit_lead`), pulled together with Phase 5 (IAM-23/24/25 employee record + HR console
+ backfill), Phase 6 (IAM-26..29 IT accounts + JML), a *minimal* slice of Phase 4 (assignment +
routed override, D-10 — NOT custom-role composition), and one requirement the program doc did not
name because it emerged from this week's escalation findings: **the UI-grantable allow-list**
(§7). Phase 3 (owner role, superadmin collapse, two-person appointment, `group_executive` removal)
is explicitly NOT this wave — see §11.

**Owner constraint change (2026-08-13):** all legal/compliance constraints relaxed for build speed
("no real employee and only me. the data are all mock anyway"). Authorization correctness, tenant
isolation/RLS, the allow-list, and the escalation boundaries are NOT relaxed — they protect the
system, not the data. See §12 for the recorded cuts.

---

## 1. The authoritative-concept ruling: permission / role / position

The program already has two authorization concepts. This phase adds a third *organizational* one.
The ruling below says which is authoritative for what, and what the other two become. **No fourth
concept is introduced** — an "override" is a `user_roles` row with provenance, not a new entity.

| Concept | What it is after this phase | Authoritative for |
|---|---|---|
| **Permission** | Unchanged. The enforcement primitive, 1:1 with Cerbos (kind, action). Code-defined catalog; new permission = code change (D-1). Gains ONE new attribute: `ui_grantable` (§7). | What an action *requires*. Frozen Phase 1 contract. |
| **Role** | Unchanged as the enforcement currency: the only thing `user_roles` grants and the only thing Cerbos matches (role arm today, perm arm where wired). Role *composition* (`role_permissions`) stays migration-seeded this wave — the authoring UI is Phase 4. | What a grant *confers*. |
| **Position** (NEW) | An org-chart seat: `(tenant, org-unit node, title, is_lead, role-set template)`. **Pure provisioning data.** Holding a position causes the position reconciler to materialize ordinary `user_roles` grants tagged with provenance. | What a person *should* hold, by virtue of their seat. |

**The invariant that keeps this cheap and safe: Cerbos and Postgres RLS never learn that positions
exist.** No new derived role reads positions; no policy condition references them; no RLS predicate
joins them. Positions are strictly *upstream* of the grant table, exactly as `service_assignments`
already are. The entire enforcement path — `assemblePrincipal()` → `attr.grants`/`attr.perms` →
derived roles → resource policies → RLS — is byte-unchanged by position-driven access.

**Two truths, one bridge, one alarm:**

- *Effective access* (what a principal can do right now) = `user_roles` + Cerbos conditions + RLS.
  Unchanged, authoritative, and the only thing enforcement reads.
- *Intended access* (what they should hold) = active position assignments (× position role-sets)
  ∪ manual grants ∪ approved overrides.
- The **position reconciler** (§3) is the bridge: it makes effective access converge on intent,
  including revocation — placement grants, transfer revokes+regrants, departure revokes (D-3).
- The **drift detector** (§3.4) is the alarm: intended ≠ materialized is a reported defect, never a
  silent state.

**What replaces what:** the org blob's display-only `kind:"role"` nodes (`platform-ui/src/lib/
org.ts`) are the informal ancestor of positions and can be imported by the backfill (§9, P2-15).
Free-text `users.title` stops being a source of anything and becomes a display mirror of the
primary position's title (open question Q6). `group_executive`'s replacement by "a named position
carrying a normal role" (D-7) becomes *expressible* this wave but is *executed* in Phase 3.

---

## 2. Data model

Conventions: all new tenant tables are FORCE RLS with the standard `tenant_isolation` predicate;
`employees` additionally sits behind the HR module's third wall (`app_module_allowed('hr')`), like
every `hr_*` table. Position tables are **core** (not module-gated): the reconciler, the dept-head
surface, and admin flows read them platform-wide. Migration numbers are reserved at implementation
time from `docs/MAP.md` (head `0108`, next free `0109` as of 2026-08-13 — a tally, re-check).

**PD column = personal data marker.** Per the owner's 2026-08-13 decision this is a LABEL ONLY —
no encryption, no scrubbing, no handling tickets. It exists so a later retrofit is mechanical.

### 2.1 `employees` — the HR people file (D-4), HR-owned

| Column | Type | PD | Notes |
|---|---|---|---|
| `id` | uuid PK | | |
| `tenant_id` | uuid NOT NULL → companies | | one row per person **per employing company** (holding-OS reality: two group companies = two employee rows) |
| `user_id` | uuid NULL → users | | 0..1. **Partial unique** `(tenant_id, user_id) WHERE user_id IS NOT NULL` — a plain UNIQUE never fires on NULLs ([null-defeats-unique]) |
| `display_name` | text NOT NULL | PD | |
| `legal_name` | text | PD | |
| `work_email` | text | PD | mirror of `users.email` once linked |
| `personal_email` | text | PD | |
| `phone` | text | PD | |
| `hire_date` | date | | |
| `employment_status` | text NOT NULL DEFAULT 'active' | | CHECK IN (`pending_start`,`active`,`on_leave`,`terminated`) |
| `terminated_at` | timestamptz | | |
| `manager_user_id` | uuid NULL → users | | explicit reporting-line override only; the DEFAULT reporting line is the org chart (nearest ancestor unit's lead position holder) — do not duplicate the tree here |
| `notes` | text | PD | |
| `origin_site` / `created_by` / timestamps / `deleted_at` | | | house style |

**Deliberately absent:** salary/compensation, national-ID, bank details, documents. Not asked for,
PII-heavy, and `hr_records` (case files, typed `contract|document|note` + jsonb) already holds
ad-hoc documents. Add columns when a real feature needs them.

### 2.2 `positions` — the seat

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `tenant_id` | uuid NOT NULL → companies | |
| `unit_node_id` | text NOT NULL, CHECK non-empty | org-blob node id (`'d-web'` convention). **Free text, NO FK** — matches `org_unit_memberships.unit_node_id` (0055) and the 0029 ruling that node ids are not a table. Department/division nodes only (enforced in the write path against the blob, like `flattenOrgUnits`) |
| `title` | text NOT NULL | |
| `is_lead` | boolean NOT NULL DEFAULT false | display + backfill convenience; **confers nothing by itself** — lead authority comes from the role set (an `org_unit_lead @ own_unit` entry), so there is exactly one grant mechanism |
| `status` | text NOT NULL DEFAULT 'active' | CHECK IN (`active`,`retired`,`orphaned`) — `orphaned` = its unit node vanished from the blob (A16 semantics, §3.3) |
| `headcount` | int NULL | soft target, display only |
| `origin_site` / timestamps | | retire via `status`, rows are never deleted |

### 2.3 `position_roles` — the role-set template

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK · `tenant_id` uuid NOT NULL | |
| `position_id` | uuid NOT NULL → positions ON DELETE CASCADE | |
| `role_id` | uuid NOT NULL → roles | |
| `scope_kind` | text NOT NULL DEFAULT 'company' | CHECK IN (`company`,`own_unit`). Resolved at materialization: `company` → (`company`, tenant); `own_unit` → (`org_unit`, position.unit_node_id). **No `global` option, structurally** — a position can never confer platform tier |
| | UNIQUE (`position_id`,`role_id`,`scope_kind`) | |

**DB trigger (structural allow-list backstop, §7):** reject any INSERT/UPDATE whose `role_id` (a)
is in the denied-role registry (`platform_admin`, `group_executive`, `client`, and `owner` when it
exists), (b) has a bundle containing any permission with `ui_grantable = false`, or (c) violates the
scope-constrained map for the scope it would materialize at (e.g. `org_unit_lead` only with
`scope_kind='own_unit'`). The same rules are enforced first, with clean 400s, in the write path
(§6.3) — the trigger is the layer that survives a forgotten guard, per this week's lesson.

### 2.4 `position_assignments` — who holds the seat (temporal)

Mirrors `org_unit_memberships`' proven 0055 shape (dates + GiST, `btree_gist` already installed):

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK · `tenant_id` uuid NOT NULL | |
| `position_id` | uuid NOT NULL → positions | |
| `user_id` | uuid NOT NULL → users | **users, not employees** — so bot/agent principals (users rows by design, [principal-kinds]) can hold seats; the agentic bar's "position-driven access must hold for a bot principal" falls out structurally. Human employees link via `employees.user_id` |
| `valid_from` date NOT NULL DEFAULT current_date · `valid_to` date NULL | | NULL = current. CHECK `valid_to >= valid_from` |
| `assigned_by` uuid → users · `reason` text · `origin_site` · `created_at` | | |
| | EXCLUDE gist (`tenant_id` =, `position_id` =, `user_id` =, daterange &&) | no overlapping duplicate of the same seat by the same person; **plurality across different positions is allowed** (Q3) |

### 2.5 `user_roles` — additive provenance columns

`managed_by` is a **typed FK to `service_assignments`** (0026) and cannot be reused. Add:

- `managed_by_position uuid NULL → position_assignments(id)` — the position reconciler's marker.
  CHECK `NOT (managed_by IS NOT NULL AND managed_by_position IS NOT NULL)`. "Reconciler-owned"
  becomes `managed_by IS NOT NULL OR managed_by_position IS NOT NULL`; each reconciler touches only
  rows carrying **its own** marker.
- `expires_at timestamptz NULL` — time-boxed override grants (D-10); swept by §3.4.
- `origin_approval_id uuid NULL` — the `automation_approvals` row that authorized an override grant.

### 2.6 `position_grant_claims` — the refcount

Byte-pattern copy of `service_grant_claims` (0026), with `position_assignment_id` in place of
`assignment_id` (same `num_nonnulls = 1` CHECK, same **partial** uniques — plain UNIQUE would let
NULLs corrupt the refcount). Kept a **separate table** from `service_grant_claims` on purpose: A2's
"claims are the authoritative liveness refcount" only stays reason-about-able if each reconciler
owns its claims outright.

### 2.7 What is deliberately NOT new schema

- **No user↔unit table** — `org_unit_memberships` (0055, temporal, GiST-guarded) already exists and
  stays the placement record, derived from the org blob by `sweepMemberships()`. See §4.2 for how
  transfers keep it consistent.
- **No IT task table** — the IT worklist (§5.4) is *derived* (active employees without a Keycloak
  account; terminated with an enabled one; unverified identity links). A queue table would be a
  second truth to drift.
- **No org hierarchy change** — the blob stays presentation-authoritative (ORG-CORE decision);
  `org_units` stays the lazy anchor; `org_unit_closure` (0101) stays the traversal path. Positions
  hang off node ids exactly as memberships already do.

---

## 3. Access derivation — the position reconciler

Modeled line-for-line on `service-reconciler.ts`'s proven invariants (the program doc names it the
pattern to copy; ORG-6/7 verified it end-to-end). Flag-gated `POSITION_SYNC_ENABLED` (default off)
until QA's battery passes.

### 3.1 Desired state

For one user in one tenant: the union over their **active** position assignments (`valid_to IS
NULL`, position `status='active'`) of each position's `position_roles`, scope-resolved
(`company` → (`company`, tenant); `own_unit` → (`org_unit`, unit_node_id)). Union semantics mean
plural positions compose naturally and identical (role, scope) pairs from two seats are one grant
with two claims.

### 3.2 Diff and write (one transaction per user or per position-event; invariants copied verbatim)

- **A2 — claims are the refcount; markers are markers.** Grant exists manually (`managed_by` and
  `managed_by_position` both NULL)? Record **no claim**, touch nothing — a manual grant is never
  hostage to a seat change. Grant exists with this reconciler's marker? Add a claim for this
  assignment. Absent? INSERT with `managed_by_position` + claim (`ON CONFLICT DO NOTHING`,
  untargeted — the 0092 partial-index lesson).
- **Removal:** claims of ended/changed assignments minus desired → lock artifact rows `FOR UPDATE`
  in **sorted artifact-id order** (the service reconciler's deadlock discipline), delete claim,
  count remaining; zero remaining ⇒ `DELETE FROM user_roles WHERE id=$1 AND managed_by_position IS
  NOT NULL`. Manual and service-managed rows are structurally untouchable from this path.
- **A14 — explicit manual acts adopt.** An admin hand-granting a (user, role, scope) the reconciler
  already manages converts it to manual (clear marker, drop claims) via a generalized
  `adoptManagedGrantAsManual` — same hook `assignRole`/`inviteUser` already run for service grants.
- **Session cut:** one `session_version` bump per affected user, after commit — mutations re-check
  `sessionVersionCurrent()` (`core/http.ts`), so revocation bites on the target's next write.
- **Mass-revoke brake:** a single reconcile computing more than N revocations (N configurable,
  default ~20) aborts and reports instead of applying — the program's own risk table names
  "position reconciler mass-revokes on an org edit" as the top hazard. The manual endpoint accepts
  `?force=1` after a dry-run has been reviewed.

### 3.3 Triggers and orphans

- Outbox consumer on `position_assignment.*` + `position.*` events, and on the **existing**
  `org_structure.updated` stream — an org edit that deletes/re-kinds a position's unit node marks
  the position `orphaned` (grants freeze standing, A16), and the drift sweep auto-retires after a
  TTL. **The stream must be added to `startConsumerLoop([...])`** — the known silent-consumer trap.
- Manual `POST /api/:t/positions/reconcile` (+ per-assignment) with `?dryRun=1` preview that reuses
  the same desired-state collector — never a re-implementation (the ORG-7b rule).

### 3.4 Drift detector + expiry sweep

Nightly plain-Postgres loop (existing sweep pattern, gated): (a) recompute intended vs materialized
for every user with any assignment; divergence → report + `iam.drift_detected` event, never a
silent self-heal while the flag is young (auto-heal is a later graduation); (b) revoke expired
override grants (`expires_at < now()`), bump session, audit. Tests must set the tenant GUC and
assert row counts — an unset GUC returns zero rows and reports success (the standing RLS trap).

---

## 4. The employee record and the `users` boundary (D-4)

### 4.1 Ownership ruling

| Field / object | Owner | Lives in |
|---|---|---|
| Person data (names, contacts, hire/termination, status, notes) | **HR** | `employees` |
| Seat + role-set (positions, assignments) | **HR creates/retires positions; dept head assigns within their subtree** (§6) | `positions*` |
| Principal (email, display name, `status`, `session_version`, `idp_subject`) | **IT** (platform-mechanical; HR flows may *create* the row, never manage its credentials) | `users` |
| Login (Keycloak account, password, enable/disable, MFA) | **IT** | Keycloak, via `keycloak-admin.ts` |
| Chat identities + verification | **IT** | `identity_links` (existing dual-proof flow) |
| Membership in a company | derived from JML flows | `company_memberships` |
| Client contacts | untouched — separate trust surface, never staff | `client_contacts` |

**Where an employee stops and an account begins:** an `employees` row is a person HR manages — it
may exist with **no `users` row at all** (`pending_start` candidates). A `users` row is a
*principal* — something Cerbos can authorize; created mechanically at hire (reusing
`inviteUser`'s reuse-by-email semantics). A *login* is neither of those: it is a Keycloak account
reached through `provisionUser()`'s email-join (verified-email takeover guard stays binding), and
only IT mints or disables one. ~7 of ~50 users rows have logins today; this design makes that gap
visible on the IT worklist instead of leaving it folklore.

### 4.2 Placement: one authority, no second hierarchy

The org blob remains the single placement authority (`sweepMemberships()` derives
`org_unit_memberships` from person nodes on every org PUT). **Therefore any flow that moves a
person MUST move their blob person node in the same transaction**, through the existing
sanitize → sweep → closure-rebuild → `org_structure.updated` pipeline (extracted into an internal
service function; the HTTP PUT and the JML flows become two callers of one implementation). A
transfer that only touched `position_assignments` would be silently reverted by the next org edit's
sweep — that would BE the stale-mover defect, reintroduced through the side door.

---

## 5. Joiners / movers / leavers

Every flow below is a **capability**: BFF endpoint + MCP tool + outbox events + golden fixture,
identical under human / n8n / agent (the seven-criterion bar). Writes are idempotent (natural keys
noted). Denials are typed 403s, never `[]`.

### 5.1 Joiner — `POST /api/:t/hr/employees` (+ optional immediate placement)

HR (hr_manager / company_admin) creates the employee. If `positionId` (+ `startDate`) is given:
create/reuse the `users` row by email, create the membership (`kind='employee'`, adopting a
service-managed row per A14 if one exists), open the position assignment, add the person node to
the blob under the position's unit, emit `employee.hired` — the reconciler materializes grants.
Idempotency: `(tenant_id, work_email)` natural key; a retry converges. The IT worklist (§5.4) now
shows the person under "needs login"; **HR never touches Keycloak.**

### 5.2 Mover — `POST /api/:t/hr/employees/:id/transfer` `{toPositionId, effectiveDate?}`

One transaction: close the outgoing assignment (`valid_to`), open the new one, move the blob person
node (§4.2), emit `employee.transferred`. The reconciler then: grants the new set, revokes every
grant whose **only** remaining claims died with the old assignment, bumps `session_version`.

**The acceptance criterion this whole phase exists for (binding on P2-05/P2-06/P2-16):** after a
transfer commits and the reconciler has run, (a) zero `user_roles` rows carry
`managed_by_position` pointing at the closed assignment; (b) a live `authorize()` probe against a
resource only the OLD department's role-set could reach returns **403** (not asserted from bundles
— proven against running Cerbos, the [role-bundles-overstate-reach] lesson); (c) the NEW
department's probe returns 200; (d) the target's `session_version` moved. Proven in all three
operating modes.

### 5.3 Leaver — `POST /api/:t/hr/employees/:id/terminate` `{lastDay?}`

One transaction + reconcile: close all assignments, remove the blob person node, membership →
`inactive`, revoke this tenant's manual grants for the user (audited list in the response),
`employment_status='terminated'` (record retained). If **no other company's active membership
remains**, set `users.status='disabled'` — `assemblePrincipal()` already returns `null` for
non-active users, so platform access dies immediately even before Keycloak is touched — and bump
`session_version` regardless (D11). Emits `employee.terminated`; the IT worklist shows "disable
login"; IT completes the Keycloak disable. Cross-company employment at another group company is
deliberately unaffected.

### 5.4 IT accounts console (Phase 6 pulled in, minimal)

`GET /api/:t/it/accounts` — a **derived** worklist joining members ↔ Keycloak (via
`findUserByEmail`) ↔ `identity_links`: joiners needing logins, leavers with enabled logins,
unverified links, `amr`/MFA visibility later. Actions (`it.account.*`, `it_admin`/`it_manager` +
company_admin): `provision` (createUser + `generateInitialPassword`, shown once), `disable`,
`enable`, `reset-password` — all through the existing `keycloak-admin.ts`, all idempotent
(`findUserByEmail` first; 409 → link, never duplicate), all audited. Not HR-module-gated.

---

## 6. The granting authorization model — who may grant what, bounded by what

Two reachable escalations shipped this week through grant write paths with incomplete guards
(IAM-SEC-02, IAM-SEC-05). This section assumes every new write path will be attacked and answers
structurally, not by care.

### 6.1 The single choke point

`GrantWriteService` becomes the **only** production code that INSERTs/DELETEs `user_roles`. The
existing statically-pinned writer enumeration (`src/admin/user-roles-writer-guard.test.ts` walks
`src/` and fails on any unclassified `INSERT INTO user_roles`) is extended: a GUARDED writer must
now be *inside this service* — a bespoke writer anywhere else turns the suite red. Existing
writers migrate: `assignRole`/`inviteUser` (behavior-identical, §6.4), both reconcilers, the
`client` grant path (as a TRUSTED internal caller). Every mutation: audit row + target session
bump. Every guard ships with a teeth test (guard disabled ⇒ the attack returns 2xx — proven, then
guarded), the program's standard.

### 6.2 Who may grant — a real Cerbos kind, not a proxy

Granting stops riding `user:create`. New kind **`role_grant`** (actions `create`, `revoke`,
`read`; resource attrs: `tenantId`, `targetUserId`, `targetUnitAncestors` — the target's current
unit ancestry from the closure, fail-closed empty like `org_unit_lead`'s own feed):

- `platform_admin` wildcard (per-kind tier rule, IAM-04c authoring rule).
- `company_admin` @ company — full-tenant granting authority (today's reality, kept).
- **Dept head:** an `org_unit_lead`-style **own rule, never mixed** (the §1.4 binding authoring
  rule): `g.role=="org_unit_lead" && g.scopeType=="org_unit" && g.scopeId in
  targetUnitAncestors`. Dept-head authority therefore comes from holding a lead **position** whose
  role set carries `org_unit_lead @ own_unit` — the owner's "department head handles permissions
  under that department" becomes a property of the org chart.
- **Structural self-target DENY** (IAM-GAP-02's proven pattern): `EFFECT_DENY` on
  `roles: ["user"]` where `targetUserId == principal.id` — deny-overrides beats every ALLOW
  including the platform_admin wildcard. D-9's no-self-escalation, expressed in the authority
  layer itself, not only in controllers.
- Per current doctrine this kind ships **role-arm only** and, because its dept-head rule is
  attribute-dependent (subtree containment), it joins `appraisal`/`report_document` in the
  **permanently-unwired** perm-mirror set (IAM-04c §9 option C precedent). Registered as such in
  the rollout register so the omission is a decision, not a gap.

`position` kind: `assign`/`unassign` carry the same rule shape (company_admin, dept-head-own-rule
over the position's unit ancestry, self-assign DENY); `create`/`update`/`retire` are
company_admin + hr_manager. `employee` kind (hr domain): hr_manager/company_admin write,
hr-reader tier read. `it_account` kind: it_admin/it_manager/company_admin.

### 6.3 Bounded by what — the invariants at the choke point (all new surfaces)

1. **Subtree bound** — target's current unit is within the grantor's lead subtree (closure
   containment; company_admin/platform_admin: whole tenant). Cerbos decides this (§6.2); the
   service re-derives `targetUnitAncestors` server-side — never caller-supplied.
2. **Ceiling** — the granted role's bundle must be a **subset of the grantor's own resolved
   permissions at that scope** (concrete-key subset over `principal.perms`; this algebra is exactly
   why IAM-04c banned a `*` permission). Nobody grants what they do not hold. `platform_admin`
   passes trivially (holds all 249 grantable); the 15 relationship keys are in no bundle, so they
   are structurally out of reach end-to-end.
3. **Allow-list** — the role must be UI-grantable (§7).
4. **Scope validity** — `assertRoleScopeAllowed` (existing map, machine-checked against
   `derived_roles.yaml`) + the per-scope shape CHECKs; `perm`-arm safety is backstopped by
   IAM-SEC-06's resolution-time filter even if a bad row exists.
5. **No self-target** — mirrored from the Cerbos DENY with a clean 400 (and Cerbos remains the
   authority if the mirror is ever lost).
6. **Elevated fence** — `platform_admin`/`group_executive` (and `owner`, Phase 3) are not
   grantable from ANY Phase-2 surface at any scope. Until the two-person appointment flow (IAM-16)
   exists, the only doors to the elevated tier remain the existing global-scope-guarded admin path
   and seeds. This is D-9's interim satisfaction: the new surfaces cannot mint tier, period.
7. **Sensitive routing (D-10 minimal)** — a role whose bundle contains any `sensitive`-flagged key
   is not directly grantable from the dept-head surface; it routes as an **override request**
   (§6.5). Routing is a code-defined map this wave (`hr.*`-sensitive → hr_manager + company_admin;
   billing/finance → company_admin; default → company_admin; `owner` slots in at Phase 3);
   the configurable routing TABLE is Phase 4 (IAM-22).

### 6.4 The legacy admin surface — explicit boundary

`assignRole`/`inviteUser` (company_admin, full catalog reach) keep today's semantics this wave —
minus one tightening: **target == caller is refused** (D-9; a clean 400; no legitimate flow
self-grants — seeds and fixtures use their own writers). Full convergence of the admin surface
onto ceiling+allow-list happens with the Phase 4 authoring UI. Recorded as an accepted, visible
boundary (Q5), not an oversight.

### 6.5 Overrides — per-person grants beyond the position (D-10)

Dept head requests → `automation_approvals` row (`origin='iam'`, `workflow_id='iam:override'`,
payload: target, role, scope, requested expiry) → routed approver decides through the **existing
inbox** via a dedicated literal action `decide_override` on the `automation_approval` kind (the
`decide_leave` precedent — no endpoint fork) → an approving decision **executes in-band** through
`GrantWriteService` (grant tagged `origin_approval_id` + `expires_at`), recording
`requested_by`/`decided_by`. **Requester ≠ decider** is a structural Cerbos DENY on
`decide_override` (creator-check pattern from the invoice seam). Expiry default 90 days (Q4);
the sweep (§3.4) revokes and audits. Agent-origin proposals ride the same D14 gate they already
would (the approval registry executes registry-listed tools only).

---

## 7. ⚠ The UI-grantable allow-list — first-class

**The hazard, stated precisely:** a `perm_*` mirror honours a permission key *whichever role
carries it*, and `role-permission-bundles` honours whatever `role_permissions` says. That is safe
today only because role composition is migration-only. This phase creates UI write paths that
*attach roles to people and seats* (and Phase 4 will compose roles outright). A staff role carrying
`portal.*` would put staff inside the client portal — **at a perfectly valid scope**, which is why
no scope check can catch it. The boundary must live on the *keys themselves*.

**Design:**

- **Catalog axis:** `permissions.ui_grantable boolean NOT NULL` + a REQUIRED `uiGrantable` field on
  every `permission-catalog.json` entry. The catalog is code (D-1), so the axis ships with the key
  — there is no runtime write path to it, ever.
- **Derived role predicate:** a role is *UI-attachable* (to a position, a direct grant, or a
  Phase-4 composition) iff every key in its bundle is `ui_grantable` AND the role is not in the
  denied-role registry (`client`, `platform_admin`, `group_executive`, `owner` later — `client` is
  listed even though its one key could be argued, because the client/staff interface boundary is a
  trust boundary, not a permission sum).
- **Initial marking:** all `portal.*` = **false**; the 15 relationship keys = false structurally
  (they are in no bundle — four independent layers already hold this); everything else grantable =
  true, with `sensitive` keys additionally gated behind §6.3(7)'s routing. One reviewed pass at
  implementation, recorded in the PERMISSION-CONTRACT.
- **Enforcement layers** (each independently sufficient for the portal case):
  1. `assertRoleUiGrantable(roleId)` in `GrantWriteService` — the one helper every writer calls.
  2. The `position_roles` DB trigger (§2.3) — survives a forgotten guard.
  3. Static invariants in the alignment chain (`test:iam-chain-alignment`).
- **How it stays correct as new keys land:** (a) the catalog completeness test **fails on any entry
  missing `uiGrantable`** — a new key cannot land without an explicit decision (the tally-vs-
  invariant lesson: this is an invariant, pinned hard); (b) a pinned test asserts `portal.* ⇒
  uiGrantable=false` and `class='relationship' ⇒ false`, so "restoring consistency" turns CI red;
  (c) flipping any key false→true is defined in the PERMISSION-CONTRACT as a contract change
  requiring an owner decision line in the catalog entry, same as a rename.

---

## 8. Agentic-native compliance (the bar, per capability)

| Criterion | How this design meets it |
|---|---|
| 1 Tool parity | Every §5/§6 capability ships its MCP tool in the same ticket (P2-07); org/people/grants move out of the "not reachable at all" row of the 2026-08-03 baseline |
| 2 Deterministic contract | Typed bodies; refusals carry `{error, code}` (`ceiling_exceeded`, `not_ui_grantable`, `outside_subtree`, `self_grant_forbidden`, `sensitive_requires_approval`…) |
| 3 Idempotent writes | Natural keys per flow (§5.1); untargeted `ON CONFLICT DO NOTHING` on grants; retries converge |
| 4 Impact-classified | hire/transfer/terminate/grant/override-decide/account-ops = medium/high → D14-registered for automation/agent origin; human-direct paths authorize identically |
| 5 Explicit refusal | 403 with reason end-to-end; the dept-head UI renders limited-access states, never empty lists |
| 6 Observable | Every mutation writes an activity + outbox event with actor + tenant; reconciler emits per-run summaries (granted/revoked/skipped/affectedUsers, the ORG-7 shape) |
| 7 Golden case | One fixture per capability (P2-16), reusable as eval cases |

Bots hold positions natively (§2.4). Agent attribution (co-author model) is deliberately NOT here —
owner decision 2026-08-08 gives it its own version cut; nothing in this design blocks it.

---

## 9. Ticket decomposition

Seats: `senior-db` / `senior-be` / `senior-fe` / `senior-integrator` / `medior` / `junior` / `qa`.
Model·effort: seat default unless flagged (flag = start there, a cheap first run would be wasted).
Every ticket: status language binding; migrations expand/contract; contract docs updated in the
same change; teeth tests for every new guard.

**Wave A — substrate (nothing user-visible changes; everything after builds on it)**

| ID | Seat · model | Ticket | Done when (acceptance) | Deps |
|---|---|---|---|---|
| **P2-01** | senior-db | Schema: `employees`, `positions`, `position_roles`, `position_assignments`, `position_grant_claims`, `user_roles` columns (§2) | Migrations (numbers reserved from MAP at impl time) apply on a fresh DB AND on a current-head copy; FORCE RLS on all new tables (hr wall on `employees`, tenant wall on position tables) with `lint:migration-rls`/`lint:withtenants` clean; partial uniques + GiST exclusion proven by attempted-violation tests; the §2.3 trigger rejects a denied role, a non-grantable bundle, and a scope-invalid pair (each RED with trigger dropped); zero existing rows altered (count-asserted) | — |
| **P2-02** | senior-be | Cerbos kinds `role_grant`/`position`/`employee`/`it_account` + catalog keys + bundles + groups | `cerbos compile` + full `test:iam-chain-alignment` green; tier rules exactly per §6.2 (dept-head rule is own-rule, never mixed — hazard-scan stays green); the self-target DENY teeth-proven (rule removed ⇒ platform_admin self-grant 200); role-arm ONLY, the 4 kinds registered in the rollout register (`role_grant` as permanently-unwired); PERMISSION-CONTRACT § updated additively | P2-01 |
| **P2-03** | senior-be | The `ui_grantable` allow-list (§7) | Column + required catalog field; completeness test fails on an entry missing the field (proven by mutation); `portal.*`/relationship pins RED under flip; `assertRoleUiGrantable()` shipped with teeth test; contract § documents the false→true owner-decision rule | P2-01 |
| **P2-04** | senior-be · **opus·medium** — refactor of the exact surface both IAM-SEC-02 and IAM-SEC-05 lived in; a silent behavior delta here IS an escalation | `GrantWriteService` choke point (§6.1) + legacy self-target tightening (§6.4) | All 6 production writers/deleters route through it; `user-roles-writer-guard.test.ts` extended to fail on any INSERT outside the service (proven by planting one); existing suites (`global-only-role-scope`, admin-identity, parity 22/22) byte-green; `assignRole`/`inviteUser` behavior identical EXCEPT target==caller ⇒ 400 (new pinned test); every mutation audits + bumps session | P2-01..03 |

**Wave B — the engine (after this wave the owner can hire/move/terminate and access follows)**

| ID | Seat · model | Ticket | Done when | Deps |
|---|---|---|---|---|
| **P2-05** | senior-be · **opus·high** — the mover guarantee lives here: claims refcounting, FOR-UPDATE lock ordering, cross-source adoption, orphan freeze, mass-revoke brake; a wrong diff is either estate-wide stale access or estate-wide lockout, and a cheap failed attempt means re-verifying every invariant from scratch | Position reconciler (§3) | A2/A12-analog/A14/A16 invariants each adversarially tested (manual grant survives seat end; two seats → one grant, two claims, survives one seat ending; admin re-grant adopts; org-edit orphan freezes grants); consumer registered in `startConsumerLoop` for the new streams AND `org_structure.updated`; dry-run reuses the desired-state collector (asserted same function); mass-revoke brake proven; per-user session bump; flag-gated default-off | P2-01..04 |
| **P2-06** | medior | Employee CRUD + JML capabilities (§5.1–5.3) incl. the shared internal org-blob edit path (§4.2) | Three flows transactional + idempotent (retry test per flow); transfer moves the blob node through the SAME sanitize/sweep/closure/emit pipeline as PUT (single implementation, asserted); terminate implements the cross-company `users.status` rule + immediate `assemblePrincipal` null; events emitted; BFF rows added; typed refusals | P2-05 |
| **P2-07** | medior | MCP tools + D14 registration for all Phase-2 capabilities | Tools via `ModuleContract.mcpTools` (hub aggregates; nothing hardcoded hub-side); UI-vs-tool reach parity test; medium/high writes registered with the impact gate and an agent-origin approval EXECUTES (D14 closed-loop test); golden agent-mode fixture per capability | P2-06, P2-08 |
| **P2-08** | senior-be · **opus·high** — the new escalation surface; the brief's instruction is to assume this path will be the next reachable escalation | Grant/revoke endpoints + override request/decide (§6.2, §6.3, §6.5) | Every §6.3 invariant enforced at the choke point AND teeth-proven (guard off ⇒ 2xx); Cerbos `role_grant` decisions live-probed (dept-head in/out of subtree, self-target DENY, elevated fence, client unreachable); override rides `automation_approvals` with `decide_override` + requester≠decider DENY; approval executes the grant in-band with `expires_at`+`origin_approval_id`; adversarial battery: ceiling breach, non-grantable role, sensitive-direct, cross-subtree, self-grant, `platform_admin@company`, portal-role attach — all refused with typed codes | P2-04, P2-02/03 |
| **P2-09** | medior | Drift detector + expiry sweep (§3.4) | Nightly gated loops; seeded divergence detected + reported (not auto-healed); expired override revoked + session bumped + audited; tests set GUC + assert counts (zero-row trap covered) | P2-05, P2-08 |

**Wave C — surfaces**

| ID | Seat · model | Ticket | Done when | Deps |
|---|---|---|---|---|
| **P2-10** | medior | HR console: hire/transfer/terminate flows + employee record on existing `/hr/people` + `/people/[userId]` | Forms drive the real endpoints (no fixture writes); capability additions with `rbac-capability-parity` green; typed refusal states rendered; e2e persona test (hr_manager can, member cannot) | P2-06 |
| **P2-11** | senior-fe | Dept-head access page (subtree roster, positions, effective access, grant/override) | Roster from closure-backed endpoint; effective access via IAM-05c BFF with its scope-level caveat honored (display-only, §5 boundary respected — no per-resource claims); assign/unassign + allow-listed direct grant + override request wired; page reachable only with `role_grant` reach (nav via `can.scopeOnly`, server re-checks); e2e: lead sees own subtree, sibling-dept lead sees 403 | P2-08 |
| **P2-12** | medior | Positions admin UI (create/edit/retire, role-set composer, is_lead, orphan badge) | Composer lists only server-filtered attachable roles (allow-list enforced server-side, UI never the filter); orphaned state visible; org-page integration | P2-05, P2-03 |
| **P2-13** | senior-integrator | IT accounts backend (§5.4) over `keycloak-admin.ts` | Worklist derivation correct on seeded fixtures (joiner/leaver/unverified); provision/disable/enable/reset idempotent (double-provision converges, 409→link); initial password display-once; `it.account.*` authz probed; audited; degrades to a typed 503 when `keycloakAdminConfigured()` is false | P2-02, P2-06 |
| **P2-14** | medior | IT accounts console (FE `/it/accounts`) | Worklist + actions against real backend; badge states (no login / disabled / unverified link); persona-gated (it_admin yes, member no) | P2-13 |

**Wave D — data + the gate**

| ID | Seat · model | Ticket | Done when | Deps |
|---|---|---|---|---|
| **P2-15** | senior-db | Backfill + adoption (IAM-25/28 slim) | `employees` seeded from `company_memberships kind='employee'` + `users`; positions optionally imported from blob `role` nodes (report for owner review); current `org_unit_memberships` → assignments where unambiguous; **manual-grant adoption**: exact (user, role, scope) matches re-tagged `managed_by_position` + claim so future moves manage them — adoption NEVER creates or widens a grant (count-asserted: `user_roles` row count identical before/after); dry-run report first; GUC-set + count-asserted throughout | P2-05, P2-06 |
| **P2-16** | qa | The adversarial + three-mode battery | §5.2's mover criterion proven in all three modes (UI persona, MCP tool, n8n envelope) against running Cerbos; leaver: denied on next mutation post-terminate; joiner golden path; P2-08's escalation battery re-run black-box; a `dept_head` position-holder persona added; existing persona suites + parity suites still green; each finding filed, nothing "fixed in test" | P2-06..15 |
| **P2-17** | junior | Contract/doc sync | FRONTEND-BFF-CONTRACT rows for every new endpoint; PERMISSION-CONTRACT §§ (allow-list contract, new kinds, legacy-surface boundary); MODULES.md + CHANGELOG bumps; MAP regenerated; rollout-register entries present | rolling, final pass after P2-16 |

**Order rationale:** A is invisible plumbing with hard gates; B lands the owner's headline
capability early (hire/move/terminate with access following — demonstrable after P2-06 + a minimal
P2-15 pass, before most UI); C makes it operable by the actual actors (HR, dept heads, IT); D
proves the whole thing hostile-grade. Nothing waits on a big bang; the flag (`POSITION_SYNC_
ENABLED`) lets schema/engine land dark.

**Opus flags, restated:** P2-05 (opus·high), P2-08 (opus·high), P2-04 (opus·medium). Everything
else runs on seat defaults — most tickets here have precise specs and strong existing patterns to
copy.

---

## 10. What this design deliberately does NOT do (and why)

- **Phase 3** — `owner` (D-8: zero policy rules, exclusion-generated bundle — per IAM-04c it
  hard-depends on perm-arm coverage of its envelope, which is still partial), superadmin collapse
  (D-6), two-person appointment (D-9's full form), `group_executive` removal (D-7, ~39-rule
  sweep), step-up/MFA wiring (IAM-18 — `assurance:"high"` is currently unreachable live anyway;
  gating Phase-2 flows on it would brick the owner). The elevated fence (§6.3.6) keeps Phase 2
  safe without them.
- **Phase 4** — custom-role composition UI and the configurable D-10 routing table. Positions
  reference existing library roles only; the routing map is code this wave. The allow-list (§7) is
  designed now precisely so Phase 4 inherits its boundary instead of retrofitting one.
- **Agent attribution (co-author)** — owner decision 2026-08-08: its own version cut. This design
  neither includes nor blocks it.
- **`users.kind` migration** — named cross-cutting item with its own design doc; Phase 2 keeps the
  `company_memberships.kind` interim and does not deepen the dependency.
- **Cerbos permission-arm completion (Phase 7)** — continues on its own register; the 4 new kinds
  follow current doctrine (role-arm + register entry) rather than expanding the mirror surface
  mid-rollout.
- **Org-chart/builder redesign** — the blob stays authoritative; positions attach to it. Reversing
  that authority is a separate program if ever wanted.
- **HR self-service portal** — scoped out previously; unchanged.
- **Payroll/compensation fields** — not asked for, PII-heavy, no consuming feature.

## 11. Deferred by owner decision (2026-08-13) — recorded gaps, not silent holes

Cut for build speed because there are no real employees and the data is mock; each becomes a
ticket the day real staff data is scheduled to enter the system:

| Cut | One-line reason |
|---|---|
| PII encryption at rest (crypto-shred, two-axis subject×entity) for `employees` | mock data only; §2.1's PD column labels make the retrofit mechanical |
| PAN / national-ID scrubbing on employee-record writes | no real identifiers will be entered; `scrub.ts` exists when needed |
| Legal Gate 1 sequencing / DPIA / consent / retention / data-subject rights | owner ruled bypassed; no ticket gated on them |

**Not cut** (explicitly, because they are system-safety, not compliance): Cerbos+RLS authority,
tenant isolation, the allow-list, every escalation boundary in §6, D11 session revocation.

## 12. Open questions for the owner (each with a recommendation)

1. **Sensitive-key roles from the dept-head surface** — always via routed override (my
   recommendation, §6.3.7), or direct for hr_manager-grade grantors? Rec: **always route**; the
   inbox is one click and the audit trail is the point.
2. **May bot/agent principals hold positions** (agent seats in the org chart)? Rec: **yes** — it
   is free by construction (§2.4) and matches the AI-staff direction; declining costs a guard.
3. **Plural positions** — may one person hold several concurrent seats? Rec: **yes** (union
   semantics are natural in the reconciler); forbidding is a one-line constraint later if wanted.
4. **Override expiry default** — Rec: **90 days**, renewable via re-request; permanent needs
   company_admin.
5. **Legacy admin surface** (`assignRole`, company_admin, full catalog) — keep unchanged this wave
   except the self-target refusal (§6.4)? Rec: **yes**; converge it in Phase 4 rather than
   destabilizing the one working grant surface mid-wave.
6. **`users.title`** becomes a display mirror of the primary position's title? Rec: **yes**,
   one-way (position → title), never edited directly once the person holds a seat.
