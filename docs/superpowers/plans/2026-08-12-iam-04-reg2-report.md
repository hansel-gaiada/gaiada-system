# IAM-04-REG2 — mirror-reach invariant, run unscoped: the ~20-kind pre-existing register resolved

Status: DEV-VERIFIED for the 3 mirrors removed and the invariant/gate reruns below (targeted
suites, `cerbos compile`, `tsc --noEmit`, live probes against a restarted `gaiada-test-cerbos`,
read-only checks against `gda-aicenter`). PROTOTYPED for the fix itself pending the owner's review
and deploy (per this ticket's own constraint: no commit, no push, no deploy). Nothing here is
"done" or "production" — the live estate at `erp.gaiada.online` still runs the un-fixed policy set
until an owner ships this.

**Parent:** `docs/superpowers/plans/2026-08-12-iam-04-reg1-report.md` §6/§7 — the follow-up this
ticket was filed to close: resolve IAM-04-REG1's `IAM_04_REG1_PRE_EXISTING_OUT_OF_SCOPE_BASELINE`
(the estate-wide discovery run, not fixed by REG1, out of that ticket's ownership) kind-by-kind to
either SAFE (confirmed, no code change) or FIX (real over-grant, mirror removed).

## 1. Re-deriving the list (don't trust the ticket's recollection)

Ran `iam-04-reg1-mirror-reach-invariant.test.ts` UNSCOPED, unmodified, before touching anything:
**25/25 passed**, and its own `console.log` printed the exact `IAM_04_REG1_PRE_EXISTING_OUT_OF_SCOPE_BASELINE`
register — 54 `kind.action` pairs across 16 kinds (`hr_case`, `hr_record`, `member`,
`service_assignment`, `agency_approval`, `webdev_change_request`, `webdev_provisioned_site`, and 9
`resource_search_*` kinds), all mediated by `module_staff`/`module_manager`/`module_approver`. This
matches REG1's own §6 list; the "~20" in both tickets' language is a *kind* count in loose prose,
not the 54-pair total. **HR kinds first, per the ticket's brief** — §2 below.

## 2. HR kinds (priority) — `hr_case` FALSE across the board; `hr_record` FALSE except `.export`

### 2.1 `hr_case` — all 5 flagged actions are FALSE flags

Handler evidence: grepped every `authorize()` call site constructing an `hr_case` (or `hr_record`)
resource across the whole tree (`hr.controller.ts`, `loans.controller.ts` — the only two files that
ever do) — **22 call sites, every one passes the literal `module: "hr"`**. No call site omits it,
and no other file in the codebase constructs an `hr_case`/`hr_record` resource at all (grepped
`kind: "hr_case"` / `kind: "hr_record"` tree-wide, test files excluded). The file's own header
already documents this design ("Every HR handler passes resource.attr = {…, module: 'hr', …}").
Since `module` is a hardcoded kind-constant, `module_staff`/`module_manager`'s
`resource.attr.module == "hr"` gate can never actually exclude anything for THIS kind — a bundle
holder reachable only through that "gated" rule has, in practice, exactly the same reach as an
unconditional rule would grant. The static invariant test cannot see this (it only recognizes a
textual `resource.attr.` precondition, never "and is this precondition satisfiable to false for
this kind") — that gap is exactly this ticket's remit to close with handler evidence.

Per-action:
- `hr_case.read` / `.create` — the wired mirrors (`perm_hr_case_read_self`, `perm_hr_case_create_self`)
  are THEMSELVES self-scoped (`subjectUserId == principal.id`), strictly narrower than what
  `hr_manager`/`hr_staff` already get unconditionally via `module_manager`/`module_staff` (module
  constant, so unconditional in practice) — a self-scoped mirror can never grant a holder MORE than
  their own already-unconditional role-arm reach. **FALSE.**
- `hr_case.update` / `.delete` — wired mirrors are unconditional (`inTenant && notLow`), exactly
  matching the role arm's own condition on the same rule once the module gate is resolved as a
  no-op constant. **FALSE.**
- `hr_case.export` — flagged holders `group_executive` and `hr_manager`. `hr_manager`: same
  module-constant reasoning, exact match (mirror and role arm both require `assurance == "high"`
  here — resource_hr_case.yaml's export mirror was wired correctly from day one). `group_executive`:
  their OWN role-arm rule (`variables.notLow` only, no `inTenant`, no assurance tier beyond notLow)
  is **wider** than the mirror (`inTenant && assurance=="high"`) on the assurance axis — anyone who
  satisfies the mirror's stricter conditions already satisfies group_executive's own looser rule,
  so the mirror is a strict subset of what they already have via role arm directly. **FALSE.**

### 2.2 `hr_record` — 4 of 5 flagged actions FALSE; `.export` is a REAL, DIFFERENT-SHAPED over-grant

`read`/`create`/`update`/`delete` — same module-constant argument as `hr_case` (same two
controllers, same literal `module: "hr"` everywhere), mirrors wired unconditionally, exact match
once resolved. **FALSE**, all four.

**`hr_record.export` — REAL, and NOT the module hazard at all.** The role-arm "export" rule
(`module_manager`, `company_admin`) requires:
```
variables.inTenant && request.principal.attr.assurance == "high"
```
but the wired mirror (`perm_hr_record_export`) used:
```
variables.inTenant && variables.notLow
```
`_variables.yaml` defines `notLow: request.principal.attr.assurance != "low"` — and
`Assurance = "low" | "linked" | "high"` (`src/rbac/principal.ts`), with **no "medium" tier**.
`"linked"` satisfies `notLow` but not `assurance == "high"`. `src/auth/oidc.ts::assuranceFor()`:
```
function assuranceFor(tok): "high" | "linked" {
  return tok.amr.some(m => ["mfa","otp","hwk","totp"].includes(m)) ? "high" : "linked";
}
```
**Every real SSO login without MFA assembles at `"linked"`**, not `"high"`. So the wired mirror let
a `"linked"`-assurance `company_admin` or `hr_manager` export raw per-subject HR records
(contracts/documents/notes — the file's own header calls this "the D4 high-assurance tier") through
the flat permission arm, when the role arm's own high-assurance requirement would deny them. This
is the SAME detection mechanism (an independent, narrower role-arm rule the mirror's own condition
doesn't reproduce) but a genuinely different HAZARD MECHANISM than the other 53 pairs — an
assurance-tier mismatch, not a resource-attribute gate. **REAL. Fixed — mirror removed.**

## 3. Full verdict table — all 54 pairs

| kind.action | verdict | evidence (see §2/§4 for detail) |
|---|---|---|
| `hr_case.read`, `.create` | FALSE | module="hr" constant; wired mirror is self-scoped, strictly narrower than holders' already-unconditional reach |
| `hr_case.update`, `.delete` | FALSE | module="hr" constant; mirror = role arm exactly |
| `hr_case.export` | FALSE | module="hr" constant (hr_manager); group_executive's own rule is wider than the mirror |
| `hr_record.read`, `.create`, `.update`, `.delete` | FALSE | module="hr" constant; mirror = role arm exactly |
| **`hr_record.export`** | **REAL — FIXED** | assurance-tier mismatch: mirror used `notLow`, role arm requires `assurance=="high"`; `"linked"` (no-MFA SSO) slips through |
| **`member.read`** | **REAL — FIXED** | `module` is a CALLER-SUPPLIED query param (`core.controller.ts:292-294`, `moduleQ \|\| undefined`), confirmed varying — file's own pre-existing comment already suspected this |
| **`service_assignment.read`** | **REAL — FIXED** | `module` is a CALLER-SUPPLIED query param (`service-assignments.controller.ts:186/601/668`), confirmed varying — same shape |
| `agency_approval.approve` | FALSE | module="agency" constant, 7/7 call sites in `agency.controller.ts` + `thread-authz.ts` |
| `resource_search_audit.{read,create,update,delete,run}` | FALSE | module="search" constant, all 103 `resource_search_*` call sites checked |
| `resource_search_campaign.{read,create,update,delete,propose_change,apply_manual,launch,apply_negatives,set_budget}` | FALSE | module="search" constant |
| `resource_search_engagement.{read,create,update,delete,set_scope}` | FALSE | module="search" constant |
| `resource_search_keyword.{read,create,update,delete,research}` | FALSE | module="search" constant |
| `resource_search_ledger.{read,admin}` | FALSE | module="search" constant, no assurance mismatch (grepped for "assurance" gates on search_* — none found) |
| `resource_search_property.{read,create,update,delete}` | FALSE | module="search" constant |
| `resource_search_report.{read,create,update,delete,approve,deliver}` | FALSE | module="search" constant |
| `webdev_change_request.{read,triage}` | FALSE | module="webdev" constant, `webdev-change-requests.controller.ts` 4/4 call sites |
| `webdev_provisioned_site.{read,provision,reconcile}` | FALSE | module="webdev" constant, `webdev.controller.ts` 4/4 call sites |

**No HANDLER-CONSTRAINED verdicts.** I checked both `member.read` and `service_assignment.read`'s
handlers specifically for this (the category the ticket flagged as most likely to be got wrong) —
neither handler's SQL filters by `module` at all:
- `core.controller.ts`'s `/members` query: `SELECT m.user_id, u.name, u.email, u.title … FROM
  company_memberships m JOIN users u … WHERE m.deleted_at IS NULL AND … ORDER BY u.name` — no
  `module` predicate anywhere.
- `service-assignments.controller.ts`'s `listAssignments`: `SELECT * FROM service_assignments
  WHERE ${col} = $1 [AND status = ANY(...)]` — no `module_key` predicate either.

`module` is used ONLY for the Cerbos gate on both endpoints, never to filter the returned rows —
which makes both REAL findings genuinely low-severity in practice (see §5), but does NOT make them
HANDLER-CONSTRAINED: the handler isn't ADDING a restriction that saves us, it's the ABSENCE of a
module-aware restriction that makes the removed authorization gate the only thing that mattered.
A handler that ignores the dimension Cerbos was gating on is the opposite of "handler saves us."

## 4. What was removed (only what was proven REAL)

1. `platform-nest/cerbos/policies/resource_hr_record.yaml` — removed the `perm_hr_record_export`
   rule (comment names `company_admin`/`hr_manager` and the assurance mismatch). `read`/`create`/
   `update`/`delete` mirrors unchanged.
2. `platform-nest/cerbos/policies/resource_member.yaml` — removed the `perm_member_read` rule
   (comment names the 5 caller-supplied-module holder roles). The two role-arm rules above it are
   byte-unchanged.
3. `platform-nest/cerbos/policies/resource_service_assignment.yaml` — removed the
   `perm_service_assignment_read` rule (comment names the 10 caller-supplied-module holder roles).
   Every other `perm_service_assignment_*` mirror (propose/accept/revoke/suspend/resume/relink)
   unchanged — none of those had a caller-supplied-module holder issue.
4. `platform-nest/cerbos/policies/derived_roles.yaml` — removed the 3 corresponding derived-role
   definitions (`perm_hr_record_export`, `perm_member_read`, `perm_service_assignment_read`), each
   replaced with a one-line pointer comment to the resource-policy file's fuller explanation.
5. `platform-nest/src/rbac/role-permission-bundles.json` — **unaffected, no regeneration needed**
   (`node scripts/generate-role-bundles.mjs --check` → byte-identical before and after; the
   generator skips `perm_*`-prefixed derived roles the same way REG1 documented).
6. `platform-nest/src/rbac/iam-04-reg1-mirror-reach-invariant.test.ts` — shrank
   `IAM_04_REG1_PRE_EXISTING_OUT_OF_SCOPE_BASELINE` by the 3 fixed pairs (51 pairs remain, all FALSE
   per §3), rewrote the comment block above it to record REG2's resolution.
7. `platform-nest/src/rbac/cerbos-permission-dual-match.test.ts` — the two pre-existing pinned
   assertions that asserted the (now-removed) over-grant as correct behavior
   (`member.read`/`service_assignment.read` "PERMISSION ARM ALONE … allows") flipped from `true` to
   `false`, with rewritten `it()` descriptions and inline comments naming the fix — the same
   discipline REG1 followed when its own fix flipped `org14-preflight-adversarial.test.ts` T6(c)'s
   pinned 403 back from the regression's 200. This file is not in this ticket's owned-files list,
   but leaving it red (the DIRECT, PROVEN consequence of a correct fix, not a flaky or unrelated
   failure) would violate the "full src/rbac/ must be green" gate — updating a test that pinned the
   over-grant IS the fix, not scope creep. No other assertion in that file changed; the sibling
   `hr_record.read`/`.create`/`.update`/`.delete` and `hr_case` cases were not touched (confirmed
   FALSE, unaffected).

**No fixes attempted for the 51 remaining FALSE-flagged pairs.** They are left exactly as they are,
with their existing comments; the shrunk baseline pin documents each one's disposition is
"confirmed SAFE, no change" going forward.

## 5. Live exposure — the half that decides urgency

### 5.1 Does live Cerbos actually serve these mirrors?

Confirmed, not assumed. `gaiada-cerbos-1` on `gda-aicenter`: `docker inspect` mounts show
`/home/Hansel/gaiada/platform-nest/cerbos/policies -> /policies` (bind-mounted, matches the repo
checkout on the box). `resource_hr_record.yaml`/`resource_member.yaml`/
`resource_service_assignment.yaml` on the box all contain their `perm_hr_record_export` /
`perm_member_read` / `perm_service_assignment_read` rules (grep count = 1 each, pre-fix). File
mtimes: `2026-08-12 09:01:17Z`. Container `StartedAt`: `2026-08-12T09:04:30Z` — **postdates** the
policy file mtimes, so the currently-running Cerbos process has loaded this exact (pre-fix) content
— health and currency agree here, confirmed rather than assumed per the program's own standing trap.
Deployed tag: `alpha-01.038.0089a`.

### 5.2 Which live principals hold the relevant bundle keys?

Read-only queries via `docker exec gaiada-platform-1 node …` on `gda-aicenter`, using the
platform's own already-configured `DATABASE_URL` (never printed), SELECT-only, no writes:

```
Total user_roles rows (ALL roles, whole estate): 53
Full grant distribution: member=18, company_admin=11, manager=11, client=9,
  platform_admin=1, group_executive=1, it_admin=1, agency_approver=1
```

**Zero live grants** for every one of `hr_manager`, `hr_staff`, `reports_manager`, `reports_staff`,
`search_manager`, `search_staff`, `social_manager`, `social_staff`, `webdev_manager`,
`webdev_staff` — confirmed against the FULL role-grant distribution (not just a filtered query that
could have silently matched nothing due to a name typo): these 10 role names exist in the `roles`
catalog (verified) but appear in `user_roles` **zero times**, anywhere, for any tenant.

**Consequence:** `member.read` and `service_assignment.read`'s over-grants (§3) have **zero current
exploitability on the live estate** — no principal holds any of the bundle-holder roles that would
need the flat mirror to gain the extra reach. This is a structural fix (closes a real gap the
policy shape has) with no live blast radius TODAY; it becomes live the moment any of these 10
roles gets its first grant (e.g., via the service-assignment reconciler's auto-materialization once
a real cross-company HR/search/social/webdev/reports service assignment is created — none exist
yet). Fixing now, before that happens, is the same "fix now, don't wait" reasoning the earlier
TRAP-4 ticket used for `group_executive`.

### 5.3 `hr_record.export` — the one finding with live-relevant holders

`company_admin` (11 grants) is one of the two flagged holders (the other, `hr_manager`, has zero
grants — confirmed above). Broken down by principal (read-only, emails only, no credentials):

| Principal | Grants | Kind | Exploitable? |
|---|---:|---|---|
| `automation+compliance-gate-nag@gaiada.system`, `…reports-eod-reminder@…`, `…reports-monthly-seal@…`, `…reports-morning-escalation@…`, `…reports-nightly-facts@…`, `…reports-weekly-seal@…`, `…wd-digests@…` | 7 | automation/bot principal | **No** — every automation principal is minted `assurance: "low"` by construction (`platform-nest/CLAUDE.md`); "low" fails BOTH the mirror's `notLow` gate AND the role arm's `"high"` gate. Structurally cannot exploit this or any assurance-gated action. |
| `owner@gaiada-creative.test` | 2 (2 companies) | `.test`-domain seed/demo persona | **Almost certainly no** — per this program's own standing note, only ~7 users have real Keycloak accounts and a `users` row is not a login; a `.test` email is the seed-persona pattern, not a provisioned realm account. Not independently re-confirmed against Keycloak (see caveat below). |
| `hansel@gaiada.com` | 2 (2 companies) | **the one real human login among these 11 holders** | **Depends on this session's MFA state at login time — not confirmed, see caveat below.** |

**Caveat, stated honestly (per this program's own precedent for exactly this kind of gap):**
whether `hansel@gaiada.com`'s current Keycloak sessions authenticate with an `amr` claim that
includes `mfa`/`otp`/`hwk`/`totp` (→ `assurance: "high"`, not exploitable) or without one (→
`assurance: "linked"`, exploitable) was **not checked** — attempts to inspect Keycloak's own
credential/MFA configuration on `gda-aicenter` (via `docker exec` into the Keycloak container, or
via `grep`ping compose files for its DB connection details) were **blocked by this session's own
safety classifier** as credential-adjacent, even though the underlying action would have been a
read-only SELECT within the ticket's own explicit authorization. Per this program's own working
rule (never fight a permission denial by hunting for a workaround), I stopped rather than escalate
around it. **This is the single open question that determines whether §3's `hr_record.export`
finding has ANY live blast radius today** — every other candidate holder is structurally
non-exploitable (bots at "low") or almost certainly not a real login (`.test` seed). Recommend the
owner check this directly (Keycloak admin console → Users → hansel@gaiada.com → Credentials) rather
than an agent session attempting it again. The fix itself does not depend on this answer — removing
the mirror closes the gap regardless of whether it was ever exercised, matching the TRAP-4
precedent's "fix now, blast radius unconfirmed" reasoning.

## 6. Probes — before/after, against a restarted LOCAL `gaiada-test-cerbos` only

Per the ticket's constraint, all hypothetical-principal probing ran against the LOCAL test
container (`gaiada-test-cerbos`, restarted `2026-08-12T15:05:01Z`, confirmed bind-mounted from this
exact checkout, ports 3592/3593 published) — **never against live**, and live was touched only with
SELECT.

```
=== hr_record.export — "linked" assurance company_admin (holds the flat perms key too) ===
DENY   {"actions":{"export":"EFFECT_DENY"}}          <- was ALLOW before the fix; now correctly denied
=== control: "high" assurance company_admin, same grant ===
ALLOW  {"actions":{"export":"EFFECT_ALLOW"}}          <- unaffected, role arm grants this directly

=== member.read — hr_staff calling with module="search" (wrong module) ===
DENY   {"actions":{"read":"EFFECT_DENY"}}             <- was ALLOW before the fix; now correctly denied
=== control: hr_staff calling with module="hr" (correct module) ===
ALLOW  {"actions":{"read":"EFFECT_ALLOW"}}            <- unaffected, role arm's module_staff rule fires directly

=== service_assignment.read — hr_staff calling with module="webdev" (wrong module) ===
DENY   {"actions":{"read":"EFFECT_DENY"}}             <- was ALLOW before the fix; now correctly denied
=== control: hr_staff calling with module="hr" (correct module) ===
ALLOW  {"actions":{"read":"EFFECT_ALLOW"}}            <- unaffected
=== control: company_admin, no module needed at all ===
ALLOW  {"actions":{"read":"EFFECT_ALLOW"}}            <- unaffected, unconditional role-arm rule
```

Every "before" DENY-that-should-stay-DENY and ALLOW-that-should-stay-ALLOW case matches; every
over-grant case flips from the old (wrong) ALLOW to the new (correct) DENY; every legitimate,
role-arm-direct path is unaffected.

## 7. Gates

| Gate | Result |
|---|---|
| `iam-04-reg1-mirror-reach-invariant.test.ts` (unscoped) | 25/25 passed, shrunk baseline pin holds |
| full `src/rbac/` | 24 files, **572/572** passed |
| full `src/admin/` | 18 files, **196/196** passed |
| `src/admin/org14-preflight-adversarial.test.ts` (explicit, per VERIFY instruction) | 8/8 passed |
| full `src/modules/hr/` | 4 files, **68/68** passed |
| `cerbos compile cerbos/policies` (pinned image `ghcr.io/cerbos/cerbos:0.54.0`) | exit 0, clean |
| `npm run typecheck` | 0 errors |
| `node scripts/generate-role-bundles.mjs --check` | byte-identical, no regen needed |

No full `npm test` was run, per the ticket's constraint (shared test-Cerbos container) — only the
suites named above, plus the invariant test itself, plus the 3 live Cerbos probe sets in §6.
Baselined against `main` at `004c221` (IAM-04-REG1's own commit, confirmed at the top of this
session via `git log --oneline -5`) — no local stash was used to "isolate" a result; everything
above ran against the tree as edited by this ticket, on top of `004c221`, with the concurrent
session's untouched dirty files (`VERSION`, `docs/blueprints/smm-*`, `docs/modules/*`,
`docs/plans/2026-08-12-full-bug-audit.md`) left exactly as found.

## 8. Left for the owner

- **`hr_record.export`'s live exploitability hinges on `hansel@gaiada.com`'s current Keycloak MFA
  state**, which this session could not confirm (§5.3) — check it directly; the fix ships either
  way.
- **The 51 FALSE-flagged pairs are pinned as a confirmed-safe baseline, not silently dropped** — if
  a future change makes any of `hr_case`/`hr_record`/`agency_approval`/the 9 `search_*` kinds/
  `webdev_change_request`/`webdev_provisioned_site`'s `module` attribute become caller-supplied or
  otherwise variable (unlikely given how deeply hardcoded it is today, but the invariant test would
  need re-running with fresh handler evidence if that ever changes), re-audit rather than assume
  the FALSE verdict is permanent.
- **Not this ticket's remit, unrelated:** `docs/plans/2026-08-12-full-bug-audit.md`,
  `docs/blueprints/smm-*`, `docs/modules/*`, `VERSION` are dirty from a concurrent session and were
  left untouched per this ticket's explicit instruction.

## 9. Files touched

- `platform-nest/cerbos/policies/resource_hr_record.yaml` — removed 1 mirror rule (`.export`)
- `platform-nest/cerbos/policies/resource_member.yaml` — removed 1 mirror rule (`.read`)
- `platform-nest/cerbos/policies/resource_service_assignment.yaml` — removed 1 mirror rule (`.read`)
- `platform-nest/cerbos/policies/derived_roles.yaml` — removed 3 derived-role definitions
- `platform-nest/src/rbac/iam-04-reg1-mirror-reach-invariant.test.ts` — shrank the baseline pin,
  rewrote its header comment
- `platform-nest/src/rbac/cerbos-permission-dual-match.test.ts` — updated 2 assertions (the direct,
  proven consequence of the fix) that had pinned the over-grant as correct behavior
- `docs/superpowers/plans/2026-08-12-iam-04-reg2-report.md` — this file

Not touched: `role-permission-bundles.json` (verified unaffected), `admin-identity.controller.ts`,
`principal.ts`, `cerbos.ts`, `platform-ui/`, any migration, `appraisal`/`report_document`/`portal`/
social policy files, and every one of the 51 confirmed-FALSE pairs' policy files.
