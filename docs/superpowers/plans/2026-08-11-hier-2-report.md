# HIER-2 — `org_unit_lead` role + subtree cascade: implementation report

**Status:** IN PROGRESS (this ticket's own scope is DEV-VERIFIED against the checks listed below;
the program-wide consolidation it belongs to is still mid-flight — HIER-3 has not landed).
**Ticket:** HIER-2, per `docs/superpowers/plans/2026-08-10-iam-hier-01-plan.md` §HIER-2. Consumes
IAM-09's closure table (`migrations/0101_org_unit_closure.sql`, `platform-nest/src/core/org-unit-closure.ts`)
and HIER-1's `org_unit` scope (`migrations/0100_user_roles_org_unit_scope.sql`).

Written incrementally; this is the final state.

---

## 1. Migration

`platform-nest/migrations/0102_iam_hier2_org_unit_lead_role.sql`. Verified free with
`ls migrations | sort | tail` before writing (head was `0101_org_unit_closure.sql`); re-verified
head is still `0101` at write time. Seeds, in one migration (unlike 0097/0098's forced split —
there is no ordering hazard here since this ticket writes the Cerbos policy, the role row, and the
bundle together):

- the global `org_unit_lead` `roles` row (idiom identical to 0091/0095/0096/0097);
- its `role_permissions` bundle: `{reports.appraisal.read, reports.document.read_department}` — 2
  pairs, derived from the ACTUAL two Cerbos rules this ticket writes (0094/0098's own
  methodology), not guessed;
- a closing assertion block (role exists exactly once, bundle has exactly 2 rows, 0
  relationship-class leaks).

**One real bug found and fixed while landing this**: `RAISE EXCEPTION`'s format argument must be a
single string literal in PL/pgSQL — it cannot be a `||`-concatenated expression the way a plain
`SELECT` can. My first draft used `||` to wrap a long message across lines and got
`syntax error at or near "||"` at migration time (caught by directly running the SQL against
`gaiada-test-pg` before trusting `initTestDb()`, not by the test framework's own error message,
which just reported the migration failed). Fixed to a single literal string; re-verified the file
applies cleanly with a direct `pg.Pool` connection before re-running the suites.

## 2. The CEL for the cascade

`platform-nest/cerbos/policies/derived_roles.yaml`:

```yaml
- name: org_unit_lead
  parentRoles: ["user"]
  condition:
    match:
      expr: >-
        request.principal.attr.grants.exists(g, g.role == "org_unit_lead" &&
          g.scopeType == "org_unit" && g.scopeId in request.resource.attr.unitAncestors)
```

The resource carries `unitAncestors` (every ancestor of its own unit, self-inclusive at depth 0,
from IAM-09's `org_unit_closure` via `org-unit-closure.ts::loadUnitAncestors`); the grant matches
if its `scopeId` is anywhere in that list. That containment IS the subtree cascade — no per-request
tree walk, it falls out of the closure's own precomputation.

Landed as its own separate rule in exactly two resource policies (never mixed with the
manager/team_lead rule in either file):

```yaml
# resource_report_document.yaml
- actions: ["read_department"]
  effect: EFFECT_ALLOW
  derivedRoles: ["org_unit_lead"]
  condition: { match: { expr: "variables.inTenant && variables.notLow" } }

# resource_appraisal.yaml
- actions: ["read"]
  effect: EFFECT_ALLOW
  derivedRoles: ["org_unit_lead"]
  condition: { match: { expr: "variables.inTenant && variables.notLow" } }
```

## 3. The ancestor-vs-sibling test result

New file `platform-nest/src/rbac/cerbos-org-unit-lead-cascade.test.ts` — 16 tests, all PASS, live
against `gaiada-test-cerbos` (restarted after the policy edit; container `StartedAt` re-verified to
postdate the edit, per the staleness trap). Highlights:

- **ancestor ALLOWS descendant**: a grant at `d-web` against a `report_document` resource whose
  `unitAncestors = ["dv-frontend","d-web","d-corp"]` → `EFFECT_ALLOW`.
- **DENIES a sibling subtree**: the SAME grant against `unitAncestors = ["dv-hr-ops","d-hr","d-corp"]`
  → `EFFECT_DENY`.
- self-inclusive-at-depth-0 (grant AT the resource's own unit allows); one-directional (a grant at a
  descendant does NOT cover its own ancestor); company/global-scoped `org_unit_lead` grants confer
  nothing; an orphaned-node grant confers nothing (fail-closed by construction, no special-case
  code); an unfed resource (no `unitAncestors` at all) confers nothing; no bleed into
  `read_person`/`read_project`; cross-tenant isolation via `variables.inTenant`; low-assurance
  denial (D4 ceiling); the SAME grant on `appraisal.read` allows/denies identically; `org_unit_lead`
  does NOT reach `write`/`submit`/`confirm_evidence`/`finalize`/`cycle_admin` (DR-11's read-only
  boundary); and a sanity check that the cascade is role-arm only (a `perms`-only principal with the
  identical key/scope gets nothing — this ticket built no permission-arm mirror for `org_unit_lead`).

I also manually probed all four shapes directly against `POST /api/check/resources` before writing
the automated test, per the ticket's own instruction not to trust a result without probing first —
outputs recorded in this session's tool transcript (ancestor ALLOW, sibling DENY, appraisal ALLOW,
`read_person` exclusion DENY).

## 4. Handlers wired

- **`platform-nest/src/modules/reports/reports.controller.ts`** — `authorizeReportDocumentRead()`:
  for `grain === "department"` ONLY, resolves `unitAncestors` via
  `loadUnitAncestors(c, tenantId, scopeRef)` (one `withTenants` round trip) and passes it on the
  `authorize()` call alongside the pre-existing `teamId` attribute (kept, not renamed — see §6).
  `read_person`/`read_project` are NOT wired (see §5).
- **`platform-nest/src/modules/reports/appraisals.controller.ts`** — new `subjectUnitAncestors()`
  helper resolves the SUBJECT's current unit (via `person-scope.ts::resolveSubjectUnit`, as-of
  today in `config.reportsTz`) then its ancestor chain via the same `loadUnitAncestors`; wired into
  `getOneRoute` (`GET /appraisals/:id`) only. A new `isOrgUnitLeadForSubject()` helper re-derives the
  identical containment check in-app (belt-and-suspenders, matching every other in-app confirmation
  in this file) so the narrowing logic recognizes a dept-lead read alongside the pre-existing exact
  `manager_user_id` match. `listRoute`/`mineRoute` are NOT wired (see §5).
- **`platform-nest/src/rbac/cerbos.ts`** — added `unitAncestors?: string[]` to `Resource` and its
  `resourcePayload()` mapping (`unitAncestors: r.unitAncestors ?? []` — omitted attr fails closed,
  same convention as every other optional field on this type).
- **`platform-nest/src/modules/reports/person-scope.ts`** — per the plan's own HIER-2 sketch:
  `UNIT_SCOPED_ROLES` gains `org_unit_lead` (see §6 for why `team_lead` was NOT dropped, unlike the
  plan's literal text); `personAxisTier`'s scope-covering check gains an `org_unit` branch (an
  `org_unit_lead` grant is never company/global/project/team/record-scoped, so without this branch
  it would never register as `unit_scoped` at all); `loadLedUnitScope()` gains an optional 5th
  `principal` parameter — when passed, unions in the grant-derived subtree (every `org_unit`-scoped
  `org_unit_lead` grant's scope, each expanded by the pre-existing `collectUnitSubtree` walk)
  alongside the placement-derived one, additive and backward-compatible (omitted → identical prior
  behavior). Both internal callers (`assertPersonInLedScope`, `assertUnitInLedScope`) now pass
  `principal` through.
- **Three external `loadLedUnitScope` call sites** updated to pass `principal`/`req.principal` so
  they benefit from the grant-derived union too: `checkins.controller.ts:722`,
  `reports.controller.ts` (`overview` and `metrics` endpoints' led-subtree narrowing).
- **`platform-nest/src/admin/admin-identity.controller.ts`** — `SCOPE_TYPES` gains `"org_unit"`
  (was deliberately excluded pending this exact ticket, per that file's own prior comment — "HIER-2
  add it here when there is something for it to do"). No uuid-shape validation added for it,
  matching 0100's own per-scope CHECK (`org_unit` → non-empty text, no uuid regex).
- **`platform-nest/cerbos/policies/resource_checkin.yaml`** + **`derived_roles.yaml`** — the
  separate rollout-batch-3 permission arm (5 new rules/roles: `submit`/`read` self-scoped-only
  mirrors, `excuse`/`pending_reminders`/`missed_by_unit` plain unconditional mirrors). Not
  `org_unit_lead` — a distinct, unrelated piece of scope bundled into this ticket per its brief.

## 5. Boundaries NOT wired — reported, not silently skipped

Per the ticket's own STOP clause ("if a handler cannot supply it, STOP and report rather than adding
a rule that can never fire"):

- **`report_document.read_person` / `read_project`** — the Cerbos rule's `actions` list is
  deliberately `["read_department"]` ONLY (not all three, despite the HIER-01 plan's own sketch
  listing all three). `ownerId`/`projectId` are not org-unit ids, and no handler resolves a unit
  ancestor list for a person/project `scopeRef` today. Landing the rule on those two actions would
  have been a rule fed nothing — the exact dead-grant shape this program spent two days measuring
  and removing. Confirmed by a passing test (`org_unit_lead does NOT bleed into read_person/read_project`).
- **`appraisals.controller.ts`'s `listRoute`/`mineRoute`** — only `getOneRoute` resolves and passes
  `unitAncestors`. An `org_unit_lead`-only caller hitting `GET /appraisals` now gets a 403 from the
  `managerCoarse` branch's bare `authorize()` call (no single subject to resolve an ancestor list
  for) rather than silently returning nothing or, worse, an unfiltered list — fails CLOSED, just via
  a less specific error path than a dedicated check would give. Documented in a code comment at the
  route. Wiring the list query to the subtree scope (it currently filters by exact `managerUserId`,
  the `manager`/`team_lead` tier's own semantic, not `org_unit_lead`'s) is left for a future ticket.
- **`reports.controller.ts`'s `overview`/`metrics` endpoints** — their OWN initial `authorize()`
  call is bare (no specific `scopeRef`, hence no `unitAncestors`), so an `org_unit_lead`-ONLY caller
  (no `manager`/`team_lead`) is denied outright at that gate for `grain=department`. The
  `loadLedUnitScope(..., principal)` wiring in these two endpoints is NOT dead code, though: it
  benefits the MIXED-role case (a caller who holds both `manager` and `org_unit_lead`) — the
  placement-derived and grant-derived subtrees are unioned, so an `org_unit_lead` grant widens what a
  manager-tier caller sees in these listings, correctly, without a separate code path.

None of these are widenings — every unwired path fails closed (denies), consistent with "ship what
you need and flag the boundaries," the same posture this file's own header already used for other
known gaps.

## 6. Deliberate deviations from the plan's literal text

1. **`teamId` kept, not renamed.** The plan's wiring note says "reports.controller.ts:166 renames
   the passed attr `teamId` → `unitAncestors`". `teamId` is a SHARED field on the `Resource` type,
   read by `team_lead`'s own derived role across ~23 kinds, not specific to `report_document`.
   Renaming/removing it would have broken every other kind's `team_lead` matching — squarely
   HIER-3's territory (`team_lead` retirement), which this ticket's constraints explicitly forbid
   touching. Implemented as ADDITIVE instead: `unitAncestors` is a new, separate attribute;
   `teamId` is untouched.
2. **`team_lead` kept in `person-scope.ts`'s `UNIT_SCOPED_ROLES`.** The plan's own sketch writes
   `UNIT_SCOPED_ROLES = {"manager","unit_lead"}` (dropping `team_lead`). This ticket's constraints
   explicitly forbid removing `team_lead` from "any policy." `person-scope.ts` is TypeScript, not a
   Cerbos policy file, but out of caution I treated the constraint as covering it too: `org_unit_lead`
   was ADDED alongside `team_lead`, not swapping it out. This is strictly additive and
   behaviour-preserving for every existing `team_lead` holder; HIER-3 removes `team_lead` here in
   the same sweep that removes it everywhere else.

## 7. Hand-check against both over-grant shapes

**Shape 1 — same-rule mixing (the `team_lead` defect).** Grepped every occurrence of
`org_unit_lead` across `cerbos/policies/*.yaml`: it appears in exactly 2 resource-policy rules
(`resource_report_document.yaml:116`, `resource_appraisal.yaml:136`), and in BOTH, `derivedRoles`
is `["org_unit_lead"]` alone — never co-listed with `manager`/`team_lead`/`company_admin`/any other
role. Confirmed structurally, not by inspection alone: `permission-arm-hazard-scan.test.ts`'s
Pattern-A scanner (which flags exactly this mixing) does not flag either kind for `org_unit_lead`
(74 tests pass unchanged). Same check applied to the 5 new `perm_checkin_*` rules in
`resource_checkin.yaml` — each rule's `derivedRoles` list has exactly one entry.

**Shape 2 — wildcard/unconditional rule combined with a narrower role (IAM-SEC-02/Pattern C).**
Grepped for `org_unit_lead` inside any `actions: ["*"]` rule across both files it appears in: zero
hits. `org_unit_lead` is never named in a wildcard rule anywhere in the estate — only
`platform_admin` (and `group_executive` in 7 kinds) occupy that position, both unchanged by this
ticket. `permission-arm-hazard-scan.test.ts`'s Pattern-C scanner (which finds exactly this shape)
was re-run and its existing assertions (platform_admin in 56 kinds, group_executive in 7,
`GLOBAL_ONLY_ROLES` coverage) are unaffected — no new Pattern-C hit was introduced.

## 8. Cerbos staleness discipline followed

`docker inspect gaiada-test-cerbos --format '{{.State.StartedAt}}'` checked before AND after
`docker restart gaiada-test-cerbos`; every live probe (curl to `/api/check/resources`) and every
automated `.test.ts` run in this report was executed against the POST-restart container.
`cerbos compile /policies` run inside the container (`MSYS_NO_PATHCONV=1 docker exec ... /cerbos
compile /policies`) — exit code 0, no compile errors.

## 9. Full verification run (real output)

```
npm run typecheck                                    -> 0 errors
npm run lint:migration-rls                            -> OK — scanned 101 migrations (53 baselined,
                                                          48 enforced); no unguarded FORCE-RLS backfills
npm run lint:withtenants                              -> OK — scanned 295 files; all withTenants()
                                                          calls single-tenant or allowlisted
node scripts/generate-role-bundles.mjs --check        -> OK: regeneration byte-identical to checked-in file
cerbos compile /policies (in-container)               -> exit 0

vitest run src/rbac                                   -> 22 files, 423 tests, ALL PASS
  (21 pre-existing + this ticket's new cerbos-org-unit-lead-cascade.test.ts)
  incl. role-permission-parity.db.test.ts (25), role-bundle-completeness.db.test.ts (3),
  iam-215-boundary-pin.test.ts (66), permission-arm-hazard-scan.test.ts (74),
  cerbos-permission-dual-match.test.ts (51, incl. this ticket's new checkin block)

vitest run src/modules/reports                        -> 28 files, 562 tests, ALL PASS
  incl. person-scope.test.ts, checkins.controller.test.ts, checkins.controller.db.test.ts,
  appraisals.controller.db.test.ts, reports-cerbos.test.ts, tr25-person-axis.db.test.ts,
  reports.controller.export.db.test.ts, reports.controller.export.pdf.db.test.ts

vitest run src/admin/admin.test.ts
           src/admin/assign-role-global-scope-idempotent.test.ts
           src/admin/global-only-role-scope.test.ts
           src/admin/managed-by-invariant.test.ts       -> 4 files, 21 tests, ALL PASS
```

Live infra used (already running, not started for this ticket): `gaiada-test-pg` (port 55433,
`gaiada_platform_test`), `gaiada-test-cerbos` (ports 3592-3593, restarted after policy edits).

## 10. Files touched

- `platform-nest/migrations/0102_iam_hier2_org_unit_lead_role.sql` (new)
- `platform-nest/cerbos/policies/derived_roles.yaml` (`org_unit_lead` + 5 `perm_checkin_*` roles, appended)
- `platform-nest/cerbos/policies/resource_report_document.yaml` (+1 rule)
- `platform-nest/cerbos/policies/resource_appraisal.yaml` (+1 rule)
- `platform-nest/cerbos/policies/resource_checkin.yaml` (+5 rules)
- `platform-nest/src/rbac/cerbos.ts` (`Resource.unitAncestors` + payload mapping)
- `platform-nest/src/modules/reports/reports.controller.ts` (unitAncestors wiring; 2 `loadLedUnitScope` call sites)
- `platform-nest/src/modules/reports/appraisals.controller.ts` (unitAncestors wiring + dept-lead narrowing)
- `platform-nest/src/modules/reports/person-scope.ts` (`UNIT_SCOPED_ROLES`, scope check, `loadLedUnitScope` grant-derived source)
- `platform-nest/src/modules/reports/checkins.controller.ts` (1 `loadLedUnitScope` call site)
- `platform-nest/src/admin/admin-identity.controller.ts` (`SCOPE_TYPES` +`org_unit`)
- `platform-nest/scripts/generate-role-bundles.mjs` (+`org_unit_lead` in `REAL_ROLES`/`DIRECT`)
- `platform-nest/scripts/generate-role-bundles.d.mts` (mirror the tuple type)
- `platform-nest/src/rbac/role-permission-parity.db.test.ts` (+`org_unit_lead` in its own duplicate `DIRECT` map)
- `platform-nest/src/rbac/role-permission-bundles.json` (regenerated only, via `npm run gen:role-bundles`)
- `platform-nest/src/rbac/cerbos-org-unit-lead-cascade.test.ts` (new — 16 tests)
- `platform-nest/src/rbac/cerbos-permission-dual-match.test.ts` (+1 describe block, 9 tests, checkin batch 3)
- This report.

## 11. Blockers / follow-ups (not this ticket's remit)

None blocking. Follow-ups for a future ticket, all documented in-code where they arise:

- `appraisals.controller.ts`'s listing endpoint is not subtree-scoped for `org_unit_lead` (§5).
- `report_document`'s `read_person`/`read_project` grains have no unit-ancestor path yet (§5).
- HIER-3 (retire `team_lead`/`teams`/`team_memberships`) is unaffected by anything in this ticket —
  `team_lead` was left in every place it already existed, per this ticket's own constraints.
