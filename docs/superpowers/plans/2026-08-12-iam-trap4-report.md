# IAM-TRAP4 — `group_executive` fold-in fix on 5 kinds: implementation report

**Status:** PROTOTYPED / DEV-VERIFIED (role-arm fix only, live-probed against a freshly-restarted
test Cerbos; not deployed to the live estate). Fixes the finding
`docs/superpowers/plans/2026-08-11-hier-5-report.md` §5 confirmed live and
`docs/superpowers/plans/2026-08-10-iam-04-rollout-scan.md` §R.6 / §2.3 Mechanism 2 first flagged:
`group_executive` was folded into an `inTenant`-gated rule it can never satisfy (it is a
GLOBAL-scope-only derived role — `derived_roles.yaml`: `g.scopeType == "global"` — so a holder has
no `company_memberships` row and `variables.inTenant` is FALSE for every resource), denying the
role outright on 5 governance-sensitive kinds.

**Owns:** the 5 policy files below, `src/rbac/role-permission-bundles.json` (regenerated,
byte-identical), `src/rbac/iam-trap4-group-executive-split.test.ts` (new), this report. Touched
nothing else — no migration, `derived_roles.yaml`, `principal.ts`, `cerbos.ts`, or `platform-ui/`.

---

## 1. The fix — exact rules split

Pattern followed: `resource_appraisal.yaml`'s `group_executive` rule (own rule, `derivedRoles:
["group_executive"]`, `condition: variables.notLow` — no `inTenant`). `company_admin`/`manager`
keep `variables.inTenant && variables.notLow` unchanged in their own (now `group_executive`-free)
rule.

| File | Action(s) split out | Notes |
|---|---|---|
| `resource_automation_approval.yaml` | `read` | named in the ticket |
| `resource_automation_approval.yaml` | `decide`, `retry` | **found while checking every action** (not named in the ticket table) — `derivedRoles: ["company_admin", "group_executive"]` under the same `inTenant && notLow` condition, same fold-in defect. `company_admin` keeps `decide`/`retry`; `group_executive` got its own `notLow`-only rule. `manager` was already, correctly, excluded from `decide`/`retry` (holds `read` only) — left untouched. |
| `resource_pipeline_gate.yaml` | `read` | named in the ticket |
| `resource_pipeline_gate.yaml` | `decide` | **found while checking every action.** The ticket's own worked example ("if it is deliberately absent from an action (e.g. `decide` on `pipeline_gate` is `company_admin`-only), LEAVE IT ABSENT") does **not** match the file as it exists: `decide`'s `derivedRoles` was `["company_admin", "group_executive"]`, not `["company_admin"]` alone — `group_executive` was present, folded into the same `inTenant && notLow` condition, the identical defect. Treated as a fold-in to fix, not an absence to preserve, per the general instruction ("check every action... if folded into other rules, fix those too") — the specific example in the ticket text appears to describe a state the file was not actually in. |
| `resource_pipeline_run.yaml` | `read` | named in the ticket. `create`/`update` do **not** name `group_executive` at all (`["company_admin", "manager", "member"]` only) — left absent, as intended; not a fold-in. |
| `resource_pipeline_stage.yaml` | `update`, `read` | both named in the ticket. `create` does not name `group_executive` (`["company_admin", "manager", "member"]` only) — left absent. |
| `resource_scope_signoff.yaml` | `create`, `read` | both named in the ticket. No other actions on this kind. |

Every split rule for `group_executive` is `condition: { match: { expr: "variables.notLow" } }` —
no `inTenant`, matching `resource_appraisal.yaml` byte-for-byte in shape. Nothing else in any of
the 5 files changed (comments preserved/extended, `platform_admin`'s wildcard rule untouched,
`company_admin`/`manager`/`member` scope semantics untouched).

## 2. Widening safety check (both preconditions confirmed, not assumed)

- **Live holder check (read-only, `ssh gda-aicenter` → `sudo -u postgres psql -d gaiada_platform`):**

  ```sql
  SELECT u.email, r.name, ur.scope_type, ur.scope_id
  FROM user_roles ur JOIN users u ON u.id = ur.user_id JOIN roles r ON r.id = ur.role_id
  WHERE r.name = 'group_executive';
  ```
  → exactly one row: `exec@gaiada.test | group_executive | global |` (no `scope_id`). The `.test`
  email domain marks it as a seed/persona account, matching the ticket's premise. No other
  `group_executive` holder exists live.

- **Estate intent check:** `resource_appraisal.yaml` already grants `group_executive` this exact
  shape (own rule, `notLow`-only, no `inTenant`) — read directly, not inferred — and both
  `2026-08-10-iam-04-rollout-scan.md` §R.6 and `2026-08-11-hier-5-report.md` §5 independently
  recommend the identical fix, framing it as a live correctness bug, not a scope decision needing
  fresh approval.

Both conditions hold, so the widening proceeded per the ticket's instruction.

## 3. Verification — probe, not test alone

`cerbos compile /policies` (fresh container run, all 5 edited files + the rest of the tree): clean,
`0 tests executed`, no compile errors.

`docker restart gaiada-test-cerbos`, polled until `healthy`.

Two batched `POST /api/check/resources` calls against the restarted PDP:

**Exec, global scope, `companies: []` (the pure cross-company shape the role exists for) — every
fixed action ALLOWs:**

```
automation_approval: read=ALLOW decide=ALLOW retry=ALLOW
pipeline_gate:        read=ALLOW decide=ALLOW
pipeline_run:          read=ALLOW
pipeline_stage:        read=ALLOW update=ALLOW
scope_signoff:         read=ALLOW create=ALLOW
```

**`company_admin` scoped to company `t1`, checked against a resource in a DIFFERENT company `t2`
(companies set includes both `t1` and `t2`, isolating "does the grant cascade" from "is the tenant
even authorized") — every action still DENIEs, proving the split did not drop the tenant gate:**

```
automation_approval: create=DENY decide=DENY read=DENY retry=DENY update=DENY
pipeline_gate:        create=DENY decide=DENY read=DENY update=DENY
pipeline_run:          read=DENY
pipeline_stage:        read=DENY update=DENY
scope_signoff:         create=DENY read=DENY
```

## 4. Bundle regeneration — before/after

`npm run gen:role-bundles` → `wrote ... — 22 roles, 1023 total (role, permission) pairs.`

**Before and after are byte-identical** (`diff` clean). This is expected, not a miss:
`scripts/generate-role-bundles.mjs`'s own header states it treats resource-instance conditions
(`inTenant`, `notLow`/assurance, self-ownership) as "satisfied" and records only which role NAME
appears against which action — the same abstraction the estate has already flagged elsewhere
(`derived_roles.yaml`'s IAM-04a header: "a flat bundle records what a rule NAMES, not what it can
REACH"). `group_executive` was already named against every one of these (kind, action) pairs
**before** this fix (in the shared, defectively-gated rule); splitting that rule moves the name
into its own rule but does not add or remove it from the action, so the bundle's content cannot
change. Confirmed directly: `group_executive`'s bundle contained
`core.automation_approval.{read,decide,retry}`, `core.pipeline_gate.{read,decide}`,
`core.pipeline_run.read`, `core.pipeline_stage.{read,update}`, `core.scope_signoff.{read,create}`
both before and after regeneration (125 total keys, unchanged).

**The real widening is a live Cerbos DECISION change** (DENY → ALLOW for the zero-membership
exec), which the bundle's own documented abstraction was never built to capture — it already
recorded these as "granted" pre-fix, on the (accurate, in the abstraction's own terms) theory that
`inTenant` is a reachability condition, not a role-membership fact. No parity-test failure
resulted from this (§5) — none was expected, since the DB-side `role_permissions` seed this
generator's output gets compared against was never touched, and the generator's output is
unchanged.

## 5. Gate results (real output, this session)

```
cerbos compile /policies                                    clean, 0 tests executed
docker restart gaiada-test-cerbos + health poll              healthy
npx tsc --noEmit                                             0 errors (both before and after
                                                                       adding the new test file)
npx vitest run src/rbac/role-permission-parity.db.test.ts \
               src/rbac/permission-arm-hazard-scan.test.ts \
               src/rbac/iam-215-boundary-pin.test.ts          3 files, 210/210 passed
npx vitest run src/rbac/ (full directory, 23 files)           534/534 passed (includes the new
                                                                       iam-trap4-group-executive-
                                                                       split.test.ts, 39/39)
```

No `npm test` (full suite) was run, per the ticket's own warning that two full runs cannot share
the test Cerbos container — only the targeted files and the `src/rbac/` directory above, both
confirmed clean.

## 6. Blockers / follow-ups

- None on this ticket's own scope — role-arm split DEV-VERIFIED live on the test PDP, gates green,
  bundle change accounted for (none, and why).
- **Batch 4** (wiring the permission arm to these same 5 kinds, per
  `2026-08-10-iam-04-rollout-scan.md` §4 and `2026-08-11-hier-5-report.md` §4) is explicitly gated
  on this ticket and was **not started** here, per the ticket's own "do NOT wire permission arms on
  these kinds" constraint — it should now mirror the corrected role arm (own `group_executive`
  branch, no `inTenant`), not the pre-fix shared shape.
- **D-7** (Phase-3 deletion of `group_executive` entirely) remains unscheduled; this fix does not
  expand the role's reach beyond repairing the fold-in, so it costs nothing extra when D-7 lands —
  a correctly-split rule is exactly as easy to delete as an incorrectly-mixed one.
- **The ticket's own worked example for `pipeline_gate.decide`** ("deliberately absent,
  `company_admin`-only") did not match the file's actual pre-fix content (`group_executive` was
  present, folded in) — flagged in §1 above; treated as a fold-in per the ticket's general
  instruction rather than left alone per the specific (inaccurate) example. Worth a second pair of
  eyes confirming this reading is correct, since it is a case where the ticket text and the file
  disagreed and I resolved the disagreement in favor of the general rule over the specific example.
