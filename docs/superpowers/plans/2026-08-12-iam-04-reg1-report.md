# IAM-04-REG1 — permission-arm mirror over-grant regression: audit, fix, invariant

Status: DEV-VERIFIED for everything reported as driven below (Cerbos probes against a restarted
`gaiada-test-cerbos`, the targeted test runs, `cerbos compile`, `tsc --noEmit`); PROTOTYPED for the
new invariant test's estate-wide discovery (mechanically derived, not yet resolved kind-by-kind —
see §6 Follow-ups). Nothing here is "done" or "production".

## 1. The confirmed defect

Batch 4 of the IAM-04 rollout (commit `20a67ae`) wired 15 `perm_*` permission-arm mirrors across
`automation_approval`, `pipeline_gate`, `pipeline_run`, `pipeline_stage`, `scope_signoff`. Two of
them over-granted: `perm_automation_approval_read` and `perm_automation_approval_decide`.

`automation_approval`'s role arm grants `read`/`decide` to `company_admin`/`manager` (company-wide,
`inTenant && notLow`) and, via a SEPARATE rule, to `module_manager` gated to
`resource.attr.module == "hr"` (the providing HR unit's `hr_manager`, HR rows only — WSD-2). The
`perm_*` mirrors were wired at the company_admin/manager shape (`inTenant && notLow`, no module
gate) — correct for THAT shape, but `role-permission-bundles.json` unions every rule that grants a
role reach on a (kind, action) regardless of which rule did the granting, so `hr_manager` (a
bundle holder via `module_manager`) ALSO satisfied the flat mirror — gaining `read`/`decide` on
every approval in the tenant, not just hr-origin ones. `src/**/org14-preflight-adversarial.test.ts`
T6(c) pins the 403 this flipped to 200.

## 2. The general invariant

For every mirrored `kind.action`: every role whose `role-permission-bundles.json` entry contains
that permission key must ALREADY have equivalent-or-wider role-arm reach on that SAME action. If
any holder's reach is narrower — gated on a resource attribute, self-ownership, or a different
scope mechanism — the flat mirror over-grants and must not exist. A flat permission key has no
attribute dimension to re-express the narrower holder's restriction, so the fix is REMOVAL, never
a gate bolted onto the `perm_*` rule.

## 3. Full holders × role-arm-reach table — all 18 mirrors

"Reach" = the role-arm rule(s) that actually grant this holder the action, and whether that rule's
own condition adds anything beyond the mirror's own condition (almost always `inTenant &&
notLow`). `platform_admin` is omitted from every row — it holds every action via the wildcard
`actions: ["*"]` rule, definitionally a superset of any mirror, by construction (IAM-04c).

### Batch 4 (`20a67ae`) — 15 mirrors

| kind.action | mirror condition | holders (bundle) | reach per holder | verdict |
|---|---|---|---|---|
| `automation_approval.create` | `inTenant && notLow` | company_admin, manager, member | same rule, same condition, exact match | **SURVIVES** |
| `automation_approval.read` | `inTenant && notLow` | company_admin, manager; group_executive; **hr_manager** | company_admin/manager: same rule, exact match. group_executive: own rule, `notLow` only (subset, wider). **hr_manager: ONLY via `module_manager` rule, condition adds `&& resource.attr.module == "hr"` — narrower.** | **REMOVED** |
| `automation_approval.decide` | `inTenant && notLow` | company_admin; group_executive; **hr_manager** | company_admin: same rule (`decide,retry`), exact match. group_executive: own rule, `notLow` only (wider). **hr_manager: ONLY via `module_manager` (`read,decide`), same hr-only extra clause — narrower.** | **REMOVED** |
| `automation_approval.retry` | `inTenant && notLow` | company_admin; group_executive | company_admin: same rule, exact match. group_executive: own rule, `notLow` only (wider). No `module_manager` holder — that rule never grants `retry`. | **SURVIVES** |
| `pipeline_gate.create` | `inTenant && notLow` | company_admin, manager, member | same rule, exact match | **SURVIVES** |
| `pipeline_gate.read` | `inTenant && notLow` | company_admin, manager; group_executive | company_admin/manager: same rule, exact match. group_executive: own rule, `notLow` only (wider) | **SURVIVES** |
| `pipeline_gate.decide` | `inTenant && notLow` | company_admin; group_executive | company_admin: same rule, exact match. group_executive: own rule, `notLow` only (wider) | **SURVIVES** |
| `pipeline_run.create` | `inTenant && notLow` | company_admin, manager, member | same rule (`create,update`), exact match | **SURVIVES** |
| `pipeline_run.update` | `inTenant && notLow` | company_admin, manager, member | same rule (`create,update`), exact match | **SURVIVES** |
| `pipeline_run.read` | `inTenant && notLow` | company_admin, manager; group_executive | company_admin/manager: same rule, exact match. group_executive: own rule, `notLow` only (wider) | **SURVIVES** |
| `pipeline_stage.create` | `inTenant && notLow` | company_admin, manager, member | same rule, exact match | **SURVIVES** |
| `pipeline_stage.update` | `inTenant && notLow` | company_admin, manager; group_executive | company_admin/manager: same rule, exact match (member correctly absent — its own role-arm rule never grants `update`). group_executive: own rule, `notLow` only (wider) | **SURVIVES** |
| `pipeline_stage.read` | `inTenant && notLow` | company_admin, manager; group_executive | company_admin/manager: same rule, exact match. group_executive: own rule, `notLow` only (wider) | **SURVIVES** |
| `scope_signoff.create` | `inTenant && notLow` | company_admin, manager; group_executive | company_admin/manager: same rule, exact match (member correctly absent — dual-sign design). group_executive: own rule, `notLow` only (wider) | **SURVIVES** |
| `scope_signoff.read` | `inTenant && notLow` | company_admin, manager; group_executive | company_admin/manager: same rule, exact match. group_executive: own rule, `notLow` only (wider) | **SURVIVES** |

### Batch 3 (`9f14cc8`) — 3 mirrors

| kind.action | mirror condition | holders (bundle) | reach per holder | verdict |
|---|---|---|---|---|
| `project.read` | `inTenant && notLow` | company_admin, manager, member, viewer | ALL FOUR named unconditionally in the SAME role-arm rule, exact match | **SURVIVES** |
| `time_entry.read` | `inTenant && notLow` | company_admin, manager, member, viewer | ALL FOUR named unconditionally in the SAME role-arm rule, exact match | **SURVIVES** |
| `time_entry.create` | `inTenant && notLow` | company_admin, manager, member | same rule, exact match | **SURVIVES** |

**Result: 2 of 18 removed (`automation_approval.read`, `automation_approval.decide`); 16 survive.**
Batch 3's 3 mirrors were correctly reasoned about at the time (their own commit message's
"Pattern B" analysis for `update`/`delete` holds up) — no defect found there, confirming the
ticket's own suspicion that only `automation_approval.read` needed checking alongside `.decide`.

## 4. The fix

- `platform-nest/cerbos/policies/resource_automation_approval.yaml` — removed the
  `perm_automation_approval_read` and `perm_automation_approval_decide` mirror rules. `create` and
  `retry` mirrors are unchanged (they pass the invariant). Added a comment naming `hr_manager` /
  `module_manager` and citing the org14 T6(c) finding.
- `platform-nest/cerbos/policies/derived_roles.yaml` — removed the now-unused
  `perm_automation_approval_read` and `perm_automation_approval_decide` derived-role definitions.
  `perm_automation_approval_create` and `perm_automation_approval_retry` are unchanged.
- `platform-nest/src/rbac/role-permission-bundles.json` — **unaffected, no regeneration needed.**
  `scripts/generate-role-bundles.mjs` explicitly skips `perm_*`-prefixed derived roles when
  computing bundles (they match on resolved `attr.perms`, never on named `attr.grants`), so
  removing two of them cannot change any role's bundle. Verified: `node
  scripts/generate-role-bundles.mjs --check` → `--check OK: regeneration is byte-identical to the
  checked-in file.`
- No other policy file, migration, or the 5 other kinds' rules were touched — the fix is a pure
  subtraction of 2 rules + 2 derived-role definitions.

## 5. The invariant test (the durable deliverable)

New file: `platform-nest/src/rbac/iam-04-reg1-mirror-reach-invariant.test.ts`. Static-only (parses
`cerbos/policies/*.yaml` + `role-permission-bundles.json` + `permission-catalog.json` fresh every
run, no DB, no live Cerbos — same discipline as this directory's sibling rbac tests). Mechanism:

1. **Discovers** every wired `perm_<kind>_<action>` mirror rule (prefix-matched, never a hardcoded
   kind list).
2. For each, looks up the catalog key and every `role-permission-bundles.json` holder of that key.
3. For each holder (except `platform_admin`, the wildcard superadmin bypass), walks every OTHER
   role-arm rule on the same `kind.action` (including wildcard `["*"]` rules — an early draft
   wrongly excluded these and produced a false positive on `group_executive` reaching `company.*`
   only through the wildcard rule; fixed before this went into service) looking for one that names
   the holder — either literally (`company_admin`) or via a "safe" compound derived role
   (`hr_people_ops`, `it_staff`, …) — whose own condition, together with the RULE's condition, adds
   nothing beyond the mirror's own clauses.
4. If no such rule exists, the holder is **narrower** than the mirror and the mirror fails.

**Hard gate** (must be green, and is): the sweep is scoped to the 7 kinds this ticket's two commits
touched (`automation_approval`, `pipeline_gate`, `pipeline_run`, `pipeline_stage`, `scope_signoff`,
`project`, `time_entry`) — every one of the 16 surviving mirrors asserts `narrow === []`, plus a
direct regression pin that `automation_approval` wires `create`/`retry` only, never `read`/`decide`.

**Teeth proof**: re-adds the exact removed rule (`perm_automation_approval_decide`, in-memory only,
never touching the real YAML) onto a clone of the REAL `automation_approval` policy, re-runs the
invariant against the REAL `role-permission-bundles.json` holder list, and asserts `hr_manager`
is caught as narrow — proving the detector actually catches the defect this ticket fixes, not just
that it happens to pass on already-fixed source. A companion negative proof asserts `retry` (no
`hr_manager` holder) is correctly NOT flagged by the same mechanism.

**Estate-wide discovery, not fixed here**: run UNSCOPED (no kind filter) as a diagnostic step
during this work, the same mechanism found the IDENTICAL shape already live on ~20 OTHER kinds —
`hr_case`, `hr_record`, `member`, `service_assignment`, all 9 `resource_search_*` kinds,
`agency_approval`, `webdev_change_request`, `webdev_provisioned_site` — every one mediated by
`module_staff`/`module_manager`/`module_approver` from EARLIER batches (IAM-04-ROLLOUT-B12,
IAM-04-ROLLOUT-B4, the IAM-04b pilot), not this ticket's two commits, and not files this ticket
owns. Unlike `automation_approval` (a genuinely multi-module kind, provably narrow: the rule pins
one literal `module == "hr"` value), most of these are single-purpose kinds where the "module is a
kind-constant, so the gate never actually excludes anything" argument (already used to justify
several of them at rollout time, per §3 Mechanism 2/3 of
`docs/superpowers/plans/2026-08-10-iam-04-rollout-scan.md`) MAY hold — but that can only be
confirmed with handler evidence (does the controller for that kind ever set `resource.attr.module`
to a different value?), which this static test cannot gather, and which is out of THIS ticket's
remit to re-litigate. `resource_member.yaml`'s own `perm_member_read` comment already flags the
identical concern for `hr_staff` as live, not theoretical — so at least `member.read` and
`service_assignment.read` (the two genuinely cross-module, caller-supplied-attribute kinds) are
credible real instances, not false positives.

**Handling**: rather than assert these away or silently ignore them, the test pins the exact
findings as a `IAM_04_REG1_PRE_EXISTING_OUT_OF_SCOPE_BASELINE` — a non-regression snapshot that
goes red if the set GROWS (a new instance introduced) or changes shape, and must be updated down
when a future ticket resolves one. See §6 for the follow-up this should become. The rollout
register (`docs/superpowers/plans/2026-08-10-iam-04-rollout-scan.md` §7, added by this ticket) has
the full narrative and the same follow-up ask.

## 6. Follow-ups / blockers (not this ticket's remit — filed, not fixed)

- **New ticket needed**: re-run the "confirm-reliable" handler-evidence audit
  (`docs/superpowers/plans/2026-08-10-iam-04-rollout-scan.md` §3 Mechanism 2/3) against
  `iam-04-reg1-mirror-reach-invariant.test.ts`'s pinned out-of-scope baseline (~20 kind.action
  pairs, listed in the test file and in §7 of the rollout register). For each: confirm the
  attribute genuinely never varies for that kind (SAFE, document why, no code change) or find it
  genuinely does (FIX: remove the mirror, matching this ticket's `automation_approval` shape), then
  shrink the pinned baseline to match. `member.read` and `service_assignment.read` are the most
  credible real instances (their own comments already say so) and should be first.
- This ticket did NOT touch `resource_member.yaml`, `resource_hr_case.yaml`, `resource_hr_record.
  yaml`, any `resource_search_*.yaml`, `resource_service_assignment.yaml`,
  `resource_webdev_change_request.yaml`, `resource_webdev_provisioned_site.yaml`, or
  `resource_agency_approval.yaml` — all out of ownership for IAM-04-REG1.

## 7. Verification driven live

### Targeted test runs (all against the restarted `gaiada-test-cerbos`, real `DATABASE_URL_TEST`)

| Suite | Result |
|---|---|
| `src/rbac/iam-04-reg1-mirror-reach-invariant.test.ts` (new) | 25/25 passed |
| `src/rbac/permission-arm-hazard-scan.test.ts` | 125/125 passed |
| `src/rbac/role-permission-parity.db.test.ts` | 27/27 passed |
| `src/rbac/iam-215-boundary-pin.test.ts` | 73/73 passed |
| `src/rbac/iam-trap4-group-executive-split.test.ts` | 39/39 passed |
| full `src/rbac/` | 24 files, 574/574 passed |
| full `src/admin/` | 18 files, 196/196 passed |
| `src/admin/org14-preflight-adversarial.test.ts` | **8/8 passed, including T6** |
| `cerbos compile cerbos/policies` (pinned image `ghcr.io/cerbos/cerbos:0.54.0`, matching the running `gaiada-test-cerbos`) | exit 0, clean |
| `npm run typecheck` | 0 errors |
| `node scripts/generate-role-bundles.mjs --check` | byte-identical, no regen needed |

No full `npm test` was run (another session may hold the shared test Cerbos container) — only the
suites named above and in the ticket's VERIFY section.

### Cerbos probes (restarted `gaiada-test-cerbos`, `CheckResources` API, verbatim)

```
=== PROBE 1: hr_manager DENY on deciding a NON-hr approval (module=billing) ===
{"requestId":"probe-1-hrmgr-nonhr-deny","results":[{"resource":{"id":"appr-1","kind":"automation_approval"},"actions":{"decide":"EFFECT_DENY"}}],"cerbosCallId":"01KZV5BMERYKS1HBWF0WZ1JBFB"}

=== PROBE 2: hr_manager ALLOW on deciding an HR approval (module=hr) ===
{"requestId":"probe-2-hrmgr-hr-allow","results":[{"resource":{"id":"appr-2","kind":"automation_approval"},"actions":{"decide":"EFFECT_ALLOW"}}],"cerbosCallId":"01KZV5BMKWZF2C8SR2A9GRC71J"}

=== PROBE 3: company_admin ALLOW company-wide (module=billing) ===
{"requestId":"probe-3-companyadmin-allow","results":[{"resource":{"id":"appr-3","kind":"automation_approval"},"actions":{"decide":"EFFECT_ALLOW"}}],"cerbosCallId":"01KZV5BMQSVSW88XA9EGX5N98T"}
```

Probe 1 and 2's principal included a resolved `attr.perms` array containing
`core.automation_approval.read`/`.decide` (simulating `hr_manager`'s real, unremoved bundle entry)
— proving the fix closes the flat-permission path specifically, not just the grants path.

## 8. Files touched

- `platform-nest/cerbos/policies/resource_automation_approval.yaml` — removed 2 mirror rules
- `platform-nest/cerbos/policies/derived_roles.yaml` — removed 2 derived-role definitions
- `platform-nest/src/rbac/iam-04-reg1-mirror-reach-invariant.test.ts` — new
- `docs/superpowers/plans/2026-08-10-iam-04-rollout-scan.md` — §7 addendum
- `docs/superpowers/plans/2026-08-12-iam-04-reg1-report.md` — this file

Not touched: `role-permission-bundles.json` (verified unaffected), `admin-identity.controller.ts`,
`user-roles-writer-guard.test.ts`, any migration, `principal.ts`, `cerbos.ts`, `platform-ui/`, and
every other kind's policy file named in §6.
