# Permission contract (IAM Phase 1)

**Status:** PROTOTYPED — updated 2026-08-13 (IAM Phase 2 P2-02/P2-03: 4 new Cerbos kinds
[role_grant/position/employee/it_account] + the `ui_grantable` allow-list; prior: IAM-GAP-01,
invoice maker/checker + the dedicated HR leave decision right; originally frozen 2026-08-10,
reconciled 2026-08-11 against two days of IAM rollout work). This is the contract Web Dev and PM
build against.
**Companion to** `docs/FRONTEND-BFF-CONTRACT.md`. Program docs live in
`docs/superpowers/plans/2026-08-10-iam-*`, `docs/superpowers/plans/2026-08-13-iam-gap-01-report.md`,
`docs/superpowers/plans/2026-08-13-iam-phase2-design.md`, and
`docs/superpowers/plans/2026-08-13-p2-02-03-report.md`.

> **⚠ NEW AXIS (2026-08-13, P2-03): `ui_grantable`.** Every catalog entry now carries a REQUIRED
> `uiGrantable: boolean` (and a DB-side `permissions.ui_grantable`, migration 0110). It answers a
> DIFFERENT question than `sensitive` or `class`: **may this permission ever appear in a role bundle
> attached through a UI-adjacent write path** — a position's role-set today (design §2.3(b)), a
> Phase-4 composed custom role tomorrow? `portal.*` and every `class: "relationship"` key are
> `false`, structurally pinned (`src/rbac/ui-grantable-catalog.test.ts`); everything else is `true`
> by the initial marking pass. **Flipping a key `false -> true` is a PERMISSION-CONTRACT change
> requiring an owner decision line in the catalog entry — the same bar as a rename.** Flipping
> `true -> false` is always safe (narrowing). See §10 below for the full mechanism.

> **⚠ Concurrent-edit notice (2026-08-11).** This checkout is shared by several agents actively
> editing Cerbos policies, `derived_roles.yaml` and `role-permission-bundles.json` as this doc was
> written. Every number below was re-derived from the artifacts on disk at the time of writing, not
> copied from a prior plan doc — but "at the time of writing" in a moving checkout is a snapshot,
> not a landed fact. Where a number could plausibly move again before this lands, it says so inline.

> **Read §5 before you gate anything on a permission.** The single most likely way to misuse this
> contract is to treat a scope-level answer as a per-resource one.

---

## 1. The model in one page

Authorization has **two layers**, by owner decision (Ruling 1):

| Layer | What it is | Who uses it |
|---|---|---|
| **Permissions** — 215 grantable, 1:1 with Cerbos | the enforcement primitive | servers, policies, tests |
| **Permission groups** — 75 curated bundles | the authoring surface | HR / dept heads composing roles in the UI |

Plus a third vocabulary that is **not** going away: the UI's **34 capabilities** (`pm.contribute`,
`approvals.decide`, …). `can()` in `platform-ui` still speaks capabilities; they are *machine-checked*
against the permission layer rather than generated from it (IAM-05b ruling — `ROLE_CAPS` encodes owner
decisions, not data, so generating it would silently overwrite rulings).

**Key format:** `<domain>.<resource>.<action>` — e.g. `pm.task.update`, `hr.record.export`,
`core.project.read`. `domain` is the owning module, or `core` for the 33 non-module kinds.
**One deliberate exception:** the client portal is its own domain (`portal.*`, not `core.portal.*`) —
owner decision DR-4, because the portal is a separate trust surface.

Domains: `agency` `assistant` `billing` `core` `hr` `it` `knowledge` `pm` `portal` `reports`
`search` `webdev`.

## 2. Current numbers (re-derived from the artifacts, 2026-08-13, post-P2-02/P2-03)

| Artifact | Value | File |
|---|---|---|
| Catalog | **282** entries = **267 grantable** + **15 relationship**; 107 flagged `sensitive`; 72 distinct Cerbos kinds (P2-02, 2026-08-13: +18 grantable across 4 NEW kinds — `role_grant` [create/revoke/read], `position` [create/update/retire/assign/unassign/read], `employee` [create/read/update/delete], `it_account` [read/provision/disable/enable/reset_password] — design §6.2. Every entry also now carries `uiGrantable` [P2-03, §7] — see the box above. Prior: IAM-GAP-01, 2026-08-13: +2 literal actions on EXISTING kinds — `invoice.approve` and `automation_approval.decide_leave`, 264/249/68; before that: SMM-30, 2026-08-12: the `social` module's 8 kinds + 35 keys, plus `portal.approve_post`, 226/211/60 → 262/247/68) | `platform-nest/src/rbac/permission-catalog.json` |
| Role bundles | **1093** pairs across **22** roles (P2-02: +62 pairs — `platform_admin`/`company_admin` +18 each [full reach on all 4 new kinds]; `org_unit_lead` +6 [`role_grant`.create/read/revoke + `position`.assign/read/unassign — the dept-head subtree rule, reusing the EXISTING `org_unit_lead` derived role]; `hr_manager` +8 / `hr_staff` +2 [`hr_people_ops`/`hr_people_reader` reach on `position`/`employee`]; `it_admin`/`it_manager` +5 each [the new `it_managers` derived role's reach on `it_account`.*] — **zero removed**, no existing user's reach narrows. Prior: IAM-GAP-01: +8 pairs, 1031 total) | `platform-nest/src/rbac/role-permission-bundles.json` |
| Permission groups | **85** groups, **20** `advancedOnly` entries (P2-02 added the 18 new keys to `advancedOnly` — no curated friendly group exists yet for grant/position/employee/IT-account administration, deferred to P2-11/P2-12/P2-10/P2-14's own authoring surfaces; prior: IAM-GAP-01 added `invoices_approve` + `hr_leave_decide`; before that: SMM-30 added 8 social groups + `portal_approve_posts`) | `platform-nest/src/rbac/permission-groups.json` |
| UI capabilities | **34** — UNCHANGED by P2-02/P2-03 (`platform-ui/` is explicitly out of this ticket's scope; the new server-side permissions have no capability mirror yet) | `platform-ui/src/lib/rbac.ts` |

**⚠ The relationship count is unchanged at 15, and that is load-bearing.** The social module adds no
relationship-class permission, so the Ruling-3 bypass-exempt set is exactly where it was. If a future
social ticket moves that number, that is the change requiring justification — not the grantable one.

**SMM-30 (2026-08-12) — the social module's IAM registration, what it did and did not do.** Migration
`0106` seeds the 36 catalog rows, the two module roles, and all 162 bundle pairs the 8 new Cerbos
policies imply (`platform_admin` +36, `company_admin` +33, `manager` +32, `social_manager` +33,
`social_staff` +19, `group_executive` +8, `client` +1). It grants nothing to any user: seeding a
`roles` row makes a name grantable, and `service-reconciler.ts` still only materializes the module
roles onto a SERVED company via an active `service_assignments` row — of which there are none for
`module_key='social'`, because the module has no code yet. **The role names are derived, not chosen:**
`module_staff`/`module_manager` string-compose `resource.attr.module + "_staff"|"_manager"` and the
module key is `social`, so `social_staff`/`social_manager` are the only names Cerbos will ever look
for. (The SMM design and its first addendum both said `smm_*`; that would have reproduced the
silent-skip defect `0069`/`0091`/`0097` each closed. Corrected at source.) **The 8 new kinds ship with
the ROLE arm only — no `perm_social_*` mirror** — deliberately: §2's wildcard-bleed hazard and §9's
detector blind spot are unresolved and awaiting an architect decision, and mirroring 8 brand-new kinds
ahead of it would widen precisely the surface flagged open. They join the IAM-04 rollout register as a
deliberate batch once that decision lands; the catalog entries exist now, so nothing blocks it.

**Bundle sizes per role** (re-counted 2026-08-13 from `role-permission-bundles.json`'s own
`_meta.counts.perRole`, post-P2-02; seven roles moved this pass — `platform_admin`/`company_admin`
+18 each, `org_unit_lead` +6, `hr_manager` +8, `hr_staff` +2, `it_admin`/`it_manager` +5 each — see
§10 below for exactly which keys):

| Role | Pairs | Role | Pairs | Role | Pairs |
|---|---:|---|---:|---|---:|
| `platform_admin` | 267 | `viewer` | 29 | `search_manager` | 37 |
| `company_admin` | 248 | `org_unit_lead` | 8 | `search_staff` | 24 |
| `group_executive` | 127 | `client` | 7 | `reports_manager` | 3 |
| `manager` | 137 | `it_admin`/`it_manager` | 8 each | `reports_staff` | 4 |
| `member` | 73 | `it` | 3 | `webdev_manager` | 6 |
| | | `agency_approver` | 1 | `webdev_staff` | 4 |
| | | `hr_staff` | 15 | `social_staff` | 19 |
| | | `hr_manager` | 32 | `social_manager` | 33 |

`company_admin`'s 195 reflects two independent moves since the prior 200 (199 baseline + DR-5's
`reports.appraisal.read`, migration `0099`): HIER-3 retired 4 `core.team.*` keys, and a concurrent,
unrelated session (DR-12) deleted `resource_portal.yaml`'s dead staff-read rule, removing
`portal.read` (200 − 4 − 1 = 195; same −5 shape hit `manager`, and −1 hit `member`/`viewer`/
`group_executive` from their own narrower `core.team.read`/`portal.read` holdings). `org_unit_lead`
(2 pairs: `reports.appraisal.read`, `reports.document.read_department`) replaces `team_lead` (was
60 pairs, full PM parity with `manager` — that PM-wide reach was itself the dead-grant defect this
retirement removed; see §9).

**IAM-04-ROLLOUT progress (the permission-arm rewrite, separate from the numbers above — role-name
matching is still what decides every live authorization; the permission arm is an additive mirror
proven identical, not yet load-bearing):** the two-kind pilot (`pm_task`, `hr_case`) is joined by
**26 more kinds** (Batches 1–2 of the rollout register: 17 SAFE + 9 confirm-reliable module kinds —
`agency_brief/campaign/creative_asset`, `chat_group`, `company`, `compliance_gate`, `contract`,
`identity_link`, `invoice`, `knowledge_source`, `report_admin`, `rollup`, `rollup_recompute`,
`service_assignment`, `user`, `webdev_change_request`, `webdev_provisioned_site`, `hr_record`,
`agency_approval`, and the 7 `resource_search_*` kinds) — **55 of 72 kinds now carry a `perm_*`
arm** (re-derived 2026-08-18 by counting resource policies that actually reference a `perm_*`
derived role, not from a prior doc's snapshot; see §9's register for the 17 that do not), verified via `permission-arm-hazard-scan.test.ts` (12→64 tests as each kind joined its own
regression guard). Batches 3–8 (self-scope-only `checkin`; the dead-grant `team_lead` sweep; 3
dual-mitigation kinds; `report_document`'s per-action split; `team`; the 6 `group_executive`
TRAP-4-blocked kinds) are **not started**. This is a snapshot — another concurrent session may move
it before this doc is read.

**A hazard beyond the pilot's own coverage, found during the B12 batch — GRANT PATH NOW CLOSED
(IAM-SEC-02, 2026-08-11), DETECTION GAP STILL OPEN.** On every kind whose wildcard rule names
`platform_admin`/`group_executive` (56 of 61, including both pilot kinds), the permission-arm mirror
does not exclude those two the way `team_lead` is excluded, because `derived_roles.yaml`'s condition
for both is `scopeType == "global"` only. A grant of either at `scopeType: "company"` would therefore
be ALLOWED by the permission arm at that company while the role arm's own global-only condition
DENIES — the permission arm granting what the role arm refuses.

It was **reachable**, not merely hypothetical: `assignRole` is authorized by `user:create`, which
`company_admin` holds, so a company admin could have minted `platform_admin@their-own-company` and
picked up the permissions their own bundle lacks — inside their own tenant, and in violation of D-9's
no-self-escalation safeguard.

- ✅ **Grant path CLOSED.** `admin-identity.controller.ts` now carries a `GLOBAL_ONLY_ROLES` guard
  returning a clean 400 for either role at any non-global scope, pinned by
  `src/admin/global-only-role-scope.test.ts` and teeth-proven (with the guard disabled the refusal
  cases return **201 instead of 400** — i.e. the grant is created). Enforced at the single
  unrestricted write path rather than by narrowing `perm_*` rules across 28 policy files: one check
  that makes the bad row impossible, instead of making a bad row harmless in one consumer.
- ✅ **Detection gap CLOSED.** `permission-arm-hazard-scan.test.ts` originally modelled only
  SAME-RULE mixing, so a wildcard/unconditional rule combined with a role whose own condition is
  narrower stayed invisible to it. **IAM-SEC-03 landed** (2026-08-11): the detector carries Pattern C,
  all kinds were swept, and no open exposure was found. IAM-SEC-04/05/06 extended the same instrument
  further (resolution-source filter in `assemblePrincipal()`).

## 3. The 15 permissions no role can ever hold

`assistant_thread` (9 actions), `assistant_memory` (4), `mcp_tool:call`, `agent_run:read` are
`class: "relationship"` — held by **owning the resource**, never by a role, and exempt from every
wildcard including superadmin and the forthcoming `owner`. Enforced at four independent layers: the
catalog class boundary, a DB trigger on `role_permissions`, the resolution-time query filter, and the
absence of any derived-role rule on those kinds.

They are exempt by **three different mechanisms** (IAM-04c): *relationship-granted* (13, owner
condition), *channel-granted* (`mcp_tool:call` — the hub never sends a platform role at all), and
*code-gated* (`agent_run:read` — an `isElevated()` check that runs before Cerbos).

**Do not "restore consistency" by adding a wildcard to those policies.** A static guard
(`iam-215-boundary-pin.test.ts`) now fails if you do.

## 4. Asking a permission question

### Server

```ts
import { can } from "../rbac/can";

// Per-resource question — ASKS CERBOS. This is the default; use it unless you know otherwise.
if (await can(principal, "pm.task.update", { tenantId, id: taskId, ownerId: task.ownerId })) { … }

// Scope-level question — answers from the principal's resolved permissions, NO Cerbos round trip,
// NO condition awareness. Deliberately a different function name so misuse is visible in review.
const showCreateButton = can.scopeOnly(principal, "pm.task.create", { scopeType: "company", scopeId: tenantId });
```

`authorize(...)` is unchanged and remains the throw + audit + D11-revocation guard. `can()` is a pure
question, like `check()`.

### UI

`can(me, capability, companyId)` in `platform-ui/src/lib/rbac.ts` — unchanged. Capabilities, not
permission keys.

### The BFF (IAM-05c, NEW 2026-08-10)

`GET /api/:tenantId/authz/permissions` and `GET /api/authz/permissions`
(`platform-nest/src/core/authz-permissions.controller.ts`) publish the caller's **scope-level**
answer as `{ scopeType, scopeId, scopeLevelPermissions, excludedRelationshipClass,
wildcardBypassRoles, caveat }`, ETag-cached and invalidated by `session_version`. This is
`can.scopeOnly()` asked 215 times and reported which answers were "yes" — **read §5 before
consuming it.** `scopeLevelPermissions` is not "may do X to any resource"; it is "holds this key
somewhere in this scope, with zero knowledge of any resource-level condition." A consumer that
treats it as a per-resource grant reproduces the IAM-04b regression (§5's `team_lead`/`pm_task`
finding) at the UI layer, now across up to 215 keys instead of one. `wildcardBypassRoles` names any
held role from `["platform_admin","group_executive"]` — for those two roles specifically, treat the
list as a floor, not a ceiling: it is resolved from the pre-computed bundle snapshot, and a Cerbos
wildcard grant added after the bundle was last regenerated would not appear until the next regen,
whereas `can()` (which always asks Cerbos live) would see it immediately. See
`docs/FRONTEND-BFF-CONTRACT.md` §8 for the route rows.

## 5. ⚠ The boundary that will bite you

**`can()` and `can.scopeOnly()` are not interchangeable.**

Cerbos evaluates conditions a flat permission list cannot express — `ownerId`, `subjectUserId`,
`teamId`, assurance floors. So a permission may be in your bundle and still be denied on a specific
resource.

This is not hypothetical. The IAM-04 pilot found `team_lead`'s bundle claiming `pm.task.*` reach that
**no handler can enable**, and the first permission-matching implementation flipped a pinned
adversarial test from **403 to 200**. The same shape exists on `hr_case`, where `member`'s self-only
grant and `company_admin`'s unconditional grant produce identical permission keys.

**Rule of thumb:** rendering a button → `can.scopeOnly()` is acceptable. Deciding whether an action
may proceed → `can()`, always. `can.scopeOnly()` throws on relationship permissions rather than
returning `false`, because a `false` would look like a legitimate deny.

## 6. Testing against this contract

**14 personas**, backend and frontend:

```ts
// backend
const p = await seedPersonaTenant();
await app.inject({ ...p.as("hr_manager"), url: "/api/…" });

// frontend (Playwright)
await loginAsPersona(page, "member");
```

Docs: `platform-nest/README-PERSONAS.md`. Helpers: `platform-nest/src/testing/personas.ts`,
`platform-ui/e2e/personas.ts`.

**Assert denials, not just grants.** Under-claims — functionality wrongly hidden — were the more
dangerous drift direction every time this program measured it.

⚠ `DEMO_MODE` covers only **5 of 14** personas. The other 9 throw a named error rather than silently
substituting a different identity.

## 7. What is FROZEN vs what will still change

**Frozen — build on these:**
- the key format and the 215/15 split;
- `can()` / `can.scopeOnly()` signatures and the boundary in §5;
- persona names and fixture APIs;
- the relationship-class exemption;
- the IAM-05c BFF response shape (`scopeLevelPermissions`/`excludedRelationshipClass`/
  `wildcardBypassRoles`/`caveat`) and its scope-level-only semantics.

**NOT frozen — actively moving as of 2026-08-11, do not build on the specifics below:**
- **Scope types finished moving (HIER-3, 2026-08-11).** The DB `scope_type` CHECK (migration
  `0103`) is now `global | company | org_unit | project` — **`team` and `record` are DELETED from
  the CHECK, not merely absent from new writes** (0103 hard-aborts if a leftover row of either
  exists, then narrows the CHECK for real), `org_unit` exists, `scope_id` is widened `uuid → text`
  (0100) with a per-shape CHECK (narrowed again by 0103 to match). `teams`/`team_memberships` are
  DROPPED (0 rows, count-asserted). `core/teams.controller.ts` is DELETED, and
  `testing/personas.ts`/`seed/personas.ts`'s `team_lead` persona is reworked to `org_unit_lead`.
  **`org_unit_lead` (HIER-2, the `team_lead` replacement) is a real, seeded, Cerbos-consuming role**
  landed on exactly two rules (`report_document.read_department`, `appraisal.read`) — see the
  `team_lead` bullet immediately below for what changed. `org_unit` is otherwise still a narrow
  scope (two landing surfaces only); do not assume it is wired everywhere.
- **`team_lead` is RETIRED (HIER-3, 2026-08-11) — the role, its Cerbos derived role, its
  `role_permissions` bundle, and every writer that could mint the grant are gone.** It is no longer
  named in any resource policy, any catalog permission, any seeded role, or any test fixture; the
  `team` Cerbos kind and `resource_team.yaml` are deleted with it. Its replacement is
  `org_unit_lead` (HIER-2's subtree-cascade role, landed on `report_document.read_department` and
  `appraisal.read` only — do not assume broader PM-parity reach the way `team_lead` claimed; that
  claim was the dead-grant defect this retirement removed).
- **`owner` (D-8) does not exist yet** and `group_executive` is slated for deletion (D-7). There is
  deliberately no `owner` persona. IAM-04c ruled `owner` will be expressed with **zero Cerbos
  policy rules** — a platform-managed bundle generated by exclusion from the 215 grantable keys —
  which is a Phase-3 design constraint worth knowing now if you're touching anything nearby.
- **The IAM-04 permission-arm rewrite is 28 of 61 kinds in, not complete, and role names — not
  permissions — still decide every live authorization.** §2 has the current kind list and the
  unresolved wildcard-bleed hazard. Do not consume `principal.perms` for anything but the IAM-05c
  BFF endpoint above; `can()` still resolves everything through Cerbos, live, by role name.
- **Custom roles / the authoring UI** (Phase 4). Bundles are data today with no runtime consumer.
- **Sensitivity flags** — 79 permissions and 42 groups are flagged, pending an owner + HR/finance pass.
- Permission **additions** are additive and safe; **removals or renames** need an owner decision.

## 8. What guards this contract

| Guard | What it pins |
|---|---|
| `role-permission-parity.db.test.ts` | DB bundles == live Cerbos reach, per (role, kind, action). **Does NOT cover the 15 exempt pairs** — see the correction below. |
| `iam-215-boundary-pin.test.ts` | the 215/15 boundary; exempt kinds carry zero derived-role rules |
| `role-permission-bundles.db.test.ts` | checked-in artifact == DB, regen-no-diff |
| `role-bundle-completeness.db.test.ts` | every seeded role has a non-empty bundle (empty allowlist) |
| `role-catalog-drift.db.test.ts` | every role named in policies/`rbac.ts` has a seeded row |
| `permission-arm-hazard-scan.test.ts` | flags a permission arm where a role's rule mixes scope-only and attribute-dependent matching (Pattern A/B). 64/64 as of 2026-08-11 (grew from 12 as 26 more kinds joined the rollout). **Does not detect** the wildcard-bleed hazard in §2 — a role reachable only via a wildcard/unconditional rule is out of its pattern scope by design. |
| `rbac-capability-parity.test.ts` (UI) | `ROLE_CAPS` == bundle ⨯ capability map, semantics-checked. 547 pairs asserted (grew from 536 with DR-6/DR-7/the `hr.case.cancel` map fix). |
| `cerbos-catalog-alignment.test.ts` (**NEW, IAM-07b**) | Cerbos policies ↔ `permission-catalog.json`, both directions: every catalog kind has a policy file, every policy kind has a catalog entry, every literal (non-`*`) action is catalogued, no kind defined twice. Explicitly does NOT claim the "orphaned catalog entry" direction for the 56 wildcard kinds — Cerbos's own `*` semantics make that direction unprovable by static inspection alone. |
| `permission-groups-catalog-parity.test.ts` (**NEW, IAM-07b**) | `permission-groups.json` ↔ catalog: key existence/grantability both directions, exhaustive coverage (every grantable key lands in a group or `advancedOnly`), no contradiction, `_meta.counts` re-derivation. |
| `iam-07b-chain-meta.test.ts` (**NEW, IAM-07b**) | the chain itself — enumerates all 8 pairwise links (the six the design doc named, plus the role-axis link and the 215/15 boundary) and fails if any named guard file is deleted, emptied, or has zero test cases. Cannot prove a guard still tests the right thing, only that it exists and isn't vacuous-by-omission. |
| `global-only-role-scope.test.ts` (**NEW, IAM-SEC-02**) | `platform_admin`/`group_executive` may only be granted at **global** scope — both roles' derived-role conditions match `scopeType=="global"` only, so a company-scoped grant of either would be silently inert for Cerbos while still resolving into `principal.perms` at company scope, which is exactly the wildcard-bleed shape §2 flags unresolved for the permission-arm mirror. Fixed at the source in `admin-identity.controller.ts`'s `GLOBAL_ONLY_ROLES` guard (found by IAM-04-ROLLOUT-B12). |
| `ui-grantable-catalog.test.ts` (**NEW, P2-03**) | the `ui_grantable` allow-list's catalog axis: completeness (every entry carries a real boolean, teeth-proven by deleting/corrupting the field on a clone), and the two pinned invariants (`portal.*` and `class:"relationship"` are always `false`, teeth-proven by flipping one to `true` on a clone). Static only. |
| `src/db/iam-phase2-ui-grantable-guard.test.ts` (**NEW, P2-03**) | the allow-list's DB axis: `permissions.ui_grantable` matches the catalog exactly (full parity, all 282 rows); `position_roles_guard()`'s clause (b) rejects a non-ui_grantable bundle on INSERT and UPDATE, teeth-proven by dropping the trigger and watching the same insert succeed, then restoring it; `assertRoleUiGrantable()`/`nonUiGrantableKeysForRole()` (`src/rbac/ui-grantable.ts`) proven against the identical clean/dirty roles the trigger test uses. |

Every one was required to demonstrate a **real failure** under mutation before being accepted. A
guard that cannot fail is worse than none — this program found one that had been quietly vacuous
(`iam-04c` finding G1) and one whose header claimed a guarantee it did not provide.

**🔴 Standing correction (IAM-04c finding G1, still true as of this pass):** `role-permission-
parity.db.test.ts` pre-filters relationship-class pairs out of its Cerbos-side coverage computation
(`if (classByPair.get(pairId) !== "grantable") continue;`) — it **assumes** the 15-pair exemption
rather than proving it. Adding a wildcard to one of the 4 exempt kinds "for consistency" would
expand, get filtered out by that line on both sides, and leave the suite green while the exemption
is destroyed. `iam-215-boundary-pin.test.ts` (66 tests) is the real static boundary-pin that would
catch it — treat that one, not the parity suite, as the authority for "no role reaches the 15."

## 9. Known-open items (refreshed 2026-08-13, IAM-GAP-02)

**Closed since the 2026-08-10 freeze:**
- ~~IAM-GAP-01's filed hole #1: platform_admin/group_executive's wildcard bypassed the invoice
  maker/checker seam's own creator check~~ — **CLOSED, IAM-GAP-02 (2026-08-13, PROTOTYPED).**
  `resource_invoice.yaml` gains a structural `EFFECT_DENY` on `approve` (`roles: ["user"]` — matches
  every principal by construction, no role name to keep in sync) whose condition is
  `has(creatorId) && creatorId != "" && creatorId == principal.id`. Cerbos combines a kind's
  matching rules with deny-overrides semantics, so this DENY beats the pre-existing
  `actions: ["*"]` wildcard for BOTH `platform_admin` and `group_executive` — live-probed and
  `app.inject`-adversarially-proven for both roles (`src/core/billing.test.ts`'s
  `"invoice approve — the self-approval hole, elevated roles (IAM-GAP-02)"` block): each can create
  an invoice and is then 403'd approving that SAME invoice, while still 200ing on a DIFFERENT
  invoice (the DENY does not over-fire into a blanket lockout). No catalog/bundle change — a
  restriction has nothing to grant. The wildcard's SEPARATE, pre-existing ability to approve an
  UNKNOWN-creator (legacy) row is explicitly UNCHANGED by this pass — Part 2 of the ticket targeted
  only creator == approver, not the wildcard's fail-open reach over legacy rows; live-probed both
  ways (§ this ticket's own report) so the boundary is stated, not assumed.
- ~~"Approval is based on managers related" — owner correction to IAM-GAP-01's default~~ —
  **CONFIRMED, IAM-GAP-02 (2026-08-13).** No narrowing: `company_admin`/`manager` (department-
  manager tier) plus `platform_admin`/`group_executive` ("due to the nature of account
  specification") is exactly IAM-GAP-01's shipped approver set. "Related" resolves to **same-company
  `manager`** — `derived_roles.yaml`'s existing `manager` role at `scopeType == "company"` — stated
  PLAINLY as the interpretation actually implemented, not silently assumed: invoices carry only
  `client_id`; their lines are computed from potentially MULTIPLE of that client's projects with no
  `project_id` persisted per line (only the project's name); `clients` has no manager/account-owner
  column at all. A tighter client/project relation is therefore NOT cheaply expressible without a
  schema change (storing project_id per invoice line) or widening `manager`'s own derived-role
  condition (shared by ~30 other resource kinds) — both bigger than a policy-only pass. Flagged for
  the owner to tighten in a follow-up if "related" was meant narrower than "any manager in the
  tenant"; see `resource_invoice.yaml`'s own IAM-GAP-02 comment for the full account.
- ~~No revision/version-control trail for invoices~~ — **CLOSED, IAM-GAP-02 (2026-08-13,
  PROTOTYPED).** New `invoice_revisions` table (migration `0108`) plus `invoices.updated_by`.
  SNAPSHOT-based (full before/after row state per mutation, not a diff) — a diff-only design would
  require replaying every prior revision to answer "what did this look like before edit N", so one
  missing/corrupt row would break every reconstruction after it; a self-contained snapshot pair
  answers that question from ANY single revision row alone. `changed_fields` is a derived,
  human-skimmable convenience computed from the two snapshots — never authoritative. Wired into all
  THREE real write paths that ever mutate `invoices` (enumerated and each independently
  `app.inject`-tested): `billing.controller.ts`'s `create()`/`setStatus()`/`approve()`, and
  `contracts.controller.ts`'s `decidePayment()` — the ONE place `invoices.status` moves to `'paid'`
  outside the billing module entirely, previously untested end-to-end at all
  (`src/core/contracts-invoice-payment-revision.test.ts`, new). Two dev/test-only seed scripts
  (`src/seed/agency.ts`, `src/seed/portal-workspace.ts`) insert invoices directly with no
  authenticated principal and are deliberately NOT wired — fabricating an actor for a seed row would
  be worse than the honest gap. Pre-existing rows (the live estate's 12 invoices, once this
  migration actually runs against them) each get exactly one
  `action='baseline_pre_revision_tracking'` marker row (`actor_id`/`before_snapshot` NULL) instead
  of silently-empty history — so "no history" always means "known to predate tracking", never
  "nothing happened, or we lost it". FORCE RLS + `tenant_isolation`, mirroring `0021`/`0075`'s
  NULLIF-hardened form; `lint:migration-rls` clean. No new Cerbos action/catalog key — this pass is
  data capture only, no read/analysis surface (deferred, per the ticket, to a separate session).
- ~~The stuck live draft with no recorded creator (IAM-GAP-01 blocker, one of the live estate's 12
  invoices)~~ — **INVESTIGATED, NOT RESOLVED FROM THIS SESSION — genuine recovery path shipped,
  outcome unverified against the live 12-row dataset.** This session had no live-database
  connectivity to inspect the actual stuck row, so migration `0108` ships a GENERAL recovery rule
  rather than a one-row hand-fix: for every invoice with `created_by IS NULL`, it checks the
  `activities` log (`verb='created', target_entity_type='invoice'`) — which
  `billing.controller.ts::create()` has written to since before `created_by` existed, recording the
  SAME fact that column was always meant to capture, just in a different table — and backfills
  `created_by` ONLY when exactly one DISTINCT actor claims that invoice's creation (an ambiguous or
  absent signal leaves it NULL, same no-fabrication policy `created_by` itself follows). The
  fail-closed `approve` rule is NOT weakened either way. `RAISE NOTICE` reports the recovered/left-
  NULL counts when the migration actually runs; **the owner or devops seat applying this migration
  to production should read that log line** to learn whether the specific stuck row was recovered.
  If it reports zero recovered for that row, the documented operator step is a hand-fix:
  `UPDATE invoices SET created_by = '<a real user id>' WHERE id = '<the stuck row's id>';` run as the
  `platform_owner`/migrator role — after which the row becomes approvable by company_admin/manager
  on the caller's next request (no restart needed; this is a data change, not a policy change).
- ~~IAM-05c (bulk effective-permissions endpoint)~~ — **LANDED.** `GET /api/:tenantId/authz/
  permissions` + `GET /api/authz/permissions`, see §4 and `FRONTEND-BFF-CONTRACT.md` §8.
- ~~IAM-SEC-02 (elevated roles grantable at non-global scope)~~ — **found and fixed** during
  IAM-04-ROLLOUT-B12: `admin-identity.controller.ts` now has a `GLOBAL_ONLY_ROLES` guard rejecting a
  company/project-scoped grant of `platform_admin`/`group_executive`, pinned by
  `global-only-role-scope.test.ts`. The underlying *detector* blind spot that let this class of bug
  exist unnoticed (`permission-arm-hazard-scan.test.ts` doesn't catch wildcard-adjacent roles) is
  **still open** — see below.
- ~~No invoice `approve` action (no maker/checker seam)~~ — **CLOSED, IAM-GAP-01 (2026-08-13,
  PROTOTYPED).** Migration `0107` adds `invoices.created_by`/`approved_by`/`approved_at` and widens
  the status CHECK to include `'approved'`; `resource_invoice.yaml` gains an `approve` action
  granted to `company_admin`/`manager` (the owner's "department manager tier" default) with a
  fail-CLOSED condition — `has(creatorId) && creatorId != "" && creatorId != principal.id` — so an
  invoice whose creator is unknown (every pre-migration row; no backfill was possible) is
  permanently unapprovable by anyone but the pre-existing `platform_admin`/`group_executive`
  wildcard. New catalog key `billing.invoice.approve` (sensitive). The BFF endpoint
  `POST /api/:tenantId/invoices/:invoiceId/approve` (`billing.controller.ts`) is the only door into
  `'approved'`; the pre-existing `PATCH .../invoices/:id` cannot set it directly, and `'sent'`/`'paid'`
  now require the invoice to already be `'approved'` (`'draft'`/`'void'` remain reachable from any
  state). No `perm_invoice_approve` permission-arm mirror — the condition is an attribute-instance
  check the flat catalog cannot re-express (same doctrine as `resource_hr_case.yaml`'s excluded
  self-only mirrors). DEV-VERIFIED: live Cerbos probes (creator denied self-approval, a different
  company_admin/manager allowed, unknown-creator legacy row denied, cross-tenant denied, low-assurance
  denied) and `app.inject` end-to-end tests in `src/core/billing.test.ts`.
- ~~HR leave decisions ride the generic `core.automation_approval.decide`~~ — **CLOSED, IAM-GAP-01
  (2026-08-13, PROTOTYPED).** New catalog key `hr.leave.decide`, mapped onto a NEW literal Cerbos
  action `decide_leave` on the existing `automation_approval` kind (not a new kind — the unified
  `POST /automation-approvals/:id/decide` endpoint still has no fork; `automation-approvals.
  controller.ts`'s `decide()` requests `decide_leave` instead of `decide` only when the row is
  origin='hr' AND `workflow_id='hr:leave'` — loan requests, `workflow_id='hr:loan'`, are
  BYTE-UNCHANGED and keep the generic `decide`). Granted to `company_admin`/`group_executive`/
  `platform_admin` (non-regression: all three already reached hr-origin leave decisions through the
  generic rule) plus `hr_manager` via `module_manager` gated on `module=='hr' && subKind=='leave'` —
  the owner's "department manager tier" default. `hr_staff` (module_staff, non-manager) does **not**
  hold it — adversarially proven in `src/modules/hr/hr.test.ts`, not just structurally asserted. No
  permission-arm mirror (same attribute-gate exclusion as `automation_approval`'s pre-existing
  `read`/`decide` — see `IAM_04_REG1_PRE_EXISTING_OUT_OF_SCOPE_BASELINE`'s own comment). Today this
  is a Phase-1 catalog/authoring addition, not a live decider-set change: no custom-role authoring
  surface exists yet (§7), so the actual population of people who can decide a leave request is
  identical before and after this ticket — what's new is that "who may approve leave" is now its
  OWN grantable key instead of being indistinguishable from `core.automation_approval.decide`'s
  reach over every other origin (loans, automation, agent).

**Still open, unresolved as of this pass:**
- **IAM-04-ROLLOUT.** **55 of 72 kinds carry a permission arm** (measured 2026-08-18 from the
  policies themselves: `grep -lE '^\s*derivedRoles:.*perm_' cerbos/policies/resource_*.yaml`).
  The remaining **17**, classified — this list, not a batch number, is the register now:
  | Kinds | Why unwired | Disposition |
  |---|---|---|
  | `assistant_thread`, `assistant_memory`, `agent_run`, `mcp_tool` | Ruling-3 relationship-class exemption; superadmin deliberately cannot reach them | **NEVER wire** |
  | `role_grant`, `position`, `employee`, `it_account` | Phase-2 kinds shipped role-arm-only on purpose (P2-02, §10.1) | Deferred past the rollout |
  | `integration_connection` | `group_executive`-only rule, no mirrorable tier (IAM-04-B5) | Blocked on D-7 (`group_executive` removal) |
  | `report_document`, `appraisal` | Blocked in B5 §4 — `org_unit_lead`'s attribute-dependent rule cannot be expressed as a flat mirror | Needs its own narrow ticket |
  | `social_account`, `social_client_review`, `social_inbox`, `social_platform_app`, `social_report` | B6 wired only the 3 social kinds with real handler code; these five have none | Wire when the handlers exist |
  | `member` | **Correctly excluded, reason established 2026-08-18.** It was in the §R.7 Batch-1 list but landed as 16 kinds, not 17 (`eec0b98`), with no recorded reason. Re-derived: `resource_member.yaml`'s `module_staff` rule gates tenant-directory `read` on `resource.attr.module` matching the staff role's module, while the bundles record `core.member.read` for **all six** module-staff roles (`hr_staff`, `search_staff`, `reports_staff`, `webdev_staff`, `social_staff`). A flat company-scope `perm_member_read` mirror would therefore hand every module-staff role tenant-wide directory read that the role arm refuses — the attribute-gate shape a flat mirror structurally cannot express. | **Do not wire** without a selective/self-scoped mitigation |
  Rollout batches 4–7 (the dead-grant `team_lead` sweep across 18 kinds, 3 dual-mitigation kinds,
  `report_document`'s per-action split, `team` itself) **dissolve rather than proceed**: their
  entire subject matter (`team`-scoped grants, `team_lead`) no longer exists post-HIER-3, exactly
  as the HIER-01 consolidation plan predicted — `pm_task` (the pilot's own `team_lead` control kind)
  measurably moved HAZARDOUS → SAFE and dropped out of `permission-arm-hazard-scan.test.ts`'s
  register (see that file's own regression-guard comment). Batch 3 (self-scope-only `checkin`) and
  batch 8 (the 6 `group_executive`/TRAP-4-blocked kinds) are unaffected and still not started.
  Still invisible to consumers of `can()` either way — role names, not permissions, decide every
  live authorization today.
- **The permission-arm hazard detector's blind spot (found during IAM-04-ROLLOUT-B12, NOT yet a
  ticket).** `permission-arm-hazard-scan.test.ts` only catches a role that is unsafe because it sits
  *mixed* with a safe role inside one rule (Pattern A/B). It does not catch a role that is unsafe
  because its ONLY reach is through a wildcard or unconditional rule whose own `derived_roles.yaml`
  condition doesn't match the mirror's assumed scope shape — the exact shape IAM-SEC-02 turned out
  to be, and which is *already* present, unaddressed, in the shipped `pm_task`/`hr_case` pilot
  (neither pilot's `perm_*` roles exclude `platform_admin`/`group_executive`; `pm_task`'s own
  `team_lead` exclusion was retired with the role itself, HIER-3). No
  live grant makes this reachable today (IAM-SEC-02's fix closed the one path that would have
  created one), but the detector itself has not been extended, and an architect decision is
  outstanding between (a) adding a fourth hazard pattern + retroactively fixing the pilot, or (b) a
  single choke-point fix already in place (`GLOBAL_ONLY_ROLES`) being judged sufficient on its own.
- `module_manager` cannot read the tenant directory though `module_staff` can
  (`resource_member.yaml`'s directory rule names `module_staff` only) — re-verified directly against
  the policy file in this pass, still present, still looks like an oversight rather than a decision.
- HR **loan** decisions still route through the generic `core.automation_approval.decide` — only
  **leave** got its own dedicated key this pass (IAM-GAP-01, closed above); the owner did not ask for
  loans in this ticket and the report flags it as a candidate follow-up rather than assuming it in
  scope. DR-1's premise (approval authority cleanly scoped per domain) is now true for leave, not
  yet for loans.
- **Sensitivity sign-off** — now **107** catalog permissions flagged `sensitive` (was 79 when this
  row was written; the social module, IAM-GAP-01 and P2-02 all added flagged keys). Still needs the
  owner + an HR/finance pass; blocks D-9/D-10, not Phase 1.
- **IAM-02c** (retire Cerbos-side `module_staff`/`module_manager` string composition in favour of
  explicitly-named per-module derived roles) — **DEFERRED, reviewed 2026-08-18.** Its own gate is
  "once IAM-04 lands", and the rollout is at 55/72 kinds with three blocked classes above. The
  narrower half of 02c is already satisfied: module roles carry explicit bundles (`0094`), every
  module role is seeded (`0091`/`0097`/`0106`), and `role-catalog-drift.db.test.ts` **derives** the
  composed names from the policies + call sites rather than listing them, so the silent-skip defect
  class that motivated 02c is already guarded. What remains is a pure no-behavior-change policy
  rewrite across every module kind — deliberately not done mid-rollout, since it would churn exactly
  the rules the rollout is still reasoning about.
- ~~HIER-2 (`org_unit_lead`) and HIER-3 (the `team`/`team_lead` retirement sweep)~~ — **LANDED
  (2026-08-11).** `org_unit_lead` is seeded and Cerbos-consuming on two rules; `team_lead`, the
  `team`/`record` scope values, and `teams`/`team_memberships` are retired. See §7's rewritten
  bullets for the current shape. Follow-up not yet done: `Resource.teamId` (the shared attribute
  field `reports.controller.ts` and others still pass) is now a fully dead attribute — no Cerbos
  rule reads it anymore — but renaming/removing it from `src/rbac/cerbos.ts` and every call site
  was reported as out of this ticket's scope (HIER-2's own report explicitly deferred it to
  HIER-3, but the rename touches ~10 files beyond team/team_lead itself); left for a future ticket.

## 10. IAM Phase 2 (P2-02/P2-03, 2026-08-13) — 4 new kinds + the `ui_grantable` allow-list

Design: `docs/superpowers/plans/2026-08-13-iam-phase2-design.md` §6.2 (the kinds), §7 (the
allow-list). Full account: `docs/superpowers/plans/2026-08-13-p2-02-03-report.md`.

### 10.1 The four new Cerbos kinds — ROLE-ARM ONLY

| Kind | Domain | Actions → catalog key | Who (role-arm) | Perm-mirror |
|---|---|---|---|---|
| `role_grant` | core | create/revoke/read → `core.role_grant.*` | `platform_admin` (wildcard); `company_admin` (full tenant); `org_unit_lead` (own subtree, via `resource.attr.unitAncestors` — reuses the EXISTING derived role, not a new one) | **PERMANENTLY UNWIRED** (IAM-04c §9 option C — the dept-head rule is subtree-attribute-dependent, same class as `appraisal`/`report_document`) |
| `position` | core | create/update/retire/read → HR tier; assign/unassign/read → dept-head tier → `core.position.*` | `platform_admin`; `company_admin` (all actions); `hr_people_ops`/`hr_people_reader` (create/update/retire/read); `org_unit_lead` (assign/unassign/read, own subtree) | **PERMANENTLY UNWIRED**, same reason as `role_grant` |
| `employee` | hr | create/read/update/delete → `hr.employee.*` | `platform_admin`; `company_admin`; `hr_people_ops` (write); `hr_people_reader` (read) | **DEFERRED** (not attribute-dependent — `hr_people_ops`/`hr_people_reader` are SAFE global-or-company shapes — but no handler exists yet; P2-06 owns building one before a mirror is wired) |
| `it_account` | it | read/provision/disable/enable/reset_password → `it.account.*` | `platform_admin`; `company_admin`; `it_managers` (NEW derived role: `it_admin`∨`it_manager`, deliberately excluding the baseline `it` role) | **DEFERRED**, same reason as `employee` — P2-13 owns the handler |

**Self-target/self-assign structural DENY** (`role_grant.create`, `position.assign`): `roles:
["user"]` (matches every principal, deny-overrides beats every ALLOW including `platform_admin`'s
wildcard) — copies `resource_invoice.yaml`'s IAM-GAP-02 pattern. Live-probed both ways (dept head
self-target, `platform_admin` self-target) against `gaiada-test-cerbos`; see the P2-02/03 report.

**Deviation from the design doc's illustrative text, flagged (not silent):** §6.2 names the
role_grant resource attribute `targetUnitAncestors`. This shipped as `unitAncestors` instead — the
SAME attribute name `report_document`/`appraisal`/`position` already use for the org_unit_lead
subtree cascade — so `role_grant` reuses the EXISTING `org_unit_lead` derived role rather than
forking a second, differently-named one that would need its own duplicate entry in
`scope-constrained-roles.json` and `admin-identity.controller.ts`'s `ROLE_SCOPE_CONSTRAINTS` for
zero behavioral gain. `position.read` was also added beyond the design text's literal action list
(assign/unassign/create/update/retire only) — every downstream ticket that reads positions needs it
and every other kind in the repo has one.

### 10.2 The `ui_grantable` allow-list (P2-03, design §7)

- **Catalog axis:** `uiGrantable: boolean` REQUIRED on every `permission-catalog.json` entry (282
  of 282, enforced by `src/rbac/ui-grantable-catalog.test.ts`'s completeness check). DB mirror:
  `permissions.ui_grantable boolean NOT NULL` (migration 0110).
- **Pinned invariants:** every `portal.*` key and every `class:"relationship"` key is `false`.
  Everything else — INCLUDING all 18 of this ticket's new keys — is `true`: positions must be able
  to confer `org_unit_lead`/`hr_manager`/`it_admin`/`it_manager` bundles that now include
  `role_grant.*`/`position.*`/`employee.*`/`it_account.*`, or the whole dept-head mechanism this
  phase exists to build would be rejected at the trigger the moment a real position tried to carry
  `org_unit_lead @ own_unit`.
- **Enforcement, 3 independent layers** (design §7):
  1. `assertRoleUiGrantable(c, roleId, roleName?)` (`platform-nest/src/rbac/ui-grantable.ts`) — the
     one helper every future write path that attaches a role to a UI-authored surface must call.
     **Not wired into any write path by this ticket** — `GrantWriteService` is P2-04's choke point;
     this ships the helper + its teeth test for P2-04/P2-08/P2-12 to import.
  2. `position_roles_guard()`'s clause (b) (migration 0110, `CREATE OR REPLACE FUNCTION` on the
     SAME trigger 0109 shipped clauses (a)/(c) on) — rejects an INSERT/UPDATE onto `position_roles`
     whose role's bundle contains any `ui_grantable=false` permission. Teeth-proven (trigger
     dropped ⇒ the same insert succeeds; restored ⇒ rejected again).
  3. Static catalog pins (`ui-grantable-catalog.test.ts`), each teeth-proven by mutating a clone.
- **Contract rule (binding):** flipping a key `false → true` is a PERMISSION-CONTRACT change
  requiring an owner decision line in the catalog entry, identical to a rename (§7 of this
  document's own frozen list). Flipping `true → false` is always a safe narrowing.

---

## 11. IAM Phase 2 (P2-06, 2026-08-18) — the first consumers of the Phase-2 kinds

P2-02 registered `employee`/`position`/`role_grant`/`it_account` with **no handler behind them**.
P2-06 built the first ones (`employees.controller.ts`), which turned two paper rules into live
decisions and surfaced two things worth recording.

### 11.1 `targetUserId` was an attribute no handler could send

`resource_position.yaml`'s self-assign DENY and `resource_role_grant.yaml`'s self-target DENY both
match `request.resource.attr.targetUserId`, but the TypeScript `Resource` type (`src/rbac/cerbos.ts`)
had no such field, and `resourcePayload()` therefore never sent one. Every such DENY was
**structurally unreachable** — not because the policy was wrong, but because the only way to feed it
did not exist. Added in P2-06 (`targetUserId?: string`, defaulted to `""` like every other optional
attr, so the `has() && != ""` guards keep failing safe when a caller omits it).

**The general lesson, which has now cost this program twice** (`team_lead`'s `teamId`,
`report_document`'s `scope_id`, and now this): a rule that reads an attribute is only as real as the
narrowest layer able to carry it — policy, the `Resource` type, `resourcePayload()`, and the handler
all have to agree. When registering a kind ahead of its handler, say explicitly which attributes do
not yet have a transport.

### 11.2 HR cannot place, move, or terminate anyone — by policy, and it contradicts design §5.1

`resource_position.yaml` grants `assign`/`unassign` to **`company_admin` and `org_unit_lead` only**.
`hr_people_ops` is absent, which matches design §4.1 ("HR creates/retires positions; dept head
assigns within their subtree") and §6.2 — but design §5.1 describes the joiner as "HR (hr_manager /
company_admin) creates the employee … if `positionId` is given … open the position assignment", and
§5.2/§5.3 present transfer and terminate as HR endpoints.

**What shipped honours Cerbos** (the authority per the program's own non-negotiables): `hr_manager`
gets 201 on a record-only hire and **403** on the placement half, on transfer, and on terminate. Both
directions are pinned in `employees-jml.test.ts`, so widening this later is a visible decision.

**Owner call needed** — either (a) give `hr_people_ops` `assign`/`unassign` (HR runs JML end to end,
dept heads keep their subtree rule), or (b) keep the split and correct design §5.1's text so the HR
console (P2-10) is built with the placement fields gated on `position.assign` reach. Recommendation:
**(a)** — an HR manager who cannot complete a hire they started will be handed `company_admin`
instead, which is the larger grant and the worse outcome.

### 11.3 Unchanged by this ticket

No permission key was added, no bundle moved, no `perm_*` arm wired. The four Phase-2 kinds remain
role-arm-only and permanently-unwired in the rollout register (§9).
