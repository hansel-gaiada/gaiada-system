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

> **⚠ PV-D18 (2026-10-11): owners of the root get full platform/system controls.** D-8 / IAM-14
> defined `owner` as "everything business + role authoring in owned companies; NO platform/system
> controls". For the **system surfaces only** that is superseded: the bots console
> (`/api/admin/bot/*`), the systems console (`/api/admin/:system/status|config`, `about`, gateway,
> hub, github, automation) and observability (`/api/admin/observability`) are now gated by
> `isPlatformOperator` (`platform-nest/src/admin/elevated.ts`): `platform_admin` at global scope,
> **or** the `owner` role on a ROOT company (PV-D20: a company whose id equals its own
> `root_company_id`; an owner of a child company does not qualify). The automation reads keep their
> extra IT arm. **Unchanged:** owner's business scope, the owner permission bundle (this gate is code,
> not Cerbos), and every other `isElevated` surface (company listing, IAM, view-all-companies,
> intelligence transcripts, mail admin) — `isElevated` stays `platform_admin`-only. **Consequence for
> D-9:** owner and `platform_admin` are no longer disjoint for system surfaces; owner grants still
> need the two-person appointment (`owner` is in `ELEVATED_TIER`), so system power still has no
> single-step path. Ruling: decision log of `docs/plans/2026-10-10-three-perspectives.md`.

> **⚠ PV-D31 (2026-10-13): the owner arm above is limited to the OPERATOR root.** D21 ruled: only
> owners of the operator's own root get the Platform area and system controls. The operator root is
> named by ONE data marker, `companies.is_operator_root` (migration `202610132137`: at most one live
> row by a partial unique index, only a root by a CHECK, and no API route writes it; never a
> hard-coded id, PV-D13). `isPlatformOperator` now admits `platform_admin` at global scope (unchanged)
> **or** the `owner` role on a root company that carries the marker; the owner of any other root (a
> future customer root) gets 403 on every system surface listed above and on PV3-04's group-company
> link. The migration marks the root automatically only when exactly one live root exists and RAISES
> otherwise, so a multi-root estate needs a human decision first. **Unchanged:** the Group area
> (PV-D11/PV-D19: every root's owner sees their own Group while that root is active), `isElevated`,
> the owner permission bundle and Cerbos (this gate is code). `/api/me` gains
> `companies[].isOperatorRoot` so the UI menu can mirror the gate.

> **⚠ PV3-01 (2026-10-11): a company `owner` may countersign that company's contracts.** Cerbos
> `contract` / `countersign` gains one rule (`resource_contract.yaml`): `roles: ["user"]`, allowed when
> the principal holds `owner` at company scope ON the contract's tenant (plus `inTenant && notLow`),
> the shape of PV1-06a's `report_document` / `read_company` rule. This implements the recorded intent
> ("owner-only, deliberately narrower than company_admin"); it is not a new ruling. Until now only the
> `platform_admin` wildcard reached the action. The pair is catalogued as `core.contract.countersign`
> (grantable, sensitive, **`uiGrantable: false`**, migration `202610112330`) only because every literal
> policy action must be (`cerbos-catalog-alignment.test.ts` (b)). **Holding the key grants nothing:** no
> `perm_*` rule names it, it is bundled onto `platform_admin` alone (its wildcard), and not onto
> `company_admin` or `owner`. So `company_admin`, `manager` and every custom role stay refused, whatever
> `core.contract.*` keys they hold, the new one included. An owner of another company is refused too. The staff contract reads expose the outcome as a
> `canCountersign` row flag (BFF §16e).

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

> **Renamed 2026-08-26:** the `billing` domain is now `invoice`, and its five keys dropped the
> redundant middle segment (`billing.invoice.read` -> `invoice.read`), following the `portal.*`
> precedent for a domain whose name equals its Cerbos kind. The kind was ALWAYS `invoice`; only the
> domain and key prefix moved. Grants were preserved — migration `202608261030` UPDATEs
> `permissions.key` in place rather than re-inserting, because `role_permissions` cascades on
> delete. Ticket narrative further down still names the old keys where it is describing what
> happened at the time; those are history, not the current contract.

Domains: `agency` `assistant` `core` `hr` `invoice` `it` `knowledge` `pm` `portal` `reports`
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
  `app.inject`-adversarially-proven for both roles (`src/core/invoice.test.ts`'s
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
  `app.inject`-tested): `invoice.controller.ts`'s `create()`/`setStatus()`/`approve()`, and
  `contracts.controller.ts`'s `decidePayment()` — the ONE place `invoices.status` moves to `'paid'`
  outside the invoice module entirely, previously untested end-to-end at all
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
  `invoice.controller.ts::create()` has written to since before `created_by` existed, recording the
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
  wildcard. New catalog key `invoice.approve` (sensitive). The BFF endpoint
  `POST /api/:tenantId/invoices/:invoiceId/approve` (`invoice.controller.ts`) is the only door into
  `'approved'`; the pre-existing `PATCH .../invoices/:id` cannot set it directly, and `'sent'`/`'paid'`
  now require the invoice to already be `'approved'` (`'draft'`/`'void'` remain reachable from any
  state). No `perm_invoice_approve` permission-arm mirror — the condition is an attribute-instance
  check the flat catalog cannot re-express (same doctrine as `resource_hr_case.yaml`'s excluded
  self-only mirrors). DEV-VERIFIED: live Cerbos probes (creator denied self-approval, a different
  company_admin/manager allowed, unknown-creator legacy row denied, cross-tenant denied, low-assurance
  denied) and `app.inject` end-to-end tests in `src/core/invoice.test.ts`.
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

**What a termination revokes (offboarding, revised 2026-10-14).** Seat-justified grants are torn down by the
position reconciler. Besides those, `terminate` sweeps the leaver's **manual** grants (`managed_by` and
`managed_by_position` both NULL; reconciler-managed rows stay the reconciler's) that belong to this company:
company scope on this company, and `org_unit` scope on **any node of this company's org**, which is the org blob
(`company_org_structure`, read with its raw ids) ∪ its `org_unit_closure` ∪ the anchored `org_units` rows
(`core/org-unit-closure.ts::loadCompanyUnitNodeIds`, read under `withTenants([tenantId])`). `org_units` alone is
not the unit set: it holds only lazily anchored, service-assigned units, so until this revision a manual grant on
any other node survived the leaver. **Cross-company guard:** an `org_unit` grant carries no tenant and node ids repeat
across companies, so a grant whose node id is also in the org of another company where the leaver still holds an
ACTIVE membership is **kept**, not revoked, and listed as `keptAmbiguousOrgUnitGrants[]` in the response and in the
`terminated` activity row, for HR/IT to decide by hand. The leaver's memberships are read through `principal_lookup`
(their own rows only) and each other company's unit set under its own single-tenant `withTenants`; no RLS context is
widened. A node id shared only with companies where the leaver is not active is revoked as usual. Proof:
`employees-jml.test.ts` (Linux gate).

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
`core.identity_link.read`, `core.rollup.read`, `core.role_grant.read`, `invoice.read`,
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

A decided D-9 `iam:appointment` executes the same way, reading its requester from the approval row under the approval's own tenant (`automation_approvals` is FORCE RLS; the bare global read used to find nothing, so every appointment failed "appointment approval row not found", fixed 2026-10-14).

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


## 25. WSK-49f — the client website editor grant path (2026-10-11, WSK-D60 amended)

`202610110520_iam_client_website_editor_grant_path.sql`. **One new global role, one new client-contact capability, two catalog keys on
the EXISTING `client_contact` kind. Catalog 416 -> 418 pairs, 401 -> 403 grantable, 193 -> 195 sensitive, kinds unchanged at 101.**

| Thing | Value |
|---|---|
| Role `client_website_editor` | A role stored as DATA, scoped to ONE client record: `user_roles.scope_type = 'client'`, `scope_id = clients.id` (new scope type; the shape CHECK requires a uuid). **No bundle (0 `role_permissions` rows) and NO `perm_*` mirror — permanently.** A flat catalog key cannot express "this one client" and would over-grant to every client. Checked by the attribute condition in `derived_roles.yaml` (grant's client == `resource.attr.clientId`, grant's tenant == `resource.attr.tenantId`). It reaches the principal only while its holder is an ACTIVE client-wide contact of that client. |
| Capability `admin` | `client_contacts.capability IN ('signer','viewer','admin')`. Assigned ONLY by staff (`manage_admin`). Confers one power of its own: granting `client_website_editor` for its OWN client. **Implies signer** (owner ruling 2026-10-11): every signer test (`portal-scope` `canSign`, `client-notify` signature recipients, `canEditCentre`) accepts `admin`; a viewer still cannot sign. Removing admin takes `{to:'signer'\|'viewer'}`, default `viewer`. |
| `core.client_contact.manage_website_editor` | sensitive: platform_admin, company_admin, owner, manager (+ the attribute-gated `client_contact_admin` derived role, own client only). Role arm for company_admin/manager; **owner reaches it through the permission arm added in §27** (it was role-arm only here, which refused `owner`). |
| `core.client_contact.manage_admin` | sensitive: platform_admin, company_admin, owner. NO client arm. Role arm for company_admin; **owner reaches it through the permission arm added in §27**. |
| Role bundles | +7 pairs (1818 -> 1825): platform_admin +2, company_admin +2, owner +2 (it mirrors company_admin both ways), manager +1. |

**Guards, and where each lives.** The grant is written in exactly one place (`grantClientWebsiteEditor` in `admin/grant-write.service.ts`,
the `user_roles` choke point), which re-checks what Cerbos cannot see: the client exists in the tenant, the target is a client-wide
non-revoked contact of THAT client, no self-grant, and a client-admin actor's `clientAdminOf` contains this exact (tenant, client). The
generic grant surfaces refuse a client scope and the role by name; `ROLE_SCOPE_CONSTRAINTS` pins the role to `client`; a DB trigger
(`user_roles_client_scope_guard`) welds role and scope together for any writer, including seeds. `client_website_editor` is the first
entry on `role-bundle-completeness.db.test.ts`'s exemption list, with the reason written next to it.

**Principal contract.** `Principal.clientAdminOf` (`[{tenantId, clientId}]`, the principal's own active client-wide admin contact rows) and
`RoleGrant.scopeTenantId` (client-scoped grants only) are resolved in `assemblePrincipal()` and sent to Cerbos by `principalPayload()`;
`Resource.clientId` is sent by `resourcePayload()`. All three are allow-list entries and default to "matches nothing".

## 26. WSK-49c — client editors on `webdesk_content_item` and `webdesk_media_asset` (2026-10-11, WSK-D58 / D59 / D60)

No migration, no new kind, no new action, no catalog change. **The first resource rules that consume the derived role
`client_website_editor` (§25).** The role is a grant scoped to ONE client record; it matches only when that client is the one the RESOURCE
is about (`resource.attr.clientId`, fed only by the portal BFF from the site -> client link it loaded in the request's tenant, never from a
body) and the grant's tenant is the resource's tenant. An unfed resource (`""`) matches nothing.

```yaml
# resource_webdesk_content_item.yaml (new block, before the self-approval DENYs; every existing rule is byte-identical)
- actions: ["read", "create", "update", "request_publish"]
  effect: EFFECT_ALLOW
  derivedRoles: ["client_website_editor"]
  condition: { match: { expr: 'variables.inTenant && variables.notLow && request.resource.attr.module == "webdev"' } }
- actions: ["publish"]
  effect: EFFECT_ALLOW
  derivedRoles: ["client_website_editor"]
  condition: # tenant/assurance/module as above, plus: approvalId present, creatorId known, and
    (creatorId == principal.id && itemCount == 1) || creatorId != principal.id
# resource_webdesk_media_asset.yaml
- actions: ["read", "upload", "update"]
  effect: EFFECT_ALLOW
  derivedRoles: ["client_website_editor"]
  condition: { match: { expr: 'variables.inTenant && variables.notLow && request.resource.attr.module == "webdev"' } }
```

| Action | A client editor of THIS client | Why |
|---|---|---|
| `webdesk_content_item` read / create / update / request_publish | allowed | the editor tier, narrowed to one client. WHICH fields they may change (D59) is not a Cerbos question: the BFF and WebDesk both enforce it from the composition. |
| `publish`, ONE item they requested (`creatorId == principal.id`, `itemCount == 1`) | allowed | D58: the client-side analogue of R4. |
| `publish`, a BATCH they requested | **DENIED** | maker != checker; also denied by the existing `roles:["user"]` self-approval DENY (denied twice). |
| `publish`, a request ANOTHER client editor filed (`creatorId != principal.id`) | allowed | D58: a batch needs a second client person with the same grant. The BFF only offers this for an approval row that carries the client (filed through the portal BFF, `tool_args.clientId`); a staff-filed request is not theirs. |
| `delete`, `unpublish`, `schedule`, anything on `webdesk_collection` (schema) | **DENIED** | absent from every client rule (default deny); `schedule` also keeps its strict maker != checker. |
| `webdesk_media_asset` read / upload / update | allowed | D59 / D53: library reads and metadata for their site. |
| `webdesk_media_asset` delete | **DENIED** | D59: "media deletion ... never reachable". |

**WSK-D65: a client publish rebuilds staging, and no policy changed.** `github_repo . deploy` is NOT granted to a client; there is no new
rule, action or role. The dispatch of the staging rebuild after a client-decided publish is authorised in code by an explicit, narrow
basis: `ClientPublishAuthority` (core/github/workflow-dispatch.ts), a class with a private constructor that only the approved-command
executor issues, after a publish decided by a client editor has EXECUTED. `dispatchApprovedWorkflow` accepts nothing else as a basis
(`instanceof`; a JSON object from a request is refused) and, before any GitHub call, re-verifies in this tenant that (a) the approval
is an executed WebDesk `content.publish` for this site, (b) it was decided by this principal, who holds the `client_website_editor`
grant for the client the row was filed for (`tool_args.clientId`), and (c) that client is still linked to this exact site. Otherwise
the build is `failed: client_publish_unverified`. Repo, workflow and ref come from `rebuildTargetFor` (config) only. A staff
decider carries no authority and still runs `authorizeDeploy`; a client can still never decide a `content.rebuild`, a schedule or a
key mint. The attempt is audited with `metadata.basis = 'client-publish'` and `metadata.ruling = 'WSK-D65'` on the `github.deploy` rows.

Unchanged on purpose: publish is HIGH for every principal (no approval id, no publish); automation / bot principals never publish
(the T7 DENY by kind still bites a client-granted automation principal); a LOW-assurance session gets nothing (`notLow`). No `variables.local`.
A client rule never reads `collectionKey` / `locale`. **Staff roles pass these rules on a resource that carries a `clientId`** (they hold
the staff tier) and are stopped at the BFF's second step (the portal scope predicate: not a contact of the client), so the portal surface
is closed to staff and the staff surface is closed to clients (the client-editor rule needs the CLIENT grant; a client editor has no
staff role). **Restart `gaiada-test-cerbos` and the live sidecar after deploying the two policy files** (nothing hot-reloads).

**Proof.** `src/rbac/client-website-editor-consumer.cerbos.test.ts` (structural pin + 14 live decisions through the real `check()`),
`client-website-editor-cerbos.test.ts` (49f's derived-role matrix, un-skipped now that a rule consumes the role), and a 282-row probe
matrix (every staff tier unchanged, the client rows above, the 49f `client_contact` rows) run against Cerbos 0.54.0: ALL ROWS AS EXPECTED.
The BFF's behaviour (scope isolation, no egress on a refusal, D58 flows, the `ce` claim) is `src/modules/webdev/webdesk-client-website.test.ts`.

## 27. M5-W1a — the writers' room roles and review actions (2026-10-11, PROTOTYPED)

`202610111443_iam_writers_room_roles.sql`; design [`plans/2026-10-11-m5-writers-room-design.md`](plans/2026-10-11-m5-writers-room-design.md)
§2 and §7. **Four new global roles stored as data (no bundle), seven catalog keys on two EXISTING kinds, no new kind. Catalog 422 -> 429
pairs, 407 -> 414 grantable, 196 -> 199 sensitive, kinds unchanged at 102. Role bundles 1847 -> 1877 pairs.**

| Thing | Value |
|---|---|
| Roles `webdesk_writer`, `webdesk_translator`, `webdesk_seo_reviewer`, `webdesk_editor` | Grants stored as DATA: a `user_roles` row at scope_type `company` (the ERP company that owns the WebDesk tenant) plus scope rows (site; collections or all; locales or all) that arrive on the grant as `editorialScopes` (W1b adds the table and `assemblePrincipal()`'s read). Checked by attribute conditions in `derived_roles.yaml` (`webdesk_editorial_site`, `webdesk_editorial_reader`, one per role). **No bundle (0 `role_permissions` rows) and NO `perm_*` mirror — permanently.** A flat key cannot say "this site, these collections, these locales". A grant at any scope other than `company`, a grant without scope rows, and a resource without `siteId` (and, for the per-role arms, `collectionKey`/`locale`) match NOTHING. |
| `webdev.webdesk_content_item.submit` / `.comment` | not sensitive. webdev_staff, webdev_manager, company_admin (+ owner by bundle, platform_admin by wildcard); writer and translator on their OWN items; SEO reviewer (`comment` only) and editor in scope. |
| `webdev.webdesk_content_item.request_changes` / `.assign` | not sensitive. webdev_manager, company_admin; SEO reviewer (`request_changes`) and editor in scope. |
| `webdev.webdesk_content_item.seo_signoff` | **sensitive.** webdev_manager, company_admin; SEO reviewer in scope. **DENY for every automation and bot principal** (platform_admin included). |
| `webdev.webdesk_content_item.approve` | **sensitive.** webdev_manager, company_admin; editor in scope. Only on an item `in_review`, and **maker ≠ checker against the creator of the version being approved, for every principal**: an inline arm on each ALLOW plus a `roles: ["user"]` DENY that beats the platform_admin wildcard. An approve whose creator is unknown is DENIED for everyone. **DENY for automation, bot and contributor principals.** |
| `webdev.webdesk_collection.manage_editorial` | **sensitive**, `advancedOnly`. Same holders as `apply_schema` (company_admin, webdev_manager, platform_admin). Grants the writers' room roles and sets a collection's review policy; it is also the live ceiling for an editorial grant (§2.5 of the design). |
| Reads for the four roles | content `read` on the scoped site + collection in ANY locale; `webdesk_collection:read` and `webdesk_media_asset:read` on any site in their scope rows. No media write. |
| Unchanged | publish / schedule / unpublish / delete (the publisher tier, WSK-D46); `manager` and `member` gain nothing; `client_website_editor` gains nothing (the editorial commands are not client commands). |
| Role bundles | +30 pairs: platform_admin, company_admin, owner, webdev_manager +7 each; webdev_staff +2 (submit, comment). selfScoped unchanged (28). |

**Resource attributes (allow-listed in `resourcePayload()`).** `siteId` (route `:siteId` after `resolveEditableSite()`) and
`reviewState` (WebDesk `editorial_items.state`) are new; `collectionKey`, `locale`, `ownerId` (= the item's author),
`creatorId` (approve: the version's creator) and `published` already existed. Every one comes from WebDesk's read or a proven route
param, never a body. Until W1c sends `siteId` and `reviewState`, every editorial rule reads `""` and DENIES; the staff tiers read
neither, so nothing that works today changes (§11.1's lesson, stated up front).

**Principal contract.** `RoleGrant.editorialScopes` (`[{siteId, allCollections, collections, allLocales, locales}]`) is sent by
`principalPayload()` field by field on the grants that carry it (a conditional spread, so every other grant keeps its exact shape);
a non-boolean `all*` flag is sent as `false`. `assemblePrincipal()` populates it from the grant's scope rows since W1b (§27.1).

**What proves it.** Bundles and parity are blind to all of this (they treat conditions as satisfied, and the four roles map to no
bundle). The proof is the decision matrix: `platform-nest/cerbos/tests/webdesk_writers_room_test.yaml` (17 principals × 24 resources ×
every action, 4 811 decisions, negatives included; `cerbos compile --tests`) and the live probes through `check()` in
`src/rbac/webdesk-writers-room-cerbos.test.ts`. The four roles are exempted in `role-bundle-completeness` with the reason beside them.

**Not decided here.** The grant path, the `user_roles_editorial_guard` trigger, the refusals on the generic grant surfaces
(`editorial_role_dedicated_path`) and `ROLE_SCOPE_CONSTRAINTS` entries are W1b (now §27.1). The contributor principal and its DENYs on the
assistant and agent-run kinds are W1d (owner question O-4). The `approve` DENY already names `contributor`, so that wall exists before
the kind does.

### 27.1 M5-W1b — the grant scopes, the guards and the dedicated grant path (2026-10-11, PROTOTYPED)

`202610111816_iam_editorial_grant_scopes.sql`; design [`plans/2026-10-11-m5-writers-room-design.md`](plans/2026-10-11-m5-writers-room-design.md)
§2.2, §2.5, §2.6. **No new role, permission, kind, bundle row or policy rule.** The catalog and bundles are unchanged from §27.

| Thing | Value |
|---|---|
| Scope rows | `user_role_editorial_scopes (user_role_id FK ON DELETE CASCADE, tenant_id, webdesk_tenant_slug, site_id, all_collections, collections text[], all_locales, locales text[], granted_by, …)`, UNIQUE `(user_role_id, site_id)`. "All" is an explicit boolean: CHECK `all_x` ⇔ empty list, else 1..100 distinct, trimmed entries (keys ≤ 100 chars, locales ≤ 35, WebDesk's own bound). One grant row per (user, role, company) carries one scope row per site. |
| RLS | FORCE. `tenant_isolation` (the 0025-hardened tenant wall; deliberately no module wall, principal assembly sets no module scope) **plus `principal_lookup` (SELECT only): the rows of grants HELD BY `app.principal_user_id`**, never a tenant's. Read outside that GUC (a bare `withGlobal`), the table returns ZERO rows and no error, which is why `assemblePrincipal()` reads it inside its lookup transaction. |
| Guards (DB, any writer, seeds included) | `user_role_editorial_scopes_guard`: a scope row only hangs off a grant of one of the four roles, at `company` scope, whose company is the row's `tenant_id`. `user_roles_editorial_guard`: the four roles only at `company` scope, never `managed_by` / `managed_by_position` (no service assignment, no position), and an editorial grant's role and scope are never repointed. `position_roles_editorial_guard`: the four never enter a position's role set. |
| Generic surfaces | `assertGrantAllowed` refuses the four by name on `legacy_admin`, `ui` and `two_person_appointment` with **400 `editorial_role_dedicated_path`**; the positions composer refuses them (and lists them `attachable:false, reason:"editorial_role_dedicated_path"`); `ROLE_SCOPE_CONSTRAINTS` pins them to `company`. A generic REVOKE of an editorial grant still works (a de-escalation; its scope rows cascade). |
| Principal | `assemblePrincipal()` attaches `editorialScopes` to each writers' room grant at `company` scope from that grant's OWN rows whose tenant is the grant's company (`attachEditorialScopes`, `src/rbac/editorial-roles.ts`). **A grant with no surviving row carries no `editorialScopes` member at all, so the derived roles' `has()` fails: fail closed.** An expired grant is not resolved at all; an editorial grant at another scope gets nothing. |
| The grant path | `grantEditorialRole` / `revokeEditorialRole` in `admin/grant-write.service.ts` (the `user_roles` choke point). The caller must pass Cerbos `webdesk_collection:manage_editorial` on `{tenantId, module: webdev, siteId}`: that decision IS the ceiling (§2.5 of the design; no bundle-subset ceiling, the four have no bundle). Re-checked inside: the site is this company's and the collections and locales exist (proven from WebDesk by the BFF before the transaction), the target is an active `employee` with an active membership of this company (every other kind is refused until the contributor principal exists, W1d), no self-grant. Role row, scope row and the audit row (`webdesk.editorial.role_granted` / `_revoked`, `target_entity_type user_role`, identifiers only) commit in ONE transaction; the target's `session_version` is bumped on every change. The grant's `expires_at` belongs to the grant: a different expiry for an existing, unexpired grant is 409 `editorial_grant_expiry_mismatch`. Revoke removes the site's scope row, and the grant itself when it covered no other site. |
| BFF + MCP | `GET/POST …/sites/:tenantSlug/:siteId/editorial/grants`, `DELETE …/editorial/grants/:userId/:role` (FRONTEND-BFF-CONTRACT §27 "Writers' room grants"). Tools `webdesk.editorial.listGrants` (read), `webdesk.editorial.grantRole` (**high**), `webdesk.editorial.revokeRole` (**medium**), assurance `verified`; both writes are D14 executables (`approval-executables.ts` + `resource_mcp_tool.yaml`). |

**What proves it.** `src/rbac/editorial-roles.test.ts` and `src/modules/webdev/webdesk-editorial-grants.unit.test.ts` (service-free: the
name lists agree across the TS, the migration and `derived_roles.yaml`; scope attachment fails closed; every pre-database refusal);
`src/admin/editorial-grant.db.test.ts` (the triggers and CHECKs, principal_lookup across users and tenants, the zero-row trap, a
scope-less grant probing DENY through the real `check()`, atomicity, revoke); `src/modules/webdev/webdesk-editorial-grants.test.ts`
(the routes over `app.inject` with real Cerbos: denials with valid bodies and no egress, the wall, the generic refusals with positive controls).

### 27.2 M5-W1c — the transport that makes the writers' room rules live: the two-phase gate and attribute provenance (2026-10-12, PROTOTYPED)

Design [`plans/2026-10-11-m5-writers-room-design.md`](plans/2026-10-11-m5-writers-room-design.md) §2.3, §8. Code: `platform-nest/src/modules/webdev/webdesk-content.{controller,service}.ts`,
`webdesk-media.service.ts`. **No policy, role, catalog, bundle or migration change**: §27's rules read `siteId` and `reviewState`, which `resourcePayload()` already carried (W1a);
until this ticket no handler sent them, so every editorial rule read `""` and denied (§11.1's lesson, stated in §27 up front). Now they are fed. FRONTEND-BFF-CONTRACT §27 "The two-phase gate" lists every route.

**Where every attribute comes from** (the only sources; a body or a query is never one):

| Attribute | Source | Never from |
|---|---|---|
| `tenantId` | route `:tenantId`, validated by `AuthGuard` | body, query |
| `siteId` | route `:siteId`; phase 2 uses the id the cross-company wall (`resolveEditableSite`) proved, never an unproven one | body, query |
| `collectionKey`, `locale` | WebDesk `item.get` of the item in the route. `create`: the route's collection (proven by `collection.get`) and the body's `locale` (WebDesk validates it); list: the route's collection | any other caller input |
| `ownerId` | WebDesk `editorial.authorSub` (`""` for a legacy item with no author: nobody owns it) | body |
| `reviewState` | WebDesk `editorial.state` (`""` when WebDesk sends none or an unknown value: the review rules deny); for a locale twin `create`, the SOURCE item's | body |
| `published` | `publishedVersion !== null` of the same read; for a twin `create`, the source's | body |
| `creatorId` (`approve`) | WebDesk's creator of the SUBMITTED version (`editorial.submittedVersion`), via the version in hand or one more `item.get?version=n`; `""` when it cannot be read | body |

**The gate.** *Phase 1* (the controller's first statement, `ContentGate.openSite`): `webdesk_collection:read` on `{tenantId, module, siteId}`. *Phase 2* (inside the service, before any
body or query validation): the real action with the attributes above, through an `ItemGate` that has a private constructor and whose factories demand a value built from a WebDesk read
(`ItemAttrs` / `CollectionProof`, branded with a module-private symbol); every write method sends through one, so a write cannot be reached without the read and the check
(`webdesk-content-two-phase.unit.test.ts` pins this with `@ts-expect-error`). A principal that holds no writers' room grant (and is not delegating) is also asked the OLD attribute-free
question in phase 1: for them it is exactly the old first statement (a denied staff caller sees no egress and no 404-before-403), and it can only deny earlier, never allow. `GET sites` asks Cerbos per site
for a writers' room grant (`check`, no denial row per hidden site) and answers 403, never `[]`, when none is readable.

**`allowed` on `item.get`.** One `CheckResources` (`checkActions`) on the same resource phase 2 used (`ItemGate.resourceOf`): `read, update, submit, comment, request_changes, seo_signoff, approve, assign,
request_publish, unpublish, delete`. Advisory (each action is checked again when taken), absent rather than `false` when Cerbos cannot answer or the call is delegated, and not sent on the client
portal. `publish`/`schedule` are decide()-only and not listed.

**Known limits, recorded so nobody rediscovers them.**
1. *Existence oracle inside a site.* Phase 2 reads the item before it can be denied, so a scoped caller sees 404 `item-not-found` for an unknown id and 403 for an item it may not touch. Ids are uuids and phase 1 already
   proved the caller may read the site; it is not closed here.
2. *Filing re-asks with the same attributes.* `fileWebdeskCommandApproval` runs its own defence-in-depth `request_publish` check; `publish-requests` now passes it the attribute-carrying resources phase 2 built (`itemResources`; empty or absent = the old attribute-free check), so a scoped `webdesk_editor` can file. Listing and withdrawing one's OWN requests (`GET/POST …/publish-requests[/:a/withdraw]`) need only phase 1 and the own-rows filter for a writers' room grant (a writer or translator can never have filed one).
3. *WebDesk can pre-empt a 403 on a read of a named version.* `publish-requests` reads each named item at its named version (for the content hash the approver sees); a version WebDesk does not have is its typed 404 before the check on that tuple.
4. *A scoped principal's malformed `publish-requests` body is 403, not 400*: with no readable item the check is asked at site level, which a scoped editor cannot pass. Authorization first.

**What proves it.** `src/modules/webdev/webdesk-content-two-phase.unit.test.ts` (service-free; a Cerbos stub emulates the W1a decisions, so it proves the TRANSPORT, the ORDER and the shapes: forged values never reach Cerbos, a denied write sends nothing,
`allowed` equals the batch answer, `GET sites` filtering, twin provenance, the controller's first statement); `src/modules/webdev/webdesk-content-two-phase.test.ts` (real Cerbos + Postgres + the real principal assembly over `app.inject`, every denial
beside a positive control, `allowed` against a direct `checkActions` for the same principal and resource; needs the Linux gate). The existing webdev suites (`webdesk-content.test.ts`, `webdesk-media.test.ts`, the client suites, the preview suite) pin the staff behaviour.

### 27.3 M5-L1d — WebDesk form definitions reuse `webdesk_collection` (2026-10-12, PROTOTYPED)

**No new kind, role, permission, bundle row or policy rule.** `forms.define` (WebDesk, MEDIUM / `webdesk:operate`) is authorised in the ERP as Cerbos
`webdesk_collection` · **`apply_schema`** (company_admin, webdev_manager / module_manager, platform_admin; sensitive publisher tier), and `forms.def.list` / `forms.def.get` as
`webdesk_collection` · **`read`**. Why `apply_schema`: a form definition is the composition of a PUBLIC intake (the fields it accepts, the consent notice it records, how long it keeps
submissions), the same family as a collection's composition, which `apply_schema` already guards; WebDesk classifies both MEDIUM / operate. No `client` rule exists on this kind
for either action, the BFF opens the STAFF gate (`authorizeSite`, never `openClient`), and WebDesk's `forms.define` carries no editorial assertion (like `schema.apply`), so a
client-editor principal (`ce`) cannot be expressed on it. MCP: `webdesk.forms.define` (**medium**, PATCH alias), `webdesk.forms.list` / `webdesk.forms.get` (read), assurance `low`.
**Two-phase (W1c, §27.2):** each handler's first statement is `authorizeSite(…, siteId, "webdesk_collection", action)` (phase 1: `read` on the route's site; for a principal with no writers' room grant also the old attribute-free question). The write then asks its REAL action, `webdesk_collection:apply_schema` with `siteId` set, for EVERY principal inside `defineFormDefinition`, before body validation and before any WebDesk call, so a writer or editor holding a grant on the site (who passes phase 1) is denied. The reads need nothing beyond phase 1.
FRONTEND-BFF-CONTRACT §27 "WebDesk form definitions". **Open follow-up:** `webdesk.forms.define` is NOT a D14 executable (`core/approval-executables.ts` + `resource_mcp_tool.yaml`'s list are
outside this change), so an unattended suspension, once approved, re-drives nothing: only an attended human can define a form until the pair is added.

### 27.4 M5-W2d — the review routes: which action decides each (2026-10-12, PROTOTYPED)

No policy change: W2d only adds the BFF and MCP surface over the W1a rules, through the W1c two-phase gate. Phase 1 is `webdesk_collection:read` on the route's site (`authorizeSite`) for every route; for the item commands the principal that holds no
writers' room grant is also asked the attribute-free action (an earlier deny, never an allow). Phase 2 runs before any body validation, with `siteId` from the wall and `collectionKey`, `locale`, `ownerId`, `reviewState`, `published` from WebDesk's `item.get`.

| Route | Phase-1 gate | Phase 2 (action · extra attributes) |
|---|---|---|
| `POST …/editorial/submit`, `/withdraw` | `webdesk_content_item:submit` | `submit` |
| `POST …/editorial/request-changes` | `…:request_changes` | `request_changes` |
| `POST …/editorial/seo-signoff` | `…:seo_signoff` | `seo_signoff` (DENY for automation, bot) |
| `POST …/editorial/approve` | `webdesk_collection:read` only (an attribute-free `approve` is denied for everyone) | `approve` with `creatorId` = `created_by` of the submitted version (WebDesk), so the structural DENY (maker != checker, platform_admin included) and the unknown-creator DENY apply; DENY for automation, bot, contributor |
| `POST …/editorial/assign` | `…:assign` | `assign` |
| `POST …/editorial/comments`, `/comments/:id/resolve` | `…:comment` | `comment` |
| `PUT/PATCH …/collections/:key/editorial-policy` | `webdesk_collection:manage_editorial` | `manage_editorial` on `{siteId, collectionKey}` |
| `GET …/editorial/board` | `webdesk_content_item:read` | company-level `read`, else `read` per (collectionKey, locale) of the rows returned; unreadable rows, their policies and the site-wide counts are withheld |
| `GET …/items/:id/editorial` | `…:read` | `read` |

`creatorId` is never taken from a body: a body key naming one is refused by the strict allow-list, after authorization. MCP: `webdesk.editorial.*` impacts are in FRONTEND-BFF-CONTRACT §27 "Writers' room review flow". Proof: `webdesk-editorial.unit.test.ts` (registry, order) and
`webdesk-editorial.test.ts` (real Cerbos + Postgres: 403 before validation per route with a positive control and no WebDesk write, self-approve DENY as platform_admin, bot and automation approve 403, notification recipients incl. another company's editor; Linux gate).

### 27.5 M5-W4 — writers' room briefs: no new kind; `assign` manages, `comment` on the linked item reads (2026-10-12, PROTOTYPED)

Design [`plans/2026-10-11-m5-writers-room-design.md`](plans/2026-10-11-m5-writers-room-design.md) §5 (W4 row) proposed a new kind `webdesk_brief` (six artifacts, assignee via `variables.owns`). It assumed no brief record existed;
`search_content_briefs` (migration 0046) already does, so the writers' room brief IS a row of it, and **W4 adds no kind, role, permission key, catalog row, group, bundle row, policy rule, derived role or pinned count**.
Code: `platform-nest/src/modules/webdev/webdesk-briefs.{controller,service}.ts`, `webdesk-brief-store.ts`; migration `202610122300_search_content_briefs_webdesk_link.sql`. FRONTEND-BFF-CONTRACT §27 "Writers' room briefs".

| What | Cerbos question (always `webdesk_content_item`, the existing W1a rules) | Who passes |
|---|---|---|
| **Manage** a brief: create, edit, link to an item, "create draft from brief", and READ any brief of a collection | `assign` on `{siteId, collectionKey, locale}` of the BRIEF (no `ownerId`) | scoped `webdesk_editor` (inside its site, collections and locales), `webdev_manager`, `company_admin` / `owner`, `platform_admin` |
| **Read** a linked brief (`GET …/items/:id/brief`, `GET …/briefs/:id`, a row of the board) | `comment` on the linked ITEM, with `ownerId`, `reviewState`, `collectionKey`, `locale` from WebDesk's `item.get` NOW | the item's own author (writer, translator), an SEO reviewer and an editor in scope, every unscoped staff tier |
| Create the draft item | `create` on `{siteId, collectionKey, locale}` of the BRIEF, through the ordinary `createItem` gate (W1c) | whoever also passes `create` there |
| Set the item's `brief_ref` / author / dates | `assign` on the new item, through the ordinary `editorial.assign` gate | as for Manage |

Why this meets the rules without a policy change:
- **A scoped writer reads only the briefs assigned to them.** `comment` is the one action whose writer and translator rules are "own items" (`variables.owns`, `ownerId` = WebDesk's `editorial.authorSub`) and whose SEO-reviewer and editor rules are "in scope". A writer never holds `assign`, so an UNLINKED brief and a brief of an item that is someone else's are both **403** (valid body, positive control in the suite). `read` would not do: it is scope-wide, so a writer could read every brief of the collection.
- **Editors in scope create and assign; staff are unchanged.** `assign` is exactly the editor/publisher/admin set of design §2.1. The unscoped `webdev_staff` tier has no `assign` (so it cannot manage briefs here) but has `comment` (so it reads every LINKED brief); staff keep the `search` routes for property briefs, which this change leaves as they were (`search.property.*` unchanged).
- **Search access is never widened.** A `propertyId` or `fromBriefId` is accepted only from a caller who ALSO passes `resource_search_property:read` on that property (403 otherwise, no row written). A writers' room principal reaches no search row except through a brief an editor with search access copied; the writer's view omits the property, provenance and grounding.

**Link integrity (an editor can set `brief_ref` to anything through the generic assign route).** The ERP half of the link (`webdesk_item_id`) is written ONLY by the brief routes, after the brief's collection and locale are shown to equal the item's, one brief per item (partial unique index). A non-manager reads a linked brief only when WebDesk's `editorial.briefRef` ALSO equals the brief id; a cleared or re-pointed `brief_ref` gives them 404, never the brief. `assignee_id` mirrors `author_sub` (kept by the BFF after the generic `assign`) and is only a list filter and a notification target: the board decides each non-manager row on WebDesk's current facts (one `item.get` per candidate, ceiling 8), so a stale mirror grants nothing.

**Known limits.** (1) "May read a brief" borrows `comment`; a brief that must outlive its item, or a reader who may not comment, is the day to promote it to its own kind (the design's `webdesk_brief`, six artifacts). (2) A manager sees an unlinked brief only inside the collections and locales it manages, and a company with no `search` module enabled can still hold writers' room briefs (the table's third wall is a property of the table: every statement runs under `modules: ["search"]` and names tenant and site itself). (3) Inside a site a scoped caller sees 403 for an existing brief it may not read and 404 for an unknown id (as §27.2 limit 1). (4) The create-draft sequence (create, assign, link) is retried under the same `Idempotency-Key`; the dev WebDesk double does not replay, so the convergence is argued in the service header and not yet proven by a test.

Proof: `webdesk-briefs.unit.test.ts` (parsers, views, the tool registry, the order of phase 2 against stubs) and `webdesk-briefs.test.ts` (real Cerbos + Postgres + RLS over `app.inject`: 403 per route with a valid body beside a positive control and no WebDesk write, the writer/other-writer/unlinked matrix, stale-assignee and forged-`brief_ref` cases, cross-company 403/404, the unset-GUC zero-row reads, the new CHECKs; Linux gate).

## 28. WSK-D60 follow-up — `owner` may grant a client's website access and the client `admin` capability (2026-10-12)

**The gap.** WSK-49f catalogued `core.client_contact.manage_website_editor` / `manage_admin` and bundled them (company_admin, owner,
platform_admin; manager for the website editor only), but wired them role-arm only. `owner` is permission-native (IAM-04c §3: zero
role rules, a kind is reached only through a `perm_*` derived role), so the keys sat in its bundle and nothing in the policy read them:
an owner was refused both actions, although WSK-D60 says Gaiada staff may.

**The fix: policy only, no new key and no migration.** Both keys, their `permission-groups.json` entries (advancedOnly), their bundle rows
(owner mirrors company_admin) and `role-permission-bundles.json` were already in place from 202610110520, so catalog counts, bundle counts
and every pinned count literal are UNCHANGED (422 pairs, 407 grantable, 196 sensitive, 102 kinds; verified by the pinned-count suites,
not edited). What was missing is the arm that reads them:

| Artifact | Addition |
|---|---|
| `derived_roles.yaml` | `perm_client_contact_manage_website_editor`, `perm_client_contact_manage_admin`: plain global-or-company mirrors of exactly their own key (`g.scopeType == "global" \|\| (company && g.scopeId == resource.attr.tenantId)`), the shape of IAM-14c's `perm_integration_connection_manage`. No `variables.local`, no attribute gate. |
| `resource_client_contact.yaml` | Two new ALLOW rules appended after every existing rule (which are byte-identical): one per action, `derivedRoles: [<its perm_*>]`, condition `variables.inTenant && variables.notLow && request.resource.attr.clientId == ""`. |

**Why `clientId == ""` (the portal arm stays closed to a key holder).** The STAFF routes send no `clientId`; the PORTAL routes send the
route's `clientId`, and that attribute is what lets the client-admin arm match. A permission key is a company-level staff authority, never a
portal one, so the mirror applies to the unfed (staff) shape only. It is therefore NARROWER than the company_admin / manager role arms (which
match with or without a `clientId`), which the mirror-reach invariant (`iam-04-reg1-mirror-reach-invariant.test.ts`) allows: a mirror may be
narrower than every holder's role arm, never wider. A key holder sending a `clientId` is a DENY, never a widening. The portal handler's own
scope check (`resolvePortalScope` + the target contact's row) is a second wall that does not depend on this rule. `cerbos.ts` defaults
`clientId` to `""`, so the comparison is always over a present string.

**Who holds the keys (unchanged from 202610110520).** manage_website_editor: platform_admin (via `*`), company_admin, manager (role arms),
owner (permission arm). manage_admin: platform_admin (via `*`), company_admin (role arm), owner (permission arm). NOT manager, member,
viewer or any client role.

**`ui_grantable` is deliberately left `true` (both keys, already `advancedOnly` in `permission-groups.json`).** Only `portal.*` and the
relationship class are non-grantable, and `assertRoleUiGrantable` refuses to attach ANY role whose bundle holds a non-grantable key to a
position: flipping these two to `false` would make `company_admin`, `manager` and `owner` unattachable to positions. No runtime write path
composes a role's permissions today (`role_permissions` is migration-only data), so a UI-editable role cannot mint these keys; when Phase 4
adds custom-role composition, that surface must treat these two keys as sensitive (they are `sensitive: true`).

**Restart `gaiada-test-cerbos` and the live sidecar after deploying the two policy files** (nothing hot-reloads).

**Proof.** `client-website-editor-cerbos.test.ts` (structural pins of both perm rules and derived roles + live decisions for a perm-only
principal: allowed in its own company on the staff shape; denied in another company, on the portal shape, at low assurance, without the
tenant in `companies`, with the other action's key only; manager keeps `manage_admin` denied), `core/client-website-access.test.ts` (an
`owner` assembled from the REAL migrated bundle grants/revokes the website editor and assigns/removes admin over HTTP, audited; an owner of
another company and an owner on the portal route are refused), and the live probe matrix against Cerbos 0.54.0 (the new rows FAIL on the
previous policy and pass on this one).

---

## 29. M5-G5b — `agency_privacy.*` may be called unattended; the approval holds hashes, never the identifier (2026-10-12, PROTOTYPED)

No new Cerbos kind, action, role or permission key. Three facts about who may do what, stated so nobody re-derives them:

| Step | Authority | Where |
|---|---|---|
| Call a privacy tool (attended, or an agent acting for a person) | `agency_lead:convert` on the tenant (company_admin; platform_admin), checked FIRST by the route | `core/agency-privacy.controller.ts` |
| **File** the approval an unattended call is suspended into (`POST /automation-approvals`, tool name `agency_privacy.*`) | the generic `automation_approval:create` **and ALSO** `agency_lead:convert` (G5b). The generic `create` is held by manager and member, so without the second check any of them could plant a privacy approval the route would never have filed | `core/approval-arg-minimisers.ts` policy `authorizeFiling` |
| Decide it | `automation_approval:decide` (company_admin), by someone other than the requester | unchanged |
| Run it | the requester only, `convert` again, by `approvalId`; maker != checker is re-read from the stored decision | `core/agency-privacy.service.ts` |

What changed in the data, not the permissions: for these three tools the filing path stores `tool_args` as the subject hashes (the G5
ledger's own SHA-256 helper) plus a display hint, the filed `reason` is generated, the `automation_approval.decided` event carries the hashes
without the hints, and the ledger's `filed` row is written in the approval's transaction. Still HIGH, still two-person, still never D14
auto-run (the bar in `core/approval-executables.ts` stands; `execution_status` stays `not_applicable`). The earlier "attended-only" caveat on
these tools is withdrawn. Proof: `core/agency-privacy.filing.test.ts`, `core/approval-filing-minimise.test.ts` (no service) and
`core/agency-privacy-unattended.db.test.ts` (Linux gate).

**The ai-agents half (M5-G5c, PROTOTYPED).** G5b minimised the ERP's copy; the agent runner held its own. `ai-agents/src/sensitive-tools.ts` is
the same idea there: a static per-tool registry, and for `agency_privacy.*` the persisted, logged and model-facing copy of a call is
`{minimised:"agency-privacy.v1", hashes, hints}` (the ERP's `subjectHash`, same domain, byte-for-byte; hints `***@domain`, `***NN`) and of its
result counts, ids and status only. The live hub call still carries the real identifiers. A per-goal scope also scrubs the learned values from the
goal row, run rows, `agent_run_events` (append-only, and pushed to the SSE bus), outcome, blackboard, eval trace and episodic memory; it is seeded
from the goal text for an agent that holds a policy tool, because the planner names the person before any tool call. No permission or policy
changes. Residuals, stated plainly: (a) the live model call and the AI gateway still see the human's goal text and the model's own args (the
model needs them to act); (b) [closed by M5-G5d, next paragraph] a `fileOnSuspend:false` suspended intent used to return the real args; (c) the hash is unsalted, as the ERP's.
Proof: `ai-agents/src/sensitive-tools.test.ts`, `ai-agents/src/sensitive-run.test.ts` (no services).

**The suspended-intent half (M5-G5d, PROTOTYPED).** The assistant's confirm chip files an approval later from the intent the runner parked when
it suspended a call with `fileOnSuspend:false`; that intent used to carry the model's raw email and phone (runner memory for 15 minutes,
`GET /goals/:id`, then `assistant_write_intents.tool_args` until a confirm, dismiss or lazy reap). Now `ai-agents` hands over, for a policy tool, only
`intentArgsFor(tool, args)`: the ERP's own already-minimised shape `{minimised, kind, identifiers, subject:{emailHash,emailHint,phoneHash,phoneHint}, tenantId?,
approvalId?}`, and platform-nest reduces whatever it receives with the same approval-args policy (`storableIntentArgs` in `modules/assistant/write-intents.ts`,
idempotent, applied in the broker, the handoff harvest and the draft INSERT) so a runner older than G5d cannot put a raw value in the database. The confirm
claims that row and files it through the unchanged `insertAutomationApprovalRow` chokepoint, so the privacy ledger's `filed` row binds the hashes and, once a
second person approves, the requester's `POST /agency/privacy/erase {approvalId}` rebuilds the subject from them: no schema change and no new route. A
malformed identifier is not narrowed away (a bad phone next to a good email would quietly shrink an erase); it drafts nothing and the turn ends with
`errorKind: intent_invalid`. A tool with no args policy is unchanged byte for byte. Residuals: the human's own typed text (the chat message, a handoff's
goal text) is the user's and stays in `assistant_messages` / `assistant_handoffs.goal_text`; the live `fileApproval` call to the hub still carries the real
args in transit. Proof: `ai-agents/src/sensitive-tools.test.ts`, `ai-agents/src/sensitive-run.test.ts`, `platform-nest/src/modules/assistant/assistant-privacy-intent.test.ts`
(no services) and `assistant-privacy-intent.db.test.ts` (Linux gate).

## 30. PV4-02 — the `conversation` kind and the portal `converse` action (2026-10-12)

Plan: `docs/plans/2026-10-12-pv4-conversation-tickets.md` (PV4-02; design decisions 1, 2, 9; owner rulings PV-D22, PV-D23, PV-D24). Status: **PROTOTYPED** (policy, catalog, bundles and tests are in the repo; the live Cerbos probe is the deploy step). There are no routes yet (PV4-03 adds them), so nothing in `FRONTEND-BFF-CONTRACT.md` changes here.

**A new kind, `conversation`, with four staff actions.** `resource_conversation.yaml`, keys `core.conversation.{read,post,draft,manage}`:

| Action | Reach (every rule `inTenant && notLow`) | What it is |
|---|---|---|
| `read` | `company_admin`, `manager`, `member`, `viewer` | see a client's threads and messages |
| `post` | `company_admin`, `manager`, `member` | send a message to the client under the sender's own name |
| `draft` | `company_admin`, `manager`, `member` | write a draft only staff see (an agent may hold this without `post`) |
| `manage` | `company_admin`, `manager`, `member` | close or reopen a thread, edit its subject, retract a staff message |

The shape is `resource_client.yaml`'s on purpose: a conversation is part of the client record, so it is never wider or narrower than the client it belongs to. Each action has a `perm_conversation_<action>` mirror under `inTenant && notLow && inRoot` (generic global-or-company, like `perm_client_*`). `platform_admin` holds the wildcard; `owner` mirrors `company_admin` exactly (bundle rows, asserted by the migration and `cerbos-conversation.test.ts`). `post` and `manage` are catalogued sensitive; `read` and `draft` are not. Two new authoring groups: `client_conversation` (staff) and `portal_conversation` (the client door).

**Agents and automation never post or manage (PV-D23).** An `EFFECT_DENY` on `post` and `manage`, on `roles: ["user"]`, fires for `principal.attr.kind in ["automation","bot"]`. It has the same shape and the same delegation reasoning as the WebDesk `publish`/`schedule` DENY in `resource_webdesk_content_item.yaml`: `authorize()` checks the caller and, when `actFor` is set, the acting human, and either denial refuses; a persona acting for a human is denied as the CALLER, the human's own principal is unaffected. Under deny-overrides it beats the `platform_admin` wildcard, every role arm and the permission mirrors. `draft` and `read` are deliberately not listed: drafting is the agent's job, and a staff member then sends. `principalPayload()` already sends `kind` (`""` when unknown, which matches no DENY), and `resourcePayload()` already carries `tenantId`, `clientId` and `projectId`, so `cerbos.ts` needs no change.

**The client reaches the conversation through `portal`, never through this kind.** `resource_portal.yaml` gains one action, `converse` (open a thread, post, edit or retract one's own message), on the existing `client` rule, with the same condition as the other client actions (`inTenant && inRoot`), plus `perm_portal_converse` (company-scope-only, like the other eight `perm_portal_*` mirrors) and the catalog key `portal.converse` (`uiGrantable:false`, like every `portal.*`). It is **not** conditioned on the contact's `capability` (owner ruling PV-D24: viewers post, because posting is not signing), exactly as `request_change` and `approve_post` are not; the capability is not a Cerbos attribute and no rule reads it (`cerbos-conversation.test.ts` pins that). Which rows a client may touch is `portal-scope.ts` and `portal-visibility.ts`, which Cerbos does not see. `portal.converse` is bundled on `client` and `platform_admin` only; `owner` and `company_admin` hold no `portal.*` key.

**The `client` role invariant is now a test.** `client` appears in no resource policy except `resource_portal.yaml`; it was a comment in each policy header until `client-role-only-in-portal.test.ts` scanned `cerbos/policies` for it. Adding `client` to `resource_conversation.yaml` fails that test.

**The six artifacts** (the `webdev_site` template, commit `2c5ab99e`): policy + derived roles; `cerbos.ts` (no change); `permission-catalog.json` (+5 keys: 104 kinds, 439 pairs, 424 grantable, 15 relationship, 204 sensitive); `permission-groups.json` (+2 groups); migration `202610130120_iam_conversation_permissions.sql`; the bundle generator (no resolver change: the kind names only direct roles, which `DIRECT` already maps) and `role-permission-bundles.json`, regenerated. Pinned tests moved: `cerbos-catalog-alignment`, `iam-215-boundary-pin`, `permission-groups-catalog-parity`, `ui-grantable-catalog`, and the portal action-set pins (`iam-04-b7-portal.{test,db.test}.ts`, `mon00i-portal-root-anchor.db.test.ts`, `iam-04-b6-social-portal.test.ts`). Deploy: Cerbos needs a restart (nothing hot-reloads), then probe a staff `member` ALLOW `post`, a `bot` DENY `post`, and a client ALLOW `converse`.

## 31. M5-P2 — ad-platform conversion uploads: no new permission; the approver needs `update` on the property (2026-10-13, PROTOTYPED)

No new Cerbos kind, action, role or permission key, no policy change, no restart. What is stated so nobody re-derives it:

| Step | Authority | Where |
|---|---|---|
| Plan an upload (consume `agency.lead.stage_changed`) | none: an event handler with no principal; it only runs for a tenant with the `search` module enabled, and files an approval | `modules/search/conversions.service.ts` |
| Configure a target (site slug, platform, stage, conversion) | `resource_search_property · update` on the property (the existing `search.property.update` permission) | `POST .../properties/:id/conversion-targets` |
| Read targets and the ledger | `resource_search_property · read` | the three GETs |
| **Approve (or reject) an upload** | the generic `automation_approval · decide` (company_admin) **and** `resource_search_property · update` on the property named in the row's `tool_args`, checked before the decision is written | `core/automation-approvals.controller.ts` decide(), same shape as probe consent |
| Execute | in-band at decide(), as the decider; the D14 hub registry is not used (the tool is barred there) | `executeApprovedConversionUpload` |

Two properties of the data worth knowing: the consent gate is strictly `visitor_consent.marketing === true` and runs at planning and again at execution; and the lead's contact fields and click id are read at execution, hashed in memory and never written down (the ledger, the approval args, the outbox and the logs hold ids, stages, kinds and typed reasons). Stage moves stay `triage`-tier (manager and up) as P1 ruled; a move is LOW because it cannot send anything: the upload needs its own approval. Proof: `modules/search/conversions.test.ts`, `conversions-consumer-wiring.test.ts` (no services) and `conversions.db.test.ts` (Linux gate).

**M5-P3 (Meta Conversions API) and M5-P4 (LinkedIn Conversions API, ERP side) add nothing to this table** (2026-10-13, PROTOTYPED). They are adapters on the same flow, so the same authorities apply unchanged: configuring a `meta_capi` or `linkedin_capi` target is `resource_search_property · update`, the reads are `read`, and an upload of either needs its own approval decided by someone holding the generic `decide` AND `update` on the row's property. No new kind, action, role or permission key, no policy change, no restart. Tenancy: every row is reached through `withTenants([tenantId], {modules:['search']})`, so another company's property is 404 and the lead's facts are read on the same tenant-scoped connection; no cross-tenant scope set is ever passed. Two properties worth stating for these platforms: the browser identifiers (`fbc`, `fbp`, `li_fat_id`) are used only when `visitor_consent.marketing === true`, checked by the gate at planning, again at execution, and a third time inside each request builder; and both platforms are simulate-only, so no personal data leaves the system at all today (the boot guard refuses either as a live platform). Proof: `modules/search/conversions-meta-linkedin.test.ts` (no services) and `conversions-meta-linkedin.db.test.ts` (Linux gate).

---

## 32. PV-5 billing actions (2026-10-12, PROTOTYPED)

Ticket: `docs/plans/2026-10-12-pv5-contracts-billing-tickets.md`, PV5-02. Rulings PV-D7 (the ledger is the invoice of record),
PV-D8 (two signature tiers). Seeded by `202610130500_iam_pv5_billing_actions.sql`. **Four new actions on three EXISTING kinds, no new kind,
no new role.** The handlers arrive in PV5-04 and PV5-06; until then nothing calls these actions, so no behaviour changes.

| Kind · action | Key | Who | Perm mirror | `uiGrantable` | Group |
|---|---|---|---|---|---|
| `invoice` · `issue` | `invoice.issue` | exactly the holders of `approve`: `company_admin`, `manager` (role arm, `inTenant && notLow`); `owner` by the permission arm; `platform_admin` by the wildcard. **Not maker/checker-bound** | yes, `perm_invoice_issue` | true | new `invoices_issue` |
| `invoice` · `void_issued` | `invoice.void_issued` | `company_admin` (role arm); `owner` by the permission arm; `platform_admin` by the wildcard. **Not `manager`** | yes, `perm_invoice_void_issued` | true | new `invoices_void_issued` |
| `finance_config` · `set_bank_details` | `finance.config.set_bank_details` | an `owner` or `finance_manager` grant at **company scope on this tenant** (inline `roles: ["user"]` rule, reads the grant, never `attr.perms`); `platform_admin` by the wildcard. **Not `company_admin`** | **none** | **false** | `advancedOnly` |
| `contract` · `mark_certified` | `core.contract.mark_certified` | exactly the holders of `send`: `company_admin` (role arm); `owner` by the permission arm; `platform_admin` by the wildcard | yes, `perm_contract_mark_certified` | true | new `client_contracts_certify` |

The portal gets **no new action**: Documents reads use `portal` `read`, and online payment uses the existing `portal` `pay`.

**Bots and automation (T7's shape).** `issue` and `void_issued` on `invoice`, and `set_bank_details` on `finance_config`, carry a
`roles: ["user"]` `EFFECT_DENY` when `principal.attr.kind in ["automation", "bot"]`. Under deny-overrides it beats every ALLOW: the
`platform_admin` wildcard, the permission-arm mirrors and the inline grant rules. `mark_certified` carries no such DENY (the ticket does not
ask for one). A **delegated** call by a bot is refused too, because `authorize()` checks the caller first; the acting human is only the
second check (`core/http.ts`). **What the DENY cannot see:** an agent running under a human's own identity envelope assembles as that human
(kind `employee`), so the DENY does not fire for it. `issue` and `void_issued` are held back on that path by the tool registry's D14
impact tier (PV5-12), and no agent tool sets bank details or marks a contract certified.

**Why `void_issued` has a mirror and `set_bank_details` does not.** `owner` is permission-native (section 28): it has no role rules, so it reaches
an action only through a `perm_*` mirror or an inline grant rule. `void_issued` is held by `company_admin`, so the key lands in
`company_admin`'s bundle and owner's (owner = company_admin's set); the standard mirror is then both the way owner reaches it and the shape of
the sibling keys. A custom role holding the key would also reach it, which is the catalog's meaning of `grantable`; today only migrations
write `role_permissions`, so the holders are exactly the three above. `set_bank_details` follows `countersign` (PV3-01) instead: it redirects
real money, so it is reached only through a grant and a key holder gets nothing. It is also **not written through `module_manager`**:
that derived role would bundle the key onto `finance_manager`, and a `ui_grantable = false` key in a bundle makes the role unattachable to
positions (position_roles_guard clause (b)), while `ui_grantable = true` would advertise a key no UI-built role can use. The inline
rule has the same reach for the two named roles and leaves the bundles alone.

**Bundles (regenerated, not hand-edited).** `platform_admin` +4 (all four, by wildcard), `company_admin` +3 (issue, void_issued, mark_certified),
`owner` +3 (equal to `company_admin`), `manager` +1 (issue). `finance_manager` gains no bundle row: it reaches `set_bank_details` by its grant.
`set_bank_details` is bundled on `platform_admin` alone, like `core.contract.countersign`.

**Pinned counts moved (deliberately), recomputed on the tree combined with PV4-02** (main's value, my delta, final):

| Pin | main | delta | final |
|---|---|---|---|
| Catalog pairs (`cerbos-catalog-alignment`, `ui-grantable-catalog`) | 439 | +4 | 443 |
| Grantable (`permission-groups-catalog-parity`, `ui-grantable-catalog`) | 424 | +4 | 428 |
| Sensitive (`_meta.counts`) | 204 | +4 | 208 |
| Kinds (`iam-215-boundary-pin`, alignment) | 104 | 0 | 104 |
| `ui_grantable = false` (`iam-phase2-ui-grantable-guard.test.ts`) | 25 | +1 | 26 |
| `ui_grantable = true` (`_meta.uiGrantable`) | 414 | +3 | 417 |
| Authoring groups | 158 | +3 | 161 |
| Covered by groups | 386 | +3 | 389 |
| advancedOnly | 38 | +1 | 39 |
| Sensitive groups | 108 | +3 | 111 |
| Role bundle pairs (regenerated) | 1923 | +11 (platform_admin +4, company_admin +3, owner +3, manager +1) | 1934 |

**What the wildcard grants, and PV-D26 (owner ruling, 2026-10-12).** `resource_invoice.yaml`, `resource_contract.yaml` and
`resource_finance_config.yaml` each open with `actions: ["*"]` for `platform_admin`, so that wildcard grants **all four new actions**,
`set_bank_details` included, at global scope on any tenant (a bot or automation account holding it is refused by the DENY). The owner ruled
that this **stays**, and added a bar: **PV-D26: the operator keeps access; high assurance for everyone; every change notifies all owners
(PV5-04).** Two `EFFECT_DENY` rules under `roles: ["user"]` (so deny-overrides beats the wildcard), both with the fail-closed condition
`!has(request.principal.attr.assurance) || request.principal.attr.assurance != "high"`, on the attribute `vendor_master` already reads
(`"low" | "linked" | "high"`; a plain SSO login is `linked`, the ruling's "medium"):

| Where | Action | Effect |
|---|---|---|
| `resource_finance_config.yaml` | `set_bank_details` (our own account) | owner, finance_manager and platform_admin all need high assurance (PV-D26); relaxed for an owner / finance_manager by PV-D29 below, **relaxation lifted 2026-10-13 by PV-D40 (PV5-14): unconditional again** |
| `resource_finance_ap.yaml` | `vendor_master` (**supplier** bank details; scope note: an AP change made by this ticket) | its ALLOW already required high, but the `*` wildcard bypassed it; platform_admin now needs high too |

Every other AP rule is byte-identical. The notification to all owners is wired by PV5-04, not here.

**PV-D29 (owner ruling, 2026-10-13): interim until MFA is enabled (`infra/runbooks/enable-mfa.md`); then restore PV-D26's unconditional
high-assurance DENY.** Live Keycloak emits no `amr` claim (the platform logs `[oidc:amr-claim-missing]` on every login), so no web session
ever reaches `assurance: high`, and PV-D26's DENY made our own bank details unsettable on live (and so no invoice issuable). The
`set_bank_details` DENY is therefore narrowed in `resource_finance_config.yaml` only: it fires when the principal is below high **and**
holds **no** `owner` / `finance_manager` grant at company scope on this tenant (the same grant expression as the ALLOW). Effect:
an owner or finance_manager of the company can change the bank details at `linked` assurance (`low` is still refused by `notLow` in the
ALLOW); `platform_admin` still needs high, which is unreachable today, so the operator cannot; bots and automation are refused by their own
DENY; `company_admin` has no ALLOW at all. **`finance_ap` `vendor_master` is unchanged**: the ruling covers our own bank details only, and
PV-D26's unconditional DENY stays there. To restore PV-D26 for `set_bank_details`, drop the grant clause from that DENY and flip the two
`linked` owner / finance_manager expectations in `pv5-billing-actions-cerbos.test.ts`.

**PV-D40 (owner ruling, 2026-10-13; PV5-14): PV-D29's bypass is LIFTED, PV-D26 applies in full again, met on the dev stage
by a SIMULATED second factor.** The `set_bank_details` assurance DENY in `resource_finance_config.yaml` is unconditional again
(`!has(request.principal.attr.assurance) || request.principal.attr.assurance != "high"`, the same expression as `vendor_master`):
an owner or finance_manager of the company at `linked` is denied, as is platform_admin. No policy was added for the simulation:
"high" is reached through `POST /api/auth/step-up/simulate` (platform-nest `src/auth/step-up.ts`; flag `MFA_SIMULATION_ENABLED`,
default off), which raises ONLY the caller's own interactive OIDC session (bound to the IdP `sid`), only for an `employee` with a
staff grant and membership, for 15 minutes, audited (`auth.step_up_simulated`). Such a principal reaches Cerbos with
`attr.assurance: "high"` and an extra, authorization-neutral `attr.assuranceSource: "simulated"` (sent only then; no policy reads
it). OBO envelopes, agents, D14 re-drives, bots, automation and portal principals can never be raised. Every other high-assurance
rule (finance tax configure and file, period close, write-offs, AP approve and payment release, vendor master, statement export,
posting-rule activate, control duties, HR exports and approvals) is unchanged and is met the same way. **Before real data:** the
flag goes off and real MFA is enabled (`infra/runbooks/enable-mfa.md`). The test flips are in `pv5-billing-actions-cerbos.test.ts`
(owner and finance_manager at `linked` now denied; a `simulated` principal decides exactly as `high`).

**Proof.** `src/rbac/pv5-billing-actions-cerbos.test.ts` (live Cerbos; per action a member denied, a bot and an automation account denied, the right
roles allowed, `company_admin` denied `set_bank_details`, a delegated bot call denied, and the PV-D26 assurance matrix for `set_bank_details` and `vendor_master`: owner, finance_manager and platform_admin each denied at `linked`, allowed at `high`), plus the static pins above and
`iam-04-reg1-mirror-reach-invariant` (the new mirrors are no wider than `company_admin`'s or `manager`'s role arm). **Restart
`gaiada-test-cerbos` and the live sidecar after deploying the policy files** (nothing hot-reloads).

---

## 33. M5-V3-f — visitor profiles and session replay: `read_visitors` and `view_replay` on `resource_search_property` (2026-10-12, PROTOTYPED)

Ticket: `docs/plans/2026-10-12-m5-phase5-design.md` section 8, V3-f; design sections 4.8 and 6.3; owner default O5. Seeded by
`202610131730_iam_m5_v3f_visitor_actions.sql`. **Two new actions on the EXISTING `resource_search_property` kind: no new kind, no new role.** No handler
calls them yet: the visitors controller is V3-g and the replay routes are V6-b, so until those land nothing changes in behaviour.

Both are **sensitive**: they expose personal data of identified website visitors (consented profiles, V3; our own sampled recordings, V6).
They are two keys on purpose. A recording is more intrusive than a profile, so each can be granted without the other, and neither is implied by
`search.property.read`.

| Action | Key | Who | Perm mirror | `uiGrantable` | Group |
|---|---|---|---|---|---|
| `read_visitors` | `search.property.read_visitors` | `search_manager` (derived role `module_manager`) and `company_admin`, `inTenant && notLow`; `owner` by the permission arm; `platform_admin` by the wildcard. **Not `search_staff`** | yes, `perm_resource_search_property_read_visitors` | true | new `search_read_visitors` |
| `view_replay` | `search.property.view_replay` | the same set. **Not `search_staff`** | yes, `perm_resource_search_property_view_replay` | true | new `search_view_replay` |

**Plain `module_staff` keeps aggregate `read` only.** The new rule names `["read_visitors", "view_replay"]` alone, so neither action can ride the
baseline `read / create / update` rule. No `member`, `viewer`, `client`, generic `manager`, `webdev_*` or any other module tier holds either key.

**What a granted permission grants.** One mirror per action, each keyed on its own permission, with the kind's usual condition
(`inTenant && notLow && inRoot`). A holder of `search.property.read_visitors` reaches `read_visitors` and nothing else: not `view_replay`, not
`read`, not `attest`. The reverse holds for `view_replay`. This is how plain search staff can be given the right, by an explicit grant. The
mirrors are not mediated by `resource.attr.module`; the role arm is (it needs a `search_manager` grant and module `search`). Every handler of this
kind passes module `search`, so the difference is unreachable today; it is recorded in `iam-04-reg1-mirror-reach-invariant` next to `attest`'s
identical entry. **The V3-g and V6-b handlers must pass `module: "search"` and `tenantId: <the served company>`** like `SearchController`.

**Bundles (regenerated by `scripts/generate-role-bundles.mjs`, not hand-edited; no resolver change was needed, the kind already maps).** Exactly
`platform_admin`, `company_admin`, `search_manager` and `owner` gain both keys (+8 pairs). `search_staff` gains nothing. The migration asserts the
holder set in both directions and that `owner` still equals `company_admin` on the two keys.

**Pinned counts moved (deliberately)**, on the tree at `origin/main` db9803ba:

| Pin | before | delta | after |
|---|---|---|---|
| Catalog pairs (`cerbos-catalog-alignment`, `ui-grantable-catalog`) | 443 | +2 | 445 |
| Grantable (`permission-groups-catalog-parity`, `ui-grantable-catalog`) | 428 | +2 | 430 |
| Sensitive (`_meta.counts`) | 208 | +2 | 210 |
| Kinds | 104 | 0 | 104 |
| `ui_grantable = false` (`iam-phase2-ui-grantable-guard`) | 26 | 0 | 26 |
| `ui_grantable = true` (`_meta.uiGrantable`) | 417 | +2 | 419 |
| Authoring groups / covered by groups / sensitive groups | 161 / 389 / 111 | +2 / +2 / +2 | 163 / 391 / 113 |
| Role bundle pairs (regenerated) | 1934 | +8 (platform_admin +2, company_admin +2, search_manager +2, owner +2) | 1942 |

**Proof.** `cerbos/tests/search_visitors_test.yaml` (23 principals x 4 resources x 7 actions; run with `cerbos compile --tests` on the Linux gate);
`src/rbac/search-visitor-actions-cerbos.test.ts` (live Cerbos: staff denied, manager and company admin allowed, other tenant denied, a granted key grants
exactly its action, root and assurance bounds); `src/rbac/search-visitor-actions-catalog.db.test.ts` (static agreement of catalog, groups, bundles, policy
and migration, plus the DB rows after migrating); and the pinned counts above. **Deploy: restart the Cerbos container and the live sidecar** (nothing hot-reloads),
then probe: a `search_staff` principal is denied `read_visitors` and `view_replay`, a `search_manager` of the same company is allowed both, and a permission-only
principal holding one key is allowed that one action.

---

## 34. PV4-05 — `share_minutes` on `meeting_recording`, and its agent DENY (2026-10-12, PROTOTYPED)

Plan: `docs/plans/2026-10-12-pv4-conversation-tickets.md` (PV4-05; design decision 9; owner ruling PV-D23). Status: **PROTOTYPED** (policy, catalog,
bundles, migration and tests are in the repo; the HTTP and live-Cerbos suites run on the Linux CI gate; the live Cerbos restart is the deploy step).
BFF: `FRONTEND-BFF-CONTRACT.md` §29c.

**One new action on an EXISTING kind, no new kind.** `meeting_recording` gains `share_minutes`: publish a meeting's **minutes** (the `meeting_minutes`
table, PV4-01) to the meeting's client in the portal. The recording, transcript, participants and pipeline run stay internal; `meeting` stays in
`NEVER_CLIENT_VISIBLE`, and only shared minutes reach a client (`meetingMinutesInPortalScope`).

- **Reach: exactly the roles that hold `update` on this kind today** (`company_admin`, `manager`, `member`, under `variables.inTenant && variables.notLow`);
  `viewer` holds neither. Whoever may edit a meeting may share its minutes. Perm mirror `perm_meeting_recording_share_minutes` (key
  `core.meeting_recording.share_minutes`, `inTenant && notLow && inRoot`), so a permission holder (and the permission-native `owner`) reaches it too.
  The key is **sensitive** (words put in front of a client under a named person) and `ui_grantable`.
- **Agent DENY (PV-D23).** `EFFECT_DENY` of `share_minutes` for `principal.attr.kind in ["automation", "bot"]`, on `roles: ["user"]` (every principal carries it),
  so under deny-overrides it beats every ALLOW: the `platform_admin` wildcard and the perm mirror included. Same shape as `resource_conversation.yaml`
  (PV4-02) and `resource_webdesk_content_item.yaml`'s `publish`. **`update` is deliberately NOT denied**: an agent may DRAFT minutes
  (`PUT /meetings/:id/minutes`, which records `drafted_by`); a person reads them and shares. Delegation: `authorize()` checks the caller and the `actFor`
  human, and either denial refuses.
- **The client never touches this kind.** A contact reads shared minutes through `portal` `read` (`GET /portal/meetings`, `/portal/meetings/:minutesId`);
  the `client` derived role still appears only in `resource_portal.yaml` (`client-role-only-in-portal.test.ts`).
- **Seeded by** `migrations/202610131740_iam_meeting_minutes_share.sql` (copied from `202610130500_iam_pv5_billing_actions.sql`'s existing-kind shape; the DO-block
  asserts the exact holder set in both directions, that it equals the holders of `update`, and owner == company_admin). Held by `platform_admin`,
  `company_admin`, `owner`, `manager`, `member`: 5 bundle rows. Authoring group `meeting_minutes_share` (its own group, so granting meeting editing does not
  carry sharing; sensitive).
- **Proof.** `src/rbac/cerbos-meeting-minutes.test.ts` (static pin always; live matrix on the gate: a member who may update may share; a `kind=bot` principal
  holding `company_admin` is DENIED `share_minutes` and ALLOWED `update`; the same for `automation`, `platform_admin`, an owner-shaped bot and a bot holding
  only the mirror) and the HTTP suite `src/core/meeting-minutes.controller.test.ts` (a bot gets a 403 on share and 200 on saving a draft).

**Pinned counts moved (deliberately), on top of M5-V3-f** (rebased by the lead 2026-10-13; main's value, my delta, final): concrete pairs / grantable
pairs 445 / 430 -> **446 / 431**; sensitive 210 -> **211**; kinds 104 (unchanged); `ui_grantable = true` 419 -> **420** (re-derived from the array);
authoring groups 163 -> **164**; covered by groups 391 -> **392**; sensitive groups 113 -> **114**; role bundle
pairs 1942 -> **1947** (platform_admin +1, company_admin +1, owner +1, manager +1, member +1). Tests moved: `cerbos-catalog-alignment`,
`permission-groups-catalog-parity`, `ui-grantable-catalog`; `iam-215-boundary-pin` unchanged (no new kind). **Restart `gaiada-test-cerbos` and the live sidecar after
deploying the policy files** (nothing hot-reloads).

## 35. DW-5a — the `agency_campaign_part` kind (2026-10-14, PROTOTYPED)

Design: `docs/FRONTEND-BFF-CONTRACT.md` §31 (plan `docs/plans/2026-10-13-department-workspaces.md` §7.1, ruling DW-D13). Status: **PROTOTYPED** (policy, catalog, bundles and tests are in the repo; the live Cerbos probe after a restart is the deploy step).

**A new kind, `agency_campaign_part` (module `agency`), with five actions.** `resource_agency_campaign_part.yaml`, keys `agency.campaign_part.{read,create,update,delete,allocate}`:

| Action | Reach | What it is |
|---|---|---|
| `read` | `company_admin`, `manager`, `member`, `viewer` (`inTenant && notLow`) | see a campaign's parts |
| `create`, `delete` | `company_admin`, `manager` | add or remove a department from a campaign |
| `allocate` | `company_admin`, `manager` | any write that sets or changes a part's `budgetMinor`; apart from `update` so an owner or head can never move money |
| `update` | `company_admin`, `manager`; **its own rule** for the part's owner (`member` + `variables.owns`); **its own rule** for `org_unit_lead` (the part's `unit_id` expanded through `org_unit_closure` into `unitAncestors`) | status, owner, brief, due date, links |

Each attribute-dependent rule stands alone (the HIER-2 authoring rule): `org_unit_lead` is never mixed with a scope role, and the owner rule names `member` only. `ownerId` and `unitAncestors` are fed by the handler from the part row and are already in `cerbos.ts`'s `Resource` type and `resourcePayload()` allow-list, so `cerbos.ts` needed no change; an unfed resource fails closed.

**The permission arm covers `read`, `create`, `delete` and `allocate`, and deliberately NOT `update`.** The owner rule (self-scoped) and the lead rule (attribute-dependent) are the shapes a flat `perms` mirror cannot express; a `perm_*update` rule fails `permission-arm-hazard-scan.test.ts` (Pattern B) and `iam-04-reg1-mirror-reach-invariant.test.ts`. This is `time_entry`'s call for its own update/delete. Consequence: the permission-native `owner` role holds the `update` key in its bundle (it mirrors `company_admin` exactly) but reaches `update` through Cerbos only if it also holds `company_admin` or `manager`.

**Bundles and the marker.** `company_admin`, `owner`, `manager`, `platform_admin` hold all five; `member` holds `read` and `update` (a **self-scoped** pair, `selfScoped.member`); `viewer` holds `read`; `org_unit_lead` holds `update` (not self-scoped: it acts on other people's parts); no other role holds any. None of the five keys is `sensitive` (see FRONTEND-BFF-CONTRACT §31.7, deviation 4).

**The six artifacts** (the `conversation` template, commit `46290cd3`): policy and four derived roles; `cerbos.ts` (no change); `permission-catalog.json` (+5 keys: 105 kinds, 451 pairs, 436 grantable, 15 relationship, 211 sensitive); `permission-groups.json` (+1 group, `agency_campaign_parts`); migration `202610140510_iam_agency_campaign_part_permissions.sql` (24 role rows, with a DO-block self-assertion including the owner-mirrors-company_admin invariant and the self-scoped marker); the bundle generator (no resolver change: the kind names only direct roles) and `role-permission-bundles.json` regenerated from a clean worktree. Pinned literals moved: `cerbos-catalog-alignment` 446 -> 451 and 104 -> 105 kinds, `permission-groups-catalog-parity` 431 -> 436, `ui-grantable-catalog` 446/431 -> 451/436, `iam-215-boundary-pin` 104 -> 105 kinds and 100 -> 101 non-exempt. Proof: `src/rbac/cerbos-agency-campaign-part.test.ts` (static pin always; live matrix needs `CERBOS_URL`). **Restart `gaiada-test-cerbos` and the live sidecar after deploying the policy files** (nothing hot-reloads).

## 36. DW-5c — the `work_request` kind (2026-10-14, PROTOTYPED)

Design: `docs/FRONTEND-BFF-CONTRACT.md` §32 (plan `docs/plans/2026-10-13-department-workspaces.md` §7.2 and §7.3, ruling DW-D14). Status: **PROTOTYPED** (policy, catalog, bundles and tests are in the repo; the live Cerbos probe after a restart is the deploy step).

**A new core kind, `work_request` (no module), with five actions.** `resource_work_request.yaml`, keys `core.work_request.{read,create,cancel,deliver,decline}`: one REQUEST between departments (a department asks another for assets, or asks Web Dev for engineering work).

| Action | Reach | What it is |
|---|---|---|
| `read` | `company_admin`, `manager`, `member`, `viewer` (`inTenant && notLow`) | see requests (the same reach as reading PM tasks, because an asset request IS a PM task) |
| `create` | `company_admin`, `manager`, `member` | ask another department; any workspace can ask, a viewer cannot |
| `cancel` | `company_admin`, `manager`; **its own rule** for the requester (`requestedBy == principal.id`, held as `member`) | withdraw an ask, only while it is `open` |
| `deliver` | `company_admin`, `manager`; **its own rule** for the work's assignees (`principal.id in assigneeIds`, held as `member`); **its own rule** for `org_unit_lead` over the receiving unit (`unitAncestors`) | hand over finished assets (asset requests only) |
| `decline` | `company_admin`, `manager`; **its own rule** for `org_unit_lead` over the receiving unit | refuse an asset request (engineering requests are declined by Web Dev triage) |

Each attribute-dependent rule stands alone (the HIER-2 authoring rule): `org_unit_lead` is never mixed with a scope role, and the requester and assignee rules name `member` only.

**`EFFECT_DENY` on `create`, `cancel`, `deliver` and `decline` for `principal.attr.kind in ["automation","bot"]`**, shaped exactly like `resource_conversation.yaml`'s (`roles: ["user"]`, `has()`-guarded), so it beats every ALLOW, the `platform_admin` wildcard and the permission mirrors under deny-overrides. `read` stays allowed. Agents may triage later, under the separate AI plan.

**Three new resource attributes, fed by the handler and never by a body.** `requestedBy` (from `work_requests.requested_by`), `assigneeIds` (the PM task's responsible person plus every person on an open owner, responsible or contributor row, unioned with the task's assignee blob) and `unitAncestors` (the request's `to_unit_id` expanded through `org_unit_closure`). `requestedBy` and `assigneeIds` are **new** entries in both the `Resource` type and the `resourcePayload()` allow-list in `src/rbac/cerbos.ts`, with fail-closed defaults (`""` and `[]`); an attribute missing from that allow-list is silently dropped. An unfed resource denies.

**The permission arm covers `read` and `create` only.** `cancel` (requester rule: self-scoped, `permission-arm-hazard-scan` Pattern B), `deliver` (assignee rule: self-scoped; lead rule: attribute-dependent) and `decline` (lead rule: attribute-dependent, fails `iam-04-reg1-mirror-reach-invariant`) are exactly the shapes a flat `perms` mirror cannot express, so they carry no `perm_*` rule. This is DW-5a's call for `agency_campaign_part` `update`. Consequence: the permission-native `owner` role (zero role-arm rules) holds all five keys in its bundle but reaches only `read` and `create` through Cerbos, unless it also holds `company_admin` or `manager`.

**Bundles and the marker.** `company_admin`, `owner`, `manager`, `platform_admin` hold all five; `member` holds `read`, `create` and two **self-scoped** pairs (`cancel`, `deliver`; `selfScoped.member`); `viewer` holds `read`; `org_unit_lead` holds `deliver` and `decline` (not self-scoped: it acts on other people's requests); no other role holds any. None of the five keys is `sensitive`.

**The six artifacts** (the `conversation` / `agency_campaign_part` template): policy and two derived roles (`perm_work_request_read`, `perm_work_request_create`); `cerbos.ts` (the two new attributes); `permission-catalog.json` (+5 keys: 106 kinds, 456 pairs, 441 grantable, 15 relationship, 211 sensitive); `permission-groups.json` (+1 group, `work_requests`); migration `202610140610_iam_work_request_permissions.sql` (27 role rows, with a DO-block self-assertion including the owner-mirrors-company_admin invariant and the two self-scoped markers); the bundle generator (no resolver change) and `role-permission-bundles.json` regenerated. Pinned literals moved: `cerbos-catalog-alignment` 451 -> 456 and 105 -> 106 kinds, `permission-groups-catalog-parity` 436 -> 441, `ui-grantable-catalog` 451/436 -> 456/441, `iam-215-boundary-pin` 105 -> 106 kinds and 101 -> 102 non-exempt. Proof: `src/rbac/cerbos-work-request.test.ts` (static pin always; live matrix needs `CERBOS_URL`). **Restart `gaiada-test-cerbos` and the live sidecar after deploying the policy files** (nothing hot-reloads).

## 37. DW-6h — the `creative_asset` kind (2026-10-13, PROTOTYPED)

Design: `docs/FRONTEND-BFF-CONTRACT.md` §35.4 (plan `docs/plans/2026-10-13-department-workspaces.md` §4.2 and §14.3). Status: **PROTOTYPED** (policy, catalog, bundles and tests are in the repo; the live Cerbos probe after a restart is the deploy step).

**A new core kind, `creative_asset` (no module), with four actions.** `resource_creative_asset.yaml`, keys `core.creative_asset.{read,request_review,decide_review,withdraw_review}`: the REVIEW ROUNDS of an Asset Library asset (`creative_assets`, its version group). **The asset routes themselves keep the generic `file` kind** (list, save including a new version, read, stream, delete); moving them would be an access change, which DW-6h does not make.

| Action | Reach | What it is |
|---|---|---|
| `read` | `company_admin`, `manager`, `member`, `viewer` (`inTenant && notLow`) | see an asset's rounds |
| `request_review` | `company_admin`, `manager`, `member` | open a round on the latest version; a viewer cannot |
| `decide_review` | `company_admin`, `manager`; **its own rule** for `org_unit_lead` over the asset's department (`unitAncestors`); **its own rule** for a requester of a linked work request (`principal.id in requesterIds`, held as `member`) | approve, or request changes with a comment |
| `withdraw_review` | `company_admin`, `manager`; **its own rule** for the opener (`reviewRequestedBy == principal.id`, held as `member`) | close an open round without a decision |

Each attribute-dependent rule stands alone (the HIER-2 authoring rule), and every relationship condition is written INLINE in its rule (never behind a policy variable), so the bundle generator and the permission-arm hazard scan see the self-scope.

**Two `EFFECT_DENY` rules on `decide_review`, both on `roles: ["user"]`**, so under deny-overrides they beat every ALLOW, the `platform_admin` wildcard and the permission mirrors:
- **maker/checker:** `has(reviewRequestedBy) && reviewRequestedBy != "" && reviewRequestedBy == principal.id`. Nobody decides a round they opened, whatever their role. The guard has the invoice `approve` shape (it fires on a KNOWN opener): the handler always feeds the opener from the round row, and a fail-closed form would make every scope-level probe that sends no round report `decide_review` as unreachable for `platform_admin`.
- **agents:** `principal.attr.kind in ["automation","bot"]`, shaped like `resource_work_request.yaml`'s. Only `decide_review` is denied.

**Two new resource attributes, fed by the handler and never by a body.** `requesterIds` (the `requested_by` of every live work request any version of the group was delivered against, via `work_request_assets`) and `reviewRequestedBy` (the round's `requested_by`). Both are new entries in the `Resource` type and the `resourcePayload()` allow-list in `src/rbac/cerbos.ts`, defaulting to `[]` and `""`. `unitAncestors` (already listed) is the version's `department_id` expanded through `org_unit_closure`.

**The permission arm covers `read` and `request_review` only.** `decide_review` (lead rule: attribute-dependent; requester rule: self-scoped) and `withdraw_review` (opener rule: self-scoped) are shapes a flat `perms` mirror cannot express. Consequence: the permission-native `owner` role holds all four keys in its bundle but reaches only `read` and `request_review` through Cerbos, unless it also holds `company_admin` or `manager`.

**Bundles and the marker.** `company_admin`, `owner`, `manager`, `platform_admin` hold all four; `member` holds `read`, `request_review` and two **self-scoped** pairs (`decide_review`, `withdraw_review`; `selfScoped.member`); `viewer` holds `read`; `org_unit_lead` holds `decide_review` (not self-scoped); no other role holds any. None of the four keys is `sensitive`.

**The six artifacts** (the `work_request` template): policy and two derived roles (`perm_creative_asset_read`, `perm_creative_asset_request_review`); `cerbos.ts` (the two new attributes); `permission-catalog.json` (+4 keys: 107 kinds, 460 pairs, 445 grantable, 15 relationship, 211 sensitive); `permission-groups.json` (+1 group, `creative_asset_reviews`); migration `202610140740_iam_creative_asset_permissions.sql` (22 role rows, with a DO-block self-assertion including the owner-mirrors-company_admin invariant and the two self-scoped markers); both bundle resolvers (`scripts/generate-role-bundles.mjs` and `role-permission-parity.db.test.ts`: no change, the kind names only direct roles and both skip `perm_*`) and `role-permission-bundles.json` regenerated. Pinned literals moved: `cerbos-catalog-alignment` 456 -> 460 and 106 -> 107 kinds, `permission-groups-catalog-parity` 441 -> 445, `ui-grantable-catalog` 456/441 -> 460/445, `iam-215-boundary-pin` 106 -> 107 kinds and 102 -> 103 non-exempt; `principal-scope-constrained-perms.db.test.ts`'s org_unit_lead key list gains `core.creative_asset.decide_review`. Proof: `src/rbac/cerbos-creative-asset.test.ts` (static pin always; live matrix needs `CERBOS_URL`) and the HTTP suite `src/core/creative-reviews.test.ts`. **Restart `gaiada-test-cerbos` and the live sidecar after deploying the policy files** (nothing hot-reloads).

## 38. DW-4e-1 — the `dept_kpi_target` kind (2026-10-14, PROTOTYPED)

Design: `docs/FRONTEND-BFF-CONTRACT.md` §40 (plan `docs/plans/2026-10-13-department-workspaces.md` §5.5, owner ruling DW-Q4). Status: **PROTOTYPED** (policy, catalog, bundles and tests are in the repo; the live Cerbos probe after a restart is the deploy step).

**A new kind, `dept_kpi_target` (module `reports`), with four actions.** `resource_dept_kpi_target.yaml`, keys `reports.dept_kpi_target.{read,propose,approve,reject}`: a department KPI's target (the head proposes, the approver approves), and the read of a department's KPIs, condition and standing.

| Action | Reach | What it is |
|---|---|---|
| `read` | `company_admin`, `manager`, `member`, `viewer`; **its own rule** for the HR read tier (`hr_people_reader`) (`inTenant && notLow`) | see a department's KPIs, condition and targets. Tenant-wide in Cerbos on purpose: the handler narrows it to the people placed in the unit today, its heads and the company-wide tiers (placement is not a Cerbos fact), and the standing of all departments to the company-wide tiers only |
| `propose` | `company_admin`; **its own rule** for `org_unit_lead` of the unit or an enclosing one (`unitAncestors`) | propose a target for one of the unit's KPIs, from a month start |
| `approve` | `company_admin` only | put a proposal in force (supersedes the approved rows from the same month on) |
| `reject` | `company_admin` only | refuse a proposal |

`manager` holds no decision: every head's lead position carries `manager` company-wide, so it cannot mean "the GM" (FRONTEND-BFF-CONTRACT §40.2). Whether the Office of the GM's lead seat should also approve is an open owner decision. A proposer never approves their own proposal: an inequality on the row's `proposed_by`, checked by the service (409 `cannot_approve_own_proposal`), not by Cerbos.

**One resource attribute, fed by the handler and never by a body.** `unitAncestors` (the target unit's node id expanded through `org_unit_closure`): from the request's `unitNodeId` on propose, from the stored row on approve and reject. It was already in the `resourcePayload()` allow-list, so `cerbos.ts` only gains a comment. An id outside the org tree has no closure rows, so a head is refused (403) before anything reveals whether it exists.

**The permission arm covers `read`, `approve` and `reject`; not `propose`.** `propose` is reachable through the attribute-dependent `org_unit_lead` rule, which a flat `perms` mirror cannot express (`iam-04-reg1-mirror-reach-invariant`): a mirror would let a head propose for every unit. Same call as `work_request`'s `decline`. Consequence: the permission-native `owner` role reads, approves and rejects through its bundle, but proposes only if it also holds `company_admin` or leads the unit.

**Bundles.** `company_admin`, `owner`, `platform_admin` hold all four; `manager`, `member`, `viewer`, `hr_staff`, `hr_manager` hold `read`; `org_unit_lead` holds `propose`; no other role holds any. No self-scoped pair. None of the four keys is `sensitive`.

**The six artifacts** (the `work_request` template): policy and three derived roles (`perm_dept_kpi_target_read`, `_approve`, `_reject`); `cerbos.ts` (comment only); `permission-catalog.json` (+4 keys, on top of DW-6h's §37: 108 kinds, 464 pairs, 449 grantable, 15 relationship, 211 sensitive); `permission-groups.json` (+1 group, `dept_kpi_targets`); migration `202610140810_iam_dept_kpi_target_permissions.sql` (18 role rows, with a DO-block self-assertion including the owner-mirrors-company_admin invariant); the bundle generator (no resolver change: the kind names only direct roles and `hr_people_reader`) and `role-permission-bundles.json` equal to the generator's derivation (checked with a port of the generator, which reproduces main's file exactly; totalPairs 2020 -> 2038). Pinned literals moved (on top of DW-6h): `cerbos-catalog-alignment` 460 -> 464 and 107 -> 108 kinds, `permission-groups-catalog-parity` 445 -> 449, `ui-grantable-catalog` 460/445 -> 464/449, `iam-215-boundary-pin` 107 -> 108 kinds and 103 -> 104 non-exempt; `principal-scope-constrained-perms.db.test.ts` lists `reports.dept_kpi_target.propose` among a head's unit-scoped keys. Proof: `src/rbac/cerbos-dept-kpi-target.test.ts` (static pin always; live matrix needs `CERBOS_URL`). **Restart `gaiada-test-cerbos` and the live sidecar after deploying the policy files** (nothing hot-reloads).

## 38a. DW-4e-3 — `appraisal_comment` and `appraisal_assess` on `dept_kpi_target` (2026-10-15, PROTOTYPED)

Design: `docs/FRONTEND-BFF-CONTRACT.md` §41 (plan `docs/plans/2026-10-13-department-workspaces.md` §5.3 and §5.5, owner ruling DW-Q4). Status: **PROTOTYPED** (policy, catalog, bundles, migrations and tests are in the repo; the live Cerbos probe after a restart is the deploy step).

**Two more actions on the existing kind, no new kind.** Keys `reports.dept_kpi_target.appraisal_comment` and `reports.dept_kpi_target.appraisal_assess`: the head's commentary and the GM's assessment on a department's appraisal for a cycle. Reading the appraisal uses the kind's existing `read` (the handler narrows it to the unit's heads and the company-wide tiers; staff of the unit are refused).

| Action | Reach | What it is |
|---|---|---|
| `appraisal_comment` | `company_admin`; **its own rule** for `org_unit_lead` of the unit or an enclosing one (`unitAncestors`) | write the head's commentary on the department's appraisal for an open cycle |
| `appraisal_assess` | `company_admin` only (the approver tier, the same that approves targets; `owner` mirrors it through the permission arm) | write the GM's assessment and judged condition |

`manager` holds neither (every head's company-wide role cannot mean "the GM", as for `approve`), and the HR tier only reads. Both writes end when the cycle is `closed` (409 `cycle_closed`: the service's rule, the cycle status is not a Cerbos fact).

**The mirror call, the same as propose vs approve (§38).** `appraisal_assess` is reached only through the `company_admin` rule, so it HAS a permission-arm mirror (`perm_dept_kpi_target_appraisal_assess`) and the permission-native `owner` assesses through its bundle. `appraisal_comment` is also reached through the attribute-dependent `org_unit_lead` rule, which a flat `perms` mirror cannot express (`iam-04-reg1-mirror-reach-invariant`): NO mirror. `owner` still holds the key in its bundle (owner == company_admin) but comments only if it also holds `company_admin` or leads the unit, exactly as it proposes; the UI parity register records that as an under-claim of `owner`.

**Bundles** (hand-edited to the generator's derivation; `totalPairs` 2038 -> 2045): `platform_admin` 449 -> 451, `company_admin` 412 -> 414, `owner` 412 -> 414, `org_unit_lead` 21 -> 22; every other role unchanged. A head's unit-scoped keys gain `appraisal_comment` (`principal-scope-constrained-perms.db.test.ts`). Neither key is `sensitive` or self-scoped.

**Artifacts.** `resource_dept_kpi_target.yaml` (the `company_admin` rules for both actions, the head's own `appraisal_comment` rule, the `appraisal_assess` mirror), `derived_roles.yaml` (+`perm_dept_kpi_target_appraisal_assess`), `permission-catalog.json` (+2 keys: 464 -> 466 pairs, 449 -> 451 grantable, 108 kinds unchanged), `permission-groups.json` (the two keys join the `dept_kpi_targets` group: 449 -> 451 grantable, 410 -> 412 covered), `role-permission-bundles.json`, and migration `202610150100_iam_dept_appraisal_permissions.sql` (7 `role_permissions` rows: 3 x 2 + 1, with a DO-block self-assertion: `appraisal_assess` held only by `platform_admin`/`company_admin`/`owner`, `owner` == `company_admin` over the whole kind, 25 `dept_kpi_target` rows on global roles). Pinned literals moved: `cerbos-catalog-alignment` 464 -> 466 (kinds stay 108), `permission-groups-catalog-parity` 449 -> 451, `ui-grantable-catalog` 464/449 -> 466/451 (`iam-215-boundary-pin` unchanged: no new kind). Proof: `src/rbac/cerbos-dept-kpi-target.test.ts` (role x action matrix extended to six actions; static pin always, live matrix needs `CERBOS_URL`). **Restart `gaiada-test-cerbos` and the live sidecar after deploying the policy files** (nothing hot-reloads).

## 38b. DW-4j — the head's KPI alerts and the scheduled run, BFF §43 (2026-10-15, PROTOTYPED for 4j-1 and the 4j-3 backend): no new kind, no new action

- **Acknowledging an off-track alert** (`POST /dept-kpis/alerts/:id/acknowledge`) is a write. Its gate:
  - Cerbos `dept_kpi_target` · `read` with the unit's ancestry;
  - then a narrowing in the handler: the caller heads the alert's unit (holds `org_unit_lead` scoped to that node) or is in the company-wide tier.

  It records only that the alert was seen. It changes no target, no condition and no score, so it needs no write action of its own.
- **The scheduled run and the digest** (`POST /dept-kpis/watch` and `/digest`) reuse `report_admin` · `recompute` (company_admin, platform_admin), the gate of `POST /reports/facts/recompute`. The n8n automation account `wf:reports-kpi-watch` holds company_admin, like the other reports flows.
- **The drivers read** (`GET /dept-kpis/drivers`, 4j-3) uses the unit read's gate, narrowed to heads and the company-wide tier. Placed staff get 403. It is the department appraisal's gate, extracted as one function (`authorizeUnitHeadRead` in `dept-kpis.controller.ts`): Cerbos `dept_kpi_target` · `read` with the unit's ancestry, then `isCompanyWide` or the unit in `loadLedUnitScope`, then 404. A manager placed in the unit and the head of an enclosing unit hold the unit in their led scope and so pass, exactly as for the appraisal.

## 38c. DW-4h — the activity series, the day read and the person filter, BFF §44 (2026-10-15, PLANNED): no new kind, no new action

- **The series and the day read** (`GET /activity/series`, `/activity/day`) are core reads with no Cerbos kind of their own. They are gated by the person-axis rule `GET /pm/productivity` already applies, moved to a shared helper:
  - yourself;
  - the `unrestricted` or `company_wide` tier (HR's people readers included);
  - a `unit_scoped` caller for a person in their led scope (TR-25);
  - else 403.
- **`GET /work-activity?personId=`** keeps its Cerbos `work_activity:read`, and from 4h-1 also applies that person-axis rule for the named person. This closes a peer read that broke line-of-sight. The unfiltered feed is unchanged. The feed never lists the bridged, person-grain sources (`BRIDGED_SOURCES`) in any mode; they are read only through the gated series and day reads (amended 2026-10-15, DW-D19, DW-D29).

## 39. DW-8g — the `calendar_event` kind (2026-10-14, PROTOTYPED)

Design: `docs/FRONTEND-BFF-CONTRACT.md` §47 (plan `docs/plans/2026-10-13-department-workspaces.md` §8.1, row 8g). Status: **PROTOTYPED** (policy, catalog, bundles and tests are in the repo; the live Cerbos probe after a restart is the deploy step).

**A new core kind, `calendar_event` (no module), with five actions.** The policy is `resource_calendar_event.yaml`, with keys `core.calendar_event.{read,create,update,cancel,respond}`. One resource is one event on the company calendar, which may carry a scheduled meeting recording.

| Action | Reach | What it is |
|---|---|---|
| `read` | `company_admin`. **Its own rule** for the organizer (`ownerId == principal.id`, held as `member` or `manager`). **Its own rule** for an attendee (`principal.id in attendeeIds`, held as `member`, `viewer` or `manager`). **Its own rule** for every `member`, `viewer` and `manager` when `visibility == "company"` | see an event. A manager reads only through those three rules, never every calendar |
| `create` | `company_admin`, `manager`, `member` | schedule an event or a meeting. It is also the gate of the busy-times read |
| `update` | `company_admin`; **its own rule** for the organizer (`member` or `manager`) | edit time, title, attendees or place |
| `cancel` | `company_admin`; **its own rule** for the organizer (`member` or `manager`) | call it off |
| `respond` | **its own rule** for an attendee (`principal.id in attendeeIds`, held as `member`, `viewer` or `manager`) | accept, decline or say maybe, for themselves only. Nobody answers for someone else, `company_admin` included |

**Authoring rules:**
- Each attribute-dependent rule stands alone (HIER-2): the organizer, attendee and company-visibility rules are separate rules, never mixed with a scope role.
- **`EFFECT_DENY` on `create`, `update`, `cancel` and `respond`** for `principal.attr.kind in ["automation","bot"]`, shaped like `resource_work_request.yaml`'s (`roles: ["user"]`, `has()`-guarded). `read` stays allowed. Agents may schedule later, under the separate AI plan.
- **`platform_admin`** keeps the house wildcard. A deny-overrides `respond` rule stops it answering for others: `principal.id in attendeeIds` must hold for every role.

**Resource attributes**, fed by the handler from the rows and never from a body:
- `ownerId` (from `organizer_id`): an existing allow-list entry.
- `attendeeIds` (from `calendar_event_attendees`): **new**, default `[]`.
- `visibility`: **new**, default `"attendees"`.

Both new attributes go in the `Resource` type and in the `resourcePayload()` allow-list in `src/rbac/cerbos.ts`. An attribute missing from that allow-list is silently dropped, and an unfed resource denies.

**The permission arm covers `create` only.** `read` (all three of its rules depend on attributes), `update`, `cancel` and `respond` are shapes that a flat `perms` mirror cannot express. They carry no `perm_*` rule, the same call as `work_request`.

**Bundles:**

| Role | Holds |
|---|---|
| `company_admin`, `owner`, `platform_admin` | all five keys |
| `manager` | `create`, `read`, and self-scoped `update`, `cancel` and `respond` |
| `member` | `create`, `read`, and self-scoped `update`, `cancel` and `respond` |
| `viewer` | `read`, and self-scoped `respond` |

No key is `sensitive`.

**The six artifacts** are as in §36:
- the policy and its derived role;
- `cerbos.ts`;
- the catalog;
- the groups (a `calendar` group);
- a migration seeding `permissions` and `role_permissions`, with the DO-block self-assertion (owner mirrors company_admin, plus the self-scoped markers);
- the bundles, regenerated from a clean worktree.

Then move the four pinned literals.

**Busy times (DW-8o, DW-D28, 2026-10-15):** `GET /api/:t/calendar/busy` rides `calendar_event` · `create` on the tenant, decided before the query is looked at, so a viewer or an agent always gets 403. No policy, catalog or bundle change.

**Proof:** `src/rbac/cerbos-calendar-event.test.ts` (a static pin, plus the live matrix with `CERBOS_URL`). **Restart Cerbos after the deploy, then probe:** on a fresh tenant, a GET of a zero-uuid event answers 404.

**As built (2026-10-14).** The policy `resource_calendar_event.yaml` follows the tables above, with these points the design left open or that moved:
- **`read`** is four rules, each on its own: `company_admin` (unconditional beyond `inTenant && notLow`), the organizer (`member` and `manager`, `ownerId == principal.id`), an attendee (`member`, `viewer` and `manager`, `principal.id in attendeeIds`) and company visibility (`member`, `viewer` and `manager`, `visibility == "company"`). **manager added to the self rules at review, 2026-10-14: a manager-only login could create but not then read its own event.**
- **`create`** is one rule for `company_admin`, `manager` and `member`; **`update`** and **`cancel`** are `company_admin` plus an organizer rule per action on `member` and `manager`.
- **`respond`** is two ALLOW rules (`company_admin`, unconditional beyond `inTenant && notLow`; and the attendee rule on `member`, `viewer` and `manager`) plus **a deny-overrides rule on `roles: ["user"]`** for any caller who is not in `attendeeIds` (`!has(attendeeIds) || !(principal.id in attendeeIds)`). That rule is what stops `company_admin` and `platform_admin` answering for someone else, and it makes an unfed `attendeeIds` deny `respond` for everyone.
- **The agent DENY** is the second `EFFECT_DENY` rule, on `create`, `update`, `cancel` and `respond` for `automation` and `bot`, shaped exactly like `resource_work_request.yaml`'s. `read` stays allowed.
- **The permission arm** is `perm_calendar_event_create` only (`inTenant && notLow && inRoot`). The permission-native `owner` holds all five keys in its bundle but reaches only `create` through Cerbos unless it also holds `company_admin`.
- **The self-scoped marker moved from the table above.** The generator derives `selfScoped` from the rule shape, and member·read and viewer·read include the company-visibility rule, which is a tenant-wide read, so they (and manager·read) are NOT marked. The marked pairs are member and manager · update, cancel and respond, and viewer·respond (7). company_admin·respond is not marked (its rule is unconditional and the deny narrows it). The migration seeds exactly that.
- **Bundles** (`role-permission-bundles.json`, `totalPairs` 2045 -> 2072, `selfScoped` pairs 33 -> 40): `platform_admin` 451 -> 456, `company_admin` 414 -> 419, `owner` 414 -> 419, `manager` 206 -> 211, `member` 104 -> 109, `viewer` 36 -> 38. Migration `202610151110_iam_calendar_event_permissions.sql` seeds 27 `role_permissions` rows with a DO-block self-assertion (owner mirrors company_admin in both directions, the seven self-scoped markers, viewer read and respond only). The catalog counts (109 kinds, 471 pairs, 456 grantable) do not move: no key was added.

**The six artifacts:** the policy and the derived role `perm_calendar_event_create`; `cerbos.ts` (`attendeeIds` default `[]`, `visibility` default `"attendees"`, in the `Resource` type and the `resourcePayload()` allow-list; `ownerId` was already there); `permission-catalog.json` (+5 keys: 109 kinds, 471 pairs, 456 grantable, 15 relationship, 211 sensitive); `permission-groups.json` (+1 group, `calendar`: 169 groups, 417 covered); the migration; the bundle generator (no resolver change: the kind names only direct roles) and `role-permission-bundles.json` regenerated. Pinned literals moved: `cerbos-catalog-alignment` 466 -> 471 and 108 -> 109 kinds, `permission-groups-catalog-parity` 451 -> 456, `ui-grantable-catalog` 466/451 -> 471/456, `iam-215-boundary-pin` 108 -> 109 kinds and 104 -> 105 non-exempt. Proof: `src/rbac/cerbos-calendar-event.test.ts` (static pin always; live matrix needs `CERBOS_URL`) and the HTTP suite `src/core/calendar-events.test.ts`. **Restart `gaiada-test-cerbos` and the live sidecar after deploying the policy files** (nothing hot-reloads).

## 40. DW-8j — the `personal_mailbox` kind (2026-10-14, PROTOTYPED)

Design: `docs/FRONTEND-BFF-CONTRACT.md` §48 (ruling DW-D24, plan `docs/plans/2026-10-13-department-workspaces.md` §11.4). Status: **PROTOTYPED** (policy, catalog, bundles, migrations and tests are in the repo; the live Cerbos probe after a restart is the deploy step).

**A new core kind, `personal_mailbox` (no module), with three actions.** The policy is `resource_personal_mailbox.yaml`, and the keys are `core.personal_mailbox.{connect,read,send}`. The resource is one person's OWN Gmail, linked to the ERP. The ERP stores nothing from it.

| Action | Reach | What it is |
|---|---|---|
| `connect` | **Its own rule** for the owner (`ownerId == principal.id`), held as `member`, `manager` or `company_admin` | link or unlink your own Gmail |
| `read` | the same self rule | read your own threads, on demand |
| `send` | the same self rule | send or reply as yourself |

**Nobody reads or sends as anyone else.**
- No role reaches another person's mailbox: not `company_admin`, not HR, not IT.
- An `EFFECT_DENY` with `roles: ["user"]` and the condition `!(has(request.resource.attr.ownerId) && request.resource.attr.ownerId == request.principal.id)` covers all three actions.
- It beats the `platform_admin` wildcard under deny-overrides.
- This is the mail design's "no domain-wide delegation" rule, written as policy.

**No automation or bot principal connects or sends.** There is an `EFFECT_DENY` on `connect` and `send` for `principal.attr.kind in ["automation","bot"]`, shaped like `resource_work_request.yaml`'s. `read` is denied to them too, by the same rule:
- an agent reading a person's mail is a separate decision, for the separate AI plan;
- a client-only principal never holds `member`, `manager` or `company_admin`, so it reaches nothing.

**Attributes and the permission arm.**
- **Attribute:** `ownerId` only, fed by the handler as the caller's own id. It is never read from a body. The allow-list entry already exists.
- **No permission arm:** every rule is self-scoped, a shape a flat `perms` mirror cannot express, so there is no `perm_*` rule.

**Bundles and markers.**
- `member`, `manager`, `company_admin`, `owner` and `platform_admin` hold all three keys. Every one of them is self-scoped (`selfScoped`), because the deny makes any other reach impossible.
- `viewer` holds none. A viewer is a read-only seat, and personal mail is a working tool.
- No key is `sensitive`: it reaches only the holder's own data.

**The six artifacts** follow §36, plus the four pinned literals. **Restart Cerbos and probe after the deploy:** the status route answers `{connected: false}` for a fresh person.

**As built (2026-10-15).** The policy `resource_personal_mailbox.yaml` follows the tables above, with these points the design left open or that moved:
- **The rules, one line each.**
  - `*` for `platform_admin`: the house wildcard (the iam-215 pin needs it), narrowed to the owner by the deny below.
  - `connect`, `read`, `send` on `member`, `manager`, `company_admin`: ONE self rule, `inTenant && notLow && ownerId != "" && ownerId == principal.id`.
  - `EFFECT_DENY`, `roles: ["user"]`: anyone who is not the owner (`!(has(ownerId) && ownerId != "" && ownerId == principal.id)`), every role, `platform_admin` included.
  - `EFFECT_DENY`, `roles: ["user"]`: `principal.attr.kind in ["automation", "bot"]`, `has()`-guarded.
  - No `perm_*` rule, no derived role, nothing for `viewer`, `client`, `org_unit_lead` or a module tier.
- **Both denies are written as `*`, not as the three named actions.** A deviation from the table above, with no effect today (the kind has three actions): an action a later ticket adds can never be left reachable through the `platform_admin` wildcard, and an unlisted action is denied for everyone on every mailbox. The matrix pins it.
- **An unfed or empty `ownerId` is not the caller**, so a probe that names no owner is denied for every role. The `platform_admin` parity sweep (`core/authz-permissions.controller.test.ts`) already probes with `ownerId: "u1"` and a principal whose id is `u1`; `cerbos-personal-mailbox.test.ts` pins both.
- **`cerbos.ts` does not change**: `ownerId` was already in `Resource` and in the `resourcePayload()` allow-list (default `""`, fail closed). The handler feeds it as `req.principal.userId`, on every route.
- **The self-scoped marker is narrower than "every one of them".** The generator derives it from the rule shape: `company_admin`, `manager` and `member` hold all three keys as self-scoped pairs (9); `platform_admin` (the wildcard) and `owner` (no rules of its own) hold them unmarked, and the deny is what makes their reach personal. `self-scoped-marker-parity.db.test.ts` pins the DB to the JSON.
- **Bundles** (`role-permission-bundles.json`, regenerated from the policy files; `totalPairs` 2072 -> 2087, `selfScopedPairs` 40 -> 49): `platform_admin` 456 -> 459, `company_admin` 419 -> 422, `owner` 419 -> 422, `manager` 211 -> 214, `member` 109 -> 112; every other role unchanged. The permission-native `owner` holds the three keys but, with no rule of its own, reaches a mailbox only if it also holds `company_admin`, `manager` or `member`.
- **The six artifacts:** the policy (no derived role); `cerbos.ts` (no change); `permission-catalog.json` (+3 keys, `core` domain, grantable, not sensitive, `uiGrantable`: 110 kinds, 474 pairs, 459 grantable, 15 relationship, 211 sensitive); `permission-groups.json` (+1 group, `personal_mailbox`: 170 groups, 420 covered); migration `202610151210_iam_personal_mailbox_permissions.sql` (15 `role_permissions` rows, with a DO-block self-assertion: the owner mirrors `company_admin` in both directions, the nine self-scoped markers, a viewer and every other role holding none); the bundle generator (no resolver change: the kind names only direct roles) and `role-permission-bundles.json`. Pinned literals moved: `cerbos-catalog-alignment` 471 -> 474 pairs and 109 -> 110 kinds, `permission-groups-catalog-parity` 456 -> 459, `ui-grantable-catalog` 471/456 -> 474/459, `iam-215-boundary-pin` 109 -> 110 kinds and 105 -> 106 non-exempt.
- **Proof:** `src/rbac/cerbos-personal-mailbox.test.ts` (7 static always; 30 live with `CERBOS_URL`: every role against its own and someone else's mailbox, an unfed owner, a bot and an automation principal, low assurance, cross-tenant, an unlisted action, an owner id that merely resembles the caller's, and the absence of a permission arm) and the HTTP suite `src/core/gmail/gmail.http.test.ts`. **Restart `gaiada-test-cerbos` and the live sidecar after deploying the policy file** (nothing hot-reloads), then probe: `GET /api/:t/integrations/gmail` answers `{connected: false}` for a fresh person.
- **One reach that no policy can express, noted for the client-context gate** (FRONTEND-BFF-CONTRACT §48.4): every role that may `send` also reads `client`, so "send about a client you cannot read" is refused by no role combination today; the controller still asks for the client's read, so a future narrowing of `client` read takes effect here without a change.

## 40a. DW-D29 — the `time_entry` list narrowed by the person-axis gate (2026-10-15, PROTOTYPED): no new kind, no new action, no policy change

Design: `docs/FRONTEND-BFF-CONTRACT.md` §48a (ruling DW-D29).
- **What changes.** `time_entry` · `read` on the tenant stays the kind-level entry gate. `GET /time-entries` then narrows the rows by the shared person-axis gate (`core/person-axis-gate.ts`):
  - yourself;
  - the `unrestricted` and `company_wide` tiers: everyone;
  - `unit_scoped`: the led-unit subtree (TR-25);
  - `self_only`: yourself only.
- **Why there is no policy change.** The list carries no subject, so Cerbos cannot filter it. The gate is the single rule that `/pm/productivity`, the activity series and `GET /work-activity?personId=` already use (§38c). A narrower policy row would only duplicate it.
- **Unchanged:** `create`, `update`, `delete`.

## 41. DW-7j — the GM's revenue plan, BFF §40.6.4 (2026-10-15, BUILT, PROTOTYPED): no new kind, no new action

DW-D30 (owner, 2026-10-15) has the revenue plan built now, so that the GM's "Revenue against plan" KPI has a plan to read. It reuses `dept_kpi_target`, because the people who set the plan are the people who put KPI targets in force:

| Route | Authorizes as | Who passes |
|---|---|---|
| `GET /api/:t/revenue-plan` | `dept_kpi_target` `read` | as §38: `company_admin`, `manager`, `member`, `viewer`, and the HR read tier |
| `PUT /api/:t/revenue-plan/:month` | `dept_kpi_target` `approve` | `company_admin` only (which `owner` mirrors) |
| `DELETE /api/:t/revenue-plan/:month` | `dept_kpi_target` `approve` | `company_admin` only |

- The resource is the company: `unitAncestors` is `[]`, so `org_unit_lead` never passes `approve` here.
- The functional-department readers (BFF §40.6.2) are not routes. They run inside the §40 engine, under the reads that the department KPIs already authorize.
- Whether the Office of the GM's lead seat should also set the plan follows §38's open owner decision on who approves targets.
- **As built.** `platform-nest/src/modules/finance/revenue-plan.controller.ts` authorizes with `{kind: "dept_kpi_target", module: "reports", unitAncestors: []}`, `read` and `approve`; no policy, catalog or bundle changed. The UI mirrors `approve` with `company.manage` (or elevated), which a `manager` also holds, so the server's 403 is the refusal and the page shows it as a sentence. Tested in `revenue-plan.controller.db.test.ts` (a manager, a member and an org_unit_lead are refused 403 on PUT and DELETE; read passes for the tenant's tiers; another tenant's approver is refused).

## 42. DW-7h — IT security, BFF §52 (2026-10-15, BUILT, PROTOTYPED): no new kind, no new action

DW-D36 (owner, 2026-10-15) moves IT's security work to the ERP side. The people who may see who is connected and sign someone out are the people who already run logins in IT accounts, so the routes reuse `it_account`:

| Route | Authorizes as | Who passes (`resource_it_account.yaml`) |
|---|---|---|
| `GET /api/:t/it/security/connections`, `/sign-ins`, `/alerts`, `/blocks` | `it_account` `read` | `platform_admin`; `company_admin` and `it_managers` with `inTenant && notLow` |
| `POST /api/:t/it/security/sessions/:sessionId/revoke` | `it_account` `disable` | as above |
| `POST /api/:t/it/security/blocks`, `/blocks/:blockId/lift` | `it_account` `disable` | as above |
| `POST /api/:t/it/accounts/:userId/disable` (now also ends sessions) | `it_account` `disable` (unchanged) | as above |

- **Why `disable`.** Ending a session and blocking an address stop access the way disabling a login does, and they are undone the same way (sign in again, lift the block). A separate action would need a policy change, the catalog and bundles, and a Cerbos restart (cerbos-new-kind-is-six-artifacts), for the same set of people.
- **Self-protection is in the routes, not the policy.** The routes refuse ending your own session, blocking your own address, a private address, and an address 3 or more members share, unless `confirmShared` is set (BFF §52.7).
- **The hot-path refusals (BFF §52.4, §52.5) are not authorization decisions.** They run before Cerbos and do not audit as decisions. A refused request is the 401 or 403 itself.
- The UI mirrors `it_account` `read` and `disable` with `it.manage`, exactly as the IT accounts page does.

## 42a. DW-7i-1 — failing workflows, BFF §52.12 (2026-10-16, BUILT, PROTOTYPED): no Cerbos kind, a rule in code

DW-D37 (owner, 2026-10-16): the shared n8n's failures are for the platform operator, the owner, the GM and the PM. The rule is in code, `core/automation-failures-audience.ts`, the same way the automation console keeps its in-code check (`automation-console/index.ts` explains why that console has no Cerbos kind):

| Who | Passes when |
|---|---|
| platform operator | always (`platform_admin`) |
| the owner | holds `owner` on this company, and `automation-console` is enabled here |
| the GM | is the seated lead of this company's Office of the GM unit, and the module is enabled here |
| the PM | holds a "Project Manager" seat in this company's organisation, and the module is enabled here |

- IT staff and `company_admin` do NOT pass on that alone (the owner's list). The GM passes by the seat, not by `company_admin`.
- A refused read is 403 `not_in_audience`. The UI hides the tile and explains on the page.

## 45. PV7-01 — `read_client` on `report_document` (2026-10-15, PROTOTYPED)

Design: `docs/FRONTEND-BFF-CONTRACT.md` §53 (plan `docs/plans/2026-10-15-pv7-performance-views-tickets.md`, PV7-01). Status: **PROTOTYPED** (policy, catalog, group, bundles, migration and tests are in the repo; the live Cerbos probe after a restart is the deploy step).

**One more action on the existing kind, no new kind.** The key is `reports.document.read_client`: read a client-grain report document (one client's figures summed across its projects), its overview listing and its export. It sits beside `read_person`, `read_project`, `read_department` and `read_company`.

| Action | Reach | What it is |
|---|---|---|
| `read_client` | the derived roles that hold `read_project`: `company_admin`, `hr_people_reader`, `manager` and `member`. **Not** the served-provider arm (`module_staff`, `module_manager`) | read a client's report document |

**The served arm is left out on purpose.** A served slice is department only (§8's fifth column). A provider's staff never read a served company's client numbers.

**Nobody gains reach.** Anyone who can read every project document in the tenant can already compute the client sum. A `member` holding only a project-scope grant matches no client resource (the derived role needs a company or global grant when the resource carries no `projectId`), so it reads its own project and no client.

**No `perm_*` rule.** The IAM-04-B5 note at the end of `resource_report_document.yaml` still holds: any `perm_*` rule on this kind fails `permission-arm-hazard-scan.test.ts` for `org_unit_lead`. The key therefore has no permission-arm mirror, and the permission-native `owner` holds it in its bundle without reaching it through Cerbos unless it also holds `company_admin` (the same under-claim as `read_project`).

**Resource attributes:** none new. The handler sends `{kind: "report_document", id: <clientId>, module: "reports"}` for a client-grain read, and none of `ownerId`, `projectId` or `teamId`.

**Not narrowed in the handler.** The person-axis and department narrowing (`requiresUnitNarrowing`) does not apply: the client grain is neither of those, as for `project`.

**Artifacts** (a new action on an existing kind): the policy (`read_client` joins the four rules above), `permission-catalog.json` (+1 key), `permission-groups.json`, `role-permission-bundles.json`, and migration `202610151700_reports_client_grain.sql` (seeds the permission and its grants). **Restart the Cerbos test container and the live sidecar after the deploy**: nothing hot-reloads.

**As built (2026-10-15).** The policy `resource_report_document.yaml` adds `read_client` to four existing rules (`company_admin`, the HR read tier, `manager`, and `member`) and to none of the served-provider, `org_unit_lead` or `owner` rules.
- **Bundles** (`role-permission-bundles.json`, `totalPairs` 2072 -> 2079): `platform_admin` 456 -> 457, `company_admin` 419 -> 420, `owner` 419 -> 420, `manager` 211 -> 212, `member` 109 -> 110, `hr_staff` 19 -> 20, `hr_manager` 60 -> 61. `reports_staff`, `reports_manager`, `viewer`, `org_unit_lead` and `client` are unchanged.
- **Migration** `202610151700_reports_client_grain.sql` seeds the key and its 7 `role_permissions` rows with a DO-block self-assertion (exactly those seven roles, none self-scoped, `owner` == `company_admin` over the whole kind).
- **Catalog and pinned literals:** `permission-catalog.json` 471 -> 472 pairs and 456 -> 457 grantable (kinds stay 109), `permission-groups.json` (the key joins `team_project_reports`: 456 -> 457 grantable, 417 -> 418 covered), `cerbos-catalog-alignment` 471 -> 472, `permission-groups-catalog-parity` 456 -> 457, `ui-grantable-catalog` 471 -> 472 and 456 -> 457.
- **Not sensitive**, like `read_project`.

**Proof.** `platform-nest/src/modules/reports/reports-cerbos.test.ts` (the `read_client` matrix: exec, admin, lead, both HR halves and member allowed; the served tiers, a project-scope member, a bare membership, another company's manager, low assurance and a portal contact refused; and `read_client` equal to `read_project` role for role except the served arm), plus the static alignment suites (`cerbos-catalog-alignment`, `permission-groups-catalog-parity`, `ui-grantable-catalog`, `permission-arm-hazard-scan`) and the HTTP suite `report-client-grain.db.test.ts`. **Restart the Cerbos test container and the live sidecar after the policy deploy.**

## 46. PV7-04a — the `client_report` kind (2026-10-15, PROTOTYPED)

Design: `docs/FRONTEND-BFF-CONTRACT.md` §55 (plan `docs/plans/2026-10-15-pv7-performance-views-tickets.md`, PV7-04, lead's call L6). Status: **BUILT, PROTOTYPED** (policy, catalog, group, bundles, migration and tests are in the repo and green on the Linux CI gate; the live Cerbos probe after a restart is the deploy step).

**A new core kind, `client_report` (no module), with four actions.** `resource_client_report.yaml`, keys `core.client_report.{read,draft,publish,withdraw}`: one report published to a client in the portal (a delivered social or search report, later the account summary).

| Action | Reach | What it is |
|---|---|---|
| `read` | `company_admin`, `manager`, `member`, `viewer` (`inTenant && notLow`), the `client` kind's read tiers | see a client's reports, every status, and download their files on the staff side |
| `draft` | `company_admin`, `manager`; **its own rule** for the client's owner (`ownerUserId == principal.id`, held as `member`) | create or edit a draft (PV7-07, PV7-08). Automation accounts draft through the `manager` or `company_admin` grant every one of them holds |
| `publish` | `company_admin`, `manager`; **its own rule** for the client's owner | put a draft in front of the client |
| `withdraw` | `company_admin`, `manager`; **its own rule** for the client's owner | take a published report back, with a reason |

**`EFFECT_DENY` on `publish` and `withdraw` for `principal.attr.kind in ["automation","bot"]`** (L6: agents draft, staff publish; the PV-D23 shape, `roles: ["user"]`, `has()`-guarded), so it beats every ALLOW, the `platform_admin` wildcard and the permission mirrors under deny-overrides.

**One new resource attribute, fed by the handler and never by a body:** `ownerUserId` (from `clients.owner_user_id`), in the `Resource` type and the `resourcePayload()` allow-list, default `""`.

**The permission arm covers `read` only** (`perm_client_report_read`). `draft`, `publish` and `withdraw` each carry a self-scoped owner rule, which a flat `perms` mirror cannot express (permission-arm-hazard-scan Pattern B).

**Portal reads do NOT use this kind.** A client contact reads published reports through `portal · read` and `clientReportInPortalScope` (BFF §55.4), as every portal read does. The `client` derived role appears nowhere in the policy.

**As built (2026-10-15).**
- **Bundles** (`role-permission-bundles.json`, `totalPairs` 2094 -> 2115): `platform_admin` 460 -> 464, `company_admin` 423 -> 427, `owner` 423 -> 427, `manager` 215 -> 219, `member` 113 -> 117 (read, plus draft/publish/withdraw marked `selfScoped`; `selfScopedPairs` 49 -> 52), `viewer` 38 -> 39. No other role changes.
- **Catalog and pinned literals:** `permission-catalog.json` 475 -> 479 pairs, 460 -> 464 grantable, 211 -> 213 sensitive (`publish` and `withdraw`, like `share_minutes`: they put figures in front of a client), kinds 110 -> 111. `permission-groups.json` +1 group `client_reports` (sensitive, not `advancedOnly`: publishing is not D14-gated, the precedent is `meeting_minutes_share`), 421 -> 425 covered. Moved: `cerbos-catalog-alignment` 475 -> 479 and 110 -> 111, `permission-groups-catalog-parity` 460 -> 464, `ui-grantable-catalog` 475/460 -> 479/464, `iam-215-boundary-pin` 110 -> 111 kinds and 106 -> 107 non-exempt.
- **Migration** `202610151720_client_reports.sql` (the same file as the tables; one prefix for the ticket) seeds the four keys and 21 `role_permissions` rows with a DO-block self-assertion: exact counts per role, the three self-scoped member pairs and no others, viewer read only, `owner` == `company_admin` over the kind in both directions.
- **No automation-only `draft` rule** (see BFF §55.7): automation accounts hold `manager` or `company_admin`.
- **The handler feeds** `{ kind: "client_report", id, tenantId, clientId, ownerUserId }` for publish and withdraw (`ownerUserId` from `clients.owner_user_id`), and `{ kind: "client_report", tenantId }` for the kind-level read that comes first. The staff file download (`GET :t/files/:fileId/content`) sends `{ kind: "client_report", id: <report id>, tenantId }` read, which the read rule admits without attributes.

**Proof.** `platform-nest/src/rbac/cerbos-client-report.test.ts` (static pin always; the live matrix on the Linux gate: the tiers, the owner rule and its fail-closed cases, the bot and automation DENY beating company_admin, manager and the platform_admin wildcard, the read-only permission arm, the permission-native owner), the HTTP suite `src/core/client-reports.db.test.ts` (the same rules through the routes), and the static alignment suites. **Restart the Cerbos test container and the live sidecar after the policy deploy.**

## 47. DW-10a — the `dept_notice` kind (2026-10-15, BUILT, PROTOTYPED)

Design: `docs/FRONTEND-BFF-CONTRACT.md` §57 (plan `docs/plans/2026-10-13-department-workspaces.md` §12.2, row 10a; owner ruling DW-D32). Status: **BUILT, PROTOTYPED (backend, DW-10a-1: the policy, `perm_dept_notice_read`, the `scope` attribute, catalog, group, bundles, migration `202610152110_iam_dept_notice_permissions.sql` and the suites are in the repo. The live Cerbos matrix and the HTTP suite are written for the Linux CI gate and skip without Postgres and Cerbos; the static pins, the catalogue and parity suites run anywhere. The UI mirror `notices.post` is DW-10a-2 and is still PLANNED. The live Cerbos probe after a restart is the deploy step)**.

**A new core kind, `dept_notice` (no module), with four actions.** The policy is `resource_dept_notice.yaml`, with keys `core.dept_notice.{read,post,edit,withdraw}`. One resource is one notice: a unit notice (on one org unit of the company) or a company-wide notice.

| Action | Reach | What it is |
|---|---|---|
| `read` | `company_admin`, `manager`, `member`, `viewer`; **its own rule** for the HR read tier (`hr_people_reader`). All with `inTenant && notLow`. **Tenant-wide here on purpose:** the per-unit narrowing (placed under the unit today, a head whose led scope holds it, or a company-wide tier) needs the caller's placement as of today, which Cerbos cannot read, so the handler applies it after this check (BFF §57.2), as `dept_kpi_target · read` does | list and open notices |
| `post` | `company_admin`. **Its own rule** for `org_unit_lead` when `scope == "unit"` (the grant's scopeId in `unitAncestors`) | post a notice. A company-wide notice (`scope == "company"`) is `company_admin` only: the lead rule carries `request.resource.attr.scope == "unit"` |
| `edit` | as `post`, on the stored row's scope and unit | change title, body, pin or end date |
| `withdraw` | as `post`, on the stored row's scope and unit | take a notice down (no delete exists) |

**Authoring rules:**
- Each attribute-dependent rule stands alone (HIER-2): the `org_unit_lead` rules for `post`, `edit` and `withdraw` are separate rules, never mixed with a scope role.
- **`EFFECT_DENY` on `post`, `edit` and `withdraw`** for `principal.attr.kind in ["automation","bot"]`, shaped like `resource_work_request.yaml`'s (`roles: ["user"]`, `has()`-guarded). `read` stays allowed: agents read notices (DW-D32).
- **`platform_admin`** keeps the house wildcard.
- `manager` gets no write. Every head's lead position also carries `manager` company-wide, so `manager` cannot mean "the head of this department" (the `dept_kpi_target` reasoning).

**Resource attributes**, fed by the handler and never from a body:
- `unitAncestors`: the existing attribute, from `loadUnitAncestors(c, tenantId, unitNodeId)` inside `withTenants([tenantId])`. It comes from the request's `unitNodeId` on `post`, from the stored row on `edit` and `withdraw`, and is `[]` for a company-wide notice.
- `scope`: **new**, `"unit"` or `"company"`, default `"unit"`. It goes in the `Resource` type and the `resourcePayload()` allow-list in `src/rbac/cerbos.ts`. An attribute missing from that allow-list is silently dropped, and the lead rule must then deny (test it).

**The tenant trap.** An `org_unit` grant carries no tenant, and node ids are unique only per company (seed ids such as `d-webdev` repeat across companies). Every rule keeps `variables.inTenant`, and `unitAncestors` is always computed with the tenant. A proof must show that the head of company A's `d-webdev` cannot post to company B's `d-webdev`.

**The permission arm covers `read` only.** `post`, `edit` and `withdraw` are reachable by `org_unit_lead` through an attribute-dependent rule. A flat `perms` mirror cannot tell "holds the key through company_admin" from "holds it through a lead grant over ONE unit", so a mirror would let a head post to EVERY unit (iam-04-reg1-mirror-reach-invariant). This is the same call as `dept_kpi_target · propose` and `work_request · decline`. Consequence: the permission-native `owner` role reads through its bundle, but posts only if it also holds `company_admin` or leads the unit.

**Bundles:**

| Role | Holds |
|---|---|
| `company_admin`, `platform_admin` | all four keys |
| `owner` | `read` (writes through `company_admin` or a lead grant, above) |
| `manager`, `member`, `viewer` | `read` |
| `org_unit_lead` | `post`, `edit`, `withdraw`, unit-scoped (the UI capability `notices.post` in `ROLE_CAPS.org_unit_lead`, answered by `canInUnit`) |

No key is `sensitive`.

**The six artifacts** are as in §36:
- the policy;
- `cerbos.ts` (the `scope` attribute);
- the catalog;
- the groups (a `notices` group);
- a migration seeding `permissions` and `role_permissions`, with the DO-block self-assertion;
- the bundles, regenerated from a clean worktree.

Plus the static pins and the live matrix (`cerbos-dept-notice.test.ts`), and the UI mirror in `platform-ui/src/lib/rbac.ts` with its parity register. **Restart Cerbos at the deploy and probe it:** a head's `post` on their own unit is allowed, and on a sibling unit denied.

**As built (DW-10a-1, 2026-10-15).**
- **Counts:** 112 kinds, 483 pairs, 468 grantable; 20 bundled pairs on global roles (3 x 4 for `platform_admin`, `company_admin`, `owner`; 5 reads; 3 head writes). The group is `notices`; none of the four keys is sensitive or advanced-only.
- **The bundles table above is completed, not changed:** `hr_staff` and `hr_manager` also hold `read` (the `hr_people_reader` rule, which the policy gives its own rule), and `owner`'s bundle holds **all four** keys, because `owner` mirrors `company_admin` exactly (`owner-role.db.test.ts`). Cerbos honours only `read` for a permission-native `owner`: it posts, edits and withdraws only when it also holds `company_admin` or leads the unit. The live matrix pins both halves.
- **The lead rules** are three separate rules (post, edit, withdraw), each `inTenant && notLow && has(scope) && scope == "unit"`. `org_unit_lead` alone (with no scope role) holds the three writes and not `read`: a real head also carries `member` and `manager`.
- **`scope`** is in the `Resource` type and the `resourcePayload()` allow-list with the default `"unit"`. The live matrix proves it reaches the policy: the same ancestry allows a head with `scope: "unit"` and denies with `scope: "company"` (a dropped attribute could only deny, through `has()`).
- **The tenant trap** is pinned twice: every ALLOW rule keeps `variables.inTenant` (static pin), and the HTTP suite runs the same node ids (`d-web`, `d-corp`, ...) in two companies: the head of A's `d-web` neither posts to, lists, reads, edits nor withdraws B's, and the other way round.

## 48. DW-10c — the department calendar: `org_structure · read_calendar` and department-visible events (2026-10-15, PLANNED)

Design: `docs/FRONTEND-BFF-CONTRACT.md` §59 (plan `docs/plans/2026-10-13-department-workspaces.md` §12.2, row 10c; owner ruling DW-D33). Status: **PLANNED**.

**1. A new action on an existing kind: `org_structure · read_calendar`.**
- **Key:** `core.org_structure.read_calendar`, in `resource_org_structure.yaml`.
- **Reach:** `company_admin`, `manager`, `member` and `viewer`, with `inTenant && notLow`, plus **its own rule** for the HR read tier (`hr_people_reader`).
- **Why a new action, not plain `read`:**
  - It gates the department calendar (BFF §59). That read discloses colleagues' approved leave and its type to the department's people (DW-D33), which no other read does.
  - A distinct key keeps that disclosure visible in the catalogue, and lets a company withhold it without touching the org chart.
- **Narrowing:** the per-unit narrowing (placed in the unit or below it today, a head whose led scope holds it, or a company-wide tier) is the handler's, as for `dept_kpi_target · read`. It needs placement as of today, which Cerbos cannot read.
- **The permission arm mirrors it** (`perm_org_structure_read_calendar`, with `inTenant && notLow && inRoot`). The action is reached only through scope-only rules, so a mirror grants no more than the role arm.
- **Bundles:** `company_admin`, `owner`, `platform_admin`, `manager`, `member` and `viewer` hold it. It is not `sensitive`.
- **Artifacts:**
  - the policy rule;
  - the catalogue entry;
  - the groups (the `org` group);
  - a migration seeding `permissions` and `role_permissions`, with the DO-block self-assertion;
  - the bundles, regenerated from a clean worktree;
  - the static pins and the live matrix (`cerbos-org-structure*.test.ts`, or a new `cerbos-dept-calendar.test.ts`).
- **Bots and automation** may read; there is no write.

**2. `calendar_event · read` for department-visible events (extends §39).**
- **New rule:** read for `member`, `viewer` and `manager` when `request.resource.attr.visibility == "department"`, with `inTenant && notLow`. It is its own rule, never mixed with the organizer, attendee or company rules (HIER-2).
- **Narrowing:** Cerbos keeps the tier; the handler and the SQL mirrors (`mine`, the detail read) narrow to the unit's placed people, its heads and the company-wide tiers (BFF §59.3).
- **New resource attribute:** `unitNodeId`, from the stored row and never from a body. It goes in the `Resource` type and `resourcePayload()` in `src/rbac/cerbos.ts`. `visibility` already exists (§39).
- **`create` and `update` are unchanged in Cerbos.** Creating or moving an event to `department` also requires the unit narrowing, which is the handler's, and it is checked before the body's other fields are validated.
- **The automation and bot DENY on writes stays.**
- **No new key**, and the bundles are unchanged.

**Deploy:** restart Cerbos and probe it:
- `read_calendar` allowed for a member, denied for a client-portal principal;
- a department event readable by a member of the tenant through Cerbos (the handler narrows);
- an attendee-only event still refused to a non-attendee.
