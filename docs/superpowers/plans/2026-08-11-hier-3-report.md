# HIER-3 — retire `team_lead`, `team`/`record` scope, `teams`/`team_memberships`: implementation report

**Status:** IN PROGRESS (this ticket's own scope is DEV-VERIFIED against the checks listed below;
full-suite confirmation is the last gate — see §7). Ticket: HIER-3, per
`docs/superpowers/plans/2026-08-10-iam-hier-01-plan.md` §HIER-3. Depends on HIER-1 (`migrations/
0100_user_roles_org_unit_scope.sql`) and HIER-2 (`migrations/0101_org_unit_closure.sql`,
`migrations/0102_iam_hier2_org_unit_lead_role.sql`, `docs/superpowers/plans/2026-08-11-hier-2-report.md`),
both already landed. This is the **contract half** of the expand/contract migration 0100 started —
values and their writers come out together, in this one change.

Written incrementally; will be finalized once the full-suite background run confirms no
regressions beyond what is already reported below.

---

## 1. Migration 0103 — the contract step

`platform-nest/migrations/0103_hier3_retire_team_scope.sql`. Verified free with
`ls migrations | sort | tail` before writing (head was `0102_iam_hier2_org_unit_lead_role.sql`).

Seven steps, in order:

1. **Hard count-assert ZERO `team`/`record` rows in `user_roles`** — `RAISE EXCEPTION` if not. This
   restores 0100's own guards, which its header explicitly downgraded to `RAISE NOTICE` on
   amendment and explicitly instructed HIER-3 to restore as hard exceptions "where they are correct
   again because the drop is real."
2. **Narrow `user_roles_scope_type_check`** to `('global','company','org_unit','project')` — drops
   `team`/`record` for real (0100 kept them, expand-only).
3. **Narrow `user_roles_scope_id_shape_check`** to match — drops the `team`/`record` branch of the
   uuid-shape rule.
4. **Hard count-assert ZERO rows in `teams`/`team_memberships`**, then `DROP TABLE` both.
5. **Delete the global `team_lead` role** (`DELETE FROM roles WHERE company_id IS NULL AND name =
   'team_lead'`) — cascades its `role_permissions` bundle rows via `role_permissions.role_id ...
   ON DELETE CASCADE` (0001). Re-asserted gone.
6. **Delete the 4 `core.team.*` permission catalog rows** (`create`/`read`/`update`/`delete`) —
   cascades any remaining `role_permissions` references (company_admin/manager/member/viewer's own
   `core.team.*` bundle rows from 0094) via `role_permissions.permission_id ... ON DELETE CASCADE`.
7. **Closing assertions** — both CHECKs present with the right shape, zero team/record rows,
   both tables gone, 0092's partial unique index still present (untouched by this migration, but
   re-verified per this family's "assert, don't assume" discipline).

RLS note: does not apply — `user_roles`/`roles`/`role_permissions`/`permissions` carry no RLS
(re-confirmed, matches every prior migration in this family); `teams`/`team_memberships` DO carry
RLS but this migration only counts them via the owner/migrator connection before `DROP TABLE`ing
outright, so there is no tenant-scoped WHERE clause that could silently under-count.

Idempotent/re-runnable: every `ADD CONSTRAINT` is guarded by an existence check; `DROP TABLE IF
EXISTS` and the `DELETE ... WHERE` statements are naturally re-runnable (a second run finds
nothing left to touch, no violation to raise).

---

## 2. Cerbos policy sweep (23 files + `derived_roles.yaml`, `resource_team.yaml` deleted)

Every file with `team_lead` in an actual `derivedRoles: [...]` list (not a comment) was edited to
remove it. `resource_team.yaml` was deleted outright.

| File | Change |
|---|---|
| `derived_roles.yaml` | Deleted the `team_lead` derived-role definition; simplified the 5 `perm_pm_task_*` roles (removed the `!attr.grants.exists(x, x.role=="team_lead"...)` exclusion clause — nothing left to exclude); trimmed a `team`/project-scope comment |
| `resource_team.yaml` | **DELETED** (whole file) |
| `resource_file.yaml`, `resource_work_activity.yaml`, `resource_member.yaml`, `resource_client.yaml`, `resource_activity.yaml`, `resource_device.yaml`, `resource_meeting_recording.yaml`, `resource_deliverable.yaml`, `resource_task.yaml`, `resource_time_entry.yaml`, `resource_pm_project.yaml`, `resource_pm_task.yaml`, `resource_project.yaml`, `resource_notification.yaml`, `resource_org_structure.yaml`, `resource_custom_field.yaml`, `resource_comment.yaml` | `team_lead` removed from `derivedRoles: [...]` lists (read and/or create/update/delete rules) |
| `resource_integration_connection.yaml` | `team_lead` removed from the self-service `owns` rule |
| `resource_client_contact.yaml` | `team_lead` removed from the read rule; the "DEAD TIER" comment explaining why rewritten to past tense |
| `resource_report_period.yaml`, `resource_report_document.yaml`, `resource_appraisal.yaml` | `["manager", "team_lead"]` → `["manager"]`; the adjacent `org_unit_lead` own-rule comments updated to say "kept the (now-retired) team_lead over-grant shape from re-firing" |

Historical/rationale comments that reference `team_lead` as **past-tense context** (e.g. why
`org_unit_lead` always gets its own rule) were left — they are accurate design history, matching
this repo's own idiom elsewhere. Three comment-only files (`resource_mcp_tool.yaml`,
`resource_report_admin.yaml`, `resource_scope_signoff.yaml`) were left untouched, matching the
consolidation plan's own finding that these are "comments/none-rule text," not functional
references.

**Cerbos discipline followed:** `docker restart gaiada-test-cerbos`; `StartedAt` confirmed
`2026-08-11T06:00:20Z`, postdating every policy edit. `cerbos compile /policies` — exit 0.
Live-probed via `POST /api/check/resources` before trusting the automated suites:

- `team_lead@team:t1` on `task.read` → **EFFECT_DENY** (role no longer exists in any derived role).
- `manager@company:c1` on `task.read` → **EFFECT_ALLOW** (unaffected).
- `org_unit_lead@org_unit:d-web` on `report_document.read_department` (resource `unitAncestors:
  [dv-frontend, d-web, d-corp]`) → **EFFECT_ALLOW** (HIER-2's cascade unaffected).

---

## 3. `core/teams.controller.ts` deleted (W1)

- `platform-nest/src/core/teams.controller.ts` — **deleted**.
- `platform-nest/src/core/teams.test.ts` — **deleted**.
- `platform-nest/src/app.module.ts` — `TeamsController` import + registration removed; header
  comment updated to record the retirement.

Zero UI callers of `/api/:t/teams*` (per the consolidation plan's own grep), zero live rows in
`teams`/`team_memberships`, zero other backend importers of the controller — matches the plan's
"delete outright, no deprecation period" instruction.

---

## 4. Personas reworked to `org_unit_lead` (W4/W5)

Both `src/testing/personas.ts` (IAM-06b, fresh-tenant-per-test) and `src/seed/personas.ts`
(IAM-06a, durable dev/staging seed) had their `team_lead` persona (`role: "team_lead", scope:
"team"`, backed by a real `teams`/`team_memberships` row) reworked to `org_unit_lead`:

- `PersonaKey`/`PersonaSpec.scope` union: `"team"` → `"org_unit"`.
- A fixed org-unit node id (`"d-persona"`, a bare 0029-convention free-form string — no
  `company_org_structure` blob needed, since `org_unit_memberships.unit_node_id` has no FK).
- The persona is PLACED there (`org_unit_memberships`, primary, open-ended) **and** granted
  `org_unit_lead` at that same scope — placement matters, because `person-scope.ts` narrows a
  unit-scoped tier by the SUBJECT's placement, not merely by holding a grant. The old `team_lead`
  fixture only ever proved raw-grant existence; this one exercises the actual narrowing mechanism.
- `PersonaTenant.teamId` / `SeededPersonas.teamId` → `orgUnitId` (no consumer read `.teamId` as a
  field outside these two files and the now-deleted `teams.test.ts` — checked before renaming).

`README-PERSONAS.md` updated to match (persona table, the ⚠ caveat bullet, the error-message
example, the "team scoping" follow-up bullet). A note was added flagging that
`platform-ui/e2e/personas.ts`/`src/lib/demoIdentity.ts` are a **separate, standalone project** not
touched here (a concurrent session owns the UI half of this retirement) — that file's DEMO_MODE
table still describes `team_lead` as of this writing.

---

## 5. 0091's seed reverted (W6), bundles regenerated (W7)

- `migrations/0091_iam_02d_ungrantable_roles.sql` is an **already-applied migration and was NOT
  edited** (rule 4) — its `team_lead` seed row is retired by 0103's `DELETE FROM roles ...`
  instead, in the contract migration, not by editing the seed. `viewer`/`it`/`it_manager`/
  `search_staff`/`search_manager` (0091's other five roles) are untouched.
- `scripts/generate-role-bundles.mjs` / `generate-role-bundles.d.mts`: `REAL_ROLES` and the
  `DIRECT` map lost `team_lead` (21 → 20 roles).
- `src/rbac/role-permission-parity.db.test.ts`: its own hand-mirrored `DIRECT` map and comment
  list updated to match.
- `src/rbac/role-permission-bundles.json` regenerated via `npm run gen:role-bundles` — 20 roles,
  861 total pairs (was 936 across 21). `--check` confirms byte-identical regeneration.

**Found while regenerating:** the bundle also picked up an UNRELATED, already-landed concurrent
change — DR-12 deleted `resource_portal.yaml`'s dead staff-read rule, which had granted
`company_admin`/`manager`/`group_executive` a `portal.read` bundle entry. Since bundle
regeneration captures the CURRENT state of all policy files, both changes landed in the same
regen. `iam-dr5-company-admin-appraisal-read.test.ts`'s hardcoded `company_admin` bundle-size
assertion (200) was updated to 195 (200 − 4 `core.team.*` − 1 `portal.read`), with the arithmetic
and attribution spelled out in the test's own comment — not silently absorbed.

---

## 6. Hazard-scan fixtures (W12) — detector logic untouched, fixtures adjusted

`src/rbac/permission-arm-hazard-scan.test.ts`:

- **Control kinds swapped.** The REGISTER test used to pin `(pm_task, hr_case)` as "known-positive
  controls." `pm_task`'s ONLY hazard was `team_lead` mixing — now retired — so it measurably moved
  HAZARDOUS → SAFE (verified: `patternA`/`patternB` produce zero hits for `pm_task` post-retirement,
  pinned as its own new assertion). `time_entry` replaces it: an INDEPENDENT Pattern-B hazard
  (unconditional `company_admin`/`manager` update/delete vs. member's self-scoped-via-`owns` rule
  on the same actions) that has nothing to do with `team_lead` and survives untouched — exactly the
  "stays hazardous only for Pattern B" shape the HIER-01 plan predicted for this kind class.
  `hr_case` is unaffected (module_staff mixing + self-scope) and stays the first control.
- **PART 4's synthetic teeth-proof rebased onto `client`.** The fixture used to mix a synthetic
  safe role with `team_lead` to prove the detector catches an unmitigated permission arm. `client`
  (a real, still-unsafe-today role — `missing-scope-branch`, no global escape) replaces it. The
  detector's own functions (`classifyDerivedRoleExpr`, `scanPatternA`, `scanPatternB`,
  `hasGrantsExclusionFor`) are **byte-unchanged** — only the example role name in the synthetic
  fixture moved.
- **The "REAL pm_task, post-mitigation" test removed and replaced.** It asserted `perm_pm_task_read`
  still carried the `team_lead` grants-exclusion; that mitigation shape no longer exists anywhere
  in the estate (confirmed by grep: zero `attr.grants.exists(x` occurrences left in
  `derived_roles.yaml`). Replaced with an assertion that `pm_task` now has ZERO Pattern-A/B hits
  and that the exclusion clause is genuinely GONE from `perm_pm_task_read` (not merely inert).
- Kind-count sanities updated 61 → 60 (`kinds.size`, the two synthetic-kind revert checks).

`cerbos-permission-dual-match.test.ts`'s own "REAL FINDING pin" for `team_lead`×`pm_task` was
removed for the identical reason (the mitigation it proved is retired with the role); its sibling
`hr.case` disagreement example stands alone as the file's live proof of the
can()-vs-scopeOnly()-disagree class. `src/rbac/can.test.ts`'s matching `team_lead`-based
disagreement test was removed the same way.

No detector logic was weakened anywhere — every change is a fixture/example swap, verified by
re-running the suite (see §7).

---

## 7. Full sweep of every remaining `team_lead`/`team`-scope reference

Beyond the files above, the following were swept for functional (non-comment) references and
fixed; historical/rationale comments were generally left as accurate design history (repo idiom):

- `src/rbac/principal.ts` — `RoleGrant`/`PermissionGrant.scopeType` union narrowed to
  `"global" | "company" | "org_unit" | "project"` (was carrying `team`/`record` "for now," per its
  own comment naming HIER-3 as the ticket to narrow it).
- `src/testing/fixtures.ts` — `grantRole()`'s `scopeType` parameter narrowed to match.
- `src/modules/reports/person-scope.ts` — `UNIT_SCOPED_ROLES` drops `team_lead` (now
  `{"manager","org_unit_lead"}`); the `unit_scoped` tier's scope-covering check drops the
  `team`/`record` branches; doc comments updated.
- `src/modules/reports/appraisals.controller.ts` — three doc comments describing the
  "manager/team_lead coarse tier" updated to "manager" (team_lead retired).
- Test files with `team`-scoped `Principal`/`RoleGrant` literals or `team_lead` personas, each
  updated or the specific case removed with an explanatory comment (never silently deleted without
  a trace): `src/rbac/cerbos.test.ts`, `src/rbac/cerbos-webdev-matrix.test.ts`,
  `src/modules/reports/reports-cerbos.test.ts`, `src/modules/reports/person-scope.test.ts`,
  `src/rbac/principal-permissions.db.test.ts` (scope-type literal swapped `"team"` → `"org_unit"`),
  `src/modules/pm/pm-adversarial-authz.test.ts`, `src/testing/iam-verify-01.authz-drive.test.ts`,
  `src/testing/personas.test.ts`.
- Catalog/count sanities updated wherever the 230/61/215 (or 200/199) numbers were pinned as
  literals: `src/rbac/cerbos-catalog-alignment.test.ts`, `src/rbac/iam-215-boundary-pin.test.ts`,
  `src/rbac/permission-catalog.db.test.ts` (plus its own idempotency test — see the callout below),
  `src/rbac/permission-groups-catalog-parity.test.ts`, `src/rbac/role-permission-parity.db.test.ts`.
- `src/rbac/permission-catalog.json` — the 4 `core.team.*` entries removed (230→226; grantable
  215→211; kinds 61→60; sensitive unchanged at 79 — none of the 4 were sensitive).
- `src/rbac/permission-groups.json` — the `"teams"` permission group (4 members, all
  `core.team.*`, none shared with another group or `advancedOnly`) removed; `_meta.counts`
  recomputed (75→74 groups, 215→211 grantable-in-catalog, 213→209 covered-by-groups).

**One real, non-obvious defect found and fixed while verifying:** `permission-catalog.db.test.ts`'s
"re-running the migration's own SQL is idempotent" test directly re-executes migration `0093`'s
RAW SQL TEXT a second time (bypassing the ledger) to prove that file is idempotent in isolation.
`0093` unconditionally `INSERT ... ON CONFLICT (key) DO UPDATE`s all 230 ORIGINAL rows, including
the 4 `core.team.*` ones `0103` later deletes — so re-running `0093`'s text on a fully-migrated
(through `0103`) database RESURRECTS those 4 rows (226 → 230), because `0093` is immutable and has
no knowledge of `0103`'s later contract-narrowing deletion. This is expected given migrations are
immutable, not a bug in either file. Fixed the test's expectation to `EXPECTED_TOTAL + 4` for this
specific re-run, with the reasoning spelled out in-line, and added a cleanup delete so the
resurrection doesn't leak into the rest of the suite's assumptions about the post-0103 shape.

---

## 8. The two inverted DB tests (0100's own instruction)

- **`src/db/user-roles-org-unit-scope.db.test.ts`** — the two `team`/`record` "scope_type CHECK
  still ACCEPTS" cases (added when 0100 was amended to expand-only) are inverted back to asserting
  **REJECTION**, now that 0103 has landed. Both still use a uuid-shaped `scope_id` so the SHAPE
  check cannot mask the scope_type behaviour being tested (a lesson the prior version's own comment
  recorded).
- **`src/db/user-roles-org-unit-scope-abort.db.test.ts`** — fully rewritten. It used to prove
  **0100** was re-runnable with a `team`-scoped row present (0100's expand-only amendment, since
  0100 itself is an applied, never-edited migration and stays that way forever). It now proves
  **0103** ABORTS (hard `RAISE EXCEPTION`) when a `team`/`record`-scoped row exists at migration
  time — the hard-abort behaviour 0100's own header explicitly said "must" be restored, now
  correctly attributed to the migration that actually restores it. Since `initTestDb()` already
  runs 0103 once (leaving both CHECKs narrow), the test manufactures the "dirty pre-existing data"
  shape by temporarily widening BOTH the scope_type AND shape CHECKs back, inserting a
  uuid-shaped poison row, re-running 0103's REAL file text, and asserting it throws — then restores
  both CHECKs to their real post-0103 shape in a `finally` block regardless of outcome.

---

## 9. Test results (real output)

```
npm run typecheck                     -> 0 errors
npm run lint:migration-rls             -> OK — 103 migrations scanned (53 baselined, 50 enforced)
npm run lint:withtenants               -> OK — 294 files scanned, all withTenants() calls compliant
node scripts/generate-role-bundles.mjs --check
                                        -> OK: regeneration byte-identical to the checked-in file
cerbos compile /policies (in-container) -> exit 0
```

Targeted re-runs of every file touched by fixes (`src/rbac`, `src/db`, `src/testing`):
**46 files, 698 tests — 4 real failures found and fixed, 1 pre-existing/unrelated failure
identified (see below); all now green** on re-run of the specific fixed files (19/19 passed).

**One failure identified as pre-existing / out of this ticket's scope, NOT fixed here:**
`src/testing/iam-verify-01.authz-drive.test.ts`'s "DEFECT B, observed" test expects
`company_admin`/`manager` to clear Cerbos's staff-support portal read rule and then be refused by
`portal-scope.ts`'s app-layer check (`"not a portal client"`). A concurrent, unrelated session
(DR-12, dated 2026-08-11 in `resource_portal.yaml`'s own header) already deleted that staff-read
rule as a deliberate owner decision ("staff have no portal access"), so Cerbos now denies at the
POLICY layer instead (`"not authorized: cerbos denied read on portal"`) — the test's premise
predates that landed decision. `resource_portal.yaml` was not touched by this ticket. Flagged for
whoever owns DR-12's test follow-through; not fixed here to avoid scope creep into an unrelated,
already-decided change.

**Full-suite run:** in progress at report-writing time; final tally to be appended here once
complete.

---

## 10. Deliberate scope boundary — `Resource.teamId` NOT renamed/removed

`src/rbac/cerbos.ts`'s `Resource.teamId` field (and every handler that still sets it, e.g.
`reports.controller.ts`) is now a **fully dead attribute** — confirmed by grep, zero Cerbos rules
read `attr.teamId` anywhere post-sweep. HIER-2's own report explicitly deferred this rename to
HIER-3 ("squarely HIER-3's territory... which this ticket's constraints explicitly forbid
touching"). Renaming/removing it touches `cerbos.ts`, every handler that sets it, and roughly a
dozen test files that construct `Resource` literals with `teamId` — a real but separable cleanup,
not named in the HIER-3 work list's W1-W13 inventory. Left in place and reported as a follow-up
rather than silently expanded into.

---

## 11. Files touched (backend only — `platform-ui/` untouched per this ticket's boundary)

**New:**
- `platform-nest/migrations/0103_hier3_retire_team_scope.sql`

**Deleted:**
- `platform-nest/src/core/teams.controller.ts`
- `platform-nest/src/core/teams.test.ts`
- `platform-nest/cerbos/policies/resource_team.yaml`

**Cerbos policies edited (23 + derived_roles.yaml):** `derived_roles.yaml`, `resource_file.yaml`,
`resource_work_activity.yaml`, `resource_member.yaml`, `resource_integration_connection.yaml`,
`resource_client_contact.yaml`, `resource_client.yaml`, `resource_activity.yaml`,
`resource_device.yaml`, `resource_meeting_recording.yaml`, `resource_deliverable.yaml`,
`resource_task.yaml`, `resource_time_entry.yaml`, `resource_pm_project.yaml`,
`resource_pm_task.yaml`, `resource_project.yaml`, `resource_report_period.yaml`,
`resource_report_document.yaml`, `resource_notification.yaml`, `resource_org_structure.yaml`,
`resource_custom_field.yaml`, `resource_comment.yaml`, `resource_appraisal.yaml`.

**Backend source edited:** `src/app.module.ts`, `src/testing/personas.ts`, `src/seed/personas.ts`,
`src/rbac/principal.ts`, `src/testing/fixtures.ts`, `src/modules/reports/person-scope.ts`,
`src/modules/reports/appraisals.controller.ts`, `src/modules/pm/pm.controller.ts`,
`scripts/generate-role-bundles.mjs`, `scripts/generate-role-bundles.d.mts`.

**Data artifacts regenerated/edited:** `src/rbac/permission-catalog.json`,
`src/rbac/permission-groups.json`, `src/rbac/role-permission-bundles.json`.

**Tests edited:** `src/testing/personas.test.ts`, `src/modules/pm/pm.test.ts`,
`src/modules/pm/pm-adversarial-authz.test.ts`, `src/rbac/cerbos.test.ts`,
`src/rbac/cerbos-webdev-matrix.test.ts`, `src/rbac/cerbos-permission-dual-match.test.ts`,
`src/rbac/can.test.ts`, `src/rbac/permission-arm-hazard-scan.test.ts`,
`src/rbac/role-permission-parity.db.test.ts`, `src/rbac/permission-catalog.db.test.ts`,
`src/rbac/cerbos-catalog-alignment.test.ts`, `src/rbac/iam-215-boundary-pin.test.ts`,
`src/rbac/permission-groups-catalog-parity.test.ts`, `src/rbac/iam-dr5-company-admin-appraisal-read.test.ts`,
`src/rbac/principal-permissions.db.test.ts`, `src/modules/reports/reports-cerbos.test.ts`,
`src/modules/reports/person-scope.test.ts`, `src/testing/iam-verify-01.authz-drive.test.ts`,
`src/db/user-roles-org-unit-scope.db.test.ts`, `src/db/user-roles-org-unit-scope-abort.db.test.ts` (rewritten).

**Docs:** `platform-nest/README-PERSONAS.md`, `platform-nest/migrations/README.md`,
`docs/PERMISSION-CONTRACT.md`, `docs/FRONTEND-BFF-CONTRACT.md`, `docs/modules/MODULES.md`,
`docs/modules/CHANGELOG.md`, this report.

**Explicitly NOT touched (concurrent agent's territory):** anything under `platform-ui/`.

---

## 12. Blockers / follow-ups (not blocking this ticket, reported per instruction)

1. **`Resource.teamId` cleanup** — dead attribute, deferred (see §10).
2. **`iam-verify-01.authz-drive.test.ts`'s "DEFECT B, observed" test** is stale against a concurrent
   DR-12 policy change unrelated to this ticket (see §9) — needs its own follow-through by whoever
   owns that change.
3. **`platform-ui/e2e/personas.ts` / `src/lib/demoIdentity.ts`** still reference `team_lead` as of
   this writing — the UI-side companion to this retirement, explicitly out of this ticket's
   boundary.
4. IAM-04-ROLLOUT batches 4-7 (per `docs/PERMISSION-CONTRACT.md` §9, now updated) dissolve rather
   than need doing — their entire subject matter no longer exists.
