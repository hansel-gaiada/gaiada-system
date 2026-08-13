# IAM-04-REG3 — restore `hr_record.export`'s permission-arm mirror at the CORRECT tier

**Status:** PROTOTYPED / DEV-VERIFIED (targeted suites, `cerbos compile`, `npm run typecheck`, live
probes against a restarted local `gaiada-test-cerbos`, both assurance tiers plus cross-tenant and a
regression control on the copied-from file). **Not deployed** — no commit, no push, per this
ticket's own constraint; the live estate at `erp.gaiada.online` keeps running IAM-04-REG2's
(over-corrected) fix until an owner reviews and ships this.

**Parent:** `docs/superpowers/plans/2026-08-12-iam-04-reg2-report.md` (the removal this ticket
partially reverses) and its commit `fd6a1eb`. **Precedent copied:**
`platform-nest/cerbos/policies/resource_hr_case.yaml`'s `perm_hr_case_export` rule (read-only,
untouched by this ticket).

## 1. What REG2 got right, and what it overcorrected

REG2 found a real hole: `perm_hr_record_export` was wired at `variables.inTenant &&
variables.notLow`, but the role arm's own `export` rule on `hr_record` requires `variables.inTenant
&& request.principal.attr.assurance == "high"` — strictly narrower. Since `notLow` is merely
`assurance != "low"` (`_variables.yaml`) and every real SSO login without MFA assembles at
`"linked"` (`src/auth/oidc.ts::assuranceFor()`), a `"linked"`-assurance `company_admin`/`hr_manager`
could export raw per-subject HR records (contracts/documents/notes) through the flat permission arm
while the role arm denied exactly that. REG2 fixed the hole by deleting the mirror outright.

Per the owner's confirmed design intent — access must work for anyone whose **role carries enough
permission**, not only for named roles — deletion was an overcorrection: it closed the hole by
removing the permission-driven path entirely, rather than fixing its tier. `resource_hr_case.yaml`
already shows the correct answer for this exact shape: mirror the action, but carry the SAME
high-assurance condition in the mirror's own rule. This ticket applies that pattern to `hr_record`.

## 2. The restored rule

`platform-nest/cerbos/policies/derived_roles.yaml` — `perm_hr_record_export` restored as a plain
`perms`-exists check (no assurance clause in the derived role itself, matching `perm_hr_case_export`
exactly):

```yaml
- name: perm_hr_record_export
  parentRoles: ["user"]
  condition:
    match:
      expr: >-
        request.principal.attr.perms.exists(g, g.key == "hr.record.export" && (
          g.scopeType == "global" ||
          (g.scopeType == "company" && g.scopeId == request.resource.attr.tenantId)))
```

`platform-nest/cerbos/policies/resource_hr_record.yaml` — the resource-policy rule, carrying the
high-assurance tier in its OWN condition (the same place the role arm's own `export` rule carries
it, and the same place `perm_hr_case_export` carries it):

```yaml
- actions: ["export"]
  effect: EFFECT_ALLOW
  derivedRoles: ["perm_hr_record_export"]
  condition:
    match:
      expr: >-
        variables.inTenant && request.principal.attr.assurance == "high"
```

**Not `notLow`** anywhere in this rule — REG2's exact mistake is not repeated. The comment blocks in
both files keep REG2's own account of the wrong-tier hole intact (quoted, not deleted) immediately
above the restored rule, so a future reader sees both what went wrong and why the fix now looks
different.

## 3. Holder-by-holder invariant check

`hr.record.export`'s bundle holders (`role-permission-bundles.json`): `platform_admin`,
`company_admin`, `hr_manager`. `platform_admin` is exempt by construction (IAM-04c: the wildcard
bypass is structure, definitionally a superset of any mirror) — the invariant's own
`findNarrowHolders()` skips it explicitly.

- **`company_admin`** — role-arm path: the `export` rule in `resource_hr_record.yaml`
  (`derivedRoles: ["module_manager", "company_admin"]`, condition `variables.inTenant &&
  request.principal.attr.assurance == "high"`). `company_admin` is itself a derived role with no
  attribute gate (global-or-company-scope check only, `derived_roles.yaml:26-33`), so it is
  classified un-gated. Its rule's condition clauses are now **identical** to the restored mirror's
  own clauses (`{"variables.inTenant", "request.principal.attr.assurance == \"high\""}`) — no extra
  clause, so `company_admin` is **covered, not narrow**. This is the change from REG2's own
  pre-removal baseline, which had `company_admin` flagged narrow (because the old mirror's condition
  was `notLow`, and `company_admin`'s real `assurance=="high"` clause was "extra" relative to that
  weaker mirror). Fixing the tier, not the module reasoning, is what drops `company_admin` out of
  the flagged set.
- **`hr_manager`** — the ONLY role-arm path to `export` on `hr_record` is via `module_manager`,
  which is gated on `has(request.resource.attr.module) && ...` with a COMPUTED role name
  (`request.resource.attr.module + "_manager"`) — the invariant's static classifier calls this
  `gated: true` (a top-level resource-attribute gate) and cannot statically confirm `hr_manager`'s
  reach. **This is flagged narrow** by the static tool — but it is the identical, already-documented
  false flag `hr_case.export` carries for the SAME role and SAME reason (REG2 §2.2, this ticket's own
  read of `resource_hr_case.yaml`): every real `authorize()` call site for `hr_record`/`hr_case`
  (22 call sites across `hr.controller.ts`/`loans.controller.ts`, confirmed by REG2's grep, not
  re-disputed here) hardcodes the literal `module: "hr"`, so `module_manager`'s attribute gate never
  actually excludes `hr_manager` in practice. The invariant's own docstring says exactly this
  category of finding is a known, structural limitation ("the static invariant test cannot see this
  — it only recognizes a textual precondition, never 'is this precondition satisfiable to false for
  this kind'") — not a live hole, and not something to silence by widening the mirror's condition.

**Verdict: no holder's role-arm path is narrower than `inTenant && high` in a way that constitutes a
real over-grant.** `hr_manager`'s flag is the accepted module-constant false positive this program
already carries for the sibling `hr_case.export` entry; nothing here is a module attribute gate that
actually varies, and nothing here is a self-scope or other genuine restriction. Per the ticket's own
STOP condition, this is reported rather than silently accepted: **if the module attribute on
`hr_case`/`hr_record` ever stops being a hardcoded constant, this specific finding needs
re-auditing** — it is a documented, not a proven-forever, disposition.

The invariant's non-regression pin (`iam-04-reg1-mirror-reach-invariant.test.ts`) now reads
`"hr_record.export": ["hr_manager"]` — one holder, shrunk from REG2's own pre-removal baseline of
`["company_admin", "hr_manager"]`, because the tier fix (not new module reasoning) removed
`company_admin` from the flagged set. 25/25 invariant tests pass with this pin in place.

## 4. Probes — verbatim, against a restarted `gaiada-test-cerbos`

Container restarted; `StartedAt` `2026-08-12T16:11:41.811820122Z`, confirmed to postdate every
policy edit in this ticket (host clock `2026-08-12T16:11:44Z` at inspection, immediately after).
Bind-mount confirmed (`docker inspect` → `/policies` bound to this exact checkout's
`platform-nest/cerbos/policies`). All five probes issued via raw `POST
http://localhost:3592/api/check/resources`, principal shape matching `principalPayload()`
(`src/rbac/cerbos.ts`): `roles: ["user"]`, empty `attr.grants` (no role grant at all — permission-arm
alone), one `attr.perms` entry for the relevant key at company scope. `T1 =
aaaaaaaa-0000-0000-0000-000000000001`, `T2 = aaaaaaaa-0000-0000-0000-000000000002`.

**(a) permission-only principal, `hr.record.export` @ company T1, `assurance: "high"`, resource in
T1 → expected ALLOW:**
```
{"requestId":"iam-04-reg3-probe","results":[{"resource":{"id":"x1","kind":"hr_record"},"actions":{"export":"EFFECT_ALLOW"}}],"cerbosCallId":"01KZVCB2B7V2YDQ3SQ06HMNAH5"}
```
**ALLOW — matches expectation.**

**(b) same principal, `assurance: "linked"` → expected DENY (the whole point of this ticket):**
```
{"requestId":"iam-04-reg3-probe","results":[{"resource":{"id":"x1","kind":"hr_record"},"actions":{"export":"EFFECT_DENY"}}],"cerbosCallId":"01KZVCB2HGRS5H6D4FET8AFE44"}
```
**DENY — matches expectation.** This is the exact case REG2's mirror wrongly ALLOWed and REG2's
removal correctly closed; the restored, correctly-tiered mirror keeps it closed by tier instead of
by deletion.

**(c) same principal, `assurance: "low"` → expected DENY:**
```
{"requestId":"iam-04-reg3-probe","results":[{"resource":{"id":"x1","kind":"hr_record"},"actions":{"export":"EFFECT_DENY"}}],"cerbosCallId":"01KZVCB2QNTDD4C1XZBMTRW0ER"}
```
**DENY — matches expectation.**

**(d) cross-tenant: principal authorized only for T1 (`companies: ["T1"]`), resource tenantId = T2,
`assurance: "high"` → expected DENY:**
```
{"requestId":"iam-04-reg3-probe","results":[{"resource":{"id":"x1","kind":"hr_record"},"actions":{"export":"EFFECT_DENY"}}],"cerbosCallId":"01KZVCB2YKDK3Q8VNFEVC0P30B"}
```
**DENY — matches expectation** (`variables.inTenant` is `resource.tenantId in principal.companies`;
T2 is not in `["T1"]`).

**(e) regression control — `hr_case.export` (the file this ticket copied the pattern from, NOT
touched) behaviour unchanged, both tiers:**
```
high:   {"requestId":"iam-04-reg3-probe","results":[{"resource":{"id":"x1","kind":"hr_case"},"actions":{"export":"EFFECT_ALLOW"}}],"cerbosCallId":"01KZVCB35FZXZKSKB7R813Y3AE"}
linked: {"requestId":"iam-04-reg3-probe","results":[{"resource":{"id":"x1","kind":"hr_case"},"actions":{"export":"EFFECT_DENY"}}],"cerbosCallId":"01KZVCB3BYPNGHWQSSKH8EE5SD"}
```
**Unchanged — matches expectation**, confirming this ticket's edits to `resource_hr_record.yaml`/
`derived_roles.yaml` did not perturb the sibling `hr_case` file (which was never edited; this is a
live-behaviour confirmation, not just a file-diff confirmation).

All five (plus the `hr_case.export` regression pair) match expectations exactly.

## 5. Test updates

- **`platform-nest/src/rbac/iam-04-reg1-mirror-reach-invariant.test.ts`** — restored
  `"hr_record.export": ["hr_manager"]` to `IAM_04_REG1_PRE_EXISTING_OUT_OF_SCOPE_BASELINE` (in its
  existing sorted position, immediately after `hr_record.delete`), and rewrote the header comment
  block above the baseline to record REG3's restoration alongside REG2's original removal reasoning
  (kept, not deleted) — explaining why the register now differs from REG2's own pre-removal
  baseline (`company_admin` drops out; `hr_manager`'s flag is the pre-existing module-constant false
  positive, unchanged in kind from `hr_case.export`'s own entry). Re-ran unscoped: **25/25 passed**.
- **`platform-nest/src/rbac/cerbos-permission-dual-match.test.ts`** — added two new tests
  immediately after the existing `hr_record.read` test (there was no pre-existing `hr_record.export`
  assertion in this file to invert — REG2's own diff shows only `member.read` and
  `service_assignment.read` were inverted; `hr_record.export`'s mirror was deleted outright, taking
  any test of it with it). The two new tests assert **both tiers** explicitly, per the ticket's
  instruction: a `roles: []`, `assurance: "high"` permission-only holder of `hr.record.export`
  ALLOWED; the identical holder at `assurance: "linked"` DENIED. Both verified running live (not
  skipped) against the restarted test Cerbos.

## 6. Gates — real output, this session

| Gate | Result |
|---|---|
| `iam-04-reg1-mirror-reach-invariant.test.ts` (unscoped) | **25/25 passed** |
| `cerbos-permission-dual-match.test.ts` (live, `CERBOS_URL` set) | included in the 230/230 run below; both new `hr_record.export` tests confirmed running (not skipped) |
| `permission-arm-hazard-scan.test.ts` | included in the 230/230 run below |
| combined run of the three files above | **3 files, 230/230 passed** |
| full `src/rbac/` (24 files, live Cerbos) | **574/574 passed** (baseline: REG2 reported 572/572 before this ticket's 2 new tests; 572+2=574, exact) |
| full `src/admin/` (18 files, incl. `org14-preflight-adversarial`) | **196/196 passed** — unchanged from REG2's own 196/196, as expected (this ticket touches no admin-surface file) |
| `src/admin/org14-preflight-adversarial.test.ts` (explicit) | **8/8 passed** |
| full `src/modules/hr/` (4 files) | **68/68 passed** — unchanged from REG2's own 68/68 |
| `role-permission-parity.db.test.ts` | covered by the full `src/rbac/` run above (574/574) |
| `cerbos compile cerbos/policies` (pinned image `ghcr.io/cerbos/cerbos:0.54.0`) | exit 0, clean |
| `npm run typecheck` | 0 errors |
| `node scripts/generate-role-bundles.mjs --check` | **byte-identical before and after** — `perm_hr_record_export` is a `perm_`-prefixed derived role; the generator skips those the same way REG1/REG2 documented. Confirmed: 22 roles / 1023 pairs, unchanged. |

No full `npm test` was run, per the ticket's constraint (shared test-Cerbos container) — only the
suites named above, plus the invariant test itself, plus the live Cerbos probes in §4.

**Baseline for "unchanged" claims:** compared against `fd6a1eb` (IAM-04-REG2's own commit, the HEAD
of this checkout at session start, confirmed via `git log --oneline -5`) — the same counts REG2's own
report recorded for `src/admin/` and `src/modules/hr/` (196/196, 68/68), neither of which this
ticket's files touch.

## 7. Context that does not change the tier decision (per the ticket's own instruction)

No user on the live estate currently has MFA configured — 17 password credentials, zero OTP; the OTP
flows are Keycloak *Conditional* subflows that never fire (this program's own standing note,
carried forward unchanged, not re-verified this session). So `assurance == "high"` is presently
**unreachable in production**, and this restored mirror grants nobody anything on `gda-aicenter`
until MFA is enabled somewhere in the estate. This is expected and is the owner's call to make when
it matters — **not** a reason to weaken the condition, and this ticket did not weaken it.

## 8. Whether anything about the tier itself should go to the owner

**No new tier concern from this ticket.** The tier (`assurance == "high"`, the D4 high-assurance
gate) is unchanged from what the role arm has always required for `hr_record.export` and what
`resource_hr_case.yaml`'s `perm_hr_case_export` has always required for its sibling action — this
ticket only restores a permission-arm path that respects that pre-existing tier, it does not set,
raise, or lower it anywhere. The one open item is the same one REG2 already surfaced and this ticket
did not attempt to resolve: whether `hansel@gaiada.com`'s live Keycloak session(s) currently assemble
at `"high"` or `"linked"` was not re-checked here (out of this ticket's remit; REG2's own §5.3
already flagged it for direct owner verification via the Keycloak admin console). §7's broader point
— MFA is not configured for ANYONE on the live estate today — is the more actionable fact for the
owner: until that changes, this restored mirror (and the role arm's own identical tier) is inert in
production regardless of which principal holds `company_admin`/`hr_manager`.

## 9. Files touched

- `platform-nest/cerbos/policies/derived_roles.yaml` — restored `perm_hr_record_export` (plain
  perms-exists check, no assurance clause), with a comment recording both REG2's removal reasoning
  and REG3's restoration reasoning.
- `platform-nest/cerbos/policies/resource_hr_record.yaml` — restored the `export` /
  `perm_hr_record_export` resource-policy rule at `variables.inTenant &&
  request.principal.attr.assurance == "high"` (not `notLow`), with the same dual-history comment.
- `platform-nest/src/rbac/iam-04-reg1-mirror-reach-invariant.test.ts` — restored
  `"hr_record.export": ["hr_manager"]` to the non-regression baseline pin; rewrote the header
  comment block to record both REG2's and REG3's history.
- `platform-nest/src/rbac/cerbos-permission-dual-match.test.ts` — added two new tests asserting both
  assurance tiers for `hr_record.export` via the permission arm alone.
- `docs/superpowers/plans/2026-08-10-iam-04-rollout-scan.md` — appended §9, the REG3 addendum to the
  rollout register.
- `docs/superpowers/plans/2026-08-13-iam-04-reg3-report.md` — this file.

**Not touched** (per the ticket's constraints): `resource_hr_case.yaml` (read-only precedent,
verified unchanged by live probe in §4(e)), `admin-identity.controller.ts`, any migration,
`principal.ts`, `cerbos.ts`, `platform-ui/`, `_variables.yaml`, `role-permission-bundles.json`
(verified byte-identical, no regen needed), and every file left dirty by the concurrent session
(`VERSION`, `docs/blueprints/smm-*`, `docs/modules/*`, `docs/plans/2026-08-12-full-bug-audit.md`).

**No commit, no push** — tree left dirty for review, per the ticket's explicit instruction.
