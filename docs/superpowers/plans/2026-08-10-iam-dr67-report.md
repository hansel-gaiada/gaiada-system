# IAM-DR67 report — two mirror corrections (DR-6, DR-7) + a capability-map defect fix

**Status:** DEV-VERIFIED. Three targeted edits to `platform-ui/src/lib/rbac.ts` and
`platform-ui/src/lib/rbac-capability-map.ts`, pinned by six new tests in
`platform-ui/src/lib/rbac.test.ts`. Zero authorization decisions changed (Cerbos untouched); this
is a mirror-only correction plus a bug fix in a UI-side capability→permission map, exactly per the
ticket's framing. `rbac-capability-parity.test.ts` (the guard) was not edited, per constraint.

## 0. The `hr.case.cancel` verdict — independently verified, not trusted from the brief

**Verdict: the brief is correct — this is a real defect in `rbac-capability-map.ts`, not an owner
decision, and removing `hr.case.cancel` from `hr.manage`'s permission set is the right fix.**

Read `platform-nest/cerbos/policies/resource_hr_case.yaml` directly (not the ticket's summary of
it). The `cancel` action appears in exactly two rules:

```yaml
# line 19-23 — wholesale, group_executive only
- actions: ["read", "create", "update", "delete", "export", "cancel"]
  effect: EFFECT_ALLOW
  derivedRoles: ["group_executive"]
  condition: { match: { expr: "variables.notLow" } }
...
# line 42-52 — self-service only, subjectUserId == principal.id
- actions: ["read", "create", "cancel"]
  effect: EFFECT_ALLOW
  derivedRoles: ["member"]
  condition:
    match:
      expr: >-
        variables.inTenant && variables.notLow &&
        has(request.resource.attr.subjectUserId) &&
        request.resource.attr.subjectUserId == request.principal.id
```

The IAM-04b additive permission-arm mirrors this exactly (`perm_hr_case_cancel_self`, lines
111–119, same self-only condition). The unconditioned staff/manager/admin tier (line 25–28) lists
only `["read", "create", "update"]`; the elevated manager/admin tier (line 30–33) lists only
`["delete"]`. **No rule in this file grants `cancel` to `module_manager` or `company_admin` under
any condition.** `hr.manage`'s permission set (`hr-capability-map.ts`) included
`hr.case.cancel` anyway, which under `all` semantics made the capability unsatisfiable for the two
roles (`company_admin`, `hr_manager`) that genuinely hold every *other* permission in the set
unconditionally — the two false over-claims the IAM-05b-3 report flagged as findings #6/#7. This
independently reproduces IAM-02a's own drift register §3 conclusion ("`hr_case:cancel`... not a
capability at all... removed from consideration"). Fixed by dropping the one key; no other member
of the set was touched.

## 1. The three changes

### DR-6 — `it_admin` loses `company.manage` (`rbac.ts`)

`it_admin`'s entire Cerbos reach (`resource_device.yaml`) is `it.device.create/update/delete` —
zero overlap with `company.manage`'s ten-permission `any` set (integration connections, company
update, billing, automation retry). Same over-claim class as DR-1: a dead button, 1 live holder
(IAM-02a-0's live census). `it_admin` keeps `it.manage`.

### DR-7 — `people.directory` for `hr_staff` / `search_staff` / `reports_staff` (`rbac.ts`)

`resource_member.yaml`'s `module_staff` rule (lines 21–24) grants tenant-directory `read`
**unconditionally** to any `module_staff`-derived role (gated only on `inTenant && notLow` and the
module attribute being present — no self/`owns` clause). Granted to the three `_staff` roles only;
`module_manager` is not named in that rule, so `hr_manager` / `search_manager` / `reports_manager`
were deliberately left unchanged — pinned by a test that explicitly checks they do NOT gain the
capability. All three roles have 0 live holders today (IAM-02a-0), so this is a pre-staffing fix,
same precedent as DR-2a.

### MAP DEFECT — `hr.case.cancel` dropped from `hr.manage` (`rbac-capability-map.ts`)

See §0 above. `hr.manage`'s set is now
`["hr.case.create","hr.case.update","hr.case.delete","hr.record.create","hr.record.update","hr.record.delete"]`
— every genuine hr_case/hr_record write action, minus the one that was never actually granted to
`module_manager`/`company_admin`.

## 2. Verification

- `npx tsc --noEmit` in `platform-ui/` — **clean, zero errors.**
- `npx vitest run` (full `platform-ui` suite) — **144 test files passed (144), 2143 tests passed
  (2143), 0 failed.** Baseline was 1590 (pre-existing) + 547 (`rbac-capability-parity.test.ts`) =
  2137; this ticket added exactly 6 new pinning tests (2 for DR-6, 2 for DR-7, 2 for the map
  defect) in `rbac.test.ts`, giving 2143 — the arithmetic reconciles exactly.
- `npx vitest run src/lib/rbac-capability-parity.test.ts` in isolation — **547/547 passed, 0
  failed.**

## 3. The DR-5 pair — NOT this ticket's work, confirmed still correct

The guard's 7th originally-red case, `company_admin × appraisal.read`, is **also green** in the
run above. This is **not something this ticket did.** `ROLE_CAPS.company_admin` in `rbac.ts` was
not touched and still contains `"appraisal.read"` unchanged (verified by re-reading the file after
all edits). The reason it now passes: a concurrent agent's Cerbos-side grant (DR-5 — adding
`company_admin` to `resource_appraisal.yaml`'s read rule) landed in this shared checkout, which
propagated into `platform-nest/src/rbac/role-permission-bundles.json` — confirmed directly:

```
company_admin has reports.appraisal.read: true
```

(checked against the live JSON file, not assumed). Per the concurrency warning in the ticket, I am
reporting this rather than claiming credit for it: **the guard is green on all 7 pairs right now**,
but only 6 of them are this ticket's fix. If that concurrent work is ever reverted or reordered
in history, the `company_admin × appraisal.read` case would go red again through no fault of this
ticket's three edits — that pair's correctness is the other agent's deliverable, not mine.

## 4. Files touched

- `platform-ui/src/lib/rbac.ts` — DR-6 (`it_admin`), DR-7 (`hr_staff`/`search_staff`/`reports_staff`).
- `platform-ui/src/lib/rbac-capability-map.ts` — the `hr.case.cancel` removal from `hr.manage`.
- `platform-ui/src/lib/rbac.test.ts` — 6 new pinning tests (3 new `describe` blocks) + a new
  `CAPABILITY_MAP` import.
- `docs/superpowers/plans/2026-08-10-iam-dr67-report.md` (this file).
- `rbac-capability-parity.test.ts` — **not edited**, per explicit constraint.
- Nothing in `platform-nest/` was read or written by this ticket's own edits (the DR-5 evidence in
  §3 was read-only, to explain an observed result, not to act on it).

## 5. Follow-ups for the orchestrator

- None blocking. The guard is fully green; six of seven pairs are this ticket's fix, the seventh
  is the concurrent DR-5 agent's — worth confirming with them that their Cerbos-side change is the
  final, intended state before either piece of work is considered closed out.
