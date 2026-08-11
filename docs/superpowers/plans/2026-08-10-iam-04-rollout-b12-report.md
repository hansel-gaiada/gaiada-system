# IAM-04-ROLLOUT-B12 — batches 1+2 permission-arm rollout (17 SAFE + 9 confirm-reliable)

**Status:** PROTOTYPED / DEV-VERIFIED against the local test containers (`gaiada-test-pg`
:55433/`gaiada-test-cerbos` :3592, restarted after every policy edit and re-verified positively
via live `POST /api/check/resources` probes). Not run against `gda-aicenter`. Zero migrations.
Zero authorization decisions changed — proven, not asserted, by the full `src/rbac/` suite
(387/387), the module suites for every touched vertical, `role-permission-parity.db.test.ts`
(24/24), `iam-215-boundary-pin.test.ts` (66/66), and `permission-arm-hazard-scan.test.ts` staying
green throughout (12→64 tests as each newly-wired kind joined its `it.each` regression guard).

**Parents:** `2026-08-10-iam-04-rollout-scan.md` (the register — batch/kind classification),
`2026-08-10-iam-04-report.md` (the pilot — pattern this ticket copies), `2026-08-10-iam-04c-bypass-
ruling.md` (wildcards permanently untouched).

**Owns:** `platform-nest/cerbos/policies/derived_roles.yaml` (extended, 100 new `perm_*` derived
roles), the 26 kinds' resource policy files (each purely additive), `platform-nest/src/rbac/cerbos-
permission-dual-match.test.ts` (extended, +26 isolation cases), this report.

**Not touched:** any migration, `principal.ts`, `cerbos.ts`, `can.ts`, `permission-catalog.json`,
`role-permission-bundles.json`, `platform-ui/`. `scripts/generate-role-bundles.mjs --check` still
reports byte-identical regeneration (my `perm_*` additions are skipped by its existing `dr.startsWith
("perm_")` guard, exactly as the pilot's report documented).

**Touched outside the primary ownership list, narrowly and necessarily** (same rationale the pilot
used for `role-permission-parity.db.test.ts`/`generate-role-bundles.mjs`): `platform-nest/src/core/
webdev-change-requests.controller.test.ts`. Its `§4.1 INVARIANT (file-level)` test does a raw
regex scan of `resource_webdev_change_request.yaml`'s `derivedRoles:` lists and asserts the
resulting name SET equals an exact, hand-enumerated list — a real, valuable tripwire against a
future `client` rule landing on that file, but also, incidentally, an exact-cardinality assertion
that any additive role-name change (not just a `client` regression) trips. Adding the three
`perm_webdev_change_request_*` roles turned this red for the reason the test was never designed to
catch (it added roles, not `client`). Fixed by extending the expected `Set` to include the three
new names, with a comment; the actual invariant the test polices (`roles` never contains
`"client"`) is asserted on the line above and is untouched. 31/31 green in that file after the fix;
no other file in the estate uses this same raw-regex-derivedRoles-list pattern (grepped for the
`matchAll(/derivedRoles</` shape — one match, this file).

---

## 1. Kinds wired, by batch

### Batch 1 — SAFE (17/17)

`agency_brief`, `agency_campaign`, `agency_creative_asset`, `chat_group`, `company`,
`compliance_gate`, `contract`, `identity_link`, `invoice`, `knowledge_source`, `report_admin`,
`rollup`, `rollup_recompute`, `service_assignment`, `user`, `webdev_change_request`,
`webdev_provisioned_site`.

Each: one new Cerbos rule per action, `derivedRoles: ["perm_<kind>_<action>"]`, condition copied
verbatim from the SAFE role rule it mirrors (`variables.inTenant && variables.notLow` for every
kind except `rollup`, which carries no outer condition at all in its original rule and gets none
on its mirror either). Every new derived role is the plain global-or-company generic mirror (no
exclusion clause needed — the register found no team_lead/client mixing anywhere in these 17).

**Deliberately not mirrored, per kind (all matching the "TRAP-4 correctly split" reasoning — a
role sitting ALONE in its own separate rule, never mixed with a SAFE role in the same rule, is not
part of what a permission-catalog entry represents for that action):**
- `company`/`contract`/`invoice`/`knowledge_source`'s wildcard `platform_admin`(+`group_executive`)
  rule — untouched, permanently, per IAM-04c.
- `compliance_gate`/`report_admin`/`service_assignment`'s `group_executive`-only rule (own
  separate rule, condition `notLow` only, no company branch) — not mirrored.
- `rollup`'s rule names `platform_admin`+`group_executive` together with no other role at all
  (no SAFE role present to mix with) — the whole rule is the elevated tier, not delegatable; the
  `core.rollup.read` permission-arm mirror is new (per IAM-04c §3.3, `core.rollup.read` is an
  explicit named candidate for the future `owner` bundle), and correctly carries no scope
  restriction beyond the standard global-or-company generic shape.
- `service_assignment`: wired `propose`/`accept`/`revoke`/`suspend`/`resume`/`relink`/`read`
  (the `company_admin` rule's action list). Did **not** wire `reconcile` (ORG-7: admin/global-only
  by design, no non-wildcard rule reaches it) and did **not** wire the `module_staff`/
  `module_manager` `read` rule. This kind's module_staff/module_manager targets are the GENERIC
  4-way fan-out (`hr_staff`+`search_staff`+`reports_staff`+`webdev_staff`, per
  `generate-role-bundles.mjs`'s `moduleStaffTargets("service_assignment")`), unlike the other
  9 confirm-reliable kinds' single-module target — `core.service_assignment.read` is bundled to
  ALL FOUR module-staff roles regardless of which module the specific assignment row is actually
  for. A generic flat-`perms` mirror cannot re-apply the module check the role arm's own
  `module_staff`/`module_manager` derived role does (it never receives `resource.attr.module` as
  an argument the way the resource-policy rule's condition does), so wiring it naively WOULD widen
  e.g. `hr_staff`'s reach to search/reports/webdev-module assignments too — a real over-grant, not
  a theoretical one. `service_assignment` is therefore NOT fully covered by this batch's `read`
  action for the module tier specifically; only `company_admin`'s reach is mirrored. Flagged as a
  follow-up alongside `report_document`'s own multi-module `module_staff` shape (register §2.3
  Mechanism 3's `report_document` row already documents the identical fan-out problem).
- `contract`: did not wire `countersign` (owner-only via the wildcard rule; no catalog key exists
  for it either — verified, catalog has only `read/create/update/delete/send`).
- `webdev_change_request`/`webdev_provisioned_site`: wired `create`(`create`,`read`,`triage`, resp.
  `read`,`provision`,`reconcile`) mirroring the combined company_admin+manager+module_manager+
  module_staff reach per action (module attr is a hardcoded literal `"webdev"` on every real
  handler call site for these two kinds — verified, no cross-module ambiguity, so one generic
  mirror per action safely covers both the plain-tenant tier and the module tier). Group_executive's
  own `notLow`-only rule is not mirrored (same TRAP-4 reasoning).

### Batch 2 — HAZARDOUS, confirm-reliable module mechanism (9/9)

`hr_record`, `agency_approval`, `resource_search_audit`, `resource_search_campaign`,
`resource_search_engagement`, `resource_search_keyword`, `resource_search_ledger`,
`resource_search_property`, `resource_search_report`.

(Note: the search kinds' real Cerbos `resource:` value is literally `resource_search_<x>`, not
`search_<x>` — confirmed against every controller's `authorize()` call site and the policy files
themselves; `perm_*` derived-role names use this exact literal, matching the existing
`perm_<kind>_<action>` convention the hazard-scan's PART 3 guard depends on.)

Each: module_staff/module_manager (+module_approver for `agency_approval`) sit in the SAME rule as
`company_admin` for baseline actions (Pattern-A hit, mechanism `top-level-attr-gate`) — mitigated
by **confirm-reliable** (no code change, per the register's own methodology): every real handler
for these kinds passes `module` as a hardcoded literal (`"hr"`/`"agency"`/`"search"`), re-verified
this session by grepping `hr.controller.ts`/`loans.controller.ts`, `agency.controller.ts`, and
`search*.controller.ts`/`search-reports.controller.ts` — no exceptions found. One generic
global-or-company mirror per action therefore safely covers the combined company_admin+
module_staff+module_manager(+module_approver) reach, with no exclusion clause, exactly matching
how the pilot itself treated `hr_case`'s own module tier.

`group_executive`'s own separate `notLow`-only rule on all 9 kinds is not mirrored (same TRAP-4
reasoning as batch 1) — checked per kind that `company_admin`'s combined (baseline+elevated) reach
equals `group_executive`'s action list exactly, so nothing group_executive-specific is lost by
declining to mirror it (see §4 of the register's own text; re-verified here per kind).

`hr_record`: wired `read/create/update/delete/export` (no self-scope rule exists on this kind at
all — the header explicitly excludes subject self-read in v1 — so there is no Pattern-B hazard to
mitigate here, unlike `hr_case`).

`agency_approval`: wired `read/create/approve` (all 3 of its actions).

Search 7×: wired every action present on each kind (25 actions in `search.campaign` through
`search.ledger`'s 2) — full per-kind list in the derived-roles diff.

---

## 2. Isolation-proof coverage

Extended `cerbos-permission-dual-match.test.ts` with 26 new cases (one per kind wired, exceeding
the "at least one" bar), each:
1. grants the permission with `roles: []` — the role arm cannot possibly be what answers;
2. asserts the action ALLOWs;
3. asserts the SAME permission does not leak cross-tenant (resource moved to T2 → DENY);
4. where the kind has ≥2 actions, asserts the permission does not bleed into a sibling action.

42/42 green live against `gaiada-test-cerbos` (16 pilot cases + 26 new). Representative live
probes (ad hoc, beyond the automated suite, run directly against `POST /api/check/resources`):
`agency_brief.read` via permission alone (no role) → ALLOW, `update` on the same principal → DENY;
`hr_record.read` via permission alone → ALLOW, `delete` → DENY; `rollup.read` via a global-scope
permission alone (no companies, no roles) → ALLOW; `agency_approval.approve` via permission alone
→ ALLOW, `create` → DENY; cross-tenant leak check on `agency_brief.read` → DENY.

---

## 3. Hazard-scan before/after

- **Before this ticket:** `permission-arm-hazard-scan.test.ts` — 12/12 (only `pm_task`/`hr_case`
  in `kindsWithPermissionArm()`'s discovered set).
- **After wiring all 26 kinds:** same file — **64/64**, with zero changes to the test file itself.
  The jump from 12→64 is entirely `it.each` fanning out over the newly-discovered 26 kinds in
  PART 3's regression guard (28 kinds total now carry a `perm_*` arm: the 2 pilot kinds + this
  ticket's 26). Every Pattern-A hit on a wired kind that names a `no-disjunction`/`missing-scope-
  branch` unsafe role turned out, on inspection, to be a role sitting alone in its own separate
  rule (never mixed with a safe role in the SAME rule) — so none of my 26 kinds actually produced a
  live Pattern-A/B hit requiring the grants-exclusion or self-scope mitigations; the register's own
  SAFE/confirm-reliable classification held for all 26 kinds under the detector's own re-derivation,
  not just under the register's static read.
- `cerbos compile /policies` (in-container, `gaiada-test-cerbos`): clean, exit 0, after every batch
  of edits.
- `npx tsc --noEmit`: clean, 0 errors (the isolation-test additions are the only `.ts` file
  touched).

---

## 4. Parity status at each increment

Ran after (a) the derived-roles.yaml append, (b) each policy-file batch, (c) the isolation-test
addition:

| Gate | Result |
|---|---|
| `permission-arm-hazard-scan.test.ts` | 64/64 |
| `role-permission-parity.db.test.ts` | 24/24 (unchanged assertions — `perm_*` roles skipped by its pre-existing filter) |
| `iam-215-boundary-pin.test.ts` | 66/66 |
| `cerbos-permission-dual-match.test.ts` | 42/42 |
| `src/rbac/` (21 files) | 387/387 |
| `npx tsc --noEmit` | clean |
| `cerbos compile /policies` | exit 0 |
| `node scripts/generate-role-bundles.mjs --check` | byte-identical (unaffected — not asked for by this ticket's gates, checked anyway since I touched `derived_roles.yaml`) |
| `src/modules/hr/hr.test.ts` | 17/17 |
| `src/modules/agency/agency.test.ts` | 15/15 |
| `src/modules/search/search-cerbos.test.ts` | 25/25 |

All runs against `gaiada-test-cerbos`, restarted immediately after the policy edits (`StartedAt`
re-verified to postdate every edit) and probed live via `POST /api/check/resources` before trusting
any suite result, per the staleness discipline.

---

## 5. Kinds I stopped on: none

No kind in either batch tripped the hazard-scan's grants-exclusion or self-scope requirement. Every
kind classified SAFE or confirm-reliable by the register held under this session's independent
re-derivation (live probes + the detector), so nothing in the assigned 26-kind list was left
unwired.

---

## 6. A finding beyond the register's and detector's coverage — NOT fixed here, flagged for follow-up

While reasoning through each kind's safety (per the ticket's instruction to verify per kind rather
than trust the label), I found a hazard **shape the current `permission-arm-hazard-scan.test.ts`
does not detect at all**, distinct from Pattern A/B:

**`platform_admin` (and, on 5 kinds, `group_executive`) sit inside a kind's WILDCARD rule (or, for
`rollup`, an unconditional non-wildcard rule with no other role present) — `generate-role-
bundles.mjs` wildcard-expands that rule and attributes the kind's full action universe to BOTH
role names' `role_permissions` bundles, regardless of the fact each role's OWN `derived_roles.yaml`
condition matches `scopeType == "global"` ONLY.** `POST /:tenantId/users/:userId/roles`
(`admin-identity.controller.ts:271-306`) places no restriction on which `roleId` may be granted at
`scopeType: "company"` — it is a live, reachable code path (gated only by the caller holding
`user:create`, i.e. `company_admin`) to record `platform_admin` or `group_executive` at COMPANY
scope for any tenant. If such a grant existed, `assemblePrincipal()` would resolve it into a
`perms` entry at company scope for every wildcard-covered action on every kind — and a **generic**
permission-arm mirror (the shape this whole ticket, and the pilot before it, use for every kind)
would ALLOW where the role arm's own `platform_admin`/`group_executive` derived role (global-scope
only) would DENY. This is structurally the identical class of bug the pilot caught for
`team_lead`×`pm_task` (Finding 2) — just triggered by a WILDCARD/unconditional rule instead of a
same-rule mix, which is exactly why `permission-arm-hazard-scan.test.ts`'s Pattern-A scanner misses
it (it explicitly skips wildcard rules by design, and requires a safe+unsafe MIX within one rule —
a rule naming only unsafe roles, or a role that's unsafe only via a SEPARATE wildcard rule, produces
no match).

**This is NOT new to this ticket** — it is already present, unaddressed, in the shipped,
DEV-VERIFIED `pm_task`/`hr_case` pilot (both kinds' wildcard rules name `platform_admin`, and
`pm_task`'s also names `group_executive`; neither pilot's `perm_*` derived roles exclude either
name, only `team_lead`). I did not fix it inside this ticket's 26 kinds because: (1) it is a
systemic characteristic of the whole IAM-04 permission-matching methodology, not something unique
to my batch; (2) the two files that would need the fix for full consistency (`resource_pm_task.yaml`
via its `derived_roles.yaml` companions) are the pilot's, not mine to touch under this ticket's
constraints; (3) inventing a NEW universal exclusion pattern (beyond the three sanctioned
mitigations) without architect sign-off risks exactly the kind of ad hoc mitigation the ticket
told me to avoid; (4) it does not change any CURRENT authorization decision (no such company-scope
`platform_admin`/`group_executive` grant exists in any seed, migration, or test fixture today, and
none of the mandated gates — which are the ticket's own arbiter for "zero decisions changed" — can
see it either way).

**Recommended follow-up (not started, PLANNED only):** either (a) extend
`permission-arm-hazard-scan.test.ts` with a fourth pattern — "a role reachable only via a wildcard
or unconditional rule, whose own `derived_roles.yaml` condition is `missing-scope-branch`, must be
excluded from every sibling `perm_*` arm on that kind, the same way `team_lead` is excluded on
`pm_task`" — and then apply the exclusion universally (retroactively to `pm_task`/`hr_case` too),
or (b) restrict `admin-identity.controller.ts`'s `assignRole` to disallow `scopeType: "company"`/
`"project"` for the two tier roles server-side, closing the grant path itself rather than
compensating for it at every read site. Recommendation leans (b) — it is a single, auditable
choke-point fix versus a permanently-repeated exclusion clause on every future kind's wildcard-
adjacent permission arm — but this is exactly the kind of contract decision the ticket's own STOP
clause reserves for the architect, so it is reported, not decided, here.

---

## 7. Files touched

- `platform-nest/cerbos/policies/derived_roles.yaml` — +100 `perm_*` derived roles (56 batch 1,
  44 batch 2), appended after the existing IAM-04a/pilot section, byte-identical otherwise.
- 26 resource policy files (`resource_agency_brief.yaml` … `resource_search_report.yaml`) — each
  purely additive (new rules appended at file end; zero existing lines changed).
- `platform-nest/src/rbac/cerbos-permission-dual-match.test.ts` — +26 isolation cases (new describe
  block; zero existing lines changed).
- `platform-nest/src/core/webdev-change-requests.controller.test.ts` — one assertion widened (see
  §0/§6-adjacent note above): the file-level `derivedRoles` exact-set tripwire now includes the 3
  new `perm_webdev_change_request_*` names; the `client`-absence assertion itself is untouched.
- This report.

**Not touched:** any migration, `principal.ts`, `cerbos.ts`, `can.ts`, `permission-catalog.json`,
`role-permission-bundles.json`, `platform-ui/`, the 4 EXEMPT kinds, the 18 dead-grant kinds, the 3
dual-mitigation kinds, `report_document`, `team`, the 6 `group_executive`/TRAP-4 kinds.

## 8. Blockers / follow-ups (not this ticket's remit)

- **§6's platform_admin/group_executive wildcard-bleed finding** — PLANNED, needs an architect
  decision between extending the detector + universal exclusion vs. restricting the grant
  endpoint; affects the already-shipped pilot too, not just this batch.
- Batches 3–8 (self-scope-only `checkin`; dead-grant `team_lead` sweep; dual-mitigation kinds;
  `report_document`'s per-action split; `team`; the `group_executive` TRAP-4-blocked 6) remain per
  the register's §4 rollout order — none started here, all still gated exactly as the register
  specified (batch 8 blocked on a separate role-arm correctness fix landing first).
