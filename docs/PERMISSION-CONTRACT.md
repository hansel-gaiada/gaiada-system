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

> **⚠ `group_executive` NO LONGER EXISTS (IAM-15 / D-7, 2026-08-23).** Every mention of it below is
> HISTORICAL and describes the contract as it stood before that removal. The role's 54 Cerbos rules,
> its derived role, its 134-key bundle, its `role_permissions` rows and the role row itself are all
> gone, and a migration revokes every grant. The counts and role tables further down are therefore
> stale for this one role and are deliberately NOT rewritten — this document is a dated freeze that
> other departments build against, and silently editing history would make the freeze unreadable.
>
> What replaced it, and what did not:
> * **Holding-wide business oversight → `owner`** (IAM-14 / D-8), granted PER OWNED COMPANY rather
>   than globally. That is the substance of D-7: "the last unrestricted cross-company business role"
>   is gone, and the person who owns the companies holds authority over them explicitly.
> * **Nothing replaced it for a non-owner.** An employee who needs cross-company reach now needs a
>   grant in each company. That is a real narrowing and it is the intended one.
> * **`platform_admin` is untouched** and remains the highest role in the system.

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

**✅ RULED BY THE OWNER, 2026-08-18: option (a).** `hr_people_ops` now holds `core.position.assign`
and `.unassign` (`resource_position.yaml`, migration `0112`), so HR runs joiner/mover/leaver end to
end and dept heads keep their own subtree rule unchanged. `hr_staff` is deliberately NOT included —
`hr_people_ops` resolves to `hr_manager` alone (the ACTING tier), and both directions are pinned in
`employees-jml.test.ts` and `client-member-delete-denied.test.ts`.

The owner also chose the stricter long-term shape: **a dept head's assignment should become a
REQUEST that HR/company_admin approves.** That half is NOT built — it needs the same approval
plumbing as §12.3's override. **✅ DONE 2026-08-19.** A dept head's `POST /positions/:id/assign` now
returns `assignment_request_required` naming `POST /positions/:id/assignment-requests`; that files an
`automation_approvals` row (`origin='iam'`, `workflow_id='iam:position_assign'`) decided by the SAME
`decide_override` action, through the SAME inbox, executed by the SAME seam
(`admin/iam-approval-execute.ts`). HR and company_admin are unaffected — they still place people
directly, which is what the 2026-08-18 widening was for.

**How "dept head" is detected without a second rule:** Cerbos is asked the same question with EMPTY
ancestry. Only the tenant-wide tiers can pass that, because `org_unit_lead`'s rule matches on subtree
containment — so a caller who needed their ancestry to get here is a lead. No new role check, no list
of who counts as a dept head, nothing to drift.

**What the flip did NOT change:** a lead's subtree bound (outside it is still 403 — asserted on the
REQUEST endpoint too, because a request path that accepted what the write path refuses would be the
hole), the self-assign DENY, and the fact that nobody approves their own request. A stale request
against a position retired in the meantime is refused at execution rather than applied.

### 11.3 Unchanged by this ticket

No permission key was added, no bundle moved, no `perm_*` arm wired. The four Phase-2 kinds remain
role-arm-only and permanently-unwired in the rollout register (§9).

---

## 12. IAM Phase 2 (P2-08/P2-09, 2026-08-18) — the ceiling, the sensitive gate, and two open items

### 12.1 The ceiling now subtracts the BASELINE role's bundle — a change to a shipped invariant

§6.3.2's ceiling ("the granted role's bundle must be a subset of the grantor's own resolved
permissions") **could not pass `company_admin` granting `member`**. The three blocking keys —
`hr.case.cancel`, `reports.appraisal.ack`, `reports.checkin.submit` — are in `member`'s bundle because
`member` has SELF-SERVICE rules for them, and absent from `company_admin`'s because nobody cancels
another person's HR case. A plain subset test therefore forbids granting the baseline role to anyone,
from any surface, forever.

`assertWithinCeiling()` now computes `bundle(role) − bundle(global 'member')`. Justification: `member`
is one of the six baseline roles every staff principal holds (`0095`), so nothing in its bundle is
authority a grant can ADD; everything above baseline still must be held by the grantor.

⚠ **RULED BY THE OWNER, 2026-08-18: replace the baseline subtraction with a CATALOG MARKER.** A
per-key marker distinguishing self-scoped keys (`hr.case.cancel` — cancel *my own* case) from
authority-over-others keys is the precise form; the baseline subtraction is a proxy that happens to
work today and would silently widen every grantor's reach if `member`'s bundle ever grew.

**✅ THE MARKER SHIPPED, 2026-08-19 — and it did NOT subsume the baseline.** `role_permissions
.self_scoped` (migration `0114`) marks a (role, key) pair when EVERY Cerbos ALLOW rule granting that
key to that role is self-scoped (`resource.attr.X == principal.id`, or `variables.owns`). It is
**derived**, not hand-listed: `scripts/generate-role-bundles.mjs::computeSelfScoped` uses the predicate
copied verbatim from the hazard scan's Pattern-B check, emits it into `role-permission-bundles.json`,
and `self-scoped-marker-parity.db.test.ts` fails if policies, JSON and DB disagree. 21 pairs today
(member 17, viewer 4).

⚠ **The correction the ruling did not anticipate, measured before committing to it.** The marker
replaces the subtraction on the REQUIRED side only. With marker-only:

| grant | required | missing |
|---|---:|---:|
| `company_admin` → `member` | 55 | 0 |
| `org_unit_lead` → `member` | 55 | **55** |
| `hr_manager` → `hr_staff` | 15 | **1** (`core.member.read`) |

i.e. marker-only re-breaks the dept-head surface. The two rules answer different questions and both
are needed: **the marker** asks "is this key authority over OTHER people?" (required side), **the
baseline** asks "does the target already hold this by being staff at all?" (now the HELD side — a
grantor is themselves staff, so passing on baseline reach confers nothing new). Putting the baseline on
the held side also keeps the refusal message truthful: a missing key is now genuinely one the grantor
lacks, not one the algebra hid.

**Why the marker is still the better mechanism**, even though it did not remove the second rule: both
`hr.case.cancel` and `core.client.delete` sat in `member`'s bundle, the subtraction removed both, and
only the first was self-service — the second was real tenant-wide reach and a live over-grant (§12.5).
A subtraction cannot tell those apart. The marker can, and pins `core.client.delete` as never-marked.

**The `core.integration_connection.*` case is the worked example of why the marker is better:** those
three keys sit in `member`'s bundle from an `owns`-gated self-service rule (manage your own provider
link), so the baseline subtraction and the marker agree. `core.client.delete` also sat in that bundle
— and there the reach was REAL, not self-scoped (see §12.5). A subtraction cannot tell those two apart;
a marker can.

### 12.2 The sensitive gate (§6.3.7) applies the SAME two rules — and its data is now ratified

The baseline `member` role carries **11 `sensitive`-flagged keys**, so an unsubtracted gate routes the
baseline grant (and everything above it) as an override — refusing the entire dept-head surface. Same
subtraction applied in `role-grants.controller.ts`.

**✅ REVIEWED BY THE OWNER, 2026-08-18** — the full list is
`docs/superpowers/plans/2026-08-18-sensitivity-review.md`, grouped by domain and marking every key
that sits in the baseline bundle. Ruling: **a READ is not sensitive authority**, with `hr.record.read`
the sole exception (bulk personal data). Seven keys were un-flagged — `core.contract.read`,
`core.identity_link.read`, `core.rollup.read`, `core.role_grant.read`, `billing.invoice.read`,
`it.account.read`, `hr.case.read` — taking the catalog from **107 to 100** flagged (`0112`). Two
permission groups (`invoices_view`, `rollups`) lost their derived `sensitive` flag as a mechanical
consequence, and both `_meta` counts were re-derived rather than hand-edited.

Rationale: flagging reads meant any role that can *view* contracts, invoices, identity links or
dashboards routed as an override. (When that was written, "routes as an override" meant "is refused";
§12.3's mechanism now exists, so the phrase means what it says — but the ruling stands on its own
merits: an approval step for reading a dashboard is friction without a safety benefit.) The override path stays reserved for authority that CHANGES something.

### 12.3 ~~`decide_override` does not exist~~ — SHIPPED 2026-08-19 (P2-08 part B)

§6.5's routed override is built. `core.role_grant.decide_override` →
(`automation_approval`, `decide_override`), migration `0115`, held by `platform_admin`,
`company_admin`, `group_executive`, `hr_manager`.

**The flow:** `POST /api/:t/role-grants/overrides` (requester needs `role_grant · create` on the
target, so an override is never a way around the SUBTREE bound — only past the sensitivity bound) files
an `automation_approvals` row with `origin='iam'`, `workflow_id='iam:override'`. The routed approver
decides it through the EXISTING inbox — one route, no fork: `automation-approvals.controller.ts` picks
the Cerbos action from `origin` + `workflow_id`, exactly as it already does for `hr:leave`. An
approving decision **executes in-band** through the grant choke point, tagged `expires_at` +
`origin_approval_id`, and bumps the target's session.

**Routing is code this wave** (`role-grants.controller.ts::routeFor`, design §6.5; the configurable
table is IAM-22): a role carrying above-baseline `hr.*`-sensitive keys routes to `hr_manager`,
everything else to `company_admin`. Cerbos holds the OUTER bound (the union of routable approvers);
the router holds the inner one, because "the approver this row was routed to" is a fact about a row,
not about a role.

**Requester ≠ decider is a structural Cerbos DENY** on `decide_override`, `roles: ["user"]`,
deny-overrides — so it beats platform_admin's wildcard, and it holds even if a future controller
forgets it. It fails CLOSED on an unresolvable requester: an override with an unknown author is exactly
the one nobody should be able to rubber-stamp.

**The routing map earns its keep, demonstrated by a test that first failed:** a `company_admin` cannot
grant `hr_manager` at all — it lacks `reports.appraisal.confirm_evidence/cycle_admin/finalize`, which
are `hr_people_ops`-only. The ceiling refuses them correctly, which is precisely why hr-sensitive
overrides route to the HR tier instead. The ceiling is enforced at EXECUTION against the DECIDER, never
the requester: the approver's authority is what backs an override.

**Still open:** `automation_approvals.origin` had to be widened to admit `'iam'` (`0115`, following
`0028`'s drop-and-re-add precedent — Postgres cannot ALTER a CHECK in place). And the dept-head assign
→ REQUEST flip (§11.2's owner end-state) is now unblocked but NOT yet done.

### 12.4 `expires_at` is now enforced at RESOLUTION, and swept afterwards

`user_roles.expires_at` has existed since `0109` and, until P2-08, **no writer set it**. P2-08 writes it,
P2-09 sweeps it (revoke + session bump + `role_grant.expired` audit event), and — because a sweep alone
left an expired grant **fully live for up to a whole sweep interval** — `assemblePrincipal()` now
carries the conjunct `(expires_at IS NULL OR expires_at > now())` on BOTH its role and permission
resolution queries.

So the order of enforcement is: the resolver makes the expiry take effect at the next request; the sweep
removes the row, cuts the session and files the audit event. `NULL` means permanent, which is every
pre-P2-08 row, so the conjunct is a no-op for existing grants. This is a deliberate TIGHTENING of a hot
path (`assemblePrincipal()` runs per request) — the direction is fail-closed, and it sits beside
IAM-SEC-06's resolution-source filter, which is the other conjunct that decides what a grant is allowed
to resolve into.

### 12.5 🔴 A live over-grant the sensitivity review found: `member` could delete any client

Not a Phase-2 defect — it predates this work and was deployed. `core.client.delete` appeared in the
BASELINE `member` bundle, which prompted a live probe: a principal whose only grant was
`member @ company` got **EFFECT_ALLOW on client create/update/delete**, tenant-wide.
`resource_client.yaml` carried a second rule naming `member` for all three actions, gated on nothing
but `inTenant && notLow` — no `owns` — and `clients.controller.ts:80` passes no ownership attribute
that could narrow it. Every staff member could remove any client in their company. Soft-delete,
audited, recoverable; still real reach over a core business entity.

**Owner ruled 2026-08-18: `member` keeps create/update, loses `delete`.** Rationale: agency staff
plausibly onboard and edit clients as ordinary work; nobody plausibly needs every staffer able to
remove one. `resource_client.yaml` amended, bundle row dropped (`0112`), and
`src/rbac/client-member-delete-denied.test.ts` probes the live engine in both directions — including
that `manager`/`company_admin` can *still* delete, so the narrowing did not over-correct.

**The transferable lesson:** the flag review was not the point — asking "why does the baseline role
hold a `delete` key?" was. A permission that is both *sensitive* and *held by everyone* is a
contradiction, and the resolution is sometimes that the FLAG is wrong (the seven reads) and sometimes
that the REACH is (this). Check which before adjusting either.

### 12.6 The IAM decision right is SPLIT in two (owner instruction, 2026-08-19)

`0115` shipped one action, `decide_override`, and `0117`'s dept-head flip made it decide two different
kinds of IAM exception. The owner instructed a split; `0118` delivers it.

| Catalog key | Cerbos action | Decides |
|---|---|---|
| `core.role_grant.decide_override` | `automation_approval:decide_override` | a routed request to grant a person a **ROLE** beyond their position |
| `core.position.decide_assignment` | `automation_approval:decide_assignment` | a department head's request to **PLACE** a person in a position |

**No behaviour changed on the day of the split, and that is worth stating rather than implying.** Both
actions are granted to the identical four tiers (`platform_admin`, `company_admin`, `group_executive`,
`hr_manager`), so nobody gained or lost the ability to decide anything. What the split buys:

1. **An honest description.** The override key said "grant a person authority beyond what their position
   confers", which read narrowly once placements rode it. A permission whose description is not what it
   does is a permission nobody can audit. `0118` also corrects that description in the DB.
2. **The ability to diverge.** One action cannot be narrowed for one request kind without narrowing the
   other. "A senior lead may approve placements but never role grants" is now expressible without a
   schema change.
3. **A truthful audit row.** The decision records WHICH kind of exception was approved.

**Each action carries its own requester ≠ decider DENY**, restated per action rather than shared: a DENY
that silently covered two actions would be one edit away from covering neither. Both also fail CLOSED on
an unresolvable requester. Pinned by live-engine probes in
`src/rbac/client-member-delete-denied.test.ts` (which has outgrown its filename — it is now the
live-probe suite for several owner decisions).

---

## 13. IAM Phase 2 (P2-15, 2026-08-19) — the backfill, and the two things it refuses to decide

`src/admin/iam-phase2-backfill.ts` + `npm run iam:backfill`. Four independent pieces, each opt-in by
flag; **dry run is the default and there is no flag that applies everything.**

### 13.1 What counts as staff — and why it is not "every membership"

Source: `company_memberships` where `kind = 'employee'` and `status = 'active'`. Two properties of that
table make it the right source, and neither is inferred:

* **Clients are structurally absent.** Migration 0072's header records the decision: `company_memberships`
  keeps its meaning as "staff and service accounts of this company", and the two places that genuinely
  need client contacts read `client_contacts` instead. The stated reason is exactly this hazard — "a
  client contact appearing in /people and the HR directory as an employee: a data-exposure bug that looks
  like ordinary data once it happens."
* **`kind` separates the bots.** Automation accounts hold real memberships on purpose (bots are `users`
  rows so authorization, audit and OBO work uniformly), and `seed/automation.ts` marks them
  `kind='service'`.

**A second wall exists anyway, because nothing ENFORCES the kind.** A bot inserted with the default
`kind='employee'` — by a future seeder, a fixture, a hand-written row — would otherwise receive a
person-shaped HR record. The backfill therefore also excludes any candidate carrying an `n8n` identity
link, and **names every exclusion in the report** so a reviewer can confirm the wall never fired on a
human. `whatsapp` links are explicitly not disqualifying: those are real people reaching the estate over
WhatsApp.

Two categories are **reported for review and neither created nor excluded**:

| Category | Why it is a question, not a rule |
|---|---|
| `@gaiada.system` address with no automation link | Including it puts a bot in HR; excluding it hides a real person. A script should not decide this quietly. |
| A `kind='employee'` membership whose user is also a client contact or a client's portal user | Should be impossible per 0072. A non-empty list is a pre-existing data defect, and the answer is a human looking at it — never an HR record for a client. |

`hire_date` is left NULL. The estate does not record when these people started, and `created_at` would
read as a hire date to every later report.

### 13.2 Position import is REPORT-ONLY, permanently

The report lists candidates derived from org-blob `role` nodes (the informal ancestor of a position).
**`applyTenantBackfill` never creates a position, and that is not a phase-1 limitation.** A blob role node
carries no role-set, so an imported seat would confer nothing and then look, to every later reader, like a
seat someone deliberately left empty. Pinned by a test that runs apply with every flag set and asserts the
`positions` row count is unchanged while the candidate list is non-empty.

### 13.3 Assignments are derived only where UNAMBIGUOUS

`org_unit_memberships` (open rows) → `position_assignments`, and **only** when the unit has exactly one
active position. Zero and many are both reported, never guessed: picking "the first" would seat someone
into a role-set nobody chose for them, and a wrong seat grants a wrong role — the top hazard in this
program's risk table.

`valid_from` is **today**, never back-dated to the membership: back-dating asserts the person held that
seat, and its roles, during a period nobody verified. `assigned_by` is NULL because no human assigned it;
the `reason` string carries the provenance instead.

### 13.4 Adoption re-labels and NEVER widens — enforced as an abort

Adoption re-tags a hand-made `user_roles` row as `managed_by_position` and adds one
`position_grant_claims` row **per justifying seat** (A2 refcounting — without the full set, a person
holding two seats that both confer the role loses the grant when the first seat closes).

**The invariant:** `user_roles`' row count is read before and after **inside the writing transaction**, and
a difference raises `AdoptionWidenedAccessError`, which rolls the whole run back. It is an abort rather
than a log line because the failure it guards is "someone silently gained access during a maintenance
run". The count is GLOBAL, not tenant-scoped: `user_roles` has no tenant column, and a tenant-filtered
count would miss a row written with the wrong scope — exactly the mistake that matters. Proven by a test
that plants a row inside the apply transaction via a trigger and asserts both the throw and the rollback.

**There is no second matcher.** "A grant that exactly matches what this seat would confer" is already
implemented once, in `position-reconciler.ts` (`collectDesired` + `classifyExisting`), and its
`skip_manual` verdict IS the adoption candidate list. A second matcher here could adopt a row the
reconciler would never manage.

**A user FROZEN by an orphaned seat (A16) is skipped entirely** — the reconciler refuses to reason about
such a user, and the backfill does not reason further than the engine that will own the result.

### 13.5 Operator guardrails

* `--all-tenants` is dry-run only and **refuses** to combine with any apply flag; apply targets exactly
  one tenant per run.
* An unknown flag is a hard error, not an ignored token: a typo'd `--adoptions` that silently ran a dry
  run would read, to the operator, as "adoption did nothing".
* Every apply prints the before/after `user_roles` count, so the claim the run is making is visible
  rather than trusted from an exit code.

---

## 14. The four direct IAM writes become agent-reachable (owner decision, 2026-08-20)

`iam.grantRole` · `iam.revokeRoleGrant` · `iam.assignPosition` · `iam.unassignPosition` are declared in
`src/core/core-tools.ts`, each with a D14 executable-approval entry
(`registerIamExecutableApprovals`) and each named in `resource_mcp_tool.yaml`'s executable allow-list.

### 14.1 What the decision rested on, and why that matters

§13 and `core-tools.ts` previously withheld these, and the objection was **not** "no executor exists" —
it was that a role-granting tool is a privilege-escalation surface while this estate's audit attribution
still records *"Alice"* rather than *"Alice's agent"* ([agent-attribution-gate]).

The owner ruled to proceed on the basis that **every employee on the estate is seed/mock data except
their own account**. That was verified against the live database before shipping, not taken on trust:

| Category | Count | Note |
|---|---|---|
| `kind='employee'` memberships | 23 | all `.test` addresses except the two below |
| `hansel@gaiada.com` | 2 (both companies) | the ONLY account with a verified login |
| `@gaiada.com`, no login | 1 | real-looking address, cannot authenticate |
| `kind='service'` (bots) | 17 | correctly kinded — none appeared as an employee |

🔴 **THE BASIS EXPIRES WHEN THE DATA DOES.** The attribution gap is unchanged. At the moment real
employee accounts exist, these four are a genuine escalation surface with an audit trail that cannot say
who used them. **Closing [agent-attribution-gate] is therefore a hard pre-staging requirement**, not a
nice-to-have, and the code comments say so at both sites. Read this section as the objection being
*outranked by a fact about the data*, never as the objection being answered.

### 14.2 What still bounds these, independently of the decision

Nothing below was relaxed, and none of it depends on the data being mock:

* the executor re-drives as the **original filing principal**, so an agent can never exceed what the
  human behind it holds (`approval-execute.ts` invariant 1);
* `GrantWriteService` remains the only writer of `user_roles`, so the ceiling arithmetic, the
  `ui_grantable` allow-list, the sensitive gate and the self-target DENY all still apply;
* Cerbos still decides `role_grant · create/revoke` and `position · assign/unassign`;
* all four are medium/high writes, so every one **suspends for a human decision** ⚠ — see §15: this was
  TRUE for n8n and FALSE for an agent when §14 shipped, because the impact gate was keyed on
  `isAutomation` (n8n only). Fixed 2026-08-20; the claim now holds as written. What these entries
  add is that the approval, once given, actually completes instead of landing `not_applicable`.

### 14.3 Impact tiers, and the one structural argument

| Tool | Impact | Why |
|---|---|---|
| `iam.grantRole` | **high** | the only one that can WIDEN authority |
| `iam.revokeRoleGrant` | medium | taking access away cannot escalate anyone; it can still break a day |
| `iam.assignPosition` | medium | **structural**: a placement can only confer what the seat's role-set already carries, and that role-set was authored by a human through a surface with its own allow-list. The escalation ceiling is the position registry. |
| `iam.unassignPosition` | medium | removal only |

Impact drives urgency and the notification tier, **not** whether a human is asked — medium and high both
suspend.

### 14.4 The preconditions, and the one that is a security property

Each entry detects a first attempt that already landed, which is what makes auto-retry safe (none sets
`neverAutoRetry`):

| Tool | Landed / stale detection |
|---|---|
| `grantRole` | `grant_already_exists` — the exact (user, role, scope) triple. The same role at a different scope is a different artifact and stays grantable. |
| `revokeRoleGrant` | `grant_not_found`, plus 🔴 **`managed_by_position_not_revocable`** |
| `assignPosition` | `already_assigned`; `position_not_active` for retired **and orphaned** seats |
| `unassignPosition` | `not_assigned` |

🔴 **`managed_by_position_not_revocable` is a security property, not housekeeping.** The reconciler would
restore a position-managed grant on its next pass, so an approval that "succeeded" would leave the access
standing while a human believed they had removed it. Refusing names the real fix — change the position.

**`position_not_active` covers `orphaned` deliberately.** An orphaned seat's unit is gone from the org
chart, so the reconciler has FROZEN grants there; placing someone into it would inherit that frozen state
rather than conferring access, and the approval would appear to work and change nothing.

**No `preconditionModules`.** Every table these read is core (`user_roles` is global outright), unlike
JML's `employees` which sits behind the HR module's third wall. Cargo-culting `["hr"]` here would be
harmless but would tell a reader something false about where these tables live.

### 14.5 A contract widening this required

`McpToolDef.method` gained `DELETE` (and `mcp-hub`'s mirroring `RemoteToolDef.method` with it), because
`iam.revokeRoleGrant`'s endpoint is a real DELETE. The hub needed no behavioural change — `callPlatform`
already passed `def.method` straight to `fetch`, so the transport always supported it and only the two
type declarations were narrower than reality. A def arriving over the wire is `JSON.parse`d, so the old
type never rejected anything at runtime; it just described it wrongly.

---

## 15. 🔴 CORRECTION to §14, and the two defects behind it (2026-08-20)

§14 claimed, of the four direct IAM writes: *"all four are medium/high writes, so every one **suspends
for a human decision**"*. **That was true for n8n and FALSE for an agent** at the moment §14 shipped.
Both halves of [agent-attribution-gate] are now fixed; this section records what was wrong and why it
was easy to state confidently.

### 15.1 The impact gate never fired for an agent

`mcp-hub`'s `isAutomation(provider)` is literally `provider === "n8n"`, and the medium/high suspend
branch sat **inside** it — in the in-code engine *and* in `resource_mcp_tool.yaml`'s impact conjunct.

`runAgent` sends the requesting **human's** OBO envelope verbatim, deliberately, so an agent can never
act with more authority than the person it serves. The unfollowed consequence: an agent-driven call
arrived as `provider: "whatsapp"`, `isAutomation` was false, and the whole conjunct short-circuited to
ALLOW. So an n8n workflow calling a high-impact write suspended for approval, and **an agent calling the
same tool ran it unattended** — the tier protection was unenforceable against precisely the caller D14
exists for.

**Fixed by splitting the two conjuncts**, because they were never the same question:

| Conjunct | Predicate | Why |
|---|---|---|
| workflow scope | `isAutomation` (n8n only) | a `wf:*` allow-list lookup; an agent has no workflow id, so applying it would deny every agent read for a reason that was never about agents |
| **impact gate** | **`isUnattended`** = n8n **OR** agent-driven | attendance, not identity. A human on an interactive surface is attended by definition and does not approve their own click |

Fixed in **both** engines. Fixing only the in-code fallback would have left the live deployment open,
because Cerbos is authoritative whenever `CERBOS_URL` is set — the hole actually lived in the policy
file. The hub now sends `isUnattended` and `agent` as principal attributes; `isAutomation` is kept, and
still means only n8n.

Proven red-then-green: reverting `isUnattended` to the old predicate fails 5 of the 17 cases in
`mcp-hub/src/agent-impact-gate.test.ts`, including *"an agent calling a HIGH-impact write SUSPENDS"*.

### 15.2 Every audit row named the human alone

`Principal` (platform) carried `userId · assurance · companies · roles · sessionVersion` and **nothing
about the channel**, so the information had nowhere to live. Every `activities` row recorded "Alice did
X" when the truth was "Alice's agent did X", unrecoverably.

Implemented as the owner's `Co-Authored-By` framing — **author = the human, co-author = the agent,
recorded alongside and never instead**, which makes it additive and authorization-neutral: nothing in
`can()`/Cerbos reads it, so no policy needed re-reasoning.

The chain, end to end:

1. `runAgent` stamps `agent: "agent:<def.name>"` onto the envelope **from the agent's own definition** —
   not from callers, who correctly pass the human's envelope and would forget.
2. `ai-agents` sends `x-obo-agent`; the hub's `mintPrincipal` carries it onto `Principal.agent`.
3. `mcp-hub/src/obo-headers.ts` is now the ONE place the outbound envelope is built — it replaced 14
   hand-built header objects across 8 files, because adding a header to 14 sites guarantees the 15th
   omits it and silently drops attribution for whichever tool group comes next.
4. The platform's `AuthGuard` reads `x-obo-agent` into `Principal.via` **and** into request context.
5. `writeActivity` stamps `metadata.via`. **`actor_id` still names the human.**

**Why ambient (`AsyncLocalStorage`) and not a seventh parameter:** `writeActivity` has **263 call
sites**, 229 of which pass `req.principal.userId` and nothing else. Threading it would have been ~229
mechanical edits *and* would have made attribution opt-in — and the failure mode of an opt-in audit
field is that the site somebody forgets is the site that mattered, with nothing failing when they
forget. Same idiom, same reasoning as the search module's `withActualCostCapture`.

**Fail-silent by design:** outside a request scope (a sweep, a consumer, the D14 executor) `via` is
absent and the row is written exactly as it always was. A caller's own `metadata.via` wins, because the
executor re-driving an approved write knows the *original* filing channel — better provenance than the
channel of the retry.

### 15.3 What this does and does not settle

**Does:** an agent-driven medium/high write now suspends, and every attributable write says which agent
drove it. §14's claim is now true as written.

**Does not:** this is step 1 of 2. Step 2 — a real persona per department with its own `users` row, roles
and lifecycle — depends on the `users.kind` migration and is not built. `via.agent` is a string the
first-party caller asserts; it is trustworthy because that block already requires the service token and
because the value is authorization-neutral (a lie gains nothing and incriminates an agent that did not
act), but it is not yet an identity Cerbos can authorize as itself.

**The staging gate therefore stands, narrowed:** the four direct tools are now gated and attributed, so
the remaining pre-staging requirement is the persona work, not the attribution hole.

## 16. `member` may raise a PM task (owner decision, 2026-08-24)

Same family as §12.5, in the opposite direction. §12.5 asked "why does the baseline role hold a
`delete` key?" and narrowed. This asks "why does the baseline role NOT hold a `create` key?" and
widens — and both questions were answered by probing the live engine, not by reading a bundle.

### 16.1 The finding

An adversarial probe of the agency vertical reported that an ordinary employee cannot raise a task.
Half right, and the half that was wrong matters: `member` already holds `core.task.create`, and
`resource_task.yaml` allows it under `inTenant && notLow`. What was closed is the **PM module**
surface — `resource_pm_task.yaml` bundled `create` into one rule with `delete` and `manage`, naming
only `company_admin`/`manager`. Of 19 seeded staff, 5 hold `manager` (one lead per department, by
`seed:roster-access`'s `MANAGER_LEVELS`), so 14 could not file work against the board their own
department runs on.

The escape hatch that made this survivable also made it invisible: the general `/tasks` UI posts to
the CORE endpoint, which `member` may call. But that door is a stub —
`core.controller.ts`'s `POST :tenantId/projects/:projectId/tasks` accepts only `title` +
`customFields`, sets no assignee/status/due date, fires no notification, and has **no PATCH sibling
at all** (the UI carries a comment saying so). An employee could create a task they could then never
assign, schedule, or update. Both doors write the same `tasks` table, so this read as "tasks work"
right up until someone tried to do anything with one.

### 16.2 The decision

**`member` gains `pm.task.create` and nothing else.** `resource_pm_task.yaml`'s
`["create","delete","manage"]` rule is split: `create` names `company_admin`/`manager`/`member`;
`delete` and `manage` are byte-for-byte unchanged and stay leads/admins. `manage` is the
load-bearing half — it gates every ownership change on `patchTask` and every tracker-suggestion
confirm.

Mirror: `202608241615_iam_member_pm_task_create.sql` (one row, the 0094/0098/0099 idiom, with a
row-count assertion so a missed join cannot pass as a no-op). `role-permission-bundles.json`
regenerated from the policy — `member` 72 → 73 pairs.

### 16.3 ⚠ The grant alone would have been the WRONG decision

`createTask` authorizes `create` and then applies the payload's `assignee` verbatim, notifying the
person named. So opening `create` would also have meant *"any employee may put work on any
colleague's plate"* — a different decision, and not the one made.

`pm.controller.ts`'s create handler therefore demands `manage` when the payload names a responsible
other than the caller. Raising unassigned, or self-assigning, needs only `create`; naming anyone else
— or a department/division, where the responsible is by definition someone else — needs `manage`.
This mirrors `patchTask`'s existing ownership-change check deliberately: the two paths reach the same
JSONB blob and the same `pm_task_assignees` dual-write, and one being more lenient than the other is
exactly how a gap gets found later by someone routing a create through the weaker door.

**If that guard is ever removed, the migration's one row silently becomes the wider grant.**

### 16.4 Proven, not assumed

Cerbos was restarted (it does not hot-reload) and probed directly. With a single
`member @ company` grant on `pm_task`: `create` → `EFFECT_ALLOW`, `update` → `EFFECT_ALLOW`,
`manage` → `EFFECT_DENY`, `delete` → `EFFECT_DENY`. The role arm carries no `inRoot` conjunct, so
the §12-era anchoring hazard does not apply to this grant — unlike the permission arm's
`perm_pm_task_create` rule, which is unchanged and still root-bounded.

### 16.5 The transferable lesson

A capability can be "present" and still not exist. `member` held a task-create permission, a task
create endpoint answered 201, and the department's actual task surface was still closed to 14 of 19
people. Neither the bundle nor a route inventory would have shown that — only asking whether the
work an employee is expected to do can actually be done end to end.

---

## 17. Finance & Accounting F0 — 3 new kinds, 13 keys, role-arm only (2026-08-24)

Design: [`docs/blueprints/finance-accounting-foundation.md`](blueprints/finance-accounting-foundation.md).
Tracker: [`docs/plans/2026-08-24-finance-PROGRESS.md`](plans/2026-08-24-finance-PROGRESS.md).
Landed by `202608241014_iam_finance_f0_permissions.sql`.

### 17.1 The kinds

| Cerbos kind | Governs | Actions |
|---|---|---|
| `finance_config` | The accounting VOCABULARY — chart of accounts, dimensions, fiscal calendar structure, currencies, exchange rates, company accounting settings | `read` `create` `update` `delete` |
| `finance_period` | The CLOSE LIFECYCLE — the `OPEN → SOFT_LOCK → HARD_LOCK` state machine | `read` `lock` `reopen` `close` |
| `finance_control` | GOVERNANCE — the segregation-of-duties matrix, cross-company elevation grants, the finance access log | `read` `assign_duty` `waive_conflict` `grant_access` `revoke_access` |

**The split follows segregation-of-duties lines, not code layout.** Closing a period is the
`period_close` duty (control function AUTHORISE); editing the chart of accounts is RECORD. The
blueprint's matrix (§2.2) forbids one person holding `journal_post` + `period_close`, and that is
only expressible if closing is separately grantable. Folded into one `finance` kind, every
accountant who could add an account could also declare the year final.

### 17.2 Holders

| Role | Reach |
|---|---|
| `finance_staff` | `finance.config.read`, `finance.period.read` — **only these two.** Reads the vocabulary and the calendar so documents can be coded. Cannot see the duty matrix at all. |
| `finance_manager` (the controller) | All of `finance_config`, all of `finance_period`, and `finance.control.read` — **none of `finance_control`'s writes.** The controller runs the books; they do not decide who else may reach them. |
| `company_admin` | All of `finance_config`, all of `finance_control`, `finance.period.read/lock/close` — **but NOT `finance.period.reopen`.** Soft-locking is administrative; reversing the accountant's lock is an accounting judgement. |
| `owner` | All 13 keys (permission-native role, no Cerbos rules). |
| `member` `viewer` `manager` `org_unit_lead` `client` | **Nothing.** Unlike the HR kinds, finance has no self-service surface — there is no "your own" general ledger. |

### 17.3 Assurance tiers

`finance_config` writes and all reads sit at `notLow`. Everything that widens reach over money is
D4 `assurance == "high"`: `finance.period.close` (irreversible — it asserts the figures are final)
and **every** `finance_control` write.

### 17.4 Two things this contract does NOT decide

1. **WHICH COMPANIES a principal may see.** That is resolved by the ownership graph in
   `202608241010_finance_ownership_and_scope.sql` (owner ruling D-F8): a holding owner reaches
   subsidiaries because they own them, not because of a bundle row. Both mechanisms must pass.
2. **Whether a period may be hard-locked.** Cerbos answers "may this principal attempt to close";
   the database answers "is this period in a state that may be closed" — `FINANCE_PERIOD_UNSIGNED`
   refuses a HARD_LOCK with no named accountant sign-off (ruling D-F5). Authorization and data
   invariants are kept in separate places on purpose.

### 17.5 ROLE-ARM ONLY — no `perm_*` mirror, for any of the three

Same posture as `resource_employee.yaml` (P2-02) and `resource_hr_payroll.yaml` (HR-FULL), with two
independent reasons: **F0 is schema only** (no handlers exist yet, so a mirror would grant reach to
an unservable surface), and **`finance_control` cannot be mirrored safely even later** — `attr.perms`
carries no record of which rule a key came through, so a mirrored `assign_duty` would collapse "in a
company you are staffed to" into an unconditional grant over the duty matrix itself. Same
granularity gap `resource_hr_case.yaml` documents for `hr.case.read`.

---

## 18. Finance F1 — the ledger kind (2026-08-24)

Landed by `202608241016_iam_finance_f1_ledger_permissions.sql` alongside the ledger schema in
`202608241015`. One new kind, `finance_ledger`, 4 keys. Extends §17.

| Action | Meaning | Holders |
|---|---|---|
| `read` | See journal entries and lines | `finance_staff`, `finance_manager`, `company_admin` |
| `verify` | Run the chain integrity check | `finance_staff`, `finance_manager`, `company_admin` |
| `post` | Create a journal | **`finance_manager` only** |
| `reverse` | Correct one by posting its mirror | **`finance_manager` only** |

**There is no `update` and no `delete`, and that absence is the contract.** A posted journal cannot
be edited or removed — `FINANCE_LEDGER_IMMUTABLE` refuses both at the trigger for every principal,
including a platform admin acting through psql. Cataloguing those actions would advertise an
operation that can never succeed.

**`verify` is the one finance key that is not `sensitive`.** It returns problems, not figures, and
its entire value is that anyone can run it — an integrity check runnable only by the person who
could have broken the chain is not an integrity check.

**Why `company_admin` reads but does not post.** Because it is a platform-ADMINISTRATIVE role and
creating entries in the book of record is accounting work — the same ground as its exclusion from
`finance.period.reopen` in §17.

⚠ **This is NOT a segregation-of-duties argument, and the distinction is load-bearing.** An earlier
draft of the policy header claimed it was, and that claim does not survive the generated bundle:
`finance_manager` holds BOTH `finance.ledger.post` and `finance.period.close`, because closing the
books is the controller's job. **Segregation of duties binds per company, per PERSON, through
`finance_duty_assignments` + `finance_sod_check()` — never through role bundles.** That is precisely
what lets a real conflict be waived deliberately, with a named compensating control recorded against
it, instead of being either impossible (so people work around it) or invisible (so nobody knows).
If a future change tries to enforce SoD by withholding a role key, re-read this paragraph first.

---

## 19. Finance F3 — the statement kind (2026-08-24)

Landed by `202608241018_iam_finance_f3_statement_permissions.sql` alongside the reporting functions
in `202608241017`. One kind, `finance_statement`, 2 keys. Extends §17–§18.

| Action | Holders | Assurance |
|---|---|---|
| `read` | `finance_staff`, `finance_manager`, `company_admin` | `notLow` |
| `export` | `finance_manager`, `company_admin` | **D4 `high`** |

**There is no write action.** A statement is derived from the ledger — if a figure is wrong, the
ledger is wrong and is corrected there by reversal. A `finance.statement.update` would imply a
statement can be adjusted independently of the entries behind it, which is the practice double-entry
bookkeeping exists to prevent.

**`export` is separated from `read` deliberately.** Reading a P&L on screen and producing a signed
file for a bank are different acts: the export outlives the session, carries no access control once
it exists, and is what a lender decides on. §10.4 of the blueprint has banks and the tax office
receiving a sealed package rather than a login — this is the action that produces it.

**Statement `read` is wider than ledger `read`.** A statement is an aggregate; someone who should
see departmental cost totals does not thereby need every journal line behind them. Both sit with
`finance_staff` today, but the ordering is deliberate and should not be tidied into one tier.

---

## 20. Finance F4 — the receivables subledger (2026-08-24)

`202608241020_iam_finance_f4_ar_permissions.sql` alongside the AR schema in `202608241019`.
One kind, `finance_ar`, 6 keys. The actions map onto **SoD duties, not CRUD**.

| Action | `finance_staff` | `finance_manager` | `company_admin` | Assurance |
|---|:--:|:--:|:--:|---|
| `read` · `reconcile` | ✅ | ✅ | ✅ | `notLow` |
| `manage` (customers, drafts) | ✅ | ✅ | ✅ | `notLow` |
| `issue` · `receipt` | ✅ | ✅ | — | `notLow` |
| `write_off` | **—** | ✅ | ✅ | **D4 `high`** |

**Why `receipt` and `write_off` are separate rights.** `202608241013` seeds
`ar_receipt_posting` + `ar_writeoff_approve` as a BLOCKING conflict — *"pocket the cash, then write
off the debt"*, the classic receivables fraud. It is only preventable if the two can be granted
apart, so `finance_staff` gets `receipt` and never `write_off`.

⚠ **Same caveat as §18, stated up front:** `finance_manager` holds both. That is not the control.
Role bundles grant **capability**; SoD binds per company, per **person**, via
`finance_duty_assignments` + `finance_sod_check()`. Splitting the actions is what gives the duty
matrix something to bind to.

**`company_admin` gets `write_off` but not `issue`/`receipt`.** Running the receivables desk is
bookkeeping; authorising the forgiveness of a debt is governance. The split follows that line.

**No `delete`.** An issued invoice is voided by reversing its journal — the ledger entry is
immutable, so removing the subledger row would break the subledger-to-GL tie.

---

## 21. Finance F5 — the payables subledger (2026-08-24)

`202608241022_iam_finance_f5_ap_permissions.sql` alongside the AP schema in `202608241021`.
One kind, `finance_ap`, 6 keys — **a finer split than `finance_ar`**, because AP carries two seeded
blocking conflicts and is where money actually leaves.

| Action | `finance_staff` | `finance_manager` | `company_admin` | Assurance |
|---|:--:|:--:|:--:|---|
| `read` / `reconcile` | yes | yes | yes | `notLow` |
| `bill_entry` | yes | yes | no | `notLow` |
| `vendor_master` | no | yes | yes | **D4 `high`** |
| `approve` | no | yes | yes | **D4 `high`** |
| `payment_release` | no | yes | **no** | **D4 `high`** |

**Two seeded conflicts drive the split** (blueprint 2.2, seeded by `202608241013`):
`vendor_master` + `ap_payment_release` (invent a vendor, pay yourself), and
`ap_bill_entry` + `ap_payment_approve` (approve your own invoice).

**Why `vendor_master` is its own right, when the AR customer equivalent is not.** Editing a vendor's
**bank details** is the highest-leverage fraud in payables: it needs no fake invoice at all, only a
redirected payment on a genuine one. An AR customer's bank details move no company money; a
vendor's do. The asymmetry between the two kinds is deliberate, not an inconsistency.

**`payment_release` is the narrowest grant in the finance module** - `finance_manager` only, high
assurance, and explicitly **not** `company_admin`. An administrative role may authorise a commitment
(`approve`); it should not be able to move cash.

---

## 22. Finance F6 — bank reconciliation (2026-08-24)

`202608241024_iam_finance_f6_bank_permissions.sql` alongside `202608241023`.
One kind, `finance_bank`, 4 keys: `read` · `reconcile` · `import` · `match`.

| Action | `finance_staff` | `finance_manager` | `company_admin` |
|---|:--:|:--:|:--:|
| `read` / `reconcile` | yes | yes | yes |
| `import` / `match` | yes | yes | **no** |

**The SoD pair is satisfied STRUCTURALLY here — a first for this module.** `202608241013` seeds
`bank_reconcile` + `cash_custody` as blocking: whoever can move money must not be the one who
declares the bank agrees. Across the tiers that now falls out by construction —

- `finance_staff` reconciles the bank and **cannot** release payments (§21 keeps
  `finance.ap.payment_release` at `finance_manager`, high assurance);
- `finance_manager` can do both, and needs a duty-matrix waiver if actually assigned both.

So the default staffing — an AR/AP officer who reconciles, a controller who releases — satisfies the
seeded pair with nobody configuring anything. Every earlier finance kind relied on the duty matrix
to *catch* the overlap; this one is arranged so it does not arise at the staff tier.

**Two actions deliberately do not exist.** There is no action that **edits a statement line** — the
statement is the bank's version of events, and if the bank is wrong the answer is a dispute plus a
correcting entry, never an edit that makes the two agree. And there is no **adjustment** action: an
unexplained difference *is* the finding, and a plug turns a real problem into a rounding line.

---

## 23. Finance F7 — tax and statutory (2026-08-24)

`202608241026_iam_finance_f7_tax_permissions.sql` alongside `202608241025`.
One kind, `finance_tax`, 4 keys.

| Action | `finance_staff` | `finance_manager` | `company_admin` | Assurance |
|---|:--:|:--:|:--:|---|
| `read` | yes | yes | yes | `notLow` |
| `prepare` | yes | yes | no | `notLow` |
| `configure` | no | yes | **no** | **D4 `high`** |
| `file` | no | yes | yes | **D4 `high`** |

**`file` is the highest bar in the module, alongside `finance.ap.payment_release`.** Everything else
in finance is a statement to ourselves, our auditor or our bank. `file` is a statement to the
**state**, and a wrong one is a legal exposure rather than an accounting error — an understated
return means an assessment plus penalties and interest; an overstated one is money that is very hard
to recover.

⚠ **`file` does not transmit anything.** Transmission goes through a licensed ASP/PJAP (§6 of the
blueprint, and owner ruling D-F2's explicit carve-out). The action records that a return *was*
lodged, with its reference, and snapshots the figures as filed — so what we told the tax office stays
distinguishable from what the data says today.

**`configure` is separated from `prepare`, and is the one action `company_admin` does not get.** A
tax *code* decides the tax on every future document; editing a rate or a base multiplier changes the
company's tax position across every unfiled document at once. That is a different order of authority
from preparing this month's return.

**No `unfile`, and no action edits a Coretax extract.** A filed return is a historical fact — a
correction is an *amended* return, a new filing on the same row, never an erasure. The extract is
DJP's record of events, the same posture as a bank statement in §22.

---

## 24. Finance F2 — posting rules (2026-08-24)

`202608241028_iam_finance_f2_posting_rule_permissions.sql` alongside `202608241027`.
One kind, `finance_posting_rule`, 4 keys.

| Action | `finance_staff` | `finance_manager` | `company_admin` | Assurance |
|---|:--:|:--:|:--:|---|
| `read` | yes | yes | yes | `notLow` |
| `process` | yes | yes | **no** | `notLow` |
| `author` | no | yes | **no** | `notLow` |
| `activate` | no | yes | **no** | **D4 `high`** |

**Authoring a rule is authoring accounting policy.** A posting rule decides which accounts every
future event of its type lands in — so whoever controls it controls where revenue, cost and tax
appear in the statements, without ever touching a journal. A single rule edit re-points an entire
event stream. `activate` is therefore separated from `author` and held at high assurance: drafting a
mapping for review is ordinary work; making it live is the decision.

**`process` is the agent and automation path, and is deliberately wide.** The agentic-native bar
requires a capability to work identically under a human, under n8n and under an agent. Processing
the queue *is* that capability: it applies a mapping somebody else authored and approved, and every
posting still passes F1's guards — balance, period, account, chain, idempotency. It cannot invent
accounting; it can only apply it.

⚠ **An automation principal may legitimately hold `process`. It must never hold `author` or
`activate`** — that is the difference between executing a policy and writing one.

**`company_admin` holds `read` only** — the narrowest it has been in the module. An administrative
role has no business deciding where revenue lands, and no business running the accounting queue.

