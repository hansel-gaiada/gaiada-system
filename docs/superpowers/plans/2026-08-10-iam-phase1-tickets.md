# IAM Phase 1 — Permission Contract Freeze: ticket decomposition

**Parent:** `2026-08-10-identity-rbac-program.md` (owner decisions D-1..D-11 locked 2026-08-10).
**Goal of Phase 1:** publish a permission contract Web Dev and PM can build against immediately,
with **zero behaviour change** for any existing user. Everything in Phases 2–7 lands behind it.

**Hard rule for this entire phase:** no authorization decision may change. Every ticket that touches
authz ships with a parity assertion. If a decision differs pre/post, the ticket is wrong, not the test.

---

## 0. Measured surface (verified in source 2026-08-10)

These numbers scope the work — they are counted, not estimated.

| Fact | Value | Source |
|---|---|---|
| Cerbos resource kinds | **61** | `cerbos/policies/resource_*.yaml` |
| Distinct `(kind, action)` pairs | **286** | parsed from policy `actions:` lists |
| Kinds carrying a `*` wildcard rule | **56 of 61** | the superadmin bypass |
| Concrete (non-wildcard) actions | **~230** | ≈ the catalog size |
| Policy rules naming `group_executive` | **39** | the D-7 removal sweep (Phase 3) |
| Policy rules naming `platform_admin` | **59** | mostly the `*` bypass rules |
| `ModuleContract.permissions` declared | yes | `src/modules/contract.ts:64` |
| Consumers of `ModuleContract.permissions` | **ZERO** | inert declaration surface |
| Runtime reads of `permissions` / `role_permissions` | **ZERO** | dead schema, `0001_core.sql` |

### The naming conflict that must be resolved first

Three conventions are live simultaneously and none of them agree:

| Where | Example | Shape |
|---|---|---|
| `ModuleContract.permissions` | `hr:case:read` | colon, `module:resource:action` |
| `platform-ui/src/lib/rbac.ts` `CAPABILITIES` | `hr.view`, `pm.contribute` | dot, coarse-grained *capability* |
| Cerbos policies | kind `hr_case` + action `read` | a pair, not a string |

Worse, they are not merely spelled differently — they are at **different granularities**.
`hr.view` is one UI capability covering several Cerbos actions. The catalog must reconcile
granularity, not just syntax. This is IAM-01a and it blocks everything else in the phase.

Also noted: the six search policies use resource kind `resource_search_*` (redundant prefix).
Handlers and policies agree, so it is not a bug — but permission keys must normalize to
`search.property.update`, never inherit the odd kind name.

---

## 1. Tickets

Tier legend: **S** = senior (design judgment), **M** = medior (clear spec), **J** = junior (mechanical).
Dependencies are hard unless marked "soft".

### IAM-01 — Permission catalog

| ID | Tier | Depends | Ticket |
|---|---|---|---|
| **IAM-01a** | ✅ **DECIDED 2026-08-10** | — | **RESOLVED by owner ruling** — see `2026-08-10-iam-01a-02a-analysis.md` §6. Two-layer model (215 fine-grained enforcement primitives + curated UI permission groups); key format `<domain>.<resource>.<action>` dotted, `core` for non-module kinds; today's ~40 `CAPABILITIES` become the first set of permission groups, retained not discarded. No longer blocks the phase. |
| **IAM-01b** | M | 01a ✅ | **Derive the catalog** at **215** role-grantable permissions (NOT 230 — see IAM-01b-2 and the three-class ruling). Ship the mapping table `permission ↔ (cerbos kind, action)`, and mark each of the 15 excluded pairs as **relationship-granted / bypass-exempt**. Normalize the `resource_search_*` kind prefix away in keys (`search.property.update`). Output is a reviewed checked-in file, not code. |
| **IAM-01b-2** | M | — (soft: 01b) | **NEW.** Verify that `mcp_tool:call` and `agent_run:read` are deliberately outside superadmin's reach before the 215 boundary is frozen. The two assistant policies carry a written rationale; these two do not. If either turns out to be an oversight, the boundary is 216 or 217 and IAM-01b must be corrected before consumers adopt it. |
| **IAM-01b-3** | M | 01b | **NEW.** Define the initial **permission groups** (the UI layer of Ruling 1), seeded from the ~40 existing `CAPABILITIES`. Each group is a named, described set of fine-grained permissions. This is what HR and dept heads actually see; treat naming and comprehensibility as the acceptance criterion, not coverage. |
| **IAM-01c** | M (senior-db review) | 01b | **Migration: seed the live `permissions` table** from the catalog. Extend the table with `module_key`, `sensitive boolean` (drives step-up + D-10 approval routing later), and `deprecated_at`. Idempotent re-seed. RLS: catalog is global reference data, not tenant data — assert the FORCE-RLS sweep treats it correctly. |
| **IAM-01d** | M | 01c | **Consume `ModuleContract.permissions`** (currently zero consumers). The module registry loads each module's declared permissions at boot, validates them against the DB catalog, and **fails closed on drift** — a module declaring an uncatalogued permission must refuse to start, not silently no-op. Migrate the existing colon-style module declarations to the 01a convention. |

### IAM-02 — Role → permission bundles

| ID | Tier | Depends | Ticket |
|---|---|---|---|
| **IAM-02a-0** | J | — | **NEW, DO FIRST.** Live-data check: who holds `group_executive`, and do they also hold `platform_admin`? One read-only query against the live box. Ruling 4 depends on it — if every holder also holds `platform_admin` the mirror's over-claim is inert and can be corrected in Phase 1; if anyone holds it alone, defer to Phase 3. **⚠ Requires operator access to `gda-aicenter` (see §6).** |
| **IAM-02a** | S (senior-be) | 01b, 02a-0 | **Seed every built-in role as a permission bundle** in the dead `role_permissions` table, derived from **wildcard-expanded** Cerbos coverage. Source of truth is the *actual* policies, cross-checked against `ROLE_CAPS`. Where they disagree, **Cerbos wins** and the discrepancy is documented — do not fix silently. Known going in: `group_executive` 118/230 vs `ALL` claimed; `platform_admin` 215/230 vs `ALL` claimed; `viewer` holds 30 pairs incl. `pm_task:update`. |
| **IAM-02c** | S (senior-be) | 02a | **NEW (Ruling 5).** Replace string-composed `module_staff`/`module_manager` with **per-module seeded roles carrying explicit bundles** (`hr_staff`, `search_staff`, `reports_staff`, …). ⚠ **Highest-risk integration point in the phase:** `service-reconciler.ts` materializes `<module>_staff` grants onto SERVED companies and the `managed_by` invariant must continue to hold. Service-assignment tests must stay green unchanged. |
| **IAM-02b** | S (qa) | 02a | **Bundle parity suite.** For every `(role, kind, action)` triple in the 286-pair matrix, assert the bundle-derived answer is identical to today's role-name answer. This is the safety net for the entire phase — it must exist and be green before IAM-04 touches a policy. |

### IAM-03 — Principal carries resolved permissions

| ID | Tier | Depends | Ticket |
|---|---|---|---|
| **IAM-03a** | S (senior-be) | 02a | **Extend `src/rbac/principal.ts`** to resolve and emit `perms` per scope alongside the existing `roles` array. Strictly **additive** — `roles` stays, every existing call site unchanged. Preserve the existing guarantees: assembled from DB only, never client-asserted; `sessionVersion` (D11) semantics untouched. |
| **IAM-03b** | S (senior-db) | 03a | **Resolution performance.** Principal assembly runs on **every request**; expanding roles→permissions adds a join per request. Measure before/after, add indexes, and cache with an invalidation keyed on `session_version` so a revoked grant is never served stale. Ship a benchmark, not an assurance. |

### IAM-04 — Cerbos compat shim

| ID | Tier | Depends | Ticket |
|---|---|---|---|
| **IAM-04a** | S (senior-be) | 03a | **Pass resolved permissions as a principal attribute** and add permission-matching derived roles beside the existing role-name ones in `derived_roles.yaml`. Nothing consumes them yet. ⚠ Cerbos must be **restarted** for policy changes — no hot reload (see memory `cerbos-new-policy-needs-restart`). |
| **IAM-04b** | S (senior-be) | 04a, 02b | **Dual-match pilot on two resources** — `pm_task` (the PM unblock path) and `hr_case` (module-role path, exercises `module_staff`/`module_manager` string composition). A rule may match a role name **or** a permission; both must produce identical decisions. Parity suite green. |
| **IAM-04c** | S (architect) | 04b | **Rule the superadmin/owner bypass.** 56 of 61 kinds carry a `*` rule for `platform_admin`/`group_executive`. Decide whether the bypass stays a wildcard rule or becomes an explicit `*` permission, and write it down — this ruling governs the Phase 3 `owner` envelope and the D-9 no-self-escalation invariant. Design output, no code. |

### IAM-05 — The public check API (the actual unblock)

| ID | Tier | Depends | Ticket |
|---|---|---|---|
| **IAM-05a** | S (senior-be) | 04b | **Server-side `can(permission, scope)`** as the single published entry point, wrapping `check()`. Existing `authorize(...)` call sites keep working unchanged. |
| **IAM-05b** | S (senior-fe) | 01b | **Generate `platform-ui/src/lib/rbac.ts` from the catalog** instead of hand-maintaining it. The file's own header already documents two past bugs caused by hand-maintained parallel lists (`Role` union missing `team_lead` and `viewer` entirely, and `CAPABILITIES`/`ALL` drift) — codegen makes that class of bug structurally impossible. Generated output must be committed and diff-reviewed, not built at runtime. |
| **IAM-05c** | M | 05a | **BFF endpoint: the caller's effective permissions** for a scope, so the UI gates on server truth rather than re-deriving it. Cacheable, invalidated on `session_version` bump. |

### IAM-06 — Personas and fixtures

| ID | Tier | Depends | Ticket |
|---|---|---|---|
| **IAM-06a** | M | 02a | **Seed 9 test personas**: superadmin, owner, company_admin, dept head, HR manager, HR staff, IT, member, viewer, plus a client contact. Idempotent seed alongside `seed:agency`. `owner` seeds as a placeholder bundle until Phase 3 defines it — flagged clearly so nobody mistakes it for the final envelope. |
| **IAM-06b** | M (qa) | 06a | **Test helpers + Playwright fixtures** so PM and Web Dev assert permission-gated behaviour deterministically. This is the deliverable those teams consume — treat their ergonomics as the acceptance criterion. |

### IAM-07 — Contract doc and drift protection

| ID | Tier | Depends | Ticket |
|---|---|---|---|
| **IAM-07a** | M | 05a, 06b | **Publish the contract** — permission catalog, `can()` semantics, scope semantics, personas, and what is explicitly NOT frozen (org_unit scope, custom roles, `owner`, all Phase 2+). Follows the `docs/FRONTEND-BFF-CONTRACT.md` convention. |
| **IAM-07b** | S (qa) | 07a | **Three-way drift test**: DB catalog ↔ Cerbos policies ↔ generated UI mirror. Fails CI on any divergence — an uncatalogued policy action, an orphaned permission, a stale mirror. This is what keeps the contract honest once consumers depend on it. |

---

## 1a. Owner decisions on the drift findings — 2026-08-10 (second decision round)

| # | Decision | Consequence |
|---|---|---|
| **DR-1** | **The UI is wrong on manager approvals.** Remove `approvals.decide` from `manager` in `rbac.ts`. Cerbos is unchanged — approval authority stays with `company_admin` / `module_manager` / `module_approver`. | 11 managers stop seeing ~8 dead buttons. **No access change.** ⚠ **Incomplete as decided — see DR-1-COLLATERAL below. Do not ship DR-1 alone.** |
| **DR-2** | **Fix both under-claims.** Grant `people.directory` to `member`/`viewer` (the only Cerbos signal, `resource_member.yaml`'s baseline read rule, includes them), and add the missing `agency_approver` role to `Role` + `ROLE_CAPS`. | UI-only. Server already allows both. Stops hiding working functionality. |
| **DR-3** | **Add the `notLow` assurance floor to `agent_run:read`** — but as its **own owner-sighted ticket**, not folded into Phase 1. | **NARROWS access**; it is a real authz change and gets its own review + Cerbos restart. |
| **DR-4** | **Portal permissions are `portal.*`, their own top-level domain** — NOT `core.portal.*`. | Deliberate departure from Ruling 2's letter: the portal is a separate trust surface with its own route group and shell. Ruling 2 is amended, not violated. |

### ⚠ DR-1-COLLATERAL — DR-1 was decided on incomplete information

`approvals.decide` was doing **DOUBLE DUTY** in the UI mirror. Neither the owner nor the drift
register knew this when DR-1 was decided. It gated:

- **(a) 3 genuine approval-decision surfaces** Cerbos denies `manager` — `automation_approval`
  `decide`/`retry`, `agency_approval.approve`, `pipeline_gate.decide`. DR-1 correctly killed these.
- **(b) 8 OPERATIONAL server actions** Cerbos **does** grant `manager`. Verified against the policy
  files in this session:

| Policy | Action | Roles granted |
|---|---|---|
| `resource_pipeline_stage.yaml` | `create` | company_admin, **manager**, member |
| `resource_pipeline_stage.yaml` | `update` | company_admin, **manager**, group_executive |
| `resource_pipeline_run.yaml` | `create`, `update` | company_admin, **manager**, member |
| `resource_pipeline_gate.yaml` | `create` | company_admin, **manager**, member |
| `resource_scope_signoff.yaml` | `create` | company_admin, **manager**, group_executive |
| `resource_webdev_provisioned_site.yaml` | `read`, `provision`, `reconcile` | company_admin, **manager**, group_executive, module_manager |

(`pipeline_gate.decide` → company_admin, group_executive only. Manager correctly excluded — that one
is a genuine DR-1 target.)

**So DR-1 as landed trades 3 false affordances for 8 real losses** — a NEW under-claim, which is the
dangerous drift direction this program exists to eliminate. The owner's intent (managers must not
decide approvals) **stands and is unchanged**; what was wrong was the assumption that
`approvals.decide` gated only approvals.

**IAM-02a-FIX-2** (in flight) introduces a separate capability for group (b), re-gates those call
sites, and keeps `manager` out of `approvals.decide`. It also repairs `queue.test.ts`, which DR-1
left failing (1584/1585) because it asserted `decidable === true` for a manager on an agency-origin
item — an expectation that encoded the old, wrong behaviour.

**✅ RESOLVED — IAM-02a-FIX-2 LANDED, DEV-VERIFIED.** DR-1 and DR-2 are now shippable.
Three purpose-built capabilities replace `approvals.decide`'s over-broad mapping, each derived
strictly from the policies:

| Capability | Roles | Evidence |
|---|---|---|
| `pipeline.write` | company_admin, manager, **member** | `pipeline_run` create/update, `pipeline_stage` create, `pipeline_gate` create — all three list the identical trio |
| `pipeline.manage` | company_admin, manager (**member excluded**) | `pipeline_stage` update, `scope_signoff` create — both explicitly deny member |
| `webdev.provision` | company_admin, manager | `webdev_provisioned_site` provision/reconcile, in-tenant tier |

`webdev.provision` was kept separate from `pipeline.manage` **even though the role sets match today**,
because that resource carries an unmirrored `module_manager`/`module_staff` tier that will diverge —
a deliberate anti-collapse decision worth preserving. `viewer` correctly gets none of them (no policy
lists it, unlike `people.directory`'s baseline rule). `decideGateAction` and
`relinkOrphanRecordingsAction` were correctly left alone.

`queue.test.ts` corrected (manager `decidable` on an agency-origin item: `true` → `false`, citing
`resource_agency_approval.yaml`) and is green. DR-1 is pinned by a new test so it cannot silently
regress.

## 1a-sexies. Wave 8 outcome — 2026-08-11

**Verified in-session: `src/rbac/` 22 files / 423 tests green, `typecheck` 0 errors.**

| Ticket | Status | Result |
|---|---|---|
| **HIER-2** | DEV-VERIFIED | `org_unit_lead` + subtree cascade. Department-scoped authority is real for the first time. Migration `0102`. Also wired rollout batch 3 (`checkin`). |
| **IAM-SEC-03** | DEV-VERIFIED | Hazard detector extended with Pattern C; all 61 kinds swept; **no open exposure**. |
| **IAM-DOCS-01** | DEV-VERIFIED | Contracts re-derived from artifacts and brought current. |
| **IAM-VERIFY-01** | PROTOTYPED | Persona-driven drive of the real API. **Found 2 defects no suite caught.** |

**The cascade CEL** (its own rule, never mixed — the binding authoring rule held):
```
grants.exists(g, g.role == "org_unit_lead" && g.scopeType == "org_unit"
                 && g.scopeId in request.resource.attr.unitAncestors)
```
The resource carries its ancestor list (IAM-09's closure), so containment is a set membership, not a
tree walk. Proven: a grant at `d-web` ALLOWS a `dv-frontend` descendant and DENIES a `d-hr` sibling.
Landed on `report_document.read_department` and `appraisal.read` — the two places handlers actually
resolve a unit. Deliberately NOT wired where no handler supplies one (`read_person`, `read_project`,
appraisal list/mine): fails closed, and a rule a handler can never satisfy is the dead grant this
program spent three days removing.

### 🔴 Two defects found by DRIVING the surface, not by the suites

Both are dead-code-in-policy, the same shape as `team_lead` — now seen three separate ways.

1. **`client_contact` persona cannot reach the portal.** `testing/personas.ts` never grants the Cerbos
   `client` role when seeding a client contact, unlike every other client-seeding path. Confirmed by
   granting it by hand and watching the request flip **403 → 200**. This is the fixture Web Dev and PM
   would use to test client gating — it would have told them the portal denies clients.
2. **A Cerbos rule nobody can ever satisfy.** `resource_portal.yaml` grants staff
   (`company_admin`/`manager`) portal `read` for support, but `portal-scope.ts`'s `callerClientIds()`
   unconditionally throws `"not a portal client"` for anyone without a `client_contacts` row — every
   staff member, by construction. **The rule is unreachable.**

Neither is fixed (IAM-VERIFY-01 was scoped as an observer). **Both need tickets.**

**Honest gap:** a low-assurance *named* persona could not be driven — the dev auth path hardcodes
`assurance: "high"`, so only anonymous requests reach `"low"`. Reported as a fixture limitation rather
than inferred as a pass.

**Transient, resolved:** `0102` briefly carried a PL/pgSQL defect (`RAISE EXCEPTION` cannot take a
`||`-concatenated format string), which broke `initTestDb()` for every platform-nest file while two
agents overlapped. Its author found and fixed it; verified applying cleanly.

## 1a-quinquies. ⚠ HIER-1 SEQUENCING DEFECT — found and fixed in-session (2026-08-10)

**HIER-1 could not land standalone.** Migration `0100` originally dropped `team` and `record` from
the `scope_type` CHECK immediately, per DR-10. But three write paths still insert
`scope_type='team'` — `core/teams.controller.ts:119` (promote-to-lead), `testing/personas.ts` and
`seed/personas.ts` (the `team_lead` persona) — and **all three belong to HIER-3, not HIER-1**.
Landing the CHECK first turned 4 tests across 3 files into CHECK violations (verified:
`teams.test.ts` ×2, `personas.test.ts` ×1, `managed-by-invariant.test.ts` ×1) and would have left
the shared checkout red for every other session until BOTH HIER-2 and HIER-3 landed.

**Fix applied: `0100` is now EXPAND-ONLY.** It adds `org_unit`, widens `scope_id` to text, and
installs the shape CHECK — while `team` and `record` stay listed. The contract half moves into
**HIER-3's migration, which removes their writers in the same change.** Textbook expand/contract:
add the new value, migrate the writers, then remove the old ones.

**DR-10's intent is preserved exactly** — `team` and `record` are still removed *together, in one
migration*; that migration is now HIER-3's. The zero-row assertions already prove neither has live
data, so the contract step stays a pure code-and-constraint change.

🔴 **A second, subtler trap fixed with it.** `0100`'s zero-row guards were `RAISE EXCEPTION` — correct
when guarding a DROP, actively wrong once the DROP moved out. `migrate()` runs on **every platform
boot**, and `teams.controller.ts` can still legitimately mint a team grant, so a developer who
promoted a team lead and then restarted would have hit a hard **boot failure** from a migration
already in the ledger with nothing left to do. Downgraded to `RAISE NOTICE`.
**HIER-3 must carry them back as hard `RAISE EXCEPTION` assertions**, where they are correct again.

Verified after both amendments: `lint:migration-rls` OK (99 migrations), `typecheck` 0 errors,
**21 files / 303 tests green** including all three previously-failing files.

## 1a-quater. Owner decisions round 4 — hierarchy consolidation (2026-08-10)

Plan: `2026-08-10-iam-hier-01-plan.md`. Analysis: `2026-08-10-hierarchy-consolidation.md`.

**Measured payoff (detector logic, BEFORE run reproduces the existing register EXACTLY — 17/4/40 —
so the port is faithful):**

| Bucket | Before | After retiring `team_lead` |
|---|---:|---:|
| SAFE | 17 | **34** |
| HAZARDOUS | 40 | **22** |
| dead-grant suspects | 22 | **0** |
| hazard rate (non-exempt) | 70% | **39%** |

The expensive mitigation class — handler-verified dead-grant exclusions with per-kind adversarial
pins, 18 kinds — **drops to zero**.

| # | Decision |
|---|---|
| **DR-8** | **Widen `user_roles.scope_id` `uuid` → `text`**, guarded by a per-scope shape CHECK (`company`/`project` → uuid regex, `org_unit` → non-empty text, `global` → NULL). Forced by substrate: node ids are free-form text and every other org table speaks it. |
| **DR-9** | The replacement lead role is **`org_unit_lead`**. |
| **DR-10** | `scope_type` → `('global','company','org_unit','project')` — **`team` AND `record` both removed** in one migration. `project` is KEPT (coherent end-to-end, merely unused live). |
| **DR-11** | The appraisal department-lead tier lands **with HIER-2**, not deferred to positions. |

**Closing evidence:** `report_document.read_department` — the scan's ONE "genuinely reachable"
`team_lead` grain — is unreachable at the DB layer too: the handler passes a text org-node id as
`teamId` while `user_roles.scope_id` is `uuid`, so the covering grant is **unstorable**. `team_lead`
is storable-reachable only on the `team` kind itself, against a 0-row table.

**What is lost by deleting `teams`:** orthogonal (non-org-chart) grouping — already covered three
ways: a delivery squad is a `project` (scope kept), a committee is a non-primary
`org_unit_membership` (0055 was designed for it), a durable named group with its own authz surface is
a relationship-granted kind (`chat_group` precedent). Genuinely gone: nested `parent_team_id` trees,
which duplicated the org chart — the disease itself.

**Ticket series:** HIER-1 (scope migration) → HIER-2 (`org_unit_lead` + cascade) → HIER-3 (retirement
sweep, W1–W13 inventory) → HIER-5 (re-scan + re-baseline); HIER-4 (rewrite IAM-08/09/10) independent.
**Rollout batches 1–3 may proceed in parallel; batches 4–7 MUST wait for HIER-3** — their subject
matter is what gets deleted.

## 1a-ter. 🔴 ROLLOUT SCAN — the IAM-04 rewrite is NOT mechanical (2026-08-10)

Register: `2026-08-10-iam-04-rollout-scan.md`. Detector: `src/rbac/permission-arm-hazard-scan.test.ts`
(12 tests, static, green, teeth-proven on a synthetic in-memory kind).

| Bucket | Count |
|---|---|
| SAFE — permission arm can be wired mechanically | **17** |
| EXEMPT — permanent, per IAM-04c | **4** |
| **HAZARDOUS** | **40** |
| …of which DEAD-GRANT SUSPECT (handler-confirmed unreachable) | **22** |

**40 of 57 non-exempt kinds (70%) carry the hazard shape.** This is the codebase's normal policy
style, not a two-resource anomaly — so **IAM-04-ROLLOUT is a long, per-kind ticket series, not a
batch job.** Plan accordingly.

### Why 70%: `team_lead` is listed nearly everywhere and reachable almost nowhere

`team_lead`'s derived role matches ONLY `scopeType == "team" && scopeId == resource.attr.teamId`, and
**`teamId` is passed to authorization in exactly TWO production places** — verified independently:
`core/teams.controller.ts` (the `team` resource itself) and `modules/reports/reports.controller.ts:166`
(department grain only). Every other policy that names `team_lead` in a baseline read/write rule
grants reach that **no handler can ever enable**.

⚠ **This reframes `team_lead` for Phase 2.** It is not a working tier with a bug; it is a tier that is
inert nearly everywhere by construction. Two honest paths: handlers start passing `teamId` broadly, or
— far more aligned with the owner's stated model (**D-3 position-driven access, dept heads managing
their subtree**) — the lead tier gets **re-scoped onto `org_unit` when IAM-08 adds that scope type**.
The second is almost certainly right, and it means **IAM-08 should be planned as `team_lead`'s
replacement, not merely as an addition.**

### A second, independent live bug found by re-deriving instead of trusting

6 kinds (`automation_approval`, `pipeline_gate`, `pipeline_run`, `pipeline_stage`, `portal`,
`scope_signoff`) fold `group_executive` into an **`inTenant`-gated rule** — the exact anti-pattern
other policy files' own "TRAP #4" comments warn against — silently denying it cross-company access on
those surfaces. Found only because the scan re-derived the classification structurally rather than
trusting the pilot's named list.

**Practical impact today is ~nil and should not be overstated:** the only `group_executive` holder is
`exec@gaiada.test`, a seed account (verified live), and **D-7 deletes the role in Phase 3** — so this
may well be fixed by deletion rather than repair. Recorded because it is real, and because the
*method* that found it (re-derive, do not trust a prior list) is the transferable lesson.

**Recommended rollout order:** 4 domain-grouped SAFE batches → 9 confirmed-mechanism module kinds →
`checkin` → 16 pure dead-grant kinds one at a time, each with a new adversarial pin → 3
dual-mitigation kinds individually → `report_document` alone (dead on 2 grains, live on 1) → `team`
alone (the ONE kind where `team_lead` is genuinely reachable) → the 6 `group_executive` kinds LAST,
blocked on a role-arm-correctness ticket.

## 1a-bis. Owner decisions round 3 — 2026-08-10 (from the capability-parity findings)

| # | Decision | Consequence |
|---|---|---|
| **DR-5** | **`company_admin` × `appraisal.read`: GRANT IT IN CERBOS** (not remove from the UI). A company's own administrator is meant to read appraisals in their company. | 🔴 **The program's FIRST deliberate authorization WIDENING.** 9 live holders gain real access to appraisal data. `read` ONLY — never write/submit/finalize/cycle_admin. Needs `resource_appraisal.yaml` + migration `0099` + bundle regen. |
| **DR-6** | **`it_admin` × `company.manage`: remove from the mirror.** IT administers devices and accounts, not company settings / modules / billing / automation retry. | Mirror-only. 1 live holder loses buttons that already 403. Same class as DR-1. |
| **DR-7** | **`hr_staff`/`search_staff`/`reports_staff` × `people.directory`: grant in the mirror.** `resource_member.yaml`'s `module_staff` rule grants the directory read unconditionally. | Mirror-only, 0 holders — fixed before HR is staffed. Same precedent as DR-2a. |
| **(bug)** | **`hr.manage` wrongly includes `hr.case.cancel` in `rbac-capability-map.ts`** — Cerbos grants `cancel` only to `member`-self and `group_executive`. NOT an owner decision; a defect in the map that made `hr.manage` unsatisfiable for the two roles that legitimately hold it. | Produced 2 of the 7 false over-claims. Fixed in the map, not `ROLE_CAPS`. |

⚠ **DR-5 deserves ongoing attention.** Every prior ticket in this program was decision-neutral; this
one widens access to sensitive HR performance data. `derived_roles.yaml` records that TR-13 previously
over-granted appraisal access — letting HR rank-and-file read and finalize performance records,
including on SERVED companies via the reconciler — and TR-25 split `hr_people_ops` from
`hr_people_reader` to undo exactly that. The implementing ticket was told to verify explicitly that a
`company_admin` grant can never be reconciler-materialized onto a served company, and to raise it
rather than ship if it can.

## 1b. ⚠ IN FLIGHT — claimed 2026-08-10 (other sessions: do not pick these up)

Four agents are working this checkout concurrently. Migration numbers are pre-assigned so they
cannot race the ledger.

| Ticket | Owns these files | Migration |
|---|---|---|
| ~~**IAM-02d**~~ — seed the 6 ungrantable roles — **LANDED, DEV-VERIFIED** | `migrations/0091_iam_02d_ungrantable_roles.sql`, `src/rbac/role-catalog-drift.db.test.ts`, `…-iam-02d-report.md` | **0091** |
| ~~**IAM-01c-2**~~ — grant-uniqueness fix (Finding F) — **LANDED, DEV-VERIFIED** | `migrations/0092_user_roles_global_scope_unique.sql`, `src/db/user-roles-global-scope-uniq.test.ts`, `…-iam-01c-2-report.md` | **0092** |
| ~~**IAM-01b**~~ — the permission catalog — **PROTOTYPED**, awaiting owner review | `platform-nest/src/rbac/permission-catalog.json`, `…-permission-catalog.md` | none |
| ~~**IAM-01b-2 + IAM-02a drift register**~~ — **LANDED** (analysis only) | `…-iam-02a-drift-register.md` | none |

**Next free migration number for anyone else: 0093.**

### Wave 2 — IN FLIGHT, claimed 2026-08-10 (other sessions: do not pick these up)

| Ticket | Owns these files | Migration |
|---|---|---|
| **IAM-02a-FIX** (DR-1 + DR-2) — mirror corrections | `platform-ui/src/lib/rbac.ts`, `rbac.test.ts`, `…-iam-02a-fix-report.md` | none |
| **IAM-01b-AMEND** (DR-4) — `portal.*` domain rename | `permission-catalog.json`, `…-permission-catalog.md`, `…-iam-01a-02a-analysis.md` | none |
| **IAM-SEC-01** (DR-3) — `agent_run:read` assurance floor | `cerbos/policies/resource_agent_run.yaml`, one test, `…-iam-sec-01-report.md` | none |
| **IAM-01c-3** — the `assignRole` regression test gating 0092 | one new test under `src/admin/`, `…-iam-01c-3-report.md` | none |

IAM-SEC-01 carries a **stop condition**: if its author concludes the missing `notLow` was deliberate
rather than an oversight, they change nothing and report back — DR-3 would then have been decided on
a wrong premise and returns to the owner.

**Wave 2 outcome: ALL FOUR LANDED.** `platform-ui` full suite green — **1590/1590**, 143 files
(re-run 2026-08-10 after a concurrent session landed its PM work; the two failures DR-1 exposed
belonged to that session and are resolved).

### Wave 3 — IN FLIGHT, claimed 2026-08-10 (other sessions: do not pick these up)

| Ticket | Owns these files | Migration |
|---|---|---|
| **IAM-01c + IAM-01d** — persist the catalog + consume `ModuleContract.permissions` fail-closed. **Must land as ONE change** (01d boot-blocks on 7 of 54 keys without 01c's map) | `migrations/0093_*.sql`, `src/modules/contract.ts`, `src/modules/registry.ts`, the 12 `src/modules/*/index.ts` declarations, tests, `…-iam-01c-01d-report.md` | **0093** |
| **IAM-02a + IAM-02b** — role→permission bundles + the parity suite | `migrations/0094_*.sql`, tests under `src/rbac/`, `…-iam-02a-02b-report.md` | **0094** |
| **IAM-01b-3** — the permission GROUPS (authoring layer) | `src/rbac/permission-groups.json`, `…-permission-groups.md` | none |
| **IAM-02e** — seed the 6 BASELINE roles that only `seed:agency` creates | `migrations/0095_*.sql`, one test, `…-iam-02e-report.md`, possibly `src/seed/agency.ts` | **0095** |

**Next free migration number for anyone else: 0096.**

⚠ **Cross-agent coupling (managed, not eliminated):** 0093 seeds the `permissions` table; 0094 seeds
`role_permissions` referencing it. They are being authored concurrently, so 0094 was instructed NOT
to read 0093 and instead to derive from `permission-catalog.json` and insert by joining on
`permissions.key`. **The catalog keys are the contract between them.** If either drifts from the
catalog, they will not compose — check this first if 0094 fails to apply.

### Wave 3 outcome — ALL FOUR LANDED (+ `0096` by the coordinator)

| Ticket | Status | What landed |
|---|---|---|
| **IAM-01c + 01d** | DEV-VERIFIED | `0093` seeds **230 rows** (215 grantable / 15 relationship / 79 sensitive), machine-generated from the catalog JSON, asserted three independent ways. `class` is CHECK-constrained **and** a `BEFORE INSERT OR UPDATE` trigger `role_permissions_reject_relationship` makes granting a relationship permission structurally impossible. `validateModulePermissions()` wired at `main.ts:344` — awaited, no try/catch, before `listen()` at 466. |
| **IAM-02a + 02b** | DEV-VERIFIED | `0094` seeds **925 `role_permissions` rows across 18 roles**; every bundle size matches the independently-derived Part 4 table exactly. Parity suite 22/22, **teeth proven** (`manager / task:update — bundle=false cerbos=true`). |
| **IAM-01b-3** | PROTOTYPED | **75 permission groups**, 213/215 reachable, 2 advanced-only, 0 relationship leakage. **9 dangerous combinations** registered. |
| **IAM-02e** | DEV-VERIFIED | `0095` seeds the 6 baseline roles. `roles` already had `roles_global_name_uniq` from `0073` — no new DDL. |
| **`0096`** (coordinator) | DEV-VERIFIED | Seeds `agency_approver`, closing the red drift-guard test that DR-2b exposed. |

**Module declarations:** 47 of 54 migrated to dotted catalog keys → **55 declared keys across 12
modules**, script-verified against the JSON, 0 mismatches. The 7 boot-blockers were resolved by
REMOVAL, not renaming: the 5 assistant keys are relationship-class (owner-granted, never role-granted)
so **`assistantModule.permissions` is now `[]`** — correct by Ruling 3, and worth understanding
plainly: *assistant access cannot be granted by any role, to anyone, by design*. The 2 true orphans
(`automation:workflow:read` — in-code admin check, never Cerbos-enforced; `search:content:publish` —
zero `authorize()` calls, declared ahead of an unbuilt feature) were removed rather than catalogued,
because cataloguing them would invent enforcement that does not exist. Correct forward path is to
mint the Cerbos action first, additively, when the feature ships.

**Honest verification gap:** the fail-closed throw is proven by 6 tests, but nobody ran
`node dist/main.js` to watch a real process exit non-zero — that step is traced from Node's
documented default, not executed.

**Transient, already resolved:** an initial full run showed 5 files failing inside `migrate()` on
`0094` with *contradictory* counts across fresh runs (109 vs 108 for the same role) — the signature of
a file being edited mid-run by a concurrent agent, not a defect. Re-ran clean 5/5.

### Wave 5 outcome — IAM-04 PILOT LANDED (the core rewrite works)

**Verified in-session: `cerbos compile` clean; `src/rbac/` + `src/modules/pm` + `src/modules/hr` =
25 files / 511 tests green.**

- **IAM-04a:** `principalPayload()` emits `attr.perms` (additive; `attr.grants` unchanged, defaults
  `[]`). **11 new `perm_*` derived roles** beside the role-name ones. Scope semantics match
  `principalHasPermission()` exactly — global covers everything, company covers that company, nothing
  narrower or broader invented.
- **IAM-04b:** `resource_pm_task.yaml` + `resource_hr_case.yaml`, **purely additive** — zero existing
  lines changed, every wildcard rule untouched per the 04c ruling.
- **Isolation proven:** 16 tests in `cerbos-permission-dual-match.test.ts` grant the permission with
  **`roles: []`**, so the role arm cannot be what answers. This was the stated failure mode — a
  dual-match where only the role arm ever fires would pass everything and prove nothing.

🔴 **A REAL REGRESSION, CAUGHT BY THE PILOT BEFORE LANDING — this is why it was two resources, not 61.**
`team_lead`'s bundle claims `pm.task.*` reach it can **never actually exercise**: `pm.controller.ts`
never sets `teamId`, and `team_lead`'s derived role matches ONLY `scopeType == "team" && scopeId ==
resource.attr.teamId`. A pre-existing pinned adversarial test documents that dead grant. The first cut
of the permission arm **flipped that test 403 → 200** — i.e. the permission path would have GRANTED
what the role path denies, a real authorization change. Fixed by having each `perm_pm_task_*` derived
role exclude the exact scope a `team_lead` grant occupies.

**The generalizable hazard for IAM-04-ROLLOUT:** a bundle records *what a role's rules name*, not
*what that role can actually reach* when a rule mixes **scope-only** and **attribute-dependent**
matching. Wherever those two are combined in one rule, flat `perms` cannot tell them apart, and the
permission arm silently over-grants. **Every remaining kind must be scanned for that shape BEFORE its
permission arm is wired.** A second instance appeared in `hr_case` (`member`'s self-only rule vs
`company_admin`'s unconditional hold of the same keys) and was resolved by building the self-scoped
mirror for only those three actions.

**Out-of-ownership edits, reviewed and accepted:** a one-line `perm_*` skip in
`role-permission-parity.db.test.ts` and its generator sibling. **Checked specifically against the G1
shape** — it is NOT vacuous: `perm_*` roles match on `attr.perms`, a different axis from the
role-name matrix this suite measures, and the permission arm's own correctness is covered
independently by the isolation tests. The comment says so and names that file. Parity still 22/22.

### ⚠ OPEN — the parity suite's role list is hand-maintained and now INCOMPLETE

`role-permission-parity.db.test.ts:62` defines its own literal `REAL_ROLES` array of **18** roles.
`webdev_staff`/`webdev_manager` (seeded 0097, bundled 0098) are **not in it**, so the parity suite —
the program's headline "zero decisions changed" gate — **silently does not compare those two roles at
all**. Its coverage looks green because the roles are invisible to it, not because they agree.

**This is the FIFTH hand-maintained-list drift in this program in one day**, after: roles named in
Cerbos with no `roles` row (0091); baseline roles created only by `seed:agency` (0095);
`agency_approver` (0096); `roles` rows with no bundle (0098); and now a test's own role list.
**The fix is the same one that worked twice already: derive, never hand-maintain.**
`role-permission-bundles.db.test.ts` already imports `REAL_ROLES` from
`scripts/generate-role-bundles.mjs` — the parity suite should use that same single source.

🚫 **Deliberately NOT fixed yet.** The parity suite is the **active gate** for IAM-04a/04b, which is
still in flight. Adding two roles to it could surface a genuine webdev bundle↔Cerbos mismatch and turn
that agent's gate red mid-ticket, for reasons unrelated to its work. **Follow-up ticket, immediately
after IAM-04 lands.**

**Stale count pins — FIXED in-session.** `role-permission-bundles.db.test.ts` hardcoded `18` and `925`
and went stale the same day 0098 landed (20/935). Both are now **derived** (`REAL_ROLES.length`, and
the sum of the artifact's own per-role counts) rather than re-pinned to the new numbers: a literal
count on a deliberately-growing set is a tripwire that fires on CORRECT work, which trains readers to
bump the number without thinking — precisely how a real regression would later slip through. The
"did the role set change unexpectedly?" question is answered properly by
`role-bundle-completeness.db.test.ts`, which derives every global `roles` row live from the DB with an
**empty** exemption allowlist. Verified 10/10 green.

### 🔴 CORRECTION — the parity suite does NOT guard the 15 exempt pairs (IAM-04c finding G1)

Earlier sections of this doc, and the parity suite's own header, claim it asserts that no role reaches
the 15 relationship pairs. **It does not.** Confirmed in-session at
`src/rbac/role-permission-parity.db.test.ts:198`:

```
if (classByPair.get(pairId) !== "grantable") continue; // relationship pairs: never role-reachable
```

That line pre-filters relationship pairs out of the **Cerbos-side** coverage computation — it ASSUMES
the property it claims to verify. Traced consequence: add a `platform_admin` wildcard to
`resource_assistant_thread.yaml` "for consistency", and the wildcard expands, every action is filtered
out by this line, computed coverage is unchanged, the DB side cannot contain them (0093's trigger),
both sides still agree — **the whole 22-test suite stays green while the exemption is destroyed.**

**G2:** `cerbos-assistant.test.ts` has **no `platform_admin` case at all** and omits `handoff` /
`confirm_write`.

So "an admin cannot read an employee's private assistant transcript" is currently guaranteed by a
COMMENT. **IAM-04c-1** (in flight) builds the real static boundary-pin test, proves it red under three
mutations, and fixes both the vacuous arm and the over-claiming header — the over-claim is precisely
what made this invisible.

### IAM-04c RULING — the bypass stays a per-kind wildcard RULE; no `*` permission, ever

Full record: `2026-08-10-iam-04c-bypass-ruling.md`.

**The catalog is the vocabulary of DELEGATABLE authority; the bypass is deliberately
non-delegatable.** D-6 makes superadmin appointable and D-9's two-person rule makes appointment the
only door to that power — a grantable `*` would open a second door through every authoring path
(Phase-4 UI, seeds, migrations, D-5 company-local authoring, a compromised flow), where **one
accidental `role_permissions` row equals total compromise**. It would also break D-5's ceiling algebra:
subset tests over concrete keys have no sane `*` semantics.

**Per-kind stays** — Cerbos cannot express cross-kind rules, and per-kind ABSENCE is exactly what makes
the 15 exemptions expressible fail-closed given the measured zero-`EFFECT_DENY` invariant. Auditability
comes from the 0094 `platform_admin` bundle as a **regenerated audit mirror, never an enforcement
source**. New authoring rule: every new resource policy either carries the tier rule explicitly or
registers as exempt with a header rationale.

**`owner` (D-8) is expressed with NO policy rules at all** — it becomes the first permission-native
role: a platform-managed bundle over the grantable catalog, scoped per owned company, generated **by
exclusion** (215 minus a named platform-control list), committed and diff-reviewed per release. A
second wildcard lattice would be `group_executive` reborn — the exact drift Finding B measured and D-7
deletes. The 15-pair exemption is inherited **structurally**, as one sentence, never as 15 denials;
four independent layers already hold it (catalog class boundary, 0093's trigger, IAM-03's
resolution-time filter, and zero rules on the four exempt kinds).

⚠ **SEQUENCING FLAG for Phase 3:** because `owner` appears in no role-name rule, **IAM-14 hard-depends
on IAM-04 permission matching covering owner's envelope kinds** — not just the two 04b pilots. The
program doc's Phase 3 needs that edit.

**Three-class table:** revise, but keep the grantability boundary BINARY (everything downstream keys on
that one bit). Add a `mechanism` sub-axis on the ungrantable 15 — `relationship` (13), `channel` (1,
`mcp_tool:call`), `code-gate` (1, `agent_run:read`) — additively in the JSON. **Do not rename the
stored `class` enum mid-wave**: 0093's CHECK + trigger, 0094, the parity suite and the catalog JSON are
the live inter-agent contract.

**Owner decisions this raises** (Phase 3, not blocking): the `owner` envelope exclusion-list
membership; whether the owner bundle is release-process-only (recommended) or runtime-editable by
superadmin; blessing the exempt-kind registry as canonical; and holding-level owner auto-implication.

### Wave 5 — IN FLIGHT, claimed 2026-08-10 (other sessions: do not pick these up)

| Ticket | Owns these files | Migration |
|---|---|---|
| **IAM-04a + 04b** — the permission shim + 2-resource pilot (**the core rewrite**) | `src/rbac/cerbos.ts`, `cerbos/policies/derived_roles.yaml`, `resource_pm_task.yaml`, `resource_hr_case.yaml`, tests, `…-iam-04-report.md` | none |
| **IAM-04c** — the wildcard-bypass ruling (analysis only) | `…-iam-04c-bypass-ruling.md` | none |
| **IAM-05b-1** — `role-permission-bundles.json` + generator + regen/DB-parity tests | `src/rbac/role-permission-bundles.json`, `scripts/`, one test, `…-iam-05b-1-report.md` | none |
| **IAM-05b-2** — the 34-entry capability→permission map | `platform-ui/src/lib/rbac-capability-map.ts`, `…-iam-05b-2-report.md` | none |

**Next free migration number: `0098`** (reserved for IAM-03 but never used — the benchmark showed no
index was warranted, so it returned to the pool).

⚠ **Deliberate decoupling:** IAM-04a/04b was told to leave every `actions: ["*"]` wildcard rule
untouched, because IAM-04c is ruling on the bypass **concurrently**. If the pilot cannot proceed
without that ruling it must STOP and report rather than decide it itself. This avoids the rework that
would follow from two agents deciding the same question in opposite directions.

### Wave 4 outcome — ALL FOUR LANDED

| Ticket | Status | What landed |
|---|---|---|
| **IAM-03a + 03b** | DEV-VERIFIED | `principal.ts` now emits `perms?: PermissionGrant[]` (`{key, scopeType, scopeId}`), isomorphic to `RoleGrant`. **Optional by design** — making it required broke ~20 pre-existing test files owned by other tickets. **No index, no cache — measured, not assumed:** perms join costs ~0.7–1.3ms marginal, `assemblePrincipal()` ~4–8ms end-to-end; EXPLAIN shows seq-scan + hash-join on the two small reference tables is the *correct* plan at this size. **`0098` was reserved and is now UNUSED — it is FREE.** Relationship-class exclusion tested at BOTH layers (trigger, and — with the trigger deliberately disabled — the query's own `class='grantable'` filter), proving defense-in-depth rather than trusting the trigger alone. |
| **IAM-02f** | DEV-VERIFIED | `0097` seeds `webdev_staff`/`webdev_manager`; the drift guard now **derives** module-role names from policies + call sites. Derived set matched the known set exactly, zero tuning. |
| **IAM-06a + 06b** | DEV-VERIFIED | **14 personas** + backend (`seedPersonaTenant().as("role")`) and frontend (`loginAsPersona(page, "role")`) fixtures. |
| **IAM-05b-DESIGN** | PLANNED (analysis) | See the ruling below. |

**Verified in-session:** `src/rbac/` 10 files / **145 tests**, `src/testing/` 5 files / **60 tests**,
`platform-ui` **1590/1590** — all green. The IAM-02b parity suite stayed 22/22 throughout, which is the
standing proof that **zero authorization decisions changed**.

**IAM-06 findings worth keeping:**
- `team_lead` is correctly **DENIED** on the IT device registry — its Cerbos derived role only
  activates against a `teamId` attribute that `resource_device.yaml` never carries. A real
  scope-cascade nuance the fixtures caught rather than assumed.
- **DEMO_MODE is only partially covered, stated plainly:** just 5 of 14 personas map to an exact
  existing demo identity. The other 9 **throw a loud named error** rather than silently substituting a
  different identity — which would be precisely the silent-wrong-claim failure this program exists to
  eliminate.
- Still open for consuming teams: multi-team scenarios, new module gating, and **no `owner` persona**
  (D-8 is Phase 3; inventing one would be a trap).

### IAM-05b RULING — `can()` keeps speaking capabilities; codegen generates the PROOF, not the file

Full analysis: `2026-08-10-iam-05b-design.md`. **Measured, correcting earlier estimates in these
docs:** `CAPABILITIES` has exactly **34** members (independently re-counted — "~40"/"~43" in earlier
sections were estimates and wrong), asked at **≈188 sites across ~75 files**, of which 62% sit on four
multi-permission tiers (`search.manage` 42, `pm.manage` 45, `hr.manage` 17, `company.manage` 16).
**22 of 34 capabilities are consumed; 12 are grant-only.** The backend has **zero runtime coupling** to
capability names.

**Why not pure derivation:** deriving `ROLE_CAPS` from the catalog was tested against this week's
corrections and **fails three ways** — it strips `agency_approver`'s only capability (DR-2b), reverts
`manager`'s Gap-3 `company.manage` judgement, and "fixes" `group_executive` against Ruling 4.
`ROLE_CAPS` **encodes decisions, not data**, so generating it would silently overwrite owner rulings.

**The insight that makes this more than drift-killing:** the hand-authored capability→permission map
is what will later let `can()` evaluate **custom roles (D-1)** from IAM-05c's resolved permissions.
Role-keyed `ROLE_CAPS` can structurally never serve a role composed in the UI — so the map is
**Phase-4 load-bearing, not scaffolding**.

**Rewritten scope:** 05b-1 generate + check in `role-permission-bundles.json` (regen-no-diff +
DB-parity — this is where the diff-review the original ticket wanted actually lands: a policy change
shows up as a role-reach diff); 05b-2 author the 34-entry capability map, type-pinned with `satisfies`
so exhaustiveness is a compile error in both directions; 05b-3 the generated capability-axis parity
test with a guarded exception register; 05b-4 docs. Zero call sites and zero `ROLE_CAPS` values change.

**IAM-07b reshaped:** "three-way drift test" is the wrong shape — it is a **pinned chain of six
pairwise links** (Cerbos↔catalog↔DB↔bundles↔map+ROLE_CAPS↔type system, plus the existing role axis).
07b promotes the manual wave-3 alignment audit to CI and asserts no link is unpinned.

⚠ **Open for the owner:** drift finding **#7** (`it_admin` × `company.manage` — over-claim, 1 live
holder, user-visible). Recommendation: remove, consistent with DR-1's precedent. Also: bless
`approvals.decide` and `company.manage` as the ONLY two capabilities with `any`-of semantics (the rest
are `all`, per FIX-2's uniform-tier invariant).

### Cerbos alignment audit — 2026-08-10, run after wave 3

Requested explicitly because several agents edited policies and Cerbos has a documented reload trap.

| Check | Result |
|---|---|
| `cerbos compile /policies` (v0.54.0, in-container) | **clean, exit 0** |
| Policy matrix vs `permission-catalog.json` | **230 = 230, ZERO drift in EITHER direction** — no policy pair missing from the catalog, no catalog entry without a policy pair |
| `gaiada-test-cerbos` serving current policies | **yes** — probed the live decision API: low-assurance owner on `agent_run:read` → `EFFECT_DENY`, so IAM-SEC-01's `notLow` is genuinely loaded, not just on disk |
| `gaiada-cerbos-1` (local dev stack) | 🔴 **WAS STALE** — see below |
| `src/rbac/` suite after restart | **8 files / 120 tests green** |

🔴 **Stale-policy finding.** `gaiada-cerbos-1` started **2026-08-08** and bind-mounts the same
`platform-nest/cerbos/policies` directory. Every policy edit since — IAM-SEC-01's `notLow` among them
— sat on its disk **unloaded**, because Windows bind-mount inotify does not propagate (the trap
`resource_assistant_thread.yaml`'s header already documents). Anything exercising the local dev stack
for two days was authorized against **stale policy**. Restarted; healthy, clean load, no errors.
**Ops rule this implies: a policy edit is not live until the container is restarted, and "it's running"
is not evidence it is current — check `docker inspect --format '{{.State.StartedAt}}'` against the
edit time.**

**What Cerbos deliberately does NOT yet reflect** (planned, correctly sequenced — not drift):
- **Still matches ROLE NAMES, not permissions.** The permission-based rewrite is IAM-04, and Phase 1's
  hard rule is that zero authorization decisions change. `role_permissions` has 925 rows and **zero
  runtime consumers** by design.
- `group_executive` remains in **39 rules** — D-7 removal is Phase 3.
- No `owner` role in any policy — Phase 3.
- No `org_unit` scope — Phase 2.
- `webdev_staff`/`webdev_manager` string composition still has no seeded role — see below.

**Live server (`gda-aicenter`) is unaffected and correct**: our changes are uncommitted, so it serves
the deployed policy set. Nothing to do there until the release ships.

### Open items after wave 3

🔴 **`webdev_staff` / `webdev_manager` — THIRD instance of the silent-skip defect.** Verified:
`resource_webdev_change_request.yaml` grants `module_manager`/`module_staff` with `module: "webdev"`,
so string composition expects those role names, and **no migration seeds them**. Needs `0097`. More
usefully: **extend the drift guard to derive module roles from string composition** — that single
change would have caught `search_*`, `webdev_*` and any future module at once, instead of finding
each one by accident.

⚠ **Migration overlap, documented not untangled:** `0094` also seeds `agency_approver` + the 6
baseline roles (it numerically precedes `0095`/`0096`, which seed the same rows idempotently). All
green together; verified no conflict with `0093`. Do not "clean up" one of the three without
re-running a fresh migrate.

**Catalog gaps needing owner input (Phase 3, alongside the sensitivity pass):**
- **No invoice approval action exists** — billing has only create/read/update/delete, so there is
  **no maker/checker seam on invoices** and "creates but cannot approve" is inexpressible.
- **HR leave/loan decisions have no dedicated permission** — they route through the generic
  `core.automation_approval.decide`, so granting HR leave-decide grants generic approval authority.
  This directly undercuts DR-1's premise that approval authority is cleanly scoped.

**Sensitivity sign-off still outstanding:** 79 catalog permissions + 42 groups flagged. Needs the
owner plus an HR/finance pass. Blocks D-9/D-10, not Phase 1.

Still unclaimed: IAM-02c (now NARROWER than planned — module roles already bundle correctly; the
remaining work is retiring Cerbos-side string composition once IAM-04 lands), IAM-03a/03b,
IAM-04a/04b/04c, IAM-05a/05b/05c, IAM-06a/06b, IAM-07a/07b, the `webdev_*` seeding ticket, and a look
at `resource_device.yaml`'s odd `it_staff` read-exclusion.

### Landed from this wave

**IAM-01c-2 — DEV-VERIFIED.** `0092_user_roles_global_scope_unique.sql` dedupes existing global-scope
duplicates (oldest row wins, `managed_by` preserved, DELETE row-count asserted via `GET DIAGNOSTICS`
rather than assumed) and adds the partial unique index. `user_roles` carries no RLS, so the
zero-row backfill trap does not apply — verified via `pg_class`, not assumed. 4/4 new tests green.
Root cause of *recurrence* traced to `src/seed/agency.ts`'s `grantRole(..., 'global', null)` running
on every `seed:agency`; that call site is now genuinely idempotent. Other grant-shaped tables
(`company_memberships`, `team_memberships`, `identity_links`, `service_grant_claims`) were checked
and are clean.

**Regression the migration would have introduced — FIXED in this session, needs a test.**
`admin-identity.controller.ts::assignRole` used a *targeted* `ON CONFLICT (user_id, role_id,
scope_type, scope_id)`. That arbiter names the 4-column constraint, which still does not fire on
NULL `scope_id`, so the new partial index would have raised an unhandled `23505` — turning a
re-grant of an already-held **global** role from a graceful no-op/adopt into a **500**. Verified by
reading the handler, then changed to an untargeted `ON CONFLICT DO NOTHING`, which arbitrates over
both; the existing `scope_id IS NOT DISTINCT FROM` recovery lookup already handled NULL correctly,
so the adopt path is unchanged.
⚠ **TODO — no regression test yet** for "re-grant an already-held global role returns the existing
grantId instead of 500". Needs the controller-level harness. Small QA ticket, must land before 0092
ships.

**IAM-02d — DEV-VERIFIED. All six roles SEEDED, none deleted.** `0091` seeds `team_lead`, `viewer`,
`it_manager`, `it`, `search_staff`, `search_manager` as global roles, with
`src/rbac/role-catalog-drift.db.test.ts` as the recurrence guard. The test was proven to have teeth:
the migration was physically removed, all 3 cases failed and reproduced all six missing roles, then
it was restored and reconfirmed green. 98/98 across 8 adjacent suites (teams, service-reconciler ×2,
service-assignments, org14-preflight, cerbos, pm-adversarial-authz, search-cerbos).

⚠ **CORRECTION to Finding E as first written above.** `team_lead` was **not** hard-ungrantable.
`core/teams.controller.ts::teamLeadRoleId()` **lazily creates the global `team_lead` role row on
first "promote to lead"** (verified: `INSERT … ON CONFLICT (name) WHERE company_id IS NULL DO
NOTHING`). So the promote path always worked; what was blocked was **granting `team_lead` directly**
(e.g. from the admin role-assignment endpoint), because the row does not exist until someone
promotes a lead. Seeding removes that ordering dependency and the race. The earlier framing of this
as a hard PM blocker was **overstated** — the real defect is narrower.

🔴 **CONFIRMED LIVE DEFECT (this is the one that matters from IAM-02d).**
`search_staff`/`search_manager` had no rows, and `service-reconciler.ts::moduleRoleId()` returns
`null` for `module_key='search'` — the caller then pushes to a `skipped` array with **no grant and no
operator-visible error**. A search service assignment would silently grant nobody anything. This is
byte-for-byte the pre-0069 reports bug, reproduced. It is not yet a live incident **only** because
`service_assignments` currently has zero rows for any module on gda-aicenter — so this was fixed
before the first search assignment, not after.

**Separate pre-existing gap, flagged not fixed:** `manager`, `member`, `company_admin`,
`platform_admin`, `group_executive`, `it_admin` are provisioned **only** by the manual `seed:agency`
script and by **no migration at all** — so a fresh environment migrated without running that script
has no baseline roles. Worth its own ticket.

**IAM-01b — PROTOTYPED (freeze at IAM-07a, not before).** `permission-catalog.json` verified in this
session: **230 entries = 215 `grantable` + 15 `relationship`**, zero duplicate keys, 79 flagged
sensitive, across core 110 / search 36 / reports 21 / agency 15 / assistant 14 / hr 11 / pm 7 /
webdev 6 / billing 4 / it 4 / knowledge 2. Companion doc carries the mapping table, the sensitivity
rubric, judgement register J1–J13, and the 54-key reconciliation.

**Independent re-derivation agreed with every prior number** (61 kinds, 286 raw, 230 concrete, 56
wildcard kinds, platform_admin 215/57, and all 14 role-reach figures). Two new structural facts make
the boundary exact rather than approximate: **zero `EFFECT_DENY` rules exist anywhere**, and **zero
pairs are reachable by any other derived role but not by `platform_admin`**. Corrections to earlier
docs: non-module core kinds number **33**, not "~20"; the 5th wildcard-less kind is `rollup` (not
exempt — its entire policy *is* the elevated grant).

**Module-key reconciliation refines the earlier orphan claim:** of 54 declared keys — 35 CLEAN,
12 ALIAS (enforced via a different kind than the key implies), 5 RELATIONSHIP (all assistant; must
never be seeded grantable), and only **2 true orphans**: `automation:workflow:read` (in-code
platform-admin check) and `search:content:publish` (no route exists). `search:rank:read` and
`it:discovery:report` are aliases, not orphans, and `assistant:handoff` maps to exempt pairs.
⚠ **Sequencing warning for IAM-01d:** its fail-closed boot validation will block startup on **7 of
the 54** unless the migration map lands in the same change.

**IAM-01b-2 — RESOLVED. The 215 boundary STANDS; both exemptions are deliberate.**
- `agent_run:read` (high confidence): the real gate is a **code-level** `isElevated()` check in
  `admin/intelligence.controller.ts` that runs BEFORE Cerbos. Superadmin's access to every run is
  granted in code, never via Cerbos role-matching, so its absence from the policy is structural.
  The Cerbos rule is purely additive and only fires when `isElevated` already said no.
- `mcp_tool:call` (high confidence, different mechanism): `mcp-hub/src/cerbos.ts` always sends
  `roles: ["hub_caller"]` — the hub's Cerbos principal **never carries the caller's platform role at
  all**. There is no role axis here for any role to be exempted from; the gate is assurance +
  automation scope, uniform for every caller. The real per-resource RBAC is enforced downstream when
  the OBO envelope resolves, and is already counted in the 230-pair matrix.
  ⚠ Note for IAM-01b: this is *not* the same "relationship-granted" mechanism as the assistant
  exemptions, so Ruling 3's three-class table should describe it as its own class rather than
  forcing it into the relationship bucket. Exclusion from the catalog is correct either way.

**IAM-02a drift register — LANDED.** All four baseline numbers reproduced exactly by an independent
parse (215/199/118/109/74/60/30/6). **8 new disagreements**, plus 4 documented false positives so
they are not rediscovered. The live-reachable ones, verified independently in this session:

| # | Finding | Direction | Live holders |
|---|---|---|---|
| 1 | **`agency_approver` is absent from `rbac.ts` entirely** — zero capabilities in the UI (grep: 0 hits) | UNDER-claim | **1 (real)** |
| 5 | **`manager` holds `approvals.decide` in the UI but Cerbos denies it** on automation / agency / pipeline-gate decisions across ~8 call sites. Verified: those rules list `company_admin`/`group_executive`/`module_manager`/`module_approver` — **`manager` appears in none** | OVER-claim | **11** |
| 6 | `company_admin` + `appraisal.read` — no Cerbos rule for that role on that kind exists at all | OVER-claim | 9 |
| 3 | `member`/`viewer` excluded from `people.directory` though the only Cerbos signal includes them | UNDER-claim | 18 |
| 7 | `it_admin` + `company.manage` — fully denied, undocumented | OVER-claim | 1 |

Theoretical only (role has 0 holders or is ungrantable): #2 `hr_staff` create/update on
hr_case/hr_record vs a read-only UI action layer; #4 `group_executive`'s blanket `ALL` overriding
three explicitly-written Cerbos exclusions.

⚠ **#5 needs an OWNER DECISION, not an engineering fix.** Eleven managers see approve buttons that
403. Removing `approvals.decide` from the mirror makes the UI honest; adding `manager` to the Cerbos
rules grants 11 people real approval authority. Those are opposite products. **Nothing was fixed** —
per the ruling, drift is documented and decided, never silently repaired.

Not yet claimed and still open: IAM-01b-3 (permission groups), IAM-01c/01d, IAM-02a/02b/02c,
IAM-03..07.

## 2. Critical path

```
IAM-01a ─> 01b ─> 01c ─> 01d
             │
             ├─> 02a ─> 02b ─────────┐
             │     └─> 03a ─> 03b    │
             │            └─> 04a ─> 04b ─> 04c
             │                        └─> 05a ─> 05c
             ├─> 05b                          │
             └────────> 06a ─> 06b ─> 07a ─> 07b
```

**IAM-01a is the single blocking decision.** It is a design ruling, not a build, and everything
queues behind it.

**Earliest usable unblock for Web Dev / PM** is IAM-06b (personas + fixtures), which needs
01a→01b→02a→06a→06b. The full contract lands at 07a.

## 3. Parallelism

Independent once 01b lands, safe to run concurrently:
- **01c/01d** (catalog persistence + module registry)
- **02a/02b** (bundles + parity)
- **05b** (UI codegen — depends only on the catalog, not on any Cerbos work)
- **06a** (persona seeds)

⚠ Concurrency caution: seats share this repo and checkout (memory `concurrent-agents-version-drift`,
`shared-repo-concurrent-sessions`). Migrations must claim ledger numbers up front —
`migration-ledger-state` puts the head at 0090; IAM-01c and any follow-on claim the next free
numbers explicitly rather than racing.

## 4. Phase 1 exit criteria

1. Full existing test suite green, **with zero authorization decisions changed** (IAM-02b proves it).
2. Permission catalog seeded, module-declared, drift-guarded (IAM-07b).
3. `can(permission, scope)` published server-side and reachable from the BFF.
4. ~~`rbac.ts` generated from the catalog, not hand-written.~~ **AMENDED 2026-08-10 by IAM-05b-DESIGN**
   → *the capability↔permission relationship is machine-CHECKED against Cerbos, with no unpinned link
   in the chain.* The original wording named a **mechanism** (codegen) before anyone had counted the
   call sites; its motive — kill the hand-maintained-parallel-list drift — is fully served by the
   parity chain, and better. See `2026-08-10-iam-05b-design.md`.
5. Personas + fixtures published; Web Dev and PM confirm they can build against them.
6. Contract doc published, stating explicitly what is frozen and what is not.

## 6. IAM-02a-0 — RESOLVED, run against live `gda-aicenter` 2026-08-10

**Ruling 4 is settled: correct the `rbac.ts` mirror during Phase 1.** The over-claim affects zero
real users.

Live role distribution (`gaiada_platform`, 50 live users, all active, 1 test account):

| Role | Holders | Grants | Scope |
|---|---|---|---|
| `member` | 18 | 18 | company |
| `manager` | 11 | 11 | company |
| `client` | 9 | 9 | company |
| `company_admin` | 9 | 11 | company |
| `agency_approver` | 1 | 1 | company |
| `it_admin` | 1 | 1 | company |
| **`platform_admin`** | **1** (`hansel@gaiada.com`) | 2 | global |
| **`group_executive`** | **1** (`exec@gaiada.test`) | 2 | global |
| `hr_staff` · `hr_manager` · `reports_staff` · `reports_manager` | **0** | 0 | — |

**The only `group_executive` holder is a seed/test account**, holding it *alone* (no
`platform_admin`). The single real elevated human is `hansel@gaiada.com` (`platform_admin`).
So D-7's removal is a code sweep plus deleting a test seed — **no user migration at all**, and
correcting the mirror in Phase 1 costs nothing.

### Finding E (NEW, live) — six code-known roles have NO `roles` row and are ungrantable

`team_lead` · `viewer` · `it_manager` · `it` · `search_staff` · `search_manager` — all zero rows.

They exist in `rbac.ts` and are granted actions across the Cerbos policies, but **no one can ever
hold them**. This is the "unreachable tier written into a contract" defect that
`derived_roles.yaml`'s own header already records for another role.

**`team_lead` is the one that matters now.** It is granted across ~27 policies (60 pairs, full PM
parity with `manager`), `rbac.ts` Gap-2 added its whole capability sweep — and it is unreachable.
**PM is blocked on exactly this tier.** `hr_*` and `reports_*` exist as rows but have zero holders,
which is why HR reads as inert live.

### Finding F (NEW, live) — `UNIQUE (user_id, role_id, scope_type, scope_id)` does not hold for global grants

Both elevated accounts carry **duplicate** grants (2 rows each) despite the constraint, because
`scope_id IS NULL` and SQL NULLs are distinct — memory `null-defeats-unique-constraints`, confirmed
live. Migration `0073_dedupe_global_roles.sql` deduped once but **cannot prevent recurrence**.

Under permission-based resolution a duplicate grant resolves the same permission set twice. Harmless
for a boolean check; **not** harmless for anything that counts grants, diffs them, or renders them in
the role-assignment UI.

### Tickets falling out

- **IAM-02d** (M) — **NEW.** Decide and act on the six ungrantable roles: seed them, or delete them
  from code. `team_lead` almost certainly must be seeded (PM depends on it); `viewer` needs a call
  since it duplicates `member`. **This is a live PM blocker, independent of the rest of the phase —
  worth pulling forward.**
- **IAM-01c-2** (J, senior-db review) — **NEW.** Partial unique index
  `(user_id, role_id, scope_type) WHERE scope_id IS NULL` to close Finding F, plus a one-off dedupe.
  Cheap, and it must land before bundles are resolved from grants.

## 5. Risks specific to Phase 1

| Risk | Mitigation |
|---|---|
| IAM-01a's granularity ruling is wrong and the catalog needs reshaping after consumers adopt it | Treat 01a as an owner-reviewed decision, not an engineering choice. Additions are additive-only afterwards; removals need an owner call. |
| The Cerbos↔`rbac.ts` disagreements found in IAM-02a turn out to be live access bugs, not drift | Expected. Document each; do **not** fix silently inside this phase — a fix is a deliberate access change and needs its own ticket and owner sight. |
| Per-request permission resolution regresses latency | IAM-03b ships a measured benchmark and cache before IAM-04 depends on it. |
| Cerbos policy edits appear to work but don't (no hot reload on Windows) | Documented in 04a; restart is part of every policy ticket's acceptance steps. |
| Wildcard `*` rules make "permission-based" incomplete from day one | IAM-04c rules on the bypass explicitly rather than letting it stay implicit. |
