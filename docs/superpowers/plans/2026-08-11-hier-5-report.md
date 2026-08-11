# HIER-5 — re-scan, re-baseline, orphan sweep: implementation report

**Status:** MEASURED / DEV-VERIFIED (this is a measurement-and-planning ticket; no permission arm
was wired, no policy/migration/artifact was modified). Per `docs/superpowers/plans/2026-08-10-iam-hier-01-plan.md`'s
own HIER-5 spec, depends on HIER-3 (landed, `docs/superpowers/plans/2026-08-11-hier-3-report.md`).

**Parents:** `2026-08-10-iam-04-rollout-scan.md` (the register this ticket re-baselines — see its new
top section, "RE-BASELINE (HIER-5, 2026-08-11)"), `2026-08-10-iam-hier-01-plan.md` (this ticket's own
spec + the pre-work prediction being tested), `2026-08-11-hier-3-report.md` /
`2026-08-11-hier-3-ui-report.md` (what just landed), `2026-08-11-iam-dr12-report.md` (an unrelated,
concurrently-landed fix that turned out to change one bucket count — see §1).

**Owns:** `docs/superpowers/plans/2026-08-10-iam-04-rollout-scan.md` (re-baselined — new top section
added, original content preserved verbatim as "Appendix A"), this report. **Touched nothing else** —
no policy, migration, test, or source file was edited. `permission-arm-hazard-scan.test.ts` was RUN
(74/74 green, unmodified) and read for its detector logic; a throwaway scratchpad port of its PART
1/2 functions was written and run to dump full per-kind hit lists the real file deliberately does not
print (it only asserts bounds, to avoid the hand-maintained-list-drift defect class) — that scratchpad
lives outside the repo (`…/scratchpad/hier5-rescan.js`) and touches nothing under version control.

---

## 0. Method

1. Re-ran `platform-nest/src/rbac/permission-arm-hazard-scan.test.ts` unmodified — **74/74 green**.
2. Confirmed Cerbos freshness before trusting any live probe: `docker inspect gaiada-test-cerbos
   --format '{{.State.StartedAt}}'` → `2026-08-11T06:00:20Z`, which postdates every policy edit in
   both HIER-3 and IAM-DR12 (their own reports independently confirm restarts at `06:00:20Z` and
   `05:43:54Z` respectively — this session's container is the later of the two, so it carries both).
   `docker run --rm ... ghcr.io/cerbos/cerbos:latest compile /policies` — clean, "0 tests executed",
   no compile errors.
3. Wrote a throwaway Node port of the detector's PART 1 (`classifyDerivedRoleExpr` and its helpers)
   and PART 2 (`parsePolicies`, `scanPatternA`, `scanPatternB`) — byte-equivalent logic, TypeScript
   types stripped, same method the HIER-01 consolidation plan itself used for its own pre-work
   projection (its own §1.1: "ported byte-equivalent ... run twice"). Ran it against the current
   `platform-nest/cerbos/policies/` tree to dump the full per-kind SAFE/HAZARDOUS list and every
   Pattern-A/B hit — information the real test file deliberately never prints as a literal (see its
   own header comment on why: a checked-in kind list would be "hand-maintained-list-drift defect #6").
4. Cross-checked every wired-vs-unwired claim against `grep -l "perm_" cerbos/policies/resource_*.yaml`
   (29 files) and against `kindsWithPermissionArm()`'s own discovery mechanism.
5. Live-probed the `group_executive` TRAP-4 finding directly against the restarted PDP
   (`POST /api/check/resources`), not inferred from policy text — both the broken shape
   (`automation_approval`) and the correctly-split contrast (`appraisal`) were exercised.
6. Ran the full `src/rbac/` suite (22 files) plus `src/db/user-roles-org-unit-scope*.db.test.ts`,
   `src/modules/reports/`, `src/core/portal-client-contacts.test.ts`, and `src/admin/` to catch any
   regression the re-baseline should report, per the ticket's own instruction to check for orphaned
   references "anywhere — policies, bundles, catalog, seeds, fixtures, the UI mirror."
7. Swept the whole repo (`platform-nest/` and `platform-ui/`) for `team_lead`, `team_memberships`,
   `core.team.*`, and `"team"`-as-scope-type, and manually classified every hit as historical comment
   vs. functional reference.

---

## 1. Measured vs predicted bucket counts

| Bucket | BEFORE (2026-08-10) | PREDICTED (HIER-01 plan) | **MEASURED (this ticket)** | Held? |
|---|---:|---:|---:|---|
| Kinds | 61 | 60 | **60** | exact |
| EXEMPT | 4 | 4 | **4** | exact |
| SAFE | 17 | 34 | **35** | off by +1 |
| HAZARDOUS | 40 | 22 | **21** | off by −1 |
| DEAD-GRANT SUSPECT (sub of HAZARDOUS) | 22 | 0 | **0** | exact |
| Hazard rate | 70% | 39% | **37.5%** | within noise |

**The prediction held.** The `team_lead`-specific effect the HIER-01 plan measured — 18 kinds leaving
HAZARDOUS, DEAD-GRANT SUSPECT going to exactly zero — reproduces **identically** under this session's
independent re-derivation: the same 17 kinds move HAZARDOUS→SAFE, the same 1 kind (`team`) leaves the
estate, and zero DEAD-GRANT SUSPECT kinds remain (the mechanism — `team_lead` mixed into a rule whose
handlers never populate `teamId` — cannot exist once the role, its derived role, and every writer
that could mint the grant are gone).

The ±1 delta (35 SAFE / 21 HAZARDOUS instead of the predicted 34/22) is **not** a miss in the
prediction. It is `portal`, and it did not move because of anything HIER-3 did. A second, unrelated,
concurrently-landed ticket — `IAM-DR12` (`docs/superpowers/plans/2026-08-11-iam-dr12-report.md`) —
found (by *driving the live API as real personas*, not by reading policy text) that `portal.yaml`'s
staff/`group_executive` read rule was dead: `core/portal-scope.ts`'s `callerClientIds()` throws "not
a portal client" for any principal with zero `client_contacts` rows, which is every staff member by
construction, so the grant could never be exercised by anyone holding it. The owner decision was to
**delete** the whole rule rather than wire it up or split it — and deleting it also, as a side effect
nobody was measuring for, removed `portal` from the `group_executive`-mixed-with-`company_admin`/
`manager` TRAP-4 shape (§4). **Stated plainly per the ticket's instruction:** the real numbers are not
worse than forecast anywhere — they are one kind better, for a reason the HIER-01 plan's own
projection (written before IAM-DR12 was scoped) could not have included. If the ±1 had instead
represented HIER-3 undershooting its own claimed 18-kind effect, that would be a different, worse
finding; it does not — reproducing the 18-kind list exactly (§2) is the check that rules that out.

## 2. The 18 kinds `team_lead` retirement moved, reproduced exactly

HAZARDOUS → SAFE (17, byte-identical to the HIER-01 plan's own list): `activity`, `client`,
`client_contact`, `comment`, `custom_field`, `deliverable`, `device`, `file`, `meeting_recording`,
`member`, `notification`, `org_structure`, `pm_project`, `pm_task`, `report_period`, `task`,
`work_activity`. Left the estate (1): `team`.

Stayed hazardous, for their independent Pattern-B shape only (also as predicted): `appraisal`,
`integration_connection`, `project`, `report_document`, `time_entry`.

## 3. What's already wired — a fact the original register predates

Since the 2026-08-10 scan, a separate, concurrent ticket — **`IAM-04-ROLLOUT-B12`**
(`docs/superpowers/plans/2026-08-10-iam-04-rollout-b12-report.md`) — already wired the *original*
rollout order's batches 1–3 for real: the 17-kind SAFE batch, the 9-kind confirm-reliable module
batch, and `checkin`'s self-scope batch, plus the pre-existing pilot (`pm_task`, `hr_case`). That is
**29 of the 60 kinds** (confirmed by `grep -l "perm_" cerbos/policies/resource_*.yaml` → 29 files,
cross-checked against the detector's own `kindsWithPermissionArm()`):

- **18 SAFE-and-wired:** the original 17-kind batch-1 list + `pm_task` (pilot).
- **11 HAZARDOUS-and-wired (mitigated, shape unchanged by design):** `hr_case` (pilot), `hr_record`,
  `agency_approval`, `resource_search_audit`, `resource_search_campaign`, `resource_search_engagement`,
  `resource_search_keyword`, `resource_search_ledger`, `resource_search_property`,
  `resource_search_report`, `checkin`.

This matters directly for "what is genuinely left": of the 60-kind estate, only **27 kinds are open
rollout work** (17 new-SAFE + 5 Pattern-B-only + 5 TRAP-4-blocked), not the 59 a reader of only the
original register would assume remained after the pilot's 2.

## 4. Re-derived remaining rollout order

| Order | Batch | Kinds | Status |
|---|---|---|---|
| — | Original batches 1–3 | 29 | **DONE** (§3) — zero action needed |
| **1** | New-SAFE (freed by retirement + DR-12) | `activity`, `client`, `client_contact`, `comment`, `custom_field`, `deliverable`, `device`, `file`, `meeting_recording`, `member`, `notification`, `org_structure`, `pm_project`, `portal`, `report_period`, `task`, `work_activity` (17) | Mechanical, batchable, zero judgment calls — identical to the already-shipped batch 1 pattern |
| **2** | `group_executive` role-arm correctness fix | `automation_approval`, `pipeline_gate`, `pipeline_run`, `pipeline_stage`, `scope_signoff` (role-arm only) | Split `group_executive` into its own `notLow`-only rule per kind (§5) — do this before batch 4 |
| **3** | Pattern-B selective self-scoped mirroring | `integration_connection`, `project`, `report_document`, `time_entry`, `appraisal` (5) | One kind at a time, per-action mitigation table in the re-baselined register §R.5, each with its own adversarial pin |
| **4** | Permission arm, post-fix | Same 5 kinds as batch 2 | Only after batch 2 lands — mirror the corrected role arm, not the pre-fix shape |

Batches 1 and 3 are independent of each other and of 2/4. Batch 4 is strictly gated on batch 2.

## 5. The `group_executive` TRAP-4 kinds — still blocked; fix now, don't wait for D-7

**Down from 6 to 5** — `automation_approval`, `pipeline_gate`, `pipeline_run`, `pipeline_stage`,
`scope_signoff`. `portal` left this bucket via IAM-DR12's rule *deletion*, not the role-arm *split*
fix the original register recommended (§1).

**Re-confirmed live** against the freshly-restarted PDP, not inferred from YAML text:

```
group_executive@global, principal has a company-membership row in t1
  -> automation_approval.read = ALLOW

SAME grant, principal has ZERO company-membership row in t1 (the pure cross-company-exec shape
the role exists to serve)
  -> automation_approval.read = DENY        <-- the live bug

Contrast: appraisal (already correctly split into its own notLow-only group_executive rule),
identical zero-membership pure-exec principal
  -> appraisal.read = ALLOW                 <-- proves the fix shape works, cheaply, today
```

Root cause unchanged from the original register: all 5 fold `group_executive` into the SAME rule as
`company_admin`/`manager` under `inTenant && notLow`, and `inTenant`
(`resource.tenantId in principal.companies`) is never true for a pure global grant with no
`company_memberships` row in that tenant.

**The call this ticket was asked to make — fix now, or wait for D-7's deletion of the role?**
**Fix now.** Reasoning:

1. This is a live authorization-correctness bug, independent of IAM-04-ROLLOUT entirely. It denies
   the ONE role whose entire design purpose is cross-company oversight, on five governance-sensitive
   surfaces (automation approvals, pipeline gates/runs/stages, scope sign-offs), **today**, whether or
   not the permission-arm rollout ever reaches these five kinds.
2. The fix is cheap and fully precedented: split one rule into two, copying the shape
   `appraisal`/`checkin`/`client_contact` already use correctly. No new mechanism to design or
   architect-approve.
3. `D-7` is an unscheduled Phase-3 item with no committed date. Blocking a known, cheap fix on it
   indefinitely trades a small near-term cost for an open-ended continuation of a live bug. Fixing now
   does not waste work if D-7 later deletes `group_executive` anyway — a correctly-split rule is
   exactly as easy to delete as an incorrectly-mixed one.

**Honest caveat:** whether this bug has *live* blast radius today — i.e., whether any real
`group_executive` holder on `gda-aicenter` currently lacks a `company_memberships` row in an affected
tenant — was not checked here; that requires a live query against the production estate, out of this
ticket's read-only-against-test-containers scope. The recommendation to fix now stands regardless
(a correctness bug is worth closing at this cost independent of its current exploitation), but the
urgency framing should not be read as a claim that live traffic is being denied right now — only that
the mechanism to deny it exists and is proven, live, on the test PDP.

**Sequencing consequence, unchanged from the original register:** wiring a permission arm around this
known-broken role arm before fixing it would encode the bug's shape into the permission catalog. Fix
the role arm first (batch 2), then wire (batch 4).

## 6. Orphaned-grant / orphaned-reference sweep

Confirmed via full-repo grep (`platform-nest/` + `platform-ui/`) for `team_lead`, `team_memberships`,
`core.team.*`, `scope_type`/`scopeType` naming `"team"`, then manually classified every hit as
historical-comment (left deliberately, matching repo idiom for retired concepts) vs. functional.

### 6.1 Clean

- **Cerbos policies** (`derived_roles.yaml` + all `resource_*.yaml`) — zero functional references;
  `cerbos compile` clean; live probes behave as expected (a `team_lead`-named role now resolves to no
  derived role at all — DENY everywhere, confirmed).
- **`role-permission-bundles.json`** — 20 roles, 861 pairs, **zero** `team_lead` occurrences (`grep -c
  team_lead` → 0). Matches HIER-3's own reported regeneration exactly.
- **`permission-catalog.json`** (content) — 226 permissions, 211 grantable, zero `core.team.*` keys.
  Matches HIER-3's own reported 230→226 / 215→211.
- **`permission-groups.json`** — 74 groups, 211 grantable-in-catalog, 209 covered, own `_meta.counts`
  block internally consistent AND parity-tested (`permission-groups-catalog-parity.test.ts` re-derives
  and asserts every one of its own count fields — 9/9 green this session). Matches HIER-3's reported
  75→74.
- **`platform-nest/src/rbac/principal.ts`, `src/testing/fixtures.ts`,
  `src/modules/reports/person-scope.ts`** — `scopeType` unions narrowed to
  `"global"|"company"|"org_unit"|"project"`; every remaining `team_lead` text in these files is a
  historical/rationale comment (verified line-by-line, not just grep-matched).
- **`platform-ui/src/lib/rbac.ts`** — 10 `team_lead` text matches, all confirmed historical comments
  (Role union and `ROLE_CAPS` entries themselves are gone, per HIER-3-UI's own report); none is a
  live object key, array entry, or `as Role` literal.
- **`platform-ui/src/lib/rbac-capability-parity.test.ts`** — the `KNOWN_NON_DRIFT` entry for
  `team_lead`×`company.manage` that HIER-3-UI's own report flagged as "will go stale once the backend
  bundle is regenerated, must be deleted then" — **already gone** (zero `team_lead` matches in this
  file now). The backend regeneration HIER-3-UI predicted would trigger this has since completed; the
  entry's absence is consistent with someone (or the guard's own self-correction path) having removed
  it, or with it never having survived past that regeneration. Either way, the file is currently
  clean and its own guard is green.
- **DB-side orphan IAM-DR12 itself flagged** (`role_permissions` rows `('company_admin'|'manager'|
  'group_executive', 'portal.read')` with no matching Cerbos grant) — **closed**. Migration `0104`
  (`0104_iam_dr12_drop_portal_staff_bundle_rows.sql`) landed with count-asserted, re-runnable deletes;
  `role-permission-parity.db.test.ts` passes clean in this session's own full `src/rbac/` run
  (416/416, 22 files).
- **Migration ledger** — head `0104`, next unused `0105` (re-verified via `ls migrations | sort |
  tail` before writing this report), no dangling reservations beyond the permanent `0058`/`0059`/
  `0070` gaps.

### 6.2 Found — genuine, currently-red regression (not caught by any prior sweep)

**`platform-nest/src/admin/managed-by-invariant.test.ts`**, test "A1 detective control — managed_by
is reconciler-only > promoting a team lead never produces a managed_by-set user_roles row"
(lines 118–145): still `POST`s to `/api/${A}/teams` and `/api/${A}/teams/${teamId}/members` — both
endpoints HIER-3 deleted outright (`core/teams.controller.ts`, `teams.test.ts` removed, zero UI
callers, W1 in the HIER-3 report). Result: `expected 404 to be 201`.

Reproduced twice, not transient: isolated re-run (`npx vitest run
src/admin/managed-by-invariant.test.ts` → 5 passed, 1 failed) and inside a 48-file, 774-test
full-directory run (same single failure, same assertion). This test was outside HIER-3's own
enumerated W1–W13 touch list and outside every concurrent ticket's (`IAM-DR12`, `HIER-3-UI`,
`IAM-SEC-03`, `IAM-VERIFY-02`) reported touched-files list — it fell through every sweep so far.
**Not fixed here** (out of HIER-5's ownership — this ticket owns only the register and this report;
the ticket's own instruction is "report anything found; do not fix outside your ownership").
Whoever picks this up needs to either retarget the test at the `org_unit_lead` promotion path (if one
exists via `admin-identity.controller.ts`'s `assignRole`) or remove the now-untestable case with the
same "kept the control, documented why" treatment `HIER-3-UI`'s report gave the equivalent PM-side
case it hit.

### 6.3 Found — live, functional (non-comment) reference in an out-of-boundary project, still unresolved

**`platform-ui/e2e/personas.ts`** — `PersonaKey` union (line 16) still includes `"team_lead"` as a
live TypeScript union member, and `isDemoModeSupported()` still lists it among the "no demo
equivalent" set. **`platform-ui/e2e/iam-personas-fixture.spec.ts`** (line 22) has a real test:
`await expect(loginAsPersona(page, "team_lead")).rejects.toThrow(...)`. Both were explicitly flagged
by HIER-3's own report as "a separate, standalone project not touched here" and by HIER-3-UI's report
as out of its remit too — confirmed still true this session (no edit landed since either report).

This is not a live crash today: the assertion is that `team_lead` has no DEMO_MODE identity, which
remains technically true regardless of whether the backend seed still produces a persona under that
name. But it is a genuine orphan in the strict sense the ticket asked about — an e2e fixture naming a
persona key the backend's `seed:personas` no longer mints under that name (reworked to
`org_unit_lead`, per HIER-3's W4/W5). Running `npm run seed:personas` against a live backend and then
this e2e spec against `team_lead` would find no matching seeded identity if the spec were ever changed
to expect a live login rather than the DEMO_MODE-unsupported throw. Flagged, not fixed — `platform-ui/`
is outside every backend ticket's ownership in this program to date, and HIER-5 does not own it either.

### 6.4 Found — minor, unenforced documentation drift

**`permission-catalog.json`'s own `_meta.counts` block** (`cerbosKinds: 61, concretePairs: 230,
grantable: 215, sensitive: 79`) is stale against the file's own `permissions` array content, which is
correctly at 226 total / 211 grantable / 60 kinds (re-derived by direct count: `cat.permissions.length
=== 226`, `.filter(p => p.class === 'grantable').length === 211`). `sensitive: 79` is still correct
(none of the 4 removed `core.team.*` permissions were sensitive, per HIER-3's own report).

No test reads this block — checked by grepping every `*.test.ts` in `src/rbac/` for
`_meta.counts`/`cerbosKinds`/`concretePairs`; only `permission-groups.json`'s OWN `_meta.counts` is
parity-tested (`permission-groups-catalog-parity.test.ts`, §6.1), and that one is correctly derived
and green. `permission-catalog.json` has no equivalent guard, so this drifted silently — the exact
"hand-maintained fact that lies" pattern this program's own memory has hit five times before. Low
severity (nothing currently consults `_meta.counts` to make a decision, as far as this sweep found),
but worth a follow-up: either refresh the block or add a parity test mirroring
`permission-groups-catalog-parity.test.ts`'s own "§5: `_meta.counts` is not a hand-maintained parallel
fact" test.

### 6.5 Found — contract docs refreshed before, now stale again (not this ticket's ownership)

`docs/PERMISSION-CONTRACT.md` and `docs/FRONTEND-BFF-CONTRACT.md` were brought current by `IAM-DOCS-01`
on 2026-08-11, but that ticket ran **before** HIER-3/IAM-DR12 landed (its own report still frames
`team_lead` as live and states catalog counts as 230/215/61-kinds). Those documents are outside
HIER-5's ownership (this ticket owns only the rollout-scan register and this report) — flagged for
whoever next touches `docs/PERMISSION-CONTRACT.md` §2, not fixed here.

## 7. Test results (real, this session)

```
platform-nest/src/rbac/permission-arm-hazard-scan.test.ts   74/74   (unmodified, re-run only)
platform-nest/src/rbac/ (22 files)                          416/416
platform-nest/src/db/user-roles-org-unit-scope.db.test.ts   18/18   (re-run isolated after a
platform-nest/src/db/user-roles-org-unit-scope-abort.db.test.ts 2/2   transient connection-drop
                                                                    on the first combined run —
                                                                    reproduced clean on retry, per
                                                                    the ticket's own "concurrent
                                                                    session may still be finishing"
                                                                    warning)
platform-nest/src/modules/reports/ + src/core/portal-client-contacts.test.ts
  + src/admin/ (48 files combined)                          773/774 — the ONE failure is the
                                                                    genuine regression, §6.2,
                                                                    reproduced twice, not transient
npx tsc --noEmit                                             0 errors
cerbos compile /policies (fresh container)                   clean, 0 tests executed (no errors)
docker inspect gaiada-test-cerbos StartedAt                  2026-08-11T06:00:20Z (postdates every
                                                                    policy edit this report relies on)
```

Live Cerbos probes (`POST /api/check/resources`, this session, against the restarted PDP):

```
group_executive@global, companies:["t1"]           -> automation_approval.read = ALLOW
group_executive@global, companies:[]                -> automation_approval.read = DENY   (the bug)
group_executive@global, companies:[]  (control)     -> appraisal.read          = ALLOW   (fix shape works)
company_admin@company:t1              (control)     -> automation_approval.read = ALLOW
team_lead-named role (no derived role exists)        -> resolves to no role at all; DENY everywhere
```

## 8. Blockers / follow-ups (not this ticket's remit — reported, not fixed)

1. **`managed-by-invariant.test.ts`'s dead `/teams` endpoint call** (§6.2) — currently red, needs
   retargeting or removal with documentation, same treatment HIER-3-UI gave its own equivalent case.
2. **`platform-ui/e2e/personas.ts`/`iam-personas-fixture.spec.ts`** (§6.3) — live `"team_lead"`
   `PersonaKey` in a project outside every backend ticket's boundary to date; needs its own UI-side
   follow-up ticket.
3. **`permission-catalog.json`'s stale `_meta.counts`** (§6.4) — low severity, unenforced; either
   refresh or add a parity test.
4. **`docs/PERMISSION-CONTRACT.md`/`FRONTEND-BFF-CONTRACT.md`** stale again post-IAM-DOCS-01 (§6.5).
5. **The 5 `group_executive` TRAP-4 kinds** (§5) — recommend the role-arm fix land before any further
   IAM-04-ROLLOUT work on these 5, and recommend it land soon rather than waiting on D-7 (reasoning in
   §5; not started here, per this ticket's "do NOT wire any permission arm" / "do NOT modify ...
   policy" constraints — this is a role-ARM fix, still out of HIER-5's remit either way).
6. **The re-derived rollout order** (§4) is the input the next rollout ticket needs; HIER-5 does not
   start it (measurement-and-planning only, per its own constraint).
