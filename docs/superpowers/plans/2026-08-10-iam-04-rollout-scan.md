# IAM-04-ROLLOUT-SCAN — the pre-rollout hazard register + detector

**Status:** ANALYSIS + DETECTOR PROTOTYPED / DEV-VERIFIED against the current tree (static parse
only, no live Cerbos, no DB — reran clean after every classification claim below was checked
against source). **No policy file changed. No authorization decision changed. Zero permission
arms added anywhere except the two that already existed (`pm_task`, `hr_case`, IAM-04b's own
pilot).** This ticket is a register + an automated detector, exactly per its constraint — the
rollout itself is a later ticket this document is written to inform.

**Parents:** `2026-08-10-iam-04-report.md` (the pilot; read its §4 and §8 first — this ticket is
the scripted pass its §8 asked for) · `2026-08-10-iam-04c-bypass-ruling.md` (wildcards
permanently out of scope) · `2026-08-10-iam-phase1-tickets.md` (Wave 5 outcome section).

**Owns:** `platform-nest/src/rbac/permission-arm-hazard-scan.test.ts` (new, 12 tests, static,
DEV-VERIFIED green — 12/12, `npx vitest run src/rbac/permission-arm-hazard-scan.test.ts`), this
document. Touched nothing else — in particular, **not** `role-permission-parity.db.test.ts` and
**not** `scripts/generate-role-bundles.mjs`, both explicitly reserved for a concurrent session per
the ticket's constraints.

---

## RE-BASELINE (HIER-5, 2026-08-11) — the measured post-retirement estate

**Status:** MEASURED / DEV-VERIFIED. This section supersedes §0–§6 below as the *current* register;
§0–§6 are preserved verbatim beneath as **Appendix A**, unedited, because the BEFORE numbers are the
evidence the `team_lead` consolidation (HIER-1..HIER-3) was worth doing — deleting them would erase
that argument. Everything in this section was re-derived this session by re-running the real
detector (`platform-nest/src/rbac/permission-arm-hazard-scan.test.ts`, 74/74 green) plus a
byte-equivalent throwaway scratchpad port of its PART 1/2 functions (same method the HIER-01
consolidation plan used for its own pre-work projection), against the tree as it stands after
HIER-1/2/3 (migrations through `0104`) and after `IAM-DR12` (an unrelated, concurrent fix — see
§R.2). Cerbos was confirmed freshly started (`StartedAt 2026-08-11T06:00:20Z`, postdating every
policy edit) and probed live before any finding below was trusted.

### R.1 Bucket counts: BEFORE → PREDICTED → MEASURED

| Bucket | BEFORE (2026-08-10 scan) | PREDICTED AFTER (HIER-01 plan, pre-work) | **MEASURED AFTER (HIER-5, this ticket)** | Held? |
|---|---:|---:|---:|---|
| Kinds in the estate | 61 | 60 | **60** | ✅ exact |
| EXEMPT | 4 | 4 | **4** | ✅ exact |
| **SAFE** | 17 | 34 | **35** | ⚠ off by +1 |
| **HAZARDOUS** | 40 | 22 | **21** | ⚠ off by −1 |
| — of which DEAD-GRANT SUSPECT | 22 | 0 | **0** | ✅ exact |
| Hazard rate (non-exempt) | 40/57 = 70% | 22/56 = 39% | **21/56 = 37.5%** | ✅ within noise |

**The prediction held, with one explained, non-`team_lead` delta.** The `team_lead`-specific effect
the plan measured — 18 kinds leaving HAZARDOUS (17 HAZARDOUS→SAFE + `team` deleted with its policy),
DEAD-GRANT SUSPECT 22→0 — landed **exactly** as predicted; re-deriving it independently this session
reproduces the identical 18-kind list (§R.3) and the identical zero. The ±1 SAFE/HAZARDOUS delta
(35 vs 34, 21 vs 22) is **not** a miss in the `team_lead` prediction — it is `portal`, which moved
HAZARDOUS→SAFE via a **second, unrelated, concurrently-landed** ticket, `IAM-DR12`
(`docs/superpowers/plans/2026-08-11-iam-dr12-report.md`): the owner decided to **delete** portal's
dead staff/`group_executive` read rule outright rather than split it (portal-scope.ts's
`callerClientIds()` makes it unreachable for staff regardless), which incidentally also resolved
that one kind's TRAP-4 mixing (§R.5) as a side effect of a decision that had nothing to do with
hierarchy consolidation. Net: **the real numbers are not worse than forecast — they are one kind
better, for a reason the forecast could not have included** (DR-12 was scoped and landed after the
HIER-01 plan was written). Stated plainly per the ticket's instruction: no surprise, no shortfall.

### R.2 What "60 kinds" is made of, restated with wiring status folded in

The detector's SAFE/HAZARDOUS buckets classify **policy shape**, not "has a permission arm yet" —
mitigating a kind changes its *risk*, not its *shape* (a mixed rule stays mixed after an exclusion is
added; a module-gated rule stays gated after its reliability is confirmed). Since the 2026-08-10
scan, **`IAM-04-ROLLOUT-B12`** (concurrent, unrelated to HIER-3) already wired batches 1–3 of the
*original* rollout order (§4 of Appendix A) for real — 29 of the 60 kinds now carry a live `perm_*`
arm (`grep -l "perm_" cerbos/policies/resource_*.yaml` → 29 files, cross-checked against
`kindsWithPermissionArm()`'s own discovery). Folding that in:

| | SAFE (35) | HAZARDOUS (21) |
|---|---|---|
| **Already wired** (`perm_*` arm exists) | 18 — the original 17-kind SAFE batch + `pm_task` (pilot) | 11 — `hr_case` (pilot) + `hr_record`/`agency_approval`/7×`search_*` (confirm-reliable batch) + `checkin` (self-scope batch) |
| **NOT yet wired** | **17** — see §R.4 | **10** — see §R.5/§R.6 |

So of the 60-kind estate, **29 already carry a permission arm** (2 pilot + 26 B12 + nothing from
this ticket — HIER-5 wires nothing, per its own constraint), and **27 kinds are genuinely open
rollout work**, down from the original register's implied "59 kinds left" the day the pilot shipped.

### R.3 The 18 kinds `team_lead` retirement actually moved (reproduced exactly, as predicted)

HAZARDOUS → SAFE (17): `activity`, `client`, `client_contact`, `comment`, `custom_field`,
`deliverable`, `device`, `file`, `meeting_recording`, `member`, `notification`, `org_structure`,
`pm_project`, `pm_task`, `report_period`, `task`, `work_activity`. Left the estate entirely (1):
`team` (policy + table + role, all deleted). Zero DEAD-GRANT SUSPECT kinds remain anywhere — the
mechanism that produced all 22 (`team_lead` mixed into a rule its handlers never fed `teamId` for)
no longer exists: the role, its derived role, and every writer that could mint the grant are gone
(migration `0103`, `derived_roles.yaml`, `core/teams.controller.ts` all confirmed absent/removed).

The 5 `team_lead`-affected kinds that **stayed** hazardous did so for their **independent** Pattern-B
(self-scope vs unconditional) hazard, exactly as the plan called out — retirement was never claimed
to touch this: `appraisal`, `integration_connection`, `project`, `report_document`, `time_entry`.

### R.4 The 17 SAFE-and-not-yet-wired kinds (mechanically wireable now, zero judgment calls)

`activity`, `client`, `client_contact`, `comment`, `custom_field`, `deliverable`, `device`, `file`,
`meeting_recording`, `member`, `notification`, `org_structure`, `pm_project`, `portal`,
`report_period`, `task`, `work_activity`.

16 of these are the `team_lead`-retirement SAFE kinds from §R.3 minus `pm_task` (already wired by the
pilot); the 17th, `portal`, is new this session — freed by `IAM-DR12`'s unrelated rule deletion
(§R.1). All 17 follow the **identical** pattern `IAM-04-ROLLOUT-B12`'s batch 1 already used for the
other 17: one new rule per action, `derivedRoles: ["perm_<kind>_<action>"]`, condition copied verbatim
from the SAFE role rule it mirrors, no exclusion clause needed (the detector found zero mixing
anywhere in these 17, confirmed structurally — not asserted). `portal`'s own wildcard/`client` rules
are untouched by this (IAM-04c: never mirror the bypass or a still-unsafe role); its `client`-only
read/decide/sign/pay/etc. rule was already excluded from any prior mirror discussion and stays so.

### R.5 The 5 Pattern-B-only kinds — mitigation needed: selective self-scoped mirroring

`appraisal`, `integration_connection`, `project`, `report_document`, `time_entry`. Each carries a
self-scoped rule (inline `subjectUserId`/`ownerId == principal.id`, or the shared `variables.owns`)
coexisting with an unconditional rule on the SAME action — flattening both into one `perms` key would
let any holder of that key in, not just the self-scoped grant's own holder (the `hr_case` Finding-1
shape). Per-kind action list, re-derived fresh this session (identical to the HIER-01 plan's own
prediction — team_lead's retirement changed nothing about these 5, confirmed):

| Kind | Actions needing selective self-scoped mirroring | Unconditional roles also holding the action |
|---|---|---|
| `appraisal` | `read` | `hr_people_ops`, `company_admin`, `group_executive`, `manager`, `org_unit_lead` |
| `checkin` | *(already mitigated — see R.2, wired via batch 3)* | — |
| `integration_connection` | `read`, `create`, `update`, `delete` | `group_executive`, `company_admin`+`manager` |
| `project` | `create`, `update`, `delete` | `company_admin`+`manager` |
| `report_document` | `read_person` | `group_executive`, `company_admin`, `hr_people_reader`, `manager` |
| `time_entry` | `update`, `delete` | `company_admin`+`manager` |

One simplification worth naming: `report_document`'s hardest historical nuance — `team_lead` dead on
2 grains, live on 1 (`read_department`), needing a per-action-not-per-kind exclusion — **is gone**.
The kind's only remaining hazard is the single `read_person` self-scope shape above; `org_unit_lead`
(HIER-2's replacement) already occupies its own separate rule on `read_department` per the binding
authoring rule the consolidation plan wrote for it, so it produces no new Pattern-A mixing to design
around. This kind is now a **one-mechanism, one-action** mitigation — the easiest it has ever been.

### R.6 The 5 `group_executive` TRAP-4 kinds — still blocked; the call on fix-now vs D-7

`automation_approval`, `pipeline_gate`, `pipeline_run`, `pipeline_stage`, `scope_signoff`. **Down
from 6** — `portal` is out (§R.1/§R.4), not by the TRAP-4 fix the original register recommended
(splitting `group_executive` into its own `notLow`-only rule, matching `appraisal`/`checkin`/
`client_contact`'s already-correct shape) but by deleting the whole dead rule outright (IAM-DR12).
The remaining 5 still fold `group_executive` into the SAME rule as `company_admin`/`manager` under
an `inTenant && notLow` condition, and `inTenant` (`resource.tenantId in principal.companies`) is
**never true** for a pure global grant with no `company_memberships` row in that tenant.

**Re-confirmed LIVE this session** against a freshly-restarted `gaiada-test-cerbos`
(`POST /api/check/resources`, real derived-role evaluation, not inferred from the YAML text):

- `group_executive`@global, principal has a `company_memberships`-equivalent (`companies: ["t1"]`)
  → `automation_approval.read` → **ALLOW**.
- The SAME grant, principal has **zero** company membership in `t1` (the pure-exec shape the role
  exists for) → `automation_approval.read` → **DENY**. This is the live bug.
- Contrast control: `appraisal` (already correctly split into its own `notLow`-only `group_executive`
  rule) → the identical zero-membership pure-exec principal → **ALLOW**, proving the fix shape works
  and is cheap to copy (3 lines, matching `appraisal`/`checkin`/`client_contact`'s existing pattern).

**The call this ticket was asked to make: fix now, or wait for D-7's Phase-3 deletion of
`group_executive` entirely?** Recommend **fix now**, not wait, for three reasons: (1) this is a live
authorization-correctness bug independent of IAM-04 — it silently denies the ONE role whose entire
purpose is cross-company oversight, on 5 governance-sensitive surfaces (approvals, pipeline
gates/runs/stages, scope sign-offs), **today**, regardless of whether the permission-arm rollout ever
reaches these 5 kinds; (2) the fix is trivial and precedented — split the rule into two, copy the
`appraisal`/`checkin`/`client_contact` shape verbatim, no new mechanism to invent; (3) `D-7` is an
unscheduled Phase-3 item with no committed date, and blocking a known, cheap, live-bug fix on it
indefinitely is a worse trade than fixing it now and letting D-7 delete the (by-then-correct) rule
later along with the role — the fix is not wasted work either way, since a correctly-split rule is
exactly as easy to delete as an incorrectly-mixed one. **Caveat, stated honestly:** whether this bug
has *live* blast radius today (i.e., whether any real `group_executive` holder on `gda-aicenter`
currently lacks a `company_memberships` row in an affected tenant) was not checked — that requires a
live DB query against the production estate, out of this ticket's read-only-against-test-containers
scope. The recommendation to fix now stands regardless of that answer (a correctness bug with unknown
current blast radius is still worth closing at 3-lines-per-kind cost), but the urgency framing should
not overstate what was and wasn't verified.

**Sequencing consequence:** wiring a permission arm around this known-broken role arm would encode
the bug's shape into the permission catalog (a generic global-or-company mirror would ALLOW a
zero-membership exec where the real role arm denies AND where the real role arm should — post-fix —
allow; today it would merely fail to match the role arm's own incorrect denial, which is at least not
a *new* over-grant, but is not a clean mirror either). The original register's own recommendation to
fix the role arm before wiring these 5 stands, unchanged by this measurement.

### R.7 Re-derived remaining rollout order (concrete, ordered)

| Order | Batch | Kinds | Status / mitigation |
|---|---|---|---|
| — | Original batches 1–3 | 29 kinds (17 SAFE + `pm_task`/`hr_case` pilot + 9 confirm-reliable + `checkin`) | **DONE** — wired by `IAM-04-ROLLOUT-B12` + the IAM-04b pilot, concurrent with HIER-1..3. Zero action needed. |
| **1** | New-SAFE, freed by retirement + DR-12 | `activity`, `client`, `client_contact`, `comment`, `custom_field`, `deliverable`, `device`, `file`, `meeting_recording`, `member`, `notification`, `org_structure`, `pm_project`, `portal`, `report_period`, `task`, `work_activity` (17) | Wire mechanically, batchable — identical pattern to the already-shipped batch 1. Zero judgment calls. |
| **2** | Role-arm correctness fix (blocks batch 3) | `automation_approval`, `pipeline_gate`, `pipeline_run`, `pipeline_stage`, `scope_signoff` (role-arm fix only, not the permission arm yet) | Split `group_executive` into its own `notLow`-only rule on each (§R.6) — a role-arm fix, not a permission-arm ticket; do this **first**, before batch 3 below touches these 5 kinds. Recommended NOW, not deferred to D-7 (§R.6). |
| **3** | HAZARDOUS, self-scope only, remaining | `integration_connection`, `project`, `report_document`, `time_entry`, `appraisal` (5) | Selective self-scoped mirroring per §R.5's action table — one kind at a time, each with its own adversarial pin proving the self-check survives wiring (mirror `hr_case`'s own pattern). |
| **4** | HAZARDOUS, permission arm, post-fix | `automation_approval`, `pipeline_gate`, `pipeline_run`, `pipeline_stage`, `scope_signoff` (5) | Only after batch 2's role-arm fix lands — wire the permission arm mirroring the NOW-correct role arm (do not mirror the pre-fix shape). |

Batches 1 and 3 have no ordering dependency on each other or on batch 2/4 and can proceed in
parallel. Batch 4 is strictly gated on batch 2.

### R.8 Orphaned-reference sweep (HIER-5's own spec) — summary; full detail in the HIER-5 report

Full detail, evidence, and file-level citations are in
`docs/superpowers/plans/2026-08-11-hier-5-report.md` §4. Headline:

- Cerbos policies, `derived_roles.yaml`, `role-permission-bundles.json` (20 roles/861 pairs),
  `permission-catalog.json` (226 permissions/211 grantable — content, not `_meta`, see below),
  `permission-groups.json`, `principal.ts`, `person-scope.ts`, `fixtures.ts`: **swept clean**, zero
  functional `team_lead`/`team`-scope/`core.team.*` references remain anywhere (only accurate
  historical comments, matching this repo's own idiom for retired concepts).
- **One genuine, currently-red, previously-unfound regression:**
  `platform-nest/src/admin/managed-by-invariant.test.ts`'s "promoting a team lead never produces a
  managed_by-set user_roles row" test still POSTs to the deleted `/api/:t/teams` and
  `/api/:t/teams/:teamId/members` endpoints and gets `404`, not the `201` it expects. This test was
  outside HIER-3's own enumerated W1–W13 sweep and outside every concurrent ticket's touched-files
  list; reproduced twice (isolated re-run and full-directory re-run), not a transient stack issue.
- **One live, functional (not comment-only) orphan in a separate project, previously flagged as
  out-of-boundary and still unresolved:** `platform-ui/e2e/personas.ts`'s `PersonaKey` union still
  includes `"team_lead"`, and `platform-ui/e2e/iam-personas-fixture.spec.ts` has a real test driving
  `loginAsPersona(page, "team_lead")`. Not a live crash (it asserts the DEMO_MODE-unsupported-persona
  throw, which is still technically true), but the persona key names a backend seed identity that no
  longer exists under that name (reworked to `org_unit_lead`).
- **One minor, unenforced documentation drift:** `permission-catalog.json`'s own `_meta.counts` block
  still reads `cerbosKinds:61, concretePairs:230, grantable:215` — stale against the file's own
  current `permissions` array (60/226/211, confirmed by direct count). No test reads this block (only
  `permission-groups.json`'s own `_meta.counts` is parity-tested), so this passed silently. Low
  severity, but the exact "hand-maintained fact that lies" pattern this program keeps re-finding.
- **Already closed, checked not assumed:** the DB-side `role_permissions` orphan `IAM-DR12` itself
  flagged as a follow-up (3 `('<role>','portal.read')` rows with no matching Cerbos grant) — migration
  `0104` landed and `role-permission-parity.db.test.ts` passes clean (confirmed in this session's own
  416/416 `src/rbac/` run).
- `docs/PERMISSION-CONTRACT.md`/`docs/FRONTEND-BFF-CONTRACT.md` — refreshed by `IAM-DOCS-01` **before**
  HIER-3/DR-12 landed, so their catalog counts (230/215/61 kinds) are stale again relative to the
  current 226/211/60. Not this ticket's ownership to fix; flagged for whoever next touches those docs.

---

## Appendix A — the original 2026-08-10 scan (historical; preserved verbatim below for the delta evidence)

## 0. Headline numbers (ORIGINAL, 2026-08-10 — superseded by the RE-BASELINE above; kept for the BEFORE/AFTER delta)

| Bucket | Count | Definition |
|---|---:|---|
| **SAFE** | **17** | Zero role-mixing hazard shape anywhere in the kind's policy. Wire mechanically, pilot pattern, no caveats. |
| **EXEMPT (permanent)** | **4** | `assistant_thread`, `assistant_memory`, `agent_run`, `mcp_tool` — the IAM-04c bypass-exempt kinds. Zero `derivedRoles` rules exist on any of them; they carry ZERO grantable permissions (all 15 relationship-class), so a permission arm is not merely unnecessary here, it is **structurally forbidden** (IAM-04c §2.4: "no permission-matching rule may ever be added to the four exempt kinds' policies — there are no permissions to match"). Counted separately from SAFE so nobody reads "61 − 40 = 21 safe" and starts wiring these four. |
| **HAZARDOUS** | **40** | The mixing shape IAM-04b's pilot found is present on at least one rule/action. Needs one of three known mitigations before a permission arm is safe (§3). |
| — of which **DEAD-GRANT SUSPECT** | **22** | Handler-verified: the attribute the hazardous role's derived-role condition needs is **never populated** by any real controller for this kind (21 kinds, full) or is populated only for a subset of the kind's actions (1 kind, partial — `report_document`). This is the `team_lead`×`pm_task` shape exactly, confirmed by grep evidence, not asserted. |
| — of which **hazardous-but-verified-safe-to-mitigate** | **18** | The mixing shape is present, but handler evidence shows the dependent attribute IS reliably populated (module-composed roles) or the role's narrow reach is genuinely exercised (`team_lead` on its own `team` kind) — mitigated the same way `hr_case`'s module tier was, by **confirming** reliability, not by excluding grants. |

**61 = 17 + 4 + 40.** ⚠ **Two-thirds of the estate (40/57 = 70% of the non-exempt kinds) carries
this shape.** The pilot's own two resources were not an unlucky pair — `team_lead`'s dead-grant
pattern alone touches 23 of the 61 kinds (38%), because `team_lead` is listed in nearly every
kind's baseline "any company member" read/write rule and `pm.controller.ts`'s omission of
`teamId` turns out to be the norm, not the exception, across this codebase. **Rollout cost is
real and should be budgeted as "confirm-or-exclude every hazardous kind individually or in small,
mechanism-grouped batches," not "wire the remaining 59 kinds."**

---

## 1. The detector

`platform-nest/src/rbac/permission-arm-hazard-scan.test.ts`, static only (no DB/PDP), 12 tests,
green. It has four parts:

1. **Structural derived-role classifier** (`classifyDerivedRoleExpr`) — parses each derived
   role's raw CEL `expr` text from `derived_roles.yaml` (via `js-yaml`, not a second regex pass
   over raw text — that was this file's own first bug, see §1.1) and classifies it **SAFE** iff
   its entire match is satisfied by an unconditional `scopeType == "global"` branch **and** an
   unconditional `scopeType == "company" && scopeId == tenantId` branch, gated by nothing else.
   Everything else is **UNSAFE**, with a structured reason:
   - `top-level-attr-gate` — a `has(resource.attr.X) && ...` precondition wraps the whole grants
     check (`module_staff`/`module_manager`/`module_approver`: gated on `resource.attr.module`).
   - `no-disjunction` — a single AND-chain with no `||` alternatives at all (`team_lead`: only
     `scopeType == "team" && scopeId == teamId`).
   - `missing-scope-branch` — a disjunction exists but is missing `global` and/or `company`
     (`client`: company-only, no global branch; `group_executive`/`platform_admin`: global-only,
     no company branch — see §2.3 for why these two still matter even though they're usually
     alone in their own rule).

   This is **derived, not switched on role name** — a brand-new derived role added to
   `derived_roles.yaml` tomorrow gets classified by the same structural rule, with no code change
   needed here.

2. **Pattern-A scanner** — for every non-wildcard `EFFECT_ALLOW` rule in every `resource_*.yaml`,
   flags the rule if its `derivedRoles` list contains ≥1 SAFE role **and** ≥1 UNSAFE role. This is
   the literal shape the ticket names: "mixes scope-only matching... with attribute-dependent
   matching... in the same rule."

3. **Pattern-B scanner** — for every `(kind, action)`, flags it if a **self-scoped** rule (its
   condition compares a resource attribute to `principal.id`, either inline
   — `resource.attr.subjectUserId == principal.id`, the `hr_case`/`appraisal`/`checkin` shape —
   or via the shared `variables.owns` CEL variable (`_variables.yaml`: `has(attr.ownerId) &&
   attr.ownerId == principal.id`) — the `integration_connection`/`time_entry`/`project`/
   `report_document` shape, which the pilot's own report never mentioned) coexists with an
   **unconditional** rule granting the same action. This is `hr_case`'s Finding 1 shape,
   generalized past the one `subjectUserId` pattern the pilot's own report literally quoted — 6
   more kinds turned out to carry the exact same "member self-rule vs. company_admin/manager
   unconditional hold" shape via `owns` instead.

4. **Regression guard + teeth proof** (§5) — checks that every kind which *already* has a `perm_*`
   permission arm (discovered by prefix, not named — today: `pm_task`, `hr_case`) carries the
   matching mitigation for every hazard this scan re-derives; then constructs a synthetic
   in-memory kind reproducing the pilot's own pre-fix shape and proves the guard's core predicate
   would flag it, without ever writing to a real policy file.

### 1.1 A bug the CRLF trap caused, fixed before this report

First draft extracted `perm_*` derived-role expression text with a second regex pass over the raw
`derived_roles.yaml` file text (rather than reusing the YAML parse already done for role
classification). `derived_roles.yaml` has **CRLF line endings** (verified:
`node -e "fs.readFileSync(...).includes('\r\n')"` → `true`) and the regex assumed bare `\n` —
every extraction silently returned an empty string, and both assertions that should have found
the real `pm_task` exclusion failed with "expected false to be true." Fixed by reusing the
existing `js-yaml` parse for `perm_*` roles too (`loadAllDerivedRoleExprs()`), which already
normalizes block-scalar content — the parser had already solved the problem a second regex pass
re-broke. Recorded here because it is exactly this program's own recurring lesson (`migration
idioms that lie`, `test DB teardown`) applied to a new file: **verify a static-text assumption
against the actual bytes before trusting an extraction, even inside a same-session draft.**

### 1.2 Teeth proof (PART 4 of the test file) — actual output

```
✓ a naive (unmitigated) permission arm on a Pattern-A hazard IS flagged
✓ REVERT: the synthetic kind is never persisted anywhere — the real 61-kind parse is unaffected
✓ the SAME detector, run against the REAL pm_task (post-mitigation), finds the exclusion present
```

Mechanism: a synthetic in-memory kind (`synthetic_widget`, never written to disk) reproduces the
pilot's exact pre-fix shape — one rule mixing `company_admin`/`manager` (SAFE) with `team_lead`
(UNSAFE, `no-disjunction`), plus a naive `perm_synthetic_widget_read` role with a plain
global-or-company mirror and **no** exclusion. `scanPatternA` re-derives the hazard from the
synthetic rule alone (never told "this is hazardous" — it parses the mix structurally), and
`hasGrantsExclusionFor(naiveExpr, "team_lead")` correctly returns `false` against the
unmitigated text (the exact shape the pilot's own first cut shipped, momentarily, before the
fix). A sibling assertion runs the identical predicate against the REAL, current
`perm_pm_task_read` text and gets `true` — proving the detector's core primitive discriminates
mitigated from unmitigated, not merely "any text is fine." Revert is definitional: the synthetic
map is a local `Map` copy (`new Map(kinds)` plus one `.set()`), and a fresh `parsePolicies()` call
in the next test proves the real 61-kind parse from disk is untouched (`freshParse.size === 61`,
`freshParse.has("synthetic_widget") === false`).

### 1.3 Test results (real, this session)

```
src/rbac/permission-arm-hazard-scan.test.ts   12/12  (new, this ticket)
src/rbac/ (16 files total, incl. the new one)  274/274
npx tsc --noEmit: clean except the SAME pre-existing js-yaml declaration warning
                  role-permission-parity.db.test.ts and iam-215-boundary-pin.test.ts already carry
                  (grepped all three: identical TS7016, not something this file introduced)
```

`gaiada-test-cerbos`/`gaiada-test-pg` were **not needed** — this detector is 100% static (policy
YAML + derived-role CEL text), matching `iam-215-boundary-pin.test.ts`'s own precedent for exactly
this reason: no PDP staleness trap to manage, runs anywhere, catches drift at parse time.

---

## 2. The full 61-kind register

### 2.1 SAFE (17) — wire mechanically, pilot pattern, no caveats

`agency_brief`, `agency_campaign`, `agency_creative_asset`, `chat_group`, `company`,
`compliance_gate`, `contract`, `identity_link`, `invoice`, `knowledge_source`, `report_admin`,
`rollup`, `rollup_recompute`, `service_assignment`, `user`, `webdev_change_request`,
`webdev_provisioned_site`.

Every rule in these files either names only SAFE roles (`company_admin`/`manager`/`member`/
`viewer`/`group_executive` alone, or `group_executive` correctly split into its OWN
`notLow`-only rule — see `webdev_change_request`/`webdev_provisioned_site`'s own header comment,
"TRAP #4", which explicitly documents doing this correctly), or splits `module_staff`/
`module_manager` into a **separate** rule from any SAFE role for the same action (so there is no
same-rule mixing — `service_assignment.read` is the clean version of this: `group_executive`/
`company_admin` get their own rule, `module_staff`/`module_manager` get their own separate one).

One reliability nuance worth a note, not a reclassification: `service_assignment.read`'s
`module_staff`/`module_manager` rule resolves `resource.attr.module` from a **caller-supplied
query parameter** (`service-assignments.controller.ts:601,668`: `module: moduleQ || undefined`),
unlike every other module-composed kind's hardcoded literal. This is not a privilege-escalation
path (a caller can only reveal whether they hold `<module>_staff`/`<module>_manager` for a module
they name, never forge a grant), and — because `module_staff`/`module_manager` sit in their own
rule here, not mixed with a SAFE role — it does not produce the Pattern-A hazard shape either way.
Flagged for completeness only.

### 2.2 EXEMPT (4) — permanently out of scope, never wire

`assistant_thread`, `assistant_memory`, `agent_run`, `mcp_tool`. Zero `derivedRoles` rules on any
of the four (re-verified this session, matches `iam-215-boundary-pin.test.ts`'s own pin). IAM-04c
§2.4: "no permission-matching rule may ever be added to the four exempt kinds' policies (there are
no permissions to match — the 15 are not in the catalog)." Not a rollout candidate at any phase.

### 2.3 HAZARDOUS — by mechanism

#### Mechanism 1 — `team_lead` (no plain scope branch at all: `no-disjunction`)

23 kinds carry a rule mixing `team_lead` with ≥1 of `company_admin`/`manager`/`member`/`viewer`.
Handler evidence (grepped `teamId:` as a `Resource`-construction key across every `*.controller.ts`
and `*.service.ts` in `src/`): **`teamId` is set in exactly two places in the entire codebase** —
`teams.controller.ts` (self-referential, for the `team` kind's own id) and
`reports.controller.ts:166` (`teamId: grain === "department" ? scopeRef : undefined`, only for
`report_document`'s `read_department` grain).

| Sub-bucket | Kinds | Evidence |
|---|---|---|
| **DEAD-GRANT SUSPECT (confirmed, full)** — 21 kinds | `activity`, `appraisal` (dept-lead rule only: `read`/`write`/`submit`/`confirm_evidence`), `client`, `client_contact`, `comment`, `custom_field`, `deliverable`, `device`, `file`, `integration_connection`, `meeting_recording`, `member`, `notification`, `org_structure`, `pm_project`, `pm_task`, `project`, `report_period` (`view`), `task`, `time_entry`, `work_activity` | `teamId` never set for these kinds by any controller. **4 of the 21 are already pinned by existing, pre-this-ticket tests**: `pm_task` (the pilot's own finding, `pm-adversarial-authz.test.ts`), `device` (`personas.test.ts:74`), `integration_connection` (`cerbos-webdev-matrix.test.ts:137`), `client_contact` (`cerbos-webdev-matrix.test.ts:178`). The other 17 share the identical mechanism (verified: same absence of `teamId`-setting code) but have no dedicated pinned test yet. |
| **DEAD-GRANT SUSPECT (confirmed, partial)** — 1 kind | `report_document` | Dead for `read_person`/`read_project` (`teamId` undefined for those grains, `reports-cerbos.test.ts:317`'s own comment: `appraisals.controller.ts never sets teamId on an appraisal resource`); genuinely reachable for `read_department` (`teamId` = the org-unit id, `reports-cerbos.test.ts:121`: `expect(await allow(teamLead, deptDoc, "read_department")).toBe(true)`). **Any mitigation here must be per-action, not per-kind** — excluding `team_lead` blanket-style would remove a real, tested grant on `read_department`. |
| **Hazardous but NOT dead** — 1 kind | `team` | `teams.controller.ts` sets `teamId: teamId` (the team's own id) on every `authorize()` call, and a `team_lead` grant is created with `scope_id` = that same team id (`teams.controller.ts:112`, `grantRole(..., "team", teamId)`). So `team_lead` genuinely reads its own team via the role arm — this is the most surprising-adjacent finding of the whole scan: **the one kind where `team_lead`'s bundle claim is NOT a phantom.** The scope-exclusion mitigation is still needed (the schema still permits granting `team_lead` at company/global scope, which the real role arm would deny but a naive mirror would not), and it is still **safe** to apply — per the pilot's own proof, excluding a scope from the permission arm never removes role-arm access, so the genuine team-scope reach is untouched by excluding company/global-scope `team_lead` entries from `perm_team_read`. |

#### Mechanism 2 — `group_executive` (`missing-scope-branch`: no company branch)

6 kinds: `automation_approval`, `pipeline_gate`, `pipeline_run`, `pipeline_stage`, `portal`,
`scope_signoff`. `group_executive`'s derived role matches `scopeType == "global"` only
(`derived_roles.yaml:18-24`) — no company branch — so a `group_executive` grant recorded at
company scope (schema-permitted, same as every other role) would be denied by the real role arm
but allowed by a naive global-or-company permission mirror. Structurally the same class of hazard
as `client`, generalized to a role the pilot's own report never named.

🔴 **Bonus finding, out of this ticket's remit but real and live:** all 6 of these kinds fold
`group_executive` into the **same rule** as `company_admin`/`manager` under an `inTenant &&
notLow` condition (e.g. `resource_automation_approval.yaml`'s `read` rule:
`derivedRoles: ["company_admin", "manager", "group_executive"]`, condition `inTenant && notLow`).
This is the exact anti-pattern **"TRAP #4"** is written to warn against in
`resource_webdev_change_request.yaml`/`resource_integration_connection.yaml`'s own header
comments: `inTenant` is `resource.tenantId in principal.companies`, which is **never true** for a
pure global `group_executive` grant with no `company_memberships` row in that tenant — so on
these 6 kinds, the sole real `group_executive` holder is silently denied read/decide access to
the automation-approval inbox, pipeline gates, and scope sign-offs for every company they are not
also a member of, defeating the role's entire cross-company-oversight design intent. This is a
**pre-existing, unrelated role-arm correctness bug**, not a permission-arm hazard — it exists with
or without IAM-04 — and I have **not fixed it** (out of scope: "do NOT change any authorization
decision"). Flagged for its own follow-up ticket; whoever picks it up should fix the role arm
(split `group_executive` into its own `notLow`-only rule, matching the 3 kinds that already do
this correctly) **before** wiring a permission arm to these 6 kinds, since the correct role-arm
shape changes what the permission arm needs to mirror.

#### Mechanism 3 — `module_staff`/`module_manager`/`module_approver` (`top-level-attr-gate`)

10 kinds: `hr_case` (mitigated, IAM-04b pilot), `hr_record`, `agency_approval`, `search_audit`,
`search_campaign`, `search_engagement`, `search_keyword`, `search_ledger`, `search_property`,
`search_report`. **All 10 confirmed RELIABLE by handler grep — none is a dead-grant suspect:**

| Module | Kinds | Evidence |
|---|---|---|
| `"hr"` | `hr_case`, `hr_record` | `hr.controller.ts`/`loans.controller.ts`: every one of 20+ `authorize()` call sites passes the literal `module: "hr"`. |
| `"search"` | 7× `search_*` | `search.controller.ts`/`search-reports.controller.ts`/`search-google-*.controller.ts`: every call site passes the literal `module: "search"`. |
| `"agency"` | `agency_approval` | `agency.controller.ts`: every call site passes the literal `module: "agency"`. |
| `"reports"` | (via `report_document`'s served-dept rule, Mechanism 4 territory) | `resource_report_document.yaml`'s own rule condition **redundantly** re-checks `request.resource.attr.module == "reports"` on top of the derived role's own gate — the strongest form of confirmation, written defensively into the policy itself. |
| `"webdev"` | `webdev_change_request`, `webdev_provisioned_site` | Already in the SAFE bucket (§2.1) — module_staff/manager sit in their own separate rule, no same-rule mixing; reliability additionally live-tested (`cerbos-webdev-matrix.test.ts`'s `module_manager`/`module_staff` cases, real ALLOW/DENY assertions against `gaiada-test-cerbos`). |

Mitigation for all 10: **confirm-reliable**, identical to what the pilot already did for
`hr_case` — no `attr.grants` exclusion needed, because the module value is never wrong or absent
for these kinds' real call sites. This is the SAME conclusion IAM-04b's own report reached for
`hr_case` specifically; this ticket extends the same verification to the other 9.

#### Mechanism 4 — Pattern B: self-scoped rule vs. unconditional rule, same action

7 kinds: `hr_case` (mitigated), `appraisal`, `checkin`, `integration_connection`, `project`,
`report_document`, `time_entry`.

| Kind | Action(s) | Self-scoped via | Unconditional role(s) also granting it |
|---|---|---|---|
| `appraisal` | `read` | `member` + inline `subjectUserId == principal.id` | `hr_people_ops`, `group_executive`, `manager`+`team_lead` |
| `checkin` | `read` | `member` + inline `subjectUserId == principal.id` | `group_executive`, `hr_people_reader`, `company_admin`, `manager` |
| `integration_connection` | `read`, `create`, `update`, `delete` | `member`/`viewer`/`team_lead` + `variables.owns` | `group_executive`, `company_admin`+`manager` |
| `project` | `create`, `update`, `delete` | `member` + `variables.owns` | `company_admin`+`manager`+`team_lead` |
| `report_document` | `read_person` | `member` + `variables.owns` | `group_executive`, `company_admin`, `hr_people_reader`, `manager`+`team_lead` |
| `time_entry` | `update`, `delete` | `member` + `variables.owns` | `company_admin`+`manager`+`team_lead` |

**4 of these 6 unmitigated kinds use `variables.owns`** (`_variables.yaml`: `has(attr.ownerId) &&
attr.ownerId == principal.id`), a shape the pilot's own report text never mentions (it only
quotes the inline `subjectUserId` pattern) — this is the single largest gap this scan closes
relative to the pilot's own write-up. Mitigation: the same "selective self-scoped mirroring" the
pilot built for `hr_case`'s `read`/`create`/`cancel` — a permission-arm rule for these actions
must carry the SAME self-check condition, never an unconditional mirror, or any holder of the
permission key (regardless of which role actually granted it) would be let through as if they
held the broader, unconditional tier.

**Overlap note:** `integration_connection`, `project`, `report_document`, `time_entry` are
**already** in the Mechanism-1 dead-grant bucket (they also mix `team_lead` in the SAME or a
sibling rule) — these four kinds need **two independent mitigations** on the affected actions
(team_lead exclusion AND self-scoped mirroring), not one. `checkin` is the one Mechanism-4 kind
with **no** team_lead involvement at all — it needs only the self-scoped-mirror treatment.

---

## 3. The three known mitigations (all precedented by the pilot; none newly invented here)

1. **Scope-exclusion** (`team_lead`/`client`/`group_executive`-style — `no-disjunction` or
   `missing-scope-branch`): the `perm_<kind>_<action>` derived role's global/company branches each
   add `&& !request.principal.attr.grants.exists(x, x.role == "<unsafe role>" && <same scope
   shape>)`, exactly as `perm_pm_task_*` does for `team_lead`. Provably never removes real access
   (§4 of the pilot report; re-confirmed structurally by this scan's teeth test, §1.2).
2. **Confirm-reliable** (`module_staff`/`module_manager`/`module_approver`-style —
   `top-level-attr-gate`): no policy change at all — verify (as this ticket did, §2.3 Mechanism 3)
   that the gating attribute is always set to the expected literal by every real handler for that
   kind, then wire the permission arm with the derived role's condition unchanged. This is a
   verification cost, not a code cost.
3. **Selective self-scoped mirroring** (Pattern B — self-scoped vs. unconditional): build a
   permission-arm rule ONLY for the self-scoped path, carrying the identical self-check condition
   as its role-arm counterpart (inline `subjectUserId`/`ownerId` equality, or `variables.owns`);
   never build an unconditional mirror for that specific action, even if another role in the same
   kind holds it unconditionally.

Kinds needing **more than one** mitigation on different actions of the same kind: `pm_task`
(scope-exclusion only, already mitigated), `hr_case` (confirm-reliable + selective self-scoped
mirroring, already mitigated — the pilot's two-mechanism resource), `integration_connection`,
`project`, `report_document`, `time_entry` (scope-exclusion + selective self-scoped mirroring,
**not yet mitigated**).

---

## 4. Recommended rollout order

**Batch, don't drip-feed the SAFE kinds; go one-at-a-time (or very small, mechanism-pure batches)
for everything else.** Rationale: SAFE kinds have zero judgment calls, so batching them costs
nothing extra in review risk. Every HAZARDOUS kind requires a human (or at minimum a
ticket-scoped agent) to look at the SPECIFIC mitigation and the SPECIFIC action list — the pilot's
own §4 finding (a naive first cut flipped a real test 403→200) is exactly the failure mode that
batching HAZARDOUS kinds together would reproduce at scale, silently, across many kinds at once.

| Order | Batch | Kinds | Why this grouping |
|---|---|---|---|
| **1** | SAFE, batch A (agency vertical) | `agency_brief`, `agency_campaign`, `agency_creative_asset` | Same module, same reviewer context, zero mixing anywhere. |
| **1** | SAFE, batch B (core entities) | `company`, `contract`, `invoice`, `user`, `identity_link`, `chat_group`, `compliance_gate`, `knowledge_source` | Foundational kinds; no module composition, no self-scope, no team_lead. |
| **1** | SAFE, batch C (ops/admin) | `report_admin`, `rollup`, `rollup_recompute`, `service_assignment` | Admin/exec-only surfaces; already exercise the `group_executive`-alone-in-its-own-rule correct shape. |
| **1** | SAFE, batch D (webdev pair) | `webdev_change_request`, `webdev_provisioned_site` | Byte-level policy siblings (each file says so), live-tested together already (`cerbos-webdev-matrix.test.ts`). |
| **2** | HAZARDOUS, confirm-reliable (module mechanism) | `hr_record`, `agency_approval`, `search_audit`, `search_campaign`, `search_engagement`, `search_keyword`, `search_ledger`, `search_property`, `search_report` | All 9 share the IDENTICAL, already-verified-reliable mechanism (§2.3, Mechanism 3) — the module literal is confirmed, so this is "confirm the same thing 9 times" work, batchable, but still worth a per-kind commit so a future audit can point at exactly which kind's confirmation landed when. |
| **3** | HAZARDOUS, self-scope only (Pattern B, no team_lead) | `checkin` | One kind, one mitigation, no interaction with any other mechanism — the cleanest possible next step after the confirm-reliable batch. |
| **4** | HAZARDOUS, dead-grant, no Pattern B interaction | `activity`, `client`, `client_contact`, `comment`, `custom_field`, `deliverable`, `device`, `file`, `meeting_recording`, `member`, `notification`, `org_structure`, `pm_project`, `task`, `work_activity`, `report_period` | Pure `team_lead` scope-exclusion, mechanically identical to the already-shipped `pm_task` fix, but **one kind at a time** — each needs its own adversarial-test check (only 2 of these 16 currently have one: none, actually — `device`/`client_contact`/`integration_connection` are the 3 pre-existing ones and none is in this batch since `integration_connection` has a Pattern-B interaction too). Recommend pairing each kind's rollout with a NEW pinned adversarial test proving `team_lead` still denies post-wiring, mirroring `pm-adversarial-authz.test.ts`. |
| **5** | HAZARDOUS, dual-mitigation (team_lead + Pattern B) | `integration_connection`, `project`, `time_entry` | Needs BOTH scope-exclusion and selective self-scoped mirroring on overlapping or adjacent actions — do individually, verify each mitigation independently before combining. |
| **6** | HAZARDOUS, dual-mitigation + per-action nuance | `report_document` | The most delicate kind in the register: team_lead is dead on 2 of 3 dept-lead actions but genuinely reachable on the third (`read_department`), AND it carries a Pattern-B self-scope hazard on a 4th action (`read_person`). Needs its own design pass, not a batch. Do last among the "already-understood" kinds. |
| **7** | HAZARDOUS, `team_lead`-genuinely-reachable | `team` | Do individually; the scope-exclusion mitigation is safe here (per §2.3's proof) but deserves its own adversarial test asserting the GENUINE team-scope grant still works post-wiring, not just that company/global-scope misuse is denied — the one kind where a false "it's just like pm_task" copy-paste could accidentally weaken real, working access if the exclusion were miswritten. |
| **8** | BLOCKED on a separate, prior ticket | `automation_approval`, `pipeline_gate`, `pipeline_run`, `pipeline_stage`, `portal`, `scope_signoff` | **Recommend a `group_executive` role-arm correctness fix ticket lands FIRST** (§2.3 Mechanism 2's bonus finding — the TRAP-4 violation), because the correct role-arm shape (splitting `group_executive` into its own `notLow`-only rule) changes what the permission arm needs to mirror. Wiring a permission arm around a KNOWN-BROKEN role arm risks encoding the bug into the permission catalog's shape. |

---

## 5. Answering the ticket's specific questions

**Most surprising hazardous kind:** `group_executive`'s presence in this hazard class at all. The
pilot's own report and its own §8 follow-up named `team_lead`/`module_staff`/`module_manager`/
`module_approver`/`client` as the attribute-dependent roles to watch for — never
`group_executive`, the SECOND-highest tier in the system. Finding it required re-deriving the
classification structurally rather than trusting the pilot's own named list (exactly the point of
"derive, don't hand-maintain"), and it led directly to a second, independent, live, pre-existing
role-arm bug (§2.3 Mechanism 2's TRAP-4 finding) that has nothing to do with the permission arm at
all — the sole real `group_executive` holder is silently denied cross-company oversight on 6
governance surfaces today, right now, regardless of whether IAM-04 ever lands.

**Teeth-check output:** see §1.2 — 3/3 PART-4 tests green, reproducing the pilot's exact pre-fix
shape in an isolated, in-memory synthetic kind, proving the detector's mitigation predicate
(`hasGrantsExclusionFor`) returns `false` for an unmitigated arm and `true` for the real,
already-mitigated `perm_pm_task_read`, then proving the synthetic construction never touched the
real 61-kind parse.

**SAFE / HAZARDOUS / DEAD-GRANT counts:** 17 / 40 / 22 (the 22 is a sub-count of the 40, per §0's
table — not a disjoint third partition; the pilot's own `team_lead`×`pm_task` example is
literally both the archetypal HAZARDOUS case and the archetypal DEAD-GRANT-SUSPECT case in the
ticket's own text, which is why this register treats DEAD-GRANT SUSPECT as "the confirmed-worst
subset of HAZARDOUS," not a separate bucket kinds get sorted into exclusively).

**If most are hazardous, say so plainly:** yes — 40 of 57 non-exempt kinds (70%) carry this shape.
This is not a two-resource anomaly; it is the norm for this codebase's policy style (nearly every
kind's baseline read/write rule lists `team_lead` alongside the plain scope-only roles, on the
apparent assumption that team scope should "just work" the same way company scope does — it does
not, for any kind except `team` itself and one grain of `report_document`). **Budget
IAM-04-ROLLOUT as a per-kind or small-batch program with its own adversarial test per kind, not as
a mechanical sweep** — 22 kinds need a real handler-verified exclusion, 18 need a lighter
confirm-or-self-scope treatment, and 6 are blocked on an unrelated, real, live bug this scan
surfaced as a side effect.

---

## 6. Blockers / follow-ups (not this ticket's remit)

- **The `group_executive` TRAP-4 violation (§2.3 Mechanism 2)** is a live, real, pre-existing
  authorization-correctness bug independent of IAM-04. Recommend its own ticket, landed before any
  of the 6 affected kinds get a permission arm.
- **16 of the 21 full dead-grant `team_lead` kinds have no dedicated pinned adversarial test yet**
  (only `pm_task`/`device`/`integration_connection`/`client_contact` do). Recommend each rollout
  batch in §4 ships its adversarial pin alongside the mitigation, not after.
- **`report_document`'s per-action `team_lead` split** (dead on 2 grains, live on 1) is not
  expressible as a single blanket exclusion — whoever picks up batch 6 needs to scope the
  exclusion to `read_person`/`read_project` only, or build it generically enough that
  `read_department`'s genuine reach survives. Flagged, not solved, here.
- **This register is a snapshot.** As batches land, kinds move from HAZARDOUS to
  mitigated-and-still-hazardous-shape (the mitigation removes the RISK, not the SHAPE — a mixed
  rule stays mixed, it just gets an exclusion). The detector (§1) re-derives the shape fresh every
  run and will keep finding these 40 kinds' mixing forever, by design — that is what makes it a
  regression guard rather than a one-time report. Do not "fix" the detector to stop reporting a
  kind once it's mitigated; instead extend PART 3's mitigation check (already generic) to cover
  each newly-wired kind, which happens automatically the moment that kind's name appears in
  `kindsWithPermissionArm()`'s discovered set — no code change needed there either.
