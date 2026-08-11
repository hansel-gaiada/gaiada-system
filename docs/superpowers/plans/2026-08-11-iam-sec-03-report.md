# IAM-SEC-03 — closing the detector's wildcard blind spot + a 61-kind sweep

**Status:** DETECTOR EXTENSION PROTOTYPED / DEV-VERIFIED against the current tree (static parse
only — `permission-arm-hazard-scan.test.ts`, `npx vitest run src/rbac/permission-arm-hazard-scan.test.ts`,
72/72 green, this session). **No policy file changed. No authorization decision changed.** This
ticket owns `permission-arm-hazard-scan.test.ts` and this document only; `admin-identity.controller.ts`,
`derived_roles.yaml`, `global-only-role-scope.test.ts`, and every `.cerbos/policies/*.yaml` file were
read-only inputs, re-read at the end of the session to confirm no concurrent edit invalidated a
finding below (three other agents were noted as active in this checkout; a final re-run at §5
confirms the numbers here are still current).

**Parents:** `2026-08-10-iam-04-rollout-scan.md` (the detector this extends), `admin-identity.controller.ts`'s
`GLOBAL_ONLY_ROLES` comment (the write-path fix this detector's finding corroborates),
`global-only-role-scope.test.ts` (the write-path guard's own teeth proof).

---

## 1. The blind spot, restated precisely

`permission-arm-hazard-scan.test.ts`'s Pattern A (the pre-existing "mixing" scanner) explicitly
skips wildcard (`actions: ["*"]`) rules:

> "Wildcard (`actions: ["*"]`) rules are the permanent IAM-04c superadmin bypass and are never
> scanned — they are structure, not a permission-catalog concept, by architect ruling."

IAM-04-ROLLOUT-B12 found that ruling does not hold in practice. Migration 0094's
`role_permissions` bundling methodology does not special-case wildcard-sourced rows: it bundles
every action of every kind whose wildcard rule names a role into that role's flat permission
catalog, indistinguishable from a normal rule. `assemblePrincipal()` then resolves that bundle at
whatever scope the GRANT itself carries — not the scope the role's own derived-role condition
would require. So a role whose own condition is narrower than "global-or-company" can be granted
at a scope its role-arm rule would refuse, and a generic `perm_<kind>_<action>` mirror (the exact
shape every already-wired kind uses) would honour it anyway. `platform_admin` — global-only,
appearing in 56 kinds' wildcard rules — was the confirmed, reachable instance: `assignRole` is
authorized by `user:create`, which `company_admin` holds, so a company admin could mint
`platform_admin@their-own-company` and pick up the ~16 permissions their own bundle lacks, inside
their own tenant, violating D-9's no-self-escalation safeguard.

That instance is now closed at the write path (`admin-identity.controller.ts`'s
`GLOBAL_ONLY_ROLES` guard, `global-only-role-scope.test.ts`'s teeth proof — both pre-existing,
read-only inputs to this ticket). **This ticket's job is the detection gap, not the fix**: prove
the detector can now see this shape at all, sweep every kind for every other instance, and
classify each by reachability.

---

## 2. How each role's condition is derived (no hand-maintained list)

`permission-arm-hazard-scan.test.ts` already had a structural CEL classifier
(`classifyDerivedRoleExpr`) that reads `derived_roles.yaml`'s raw `condition.match.expr` text via
`js-yaml` (never a role-name switch) and buckets every derived role SAFE (its whole match reduces
to an unconditional `scopeType == "global"` branch **and** an unconditional
`scopeType == "company" && scopeId == tenantId` branch, nothing else) or UNSAFE (three structured
reasons: `top-level-attr-gate`, `no-disjunction`, `missing-scope-branch`). That classifier is
reused as-is — it is exactly the "is this role narrower than a plain global-or-company mirror"
test the wildcard shape needs.

**New code, `scanPatternC`:** for every `EFFECT_ALLOW` rule whose `actions` includes `"*"`, for
every named role, look it up in the same `roleClass` map; if UNSAFE, record `{kind, role, reason}`.
Deliberately **no co-occurring-SAFE-role requirement** (unlike Pattern A) — a wildcard rule's very
presence is what produces the always-bundled row IAM-04c assumed would never exist, so an unsafe
role doesn't need a safe rule-mate in the same rule to be dangerous; it needs only to be named in a
rule that performs no per-request scope re-check of its own.

**New code, `isGlobalScopeOnly`:** a second, more precise structural check, needed because
`classifyDerivedRoleExpr`'s bucket names turned out to be coarser than "is this role global-only".
`platform_admin`'s raw expr (`g.role == "platform_admin" && g.scopeType == "global"`) has no `||`
at all, so the classifier's `no-disjunction` bucket catches it — the **same** bucket `team_lead`
occupies for the unrelated reason that its own AND-chain (`scopeType == "team" && scopeId ==
teamId`) also has no `||`. The two shapes need different mitigations (a global-only write-guard
vs. a scope-exclusion on the permission arm), so `isGlobalScopeOnly` splits the AND-chain on
top-level `&&`, strips the role-match clause, and checks whether exactly one clause remains and it
is literally `g.scopeType == "global"`. This is what the sweep uses to answer "can
`GLOBAL_ONLY_ROLES` actually mitigate this finding" per-role, not the coarser bucket label.

**New code, `loadGlobalOnlyRolesFromController`:** a regex read (not an import — importing the
controller module would drag in Nest/`../db`/`../config` for a plain constant) of
`admin-identity.controller.ts`'s `GLOBAL_ONLY_ROLES` `Set([...])` literal, used to cross-check the
sweep's findings against the one write-path mitigation that actually exists, without modifying
that file (out of scope per the ticket's constraints).

---

## 3. Sweep result — every instance, all 61 kinds

```
Pattern C by role: platform_admin: 56 kinds; group_executive: 7 kinds
```

**Only two roles ever appear in a wildcard rule, anywhere in the 61-kind estate**, confirmed by
direct grep of every `resource_*.yaml` (`grep -c 'actions: \["\*"\]'` across all 56 files that
contain a wildcard rule) cross-checked against the detector's own live output:

- **`platform_admin`** — all 56 wildcard-carrying kinds. Every wildcard rule in the estate names
  it (it is, structurally, the "platform superadmin bypass" role IAM-04c's ruling was written
  about).
- **`group_executive`** — 7 of those 56 kinds, always alongside `platform_admin` in the SAME rule:
  `company`, `device`, `invoice`, `knowledge_source`, `contract`, `pm_task`, `pm_project`.

**No other role of the six the ticket asked about (`client`, `team_lead`, `module_approver`,
`hr_people_ops`/`hr_people_reader`, `it_staff`) appears in ANY wildcard rule.** Checked
mechanically (`scanPatternC` iterates every wildcard rule's full `derivedRoles` list against the
same classifier Pattern A uses — nothing about the implementation limits it to these two names) and
confirmed by direct inspection of every one of the 56 wildcard-carrying files: every wildcard rule
in the codebase names only `platform_admin`, alone or paired with `group_executive`. `team_lead`,
`client`, and the `module_*` trio only ever appear in **non-wildcard** rules (always mixed with a
SAFE role in the same rule — Pattern A already catches those instances; that is the pilot's own
`team_lead`×`pm_task` finding, unrelated to this ticket's blind spot).

`hr_people_ops`, `hr_people_reader`, and `it_staff` are, independently, classified **SAFE** by
`classifyDerivedRoleExpr` — each reduces to the plain `scopeType == "global" ||
(scopeType == "company" && scopeId == tenantId)` disjunction with no extra gate
(`derived_roles.yaml:173-192`, `:74-82`). They cannot produce this hazard shape at all, in a
wildcard rule or anywhere else — not because nobody has found an instance yet, but because their
own condition already grants everything a naive global-or-company permission mirror would.

### Precise semantics: both flagged roles are true global-only, confirmed by `isGlobalScopeOnly`

Both `platform_admin` and `group_executive`'s raw CEL text reduces to exactly `g.scopeType ==
"global"` with no other clause (`isGlobalScopeOnly` returns `true` for both, `false` for every
other role checked) — the REACHABILITY test in Part 3b of the detector asserts this holds for
every Pattern-C finding and fails loudly if a future policy edit ever introduces a
non-global-only role into a wildcard rule (that would need a different mitigation than
`GLOBAL_ONLY_ROLES` can provide).

---

## 4. Reachability classification

| Finding | Role | Kinds | Reachable via a write path today? |
|---|---|---|---|
| Wildcard rule, global-only role | `platform_admin` | 56 | **CLOSED.** `admin-identity.controller.ts`'s `GLOBAL_ONLY_ROLES = new Set(["platform_admin", "group_executive"])` rejects any `assignRole` call for this role at a non-global `scopeType` with a 400, before the row is ever inserted. `global-only-role-scope.test.ts` proves the refusal (company + project scope, both denied, clean 400 never a 500) using the **strongest possible caller** (a platform admin themself) and proves the guard does not over-refuse (global-scope grants and non-elevated roles at company scope both still succeed). No seed, fixture, or live row carries this grant at a non-global scope (per the controller's own comment, verified independently by this ticket's read of the same file). |
| Wildcard rule, global-only role | `group_executive` | 7 (`company`, `device`, `invoice`, `knowledge_source`, `contract`, `pm_task`, `pm_project`) | **CLOSED**, same guard, same set, same test file (the guard and its test explicitly cover both roles, not just `platform_admin` — see `global-only-role-scope.test.ts`'s own two "refuses ... at company scope" cases). |
| Every other named-in-ticket role (`client`, `team_lead`, `module_approver`, `hr_people_ops`/`hr_people_reader`, `it_staff`) | — | 0 | **N/A — no instance exists.** None of these roles appears in any wildcard rule anywhere in the 61-kind estate (§3). This is not "theoretically reachable but unmitigated"; there is nothing to reach. |

**There is currently no OPEN (detected-but-unmitigated) finding from this scan.** Both real
instances this scan found are already closed by a write-path guard that predates this ticket's own
detector extension (the guard landed 2026-08-11 per its own header; this ticket's job, per its
brief, was to prove the DETECTOR can see the shape the guard was built for, and to prove nothing
else needs the same treatment).

---

## 5. Teeth-check — verbatim output

Synthetic, in-memory-only kinds (never written to disk, reverted by construction — the next test
re-parses from disk and proves the synthetic kind is gone):

```
✓ (IAM-SEC-03) a wildcard rule naming a scope-narrower role IS flagged by Pattern C
✓ (IAM-SEC-03) a wildcard rule naming ONLY a SAFE role is NOT flagged (no false positives)
✓ REVERT: neither synthetic kind above is persisted anywhere — the real 61-kind parse is unaffected
✓ the SAME Pattern-C detector, run against REAL platform_admin, finds it flagged in every wildcard-carrying kind
```

The first synthetic case reproduces the exact `platform_admin` shape: a wildcard rule naming
`platform_admin` (global-only, UNSAFE) alongside a **separate** rule naming `company_admin`
(SAFE, for contrast). `scanPatternC` flags `platform_admin` and does **not** flag `company_admin`
(no false positive on a safe role sharing the same synthetic kind). The second synthetic case (a
wildcard rule naming ONLY a SAFE role) produces zero hits — proving the scanner isn't just
"flag every wildcard rule," it specifically discriminates on the named role's own condition.

Full suite result, this session:

```
src/rbac/permission-arm-hazard-scan.test.ts   72/72  (was 12/12 before this ticket; +60 new
                                                assertions: Part 3b's 4 tests (sweep, two
                                                reachability cross-checks, informational report)
                                                + Part 4's 3 new teeth-proof tests, plus the
                                                pre-existing 12 unchanged and still green)
src/rbac/ (21 files total)                     395/395 (full directory re-run, no regression)
src/admin/global-only-role-scope.test.ts       5/5 (the write-path guard this scan corroborates,
                                                re-run against the live DB+Cerbos test stack —
                                                unaffected by this ticket, checked to rule out a
                                                concurrent-session collision)
npx tsc --noEmit                               no new errors attributable to this file
```

**The real tree is NOT red.** Every finding this scan produces is already covered by the existing
`GLOBAL_ONLY_ROLES` guard, so the reachability cross-check tests (Part 3b, tests 2–3) pass rather
than fail. This is the correct outcome, not a tuned one: the detector was extended to see a shape
it previously could not see, ran the sweep, and the sweep's own findings happen to already be
mitigated — verified by reading the mitigation's source and its own test file, not by narrowing
what the detector reports. If a fourth agent working this checkout concurrently removes
`platform_admin`/`group_executive` from `GLOBAL_ONLY_ROLES`, or adds a new role to any wildcard
rule that fails `isGlobalScopeOnly`, this suite goes red the next run — that is the regression
guard the ticket asked for.

---

## 6. What was NOT done (explicitly out of scope)

- **No Cerbos policy file was touched.** `derived_roles.yaml`, every `resource_*.yaml` — read-only.
- **No authorization decision changed.** Nothing in `permission-arm-hazard-scan.test.ts` executes
  against live Cerbos or the DB; it is a static YAML/text parse, same discipline as the file's
  pre-existing Parts 1–4.
- **`admin-identity.controller.ts` was not modified.** The `GLOBAL_ONLY_ROLES` guard and its
  comment predate this ticket (dated 2026-08-11 in its own header, "found by
  IAM-04-ROLLOUT-B12") — this ticket's contribution is proving the STATIC detector can now
  independently re-derive the same finding that guard was built for, plus proving no other role
  needs the same treatment.
- **The `group_executive` role-arm TRAP-4 bug** (six kinds fold `group_executive` into a rule
  gated by `variables.inTenant`, which is never true for a pure global grant — flagged by the
  2026-08-10 rollout-scan report, §2.3 Mechanism 2) is unrelated to this ticket's finding and was
  not touched; it is a role-ARM correctness bug, not a permission-arm hazard.
