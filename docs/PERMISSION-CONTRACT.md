# Permission contract (IAM Phase 1)

**Status:** PROTOTYPED — updated 2026-08-13 (IAM-GAP-01: invoice maker/checker + the dedicated HR
leave decision right; originally frozen 2026-08-10, reconciled 2026-08-11 against two days of IAM
rollout work). This is the contract Web Dev and PM build against.
**Companion to** `docs/FRONTEND-BFF-CONTRACT.md`. Program docs live in
`docs/superpowers/plans/2026-08-10-iam-*` and `docs/superpowers/plans/2026-08-13-iam-gap-01-report.md`.

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

## 2. Current numbers (re-derived from the artifacts, 2026-08-13, post-IAM-GAP-01)

| Artifact | Value | File |
|---|---|---|
| Catalog | **264** entries = **249 grantable** + **15 relationship**; 93 flagged `sensitive`; 68 distinct Cerbos kinds (IAM-GAP-01, 2026-08-13: +2 literal actions on EXISTING kinds — `invoice.approve` and `automation_approval.decide_leave` — so pairs/grantable/sensitive move by 2 each but the kind count does NOT. Prior: SMM-30, 2026-08-12: the `social` module's 8 kinds + 35 keys, plus `portal.approve_post`, 226/211/60 → 262/247/68) | `platform-nest/src/rbac/permission-catalog.json` |
| Role bundles | **1031** pairs across **22** roles (IAM-GAP-01: +8 pairs — `billing.invoice.approve` to `company_admin`/`group_executive`/`manager`/`platform_admin`; `hr.leave.decide` to `company_admin`/`group_executive`/`hr_manager`/`platform_admin` — **zero removed**, no existing user's reach narrows) | `platform-nest/src/rbac/role-permission-bundles.json` |
| Permission groups | **85** (IAM-GAP-01 added `invoices_approve` + `hr_leave_decide`; prior: SMM-30 added 8 social groups + `portal_approve_posts`) | `platform-nest/src/rbac/permission-groups.json` |
| UI capabilities | **34** — UNCHANGED by IAM-GAP-01 (`platform-ui/` is out of this ticket's scope; the new server-side permissions have no capability mirror yet) | `platform-ui/src/lib/rbac.ts` |

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
`_meta.counts.perRole`, post-IAM-GAP-01; five roles moved — `platform_admin`/`company_admin`/
`group_executive`/`manager` +2 each, `hr_manager` +1 — see §9's changelog entry for which two keys):

| Role | Pairs | Role | Pairs | Role | Pairs |
|---|---:|---|---:|---|---:|
| `platform_admin` | 249 | `viewer` | 29 | `search_manager` | 37 |
| `company_admin` | 230 | `org_unit_lead` | 2 | `search_staff` | 24 |
| `group_executive` | 127 | `client` | 7 | `reports_manager` | 3 |
| `manager` | 137 | `it_admin`/`it_manager`/`it` | 3 each | `reports_staff` | 4 |
| `member` | 73 | `agency_approver` | 1 | `webdev_manager` | 6 |
| | | `hr_staff` | 13 | `webdev_staff` | 4 |
| | | `hr_manager` | 24 | `social_staff` | 19 |
| | | | | `social_manager` | 33 |

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
`agency_approval`, and the 7 `resource_search_*` kinds) — **28 of 61 kinds now carry a `perm_*`
arm**, verified via `permission-arm-hazard-scan.test.ts` (12→64 tests as each kind joined its own
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
- ⏳ **Detection gap OPEN.** `permission-arm-hazard-scan.test.ts` models only SAME-RULE mixing, so a
  wildcard/unconditional rule combined with a role whose own condition is narrower stays invisible to
  it. **IAM-SEC-03** extends the detector and sweeps all 61 kinds for other instances.

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

## 9. Known-open items (refreshed 2026-08-11)

**Closed since the 2026-08-10 freeze:**
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
- **IAM-04-ROLLOUT.** 28 of 61 kinds now carry a permission arm (up from the 2-kind pilot) — see §2
  for the exact list; §2's kind count itself is now 60, not 61 (HIER-3 deleted the `team` kind).
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
- **Sensitivity sign-off** (79 permissions + 42 groups flagged) still needs the owner + an
  HR/finance pass; blocks D-9/D-10, not Phase 1.
- ~~HIER-2 (`org_unit_lead`) and HIER-3 (the `team`/`team_lead` retirement sweep)~~ — **LANDED
  (2026-08-11).** `org_unit_lead` is seeded and Cerbos-consuming on two rules; `team_lead`, the
  `team`/`record` scope values, and `teams`/`team_memberships` are retired. See §7's rewritten
  bullets for the current shape. Follow-up not yet done: `Resource.teamId` (the shared attribute
  field `reports.controller.ts` and others still pass) is now a fully dead attribute — no Cerbos
  rule reads it anymore — but renaming/removing it from `src/rbac/cerbos.ts` and every call site
  was reported as out of this ticket's scope (HIER-2's own report explicitly deferred it to
  HIER-3, but the rename touches ~10 files beyond team/team_lead itself); left for a future ticket.
