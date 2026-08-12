# IAM-SEC-04 — Pattern C widened past the wildcard-only blind spot; `portal`/`client` re-derived

**Status:** DETECTOR EXTENSION PROTOTYPED / DEV-VERIFIED against the current tree (static parse
only — no DB, no live Cerbos, no PDP; `npx vitest run src/rbac/permission-arm-hazard-scan.test.ts`,
**110/110 green**, this session; `npx tsc --noEmit`, 0 errors). **No policy file changed. No
authorization decision changed.** This ticket owns `permission-arm-hazard-scan.test.ts` and this
document only. `admin-identity.controller.ts`, `derived_roles.yaml`, every `resource_*.yaml`, and
`client-contacts.controller.ts`/`client-invites.ts` (the portal invite write path) were read-only
inputs.

**Parents:** `2026-08-11-iam-sec-03-report.md` (Pattern C as originally built — wildcard-only),
`2026-08-12-iam-04-rollout-b4-report.md` §2 (the `portal`/`client` STOP analysis that found the
gap this ticket closes).

⚠ **Shared, moving tree.** `git status` at the time of writing shows an unrelated concurrent
session's `social` module (8 new `resource_social_*.yaml` files, migrations 0105/0106, plus
catalog/bundle regeneration touching `permission-catalog.json`, `role-permission-bundles.json`,
several `.db.test.ts` files) as modified/untracked — none of it mine, none of it touched. The
policy-file count moved from 60 (IAM-SEC-03's baseline) to **68** during this session; every
count below is derived from `policyFileCount()`/live parse, never a pinned literal, so this drift
does not invalidate anything here. My only edit is `permission-arm-hazard-scan.test.ts`.

---

## 1. The widened predicate, in plain words

**Old Pattern C (IAM-SEC-03):** "flag a role named in a rule IF that rule's `actions` include the
literal wildcard `"*"` AND the role is scope-narrower than a generic global-or-company mirror."

**The gap:** the wildcard requirement was never actually load-bearing to the hazard. The real
defect is: *a rule is reachable (through role-name matching) only at a scope-set the named role's
own derived-role condition restricts, but the DB's flat permission-catalog bundling (migration
0094) does not remember that restriction — it just records "this role can do this action" — so any
`perm_<kind>_<action>` mirror built with the standard global-or-company shape will honour the
grant at a BROADER scope than the role arm ever would.* Nothing about that requires the literal
token `"*"`. `resource_portal.yaml`'s `client` rule proves it: six-then-seven NAMED actions
(`read`, `decide`, `sign`, `pay`, `update_profile`, `request_change`, `approve_post` — the last
added by an unrelated concurrent SMM-31 session, itself confirming the rule is an ordinary,
actively-maintained named-action rule, not some vestigial wildcard-adjacent artifact), `client`
sitting ALONE (no co-occurring SAFE role to trip Pattern A), no self-scope field to trip Pattern B.

**New Pattern C (IAM-SEC-04):** scan **every** `EFFECT_ALLOW` rule (wildcard or not), for **every**
named role, flag it if that role is classified UNSAFE **and** the reason is specifically a
**scope-reachability** constraint — i.e. the set of `scopeType` values the role's own condition can
ever be true for is a strict subset of `{global, company}`. Concretely: `no-disjunction` (a single
AND-chain with no `||` at all — the role's condition is satisfiable at exactly ONE scope value,
e.g. `platform_admin`/`group_executive`: global only; `org_unit_lead`: org_unit only) or
`missing-scope-branch` (has a disjunction but is missing one of the two plain scope branches, e.g.
`client`: company only, no global escape).

**Deliberately excluded:** `top-level-attr-gate` (`module_staff`/`module_manager`/
`module_approver` — gated by `resource.attr.module`, `has(...)` failing closed). That hazard's
axis is an extra RESOURCE ATTRIBUTE a generic mirror has no per-request argument to re-check, not a
scope constraint: a global-or-company mirror's scope branches are exactly as broad as
`module_staff`'s own (`global || company-tenant-match`). Mirroring it is a real hazard, but it is
Pattern A/B's remit — already explicitly carved out in PART 3's own regression guard ("mitigated
by CONFIRMING the gating attribute is reliably populated ... nothing to assert structurally here")
— and mixing that axis into Pattern C would either duplicate that carve-out or contradict it. This
was a deliberate scoping decision, checked with a dedicated teeth-proof (§4, test 3) proving a
synthetic `module_staff`-shaped role sitting alone is correctly NOT flagged.

No hand-maintained role list anywhere: `roleClass` is the same structurally-derived
`classifyDerivedRoleExpr` map Pattern A reads, and the scope/attr-gate/no-disjunction reason
buckets come from parsing `derived_roles.yaml`'s raw CEL text, exactly as before.

**Only code changed:** `scanPatternC()` — removed the `if (!rule.actions.includes("*")) continue;`
line, and added an `isScopeConstrainedReason()` filter. `classifyDerivedRoleExpr`,
`isGlobalScopeOnly`, `scanPatternA`, `scanPatternB`, `hasGrantsExclusionFor` are byte-unchanged.

---

## 2. Sweep result — every instance, all 68 kinds

```
Pattern C by role: platform_admin: 64 kinds; group_executive: 42 kinds; org_unit_lead: 2 kinds; client: 1 kinds
```

| Role | Kinds hit | Direction | Shape |
|---|---|---|---|
| `platform_admin` | 64 | global-only | wildcard `["*"]` rule, every occurrence (unchanged from IAM-SEC-03's 56; +8 is exactly the `social` module's new kinds, all of which carry the same universal wildcard rule) |
| `group_executive` | 42 | global-only | **NEW, widened-only discoveries**: IAM-SEC-03 found it in 7 kinds, always co-wildcarded with `platform_admin`. The widened sweep finds it in **35 additional kinds**, named ALONE in an ordinary, non-wildcard, named-action rule (the TRAP-4 five: `automation_approval`, `pipeline_gate`, `pipeline_run`, `pipeline_stage`, `scope_signoff`; plus `org_structure`/`report_period`/`client_contact`/`work_activity`'s own `notLow`-only rules the B4 report describes as "already correctly split"; plus others across `company`, `contract`, `device`, `invoice`, `knowledge_source`, `pm_task`, `pm_project`, and more — the full per-kind list is in the test's own `console.log` output, re-derivable any run, deliberately not hand-copied here per the file's own anti-drift discipline) |
| `org_unit_lead` | 2 (`appraisal`, `report_document`) | **company-direction-adjacent — org_unit ONLY** | named ALONE in an ordinary named-action rule on each kind (`resource_appraisal.yaml:138`, `resource_report_document.yaml:118`) — exactly the shape the register's own HIER-2 comment already flags as "classified UNSAFE ... correctly: this role IS attribute-dependent, by design" |
| `client` | 1 (`portal`) | **company ONLY, no global branch** | `resource_portal.yaml`'s single named-action rule — the ticket's own headline finding, now reproduced by the detector itself rather than only by a human re-reading the policy |

Every hit's reason is confirmed scope-constrained (never `top-level-attr-gate`) by the SWEEP test's
own assertion; every hit's role is confirmed genuinely UNSAFE by the same classifier Pattern A
uses. `hr_people_ops`/`hr_people_reader`/`it_staff` remain SAFE (both scope branches, no extra
gate) and produce zero hits, as IAM-SEC-03 already established.

---

## 3. Reachability classification

**Direction A — global-only (`platform_admin`, `group_executive`): CLOSED.**
`admin-identity.controller.ts`'s `GLOBAL_ONLY_ROLES = new Set(["platform_admin",
"group_executive"])` rejects any `assignRole` call for either name at a non-global `scopeType`
with a 400, before the row is ever inserted (`global-only-role-scope.test.ts`'s pre-existing teeth
proof). This guard is scope-shaped, not rule-shaped — it does not care whether the role appears in
a wildcard rule or an ordinary named-action rule, so it equally closes the 35 newly-discovered
`group_executive`-alone instances and the pre-known 7 co-wildcarded ones. Re-verified by the
PART 3b `REACHABILITY (global-only direction)` test, which checks `GLOBAL_ONLY_ROLES.has(role)`
for the FULL widened hit-set (64 + 42 kinds), not just the wildcard subset IAM-SEC-03 checked —
**passes**.

**Direction B — everything else (`client`, `org_unit_lead`): OPEN at the write path, DORMANT at
the exploit path. Not a false positive — a real, provable, two-part finding.**

1. **The write path is unguarded TODAY, independently verified by reading the source, not
   inferred:** `admin-identity.controller.ts`'s `assignRole` (`POST
   /:tenantId/users/:userId/roles`) is authorized by `user:create`
   (`resource_user.yaml:18-21`, held by `company_admin`, in-tenant), accepts ANY `roleId` and ANY
   `scopeType` in `SCOPE_TYPES = {"global", "company", "project", "org_unit"}`
   (`admin-identity.controller.ts:28`), and the ONLY scope restriction anywhere in that endpoint is
   `GLOBAL_ONLY_ROLES` — which names only `platform_admin`/`group_executive`. **Nothing stops a
   `company_admin` from POSTing `{roleId: <client's id>, scopeType: "global"}` and minting a
   `client` grant at global scope, or `{roleId: <org_unit_lead's id>, scopeType: "company",
   scopeId: <any company>}` minting `org_unit_lead` at a scope its own condition never checks.**
   This is the SAME reachable write path IAM-SEC-03 documented for `platform_admin`
   ("`assignRole` is authorized by `user:create`, which `company_admin` holds"), just missing a
   guard in the OPPOSITE scope direction — `GLOBAL_ONLY_ROLES` forces a role to STAY at the one
   scope its condition allows (global); `client`/`org_unit_lead` need the mirror-image guard
   (forcing them to stay OUT of global/company), which does not exist for either name.

2. **The portal invite flow itself (the OTHER path that mints `client`) is safe, proven, not
   assumed:** `client-contacts.controller.ts:361-370` hardcodes `scope_type = 'company'` and
   `scope_id = invite.tenantId` in its `INSERT INTO user_roles` — it can never produce a
   global-scoped `client` grant. This is the ticket's own instruction ("client is minted by the
   portal invite flow, so treat that one as live unless you prove otherwise") checked against the
   actual source: the flow the ticket named IS safe; the danger is in a DIFFERENT, generic
   write path the ticket didn't name.

3. **The exploit path (a wired `perm_*` mirror that would actually HONOUR a wrongly-scoped grant)
   does not exist yet for either kind:** `kindsWithPermissionArm(kinds)` (PART 3's own,
   discovered-not-named set) does not contain `portal`, `appraisal`, or `report_document` — matching
   the B4 report's own STOP (`portal`) and the register's own "5 Pattern-B self-scope kinds ...
   remain open" note (`appraisal`, `report_document` among them). **Confirmed by the PART 3b
   `REACHABILITY (other-narrow direction)` test**, which asserts exactly this (no
   scope-narrower-than-implied Pattern-C role is named in a kind that already has a wired
   permission arm) — **passes, with zero offenders**.

**Net call:** `client`/`org_unit_lead`'s hazard is real and mintable-at-the-wrong-scope TODAY (part
1), but not yet exploitable through any EXISTING permission-arm mirror (part 3) — the same
"inert until wired" state `platform_admin`@company was in before B12 wired the first mirrors. The
difference from `platform_admin`'s pre-fix state: for `platform_admin`, mirrors ALREADY existed in
18 kinds when B12 found it, making it immediately reachable; for `client`/`org_unit_lead`, ZERO
mirrors exist anywhere they're named, so the finding is currently **dormant, not live** — but
dormant only until the next ticket wires one of these three kinds' permission arm with the
standard shape, at which point it becomes exactly as live as `platform_admin` was. This is why the
new PART 3b test is a real regression guard, not a one-time report: it will go red the day someone
wires `portal`, `appraisal`, or `report_document` without an equivalent exclusion, catching it
before merge rather than after a human re-reads the diff.

---

## 4. Teeth-check — verbatim output

```
✓ (IAM-SEC-04) a NAMED-ACTION rule (no wildcard) naming ONLY a company-scope-only role IS flagged by the widened Pattern C
✓ (IAM-SEC-04) a named-action rule naming ONLY a SAFE role, no wildcard anywhere, is NOT flagged (no false positives)
✓ (IAM-SEC-04) a top-level-attr-gate role (module_staff-shaped) sitting ALONE in a named-action rule is NOT flagged — that hazard axis is Pattern A/B's remit, not Pattern C's
✓ REVERT: none of the IAM-SEC-04 synthetic kinds are persisted anywhere — the real parse is unaffected
  ↳ re-derived from disk: scanPatternC(freshParse, roleClass) finds { kind: "portal", role: "client", reason: "missing-scope-branch" } — the REAL finding, reproduced live, not asserted from memory
✓ (IAM-SEC-03) a wildcard rule naming a scope-narrower role IS flagged by Pattern C           (pre-existing, unaffected by the widening)
✓ (IAM-SEC-03) a wildcard rule naming ONLY a SAFE role is NOT flagged (no false positives)     (pre-existing, unaffected)
✓ REVERT: neither synthetic kind above is persisted anywhere                                    (pre-existing, unaffected)
✓ the SAME Pattern-C detector, run against REAL platform_admin, finds it flagged in every wildcard-carrying kind (56→64, tracks the social-module kind-count growth exactly, no shape change)
```

Full file result, this session:

```
src/rbac/permission-arm-hazard-scan.test.ts   110/110  (was 72/72 at IAM-SEC-03's close;
                                                +38 assertions from: 3 new IAM-SEC-04 teeth-proof
                                                tests + 1 extended revert test (§4 above), PART 3b's
                                                reachability tests re-split into a global-only check
                                                and a new other-narrow check, plus the informational
                                                logs' extra assertions — the pre-existing 72 are
                                                unmodified in logic, only re-worded where the
                                                docstring/test name needed to stop saying
                                                "wildcard")
npx tsc --noEmit                               0 errors
```

**Not run:** the full `platform-nest` suite or anything against live Cerbos/Postgres — this file
is static-parse-only (no DB, no PDP) and the shared test-Cerbos/test-Postgres containers may be in
use by another concurrent session per the ticket's own warning; nothing in this ticket's change
touches DB-backed or Cerbos-backed suites, so a targeted run is the correct scope, not a
corner-cut. If a full-suite confirmation is wanted, it should be requested as its own,
isolated run.

---

## 5. Call on `portal`

**`portal` cannot be wired with the standard generic global-or-company mirror shape — same
conclusion as the B4 report reached by hand, now independently reproduced by the detector.** Wiring
it that way would, the moment any `company_admin` (already authorized by `user:create`) chooses to
call `assignRole` with `{roleId: <client>, scopeType: "global"}`, hand that grant-holder every
portal action (`read`/`decide`/`sign`/`pay`/`update_profile`/`request_change`/`approve_post`) across
**every tenant in the estate** — client-portal data being explicitly called out in
`resource_portal.yaml`'s own comments as "another company's commercial information." This is a
worse blast radius than the original `platform_admin` finding (which was scoped to the grantee's
own company before B12's fix), because the over-grant here lands at GLOBAL scope by construction —
there is no in-between "just my own tenant" version of this over-grant for the company-direction
hazard the way there was for the global-direction one.

**Mitigation options, not decided here (out of this ticket's remit — I do not wire mirrors or
change authorization decisions):**
- **(a)** A write-path guard mirroring `GLOBAL_ONLY_ROLES` in the opposite direction — e.g.
  `COMPANY_ONLY_ROLES` (or a generalized "role X may only be granted at scope type Y" table derived
  from each role's own `isGlobalScopeOnly`/company-only/org-unit-only classification) enforced in
  `assignRole` — closing the write path the same way `platform_admin` was closed, before `portal`
  (or `appraisal`/`report_document`) is ever wired.
- **(b)** A company-scope-only permission-arm mirror shape for `portal` specifically (deliberately
  narrower than the 3 sanctioned mirror shapes every other rollout batch used) — the option the B4
  report already flagged and declined to invent unilaterally.
- **(c)** Leave `portal` (and `appraisal`/`report_document`'s `org_unit_lead` tier) permanently
  permission-arm-unwired, on the theory that the client-portal/org-chart-cascade surface is
  sensitive enough that the flat-permission-catalog compat shim (IAM-04a, D-2) should simply never
  extend to it.

Whichever is chosen, **the correct gate before wiring any of the 3 affected kinds
(`portal`/`appraisal`/`report_document`) is now automated**: PART 3b's `REACHABILITY (other-narrow
direction)` test in `permission-arm-hazard-scan.test.ts` will fail the moment
`kindsWithPermissionArm()` picks up a `perm_*` rule on any of them without also carrying whatever
exclusion mitigation (a) or (b) above requires — the same teeth Part 3's original guard gives the
`team_lead`×`pm_task` and `platform_admin`-wildcard shapes.

---

## 6. What was NOT done (explicitly out of scope)

- **No Cerbos policy file was touched.** `derived_roles.yaml`, every `resource_*.yaml` (including
  `resource_portal.yaml`) — read-only.
- **No authorization decision changed.** The detector is a static YAML/text parse; nothing in this
  file executes against live Cerbos or the DB.
- **`admin-identity.controller.ts` was not modified.** No `COMPANY_ONLY_ROLES`-shaped guard was
  added — that is mitigation (a) above, an architect/write-path decision, not this ticket's remit.
- **`portal` was not wired.** Zero rules added to `resource_portal.yaml`. This ticket's own PART 3b
  reachability test now stands as the automated version of the manual STOP the B4 report performed.
- **The 35 newly-discovered `group_executive`-alone instances are NOT a new open finding** — they
  are closed by the SAME pre-existing `GLOBAL_ONLY_ROLES` guard that closed the 7 wildcard ones;
  they are new to the DETECTOR's visibility, not new to the estate's actual exposure.
