# IAM-SEC-06 — REPORT: the resolution-source filter (IAM-04c ruling §8 option A)

**Status: DEV-VERIFIED** (fix + new tests driven against the real test Postgres and test Cerbos;
Cerbos restarted before probing per the program's own "does not hot-reload" trap; before/after perf
measured on the real `assemblePrincipal()`, not simulated). Every gate named in the ticket is green;
one file (`iam-04-reg1-mirror-reach-invariant.test.ts`) was observed red mid-task from a concurrent
session's uncommitted work, unrelated to this ticket, and observed green again once that session's
own fix landed — see §7.

## 1. Where the filter sits, and why that layer

`assemblePrincipal()` (`platform-nest/src/rbac/principal.ts`) is the resolution boundary: it is the
one function that turns a `user_roles` grant row into the `perms` array Cerbos's `perm_*` derived
roles read (via `cerbos.ts::principalPayload()`). `IAM-SEC-05` closed the two *write* paths that
could mint a mis-scoped grant (`assignRole`, `inviteUser`, both gated by
`admin-identity.controller.ts`'s `ROLE_SCOPE_CONSTRAINTS`). The architect's ruling
(`docs/superpowers/plans/2026-08-12-iam-04c-ruling.md` §8, option A) held that a write-path guard is
the wrong *authority* for this: `CLAUDE.md` fixes Cerbos as the authorization authority and every
controller as a mirror; seeds and migrations write `user_roles` directly by design (bypassing any
controller-level check by construction, not by oversight); and IAM-SEC-05 itself proved a guard is
only as good as its completeness — one writer went unguarded for a full ticket cycle. Filtering at
`assemblePrincipal()` closes the hazard **regardless of how the underlying grant row came to exist** —
a mis-scoped row from a future fourth writer, a hand-run SQL fix, or a seed script bug all resolve
zero poisoned permissions the same way a guarded `inviteUser` call does. This is the fix Cerbos
itself cannot express (it only ever sees what `assemblePrincipal` sends it), and the one layer
`CLAUDE.md` already designates as authoritative.

## 2. The role→scope source: derived, not hand-maintained

**Derived**, not machine-checked-against-a-hand-list. `platform-nest/scripts/generate-scope-constrained-roles.mjs`
parses `cerbos/policies/derived_roles.yaml` with `js-yaml` (the same library
`generate-role-bundles.mjs`/`permission-arm-hazard-scan.test.ts` already use) and, for every literal
`g.role == "<name>"` occurrence, collects every literal `g.scopeType == "<value>"` that appears
anywhere in that same derived-role condition — correct regardless of whether the condition is a
single AND-chain (one scope value, e.g. `platform_admin`/`org_unit_lead`) or a disjunction of several
`(scopeType == "X" && ...)` branches (each branch's literal is an independently-sufficient
alternative, so the union of all literals found is exactly the full reachable set). Output is
checked in at `platform-nest/src/rbac/scope-constrained-roles.json`:

```json
"client": ["company"],
"company_admin": ["company", "global"],
"group_executive": ["global"],
"hr_manager": ["company", "global"],
"hr_staff": ["company", "global"],
"it": ["company", "global"],
"it_admin": ["company", "global"],
"it_manager": ["company", "global"],
"manager": ["company", "global", "project"],
"member": ["company", "global", "project"],
"org_unit_lead": ["org_unit"],
"platform_admin": ["global"],
"viewer": ["company", "global"]
```

`platform-nest/src/rbac/scope-constrained-roles.ts` (production code) imports this JSON directly
(`resolveJsonModule`, the same pattern `authz-permissions.controller.ts` already uses for
`permission-catalog.json`) and exposes `isGrantScopeReachable(role, scopeType): boolean` — no YAML
parsing, no filesystem read, at request time; the whole map is a handful of `Set` lookups baked into
the module at import time.

This is a **separate artifact** from `admin-identity.controller.ts`'s `ROLE_SCOPE_CONSTRAINTS` (which
serves the write-path guard, a different layer), not a duplicate of it — I did not touch that
controller. Both are independently re-derived from the *same* `derived_roles.yaml` (one via this
new script, one via `permission-arm-hazard-scan.test.ts`'s own parser), so neither can silently drift
from the policy even though they are not literally the same object. Unifying them into one shared
module was a real option I considered and rejected for this ticket: `permission-arm-hazard-scan.test.ts`
currently regex-parses `ROLE_SCOPE_CONSTRAINTS` as an inline object literal straight out of the
controller's source text (`loadRoleScopeConstraintsFromController`), and replacing that literal with
an import would require rewriting that parser too — out of this ticket's owned-files list and a
needless coupling between two independently-reviewable diffs in a shared, concurrently-edited
checkout.

**Drift cannot happen silently**: `platform-nest/src/rbac/scope-constrained-roles.test.ts`'s first
test re-runs the generator and asserts the output is byte-identical to the checked-in JSON. Edit
`derived_roles.yaml` without running `npm run gen:scope-constrained-roles` and this test goes red.

## 3. Fail-open, deliberately — and why that's the safe direction

**Fail-open for any role absent from the map.** `isGrantScopeReachable()` returns `true`
unconditionally when `role` has no entry — most roles (`company_admin`, `manager`, `member`,
`viewer`, every `module_staff`/`module_manager`/`module_approver`-composed name like
`webdev_staff`/`hr_staff`-via-that-path/`agency_approver`) have either no scope narrowing at all, or
a shape this map already captures exactly (they're present with `{global, company[, project]}}`).
Getting this backwards — failing *closed* for an unlisted role — would drop every permission for
every role that never appears as a literal `g.role == "..."` string in `derived_roles.yaml`, which is
most of the estate (any module-composed role name is never a literal). The ticket's own acceptance
list flags this explicitly, and I pinned it as its own dedicated test
(`scope-constrained-roles.test.ts`'s "FAIL-OPEN direction" test, plus a live DB proof in
`principal-scope-constrained-perms.db.test.ts`'s "FAIL-OPEN PIN" test using `agency_approver`, a real
seeded role reached only through `module_approver`'s dynamic composition — confirmed absent from the
generated map, confirmed unaffected at every scope tried).

The filter only activates for a role **present** in the map, and only rejects the specific
`scopeType` values *not* listed for it — `company_admin@org_unit` would be filtered (correctly: its
own Cerbos condition has no `org_unit` branch either) while `company_admin@company` and
`company_admin@global` are untouched.

## 4. The change in `principal.ts`

The perms query gained one JOIN (to `roles`, for the grant's role name) and one selected column
(`roleName`) — still **one query**, not a query per grant. `SELECT DISTINCT` on the SQL side no
longer fully de-duplicates (adding `roleName` means two *different* roles reaching the identical
`(key, scopeType, scopeId)` triple now arrive as two rows, not one), so de-duplication moved into the
same JS loop that applies the filter:

```ts
const filtered = new Map<string, PermissionGrant>();
for (const row of permsRes.rows) {
  if (!isGrantScopeReachable(row.roleName, row.scopeType)) continue; // IAM-SEC-06
  const dedupeKey = `${row.key} ${row.scopeType} ${row.scopeId ?? ""}`;
  if (!filtered.has(dedupeKey)) {
    filtered.set(dedupeKey, { key: row.key, scopeType: row.scopeType, scopeId: row.scopeId });
  }
}
```

A `(key, scope)` pair is dropped only if **every** grant that would have produced it was mis-scoped;
it survives if any *other*, validly-scoped grant also reaches it — proven by
`principal-scope-constrained-perms.db.test.ts`'s "mixed" test (a user with both a mis-scoped
`platform_admin@company` grant and a legitimate `manager@company` grant resolves exactly `manager`'s
bundle, not zero and not `platform_admin`'s). The underlying **grant row is untouched** — `roles`
still reports it; only the derived `perms` entries are withheld.

## 5. Acceptance criteria — all verified against the real test DB

`platform-nest/src/rbac/principal-scope-constrained-perms.db.test.ts` (new file), against
`gaiada-test-pg` (55433):

| Criterion | Result |
|---|---|
| Synthetic `platform_admin@company` grant | `perms = []` (grant itself still visible in `roles`) |
| Synthetic `org_unit_lead@company` grant | `perms = []` |
| **Over-refusal control**: legitimate `org_unit_lead@org_unit` grant | resolves normally — `["reports.appraisal.read", "reports.document.read_department"]`, exactly its checked-in bundle (2 keys), scoped to the granted `org_unit` id |
| Legitimate `client@company` | unaffected — resolves its full 7-key bundle at `company`/that tenant |
| Legitimate `company_admin@company` | unaffected — 228-key bundle |
| Legitimate `manager@company` | unaffected — 136-key bundle |
| Generalization beyond the two named roles | a synthetic `group_executive@company` grant **also** resolves `perms = []` (ruling §6: the global-only direction shares the identical hole) |
| Fail-open pin | `agency_approver@company` (unconstrained — reached only via `module_approver`'s dynamic composition, absent from the map) resolves its 1-key bundle completely normally |
| Mixed grants | mis-scoped `platform_admin@company` + legitimate `manager@company` on the same user → resolves exactly `manager`'s bundle, proving the filter drops only the poisoned contribution |

All 11 tests in that file pass; `scope-constrained-roles.test.ts`'s 8 static tests (drift guard +
fail-open/closed pins) pass; `principal-permissions.db.test.ts`'s 20 pre-existing tests (every
legitimately-scoped persona: `platform_admin@global`, `group_executive@global`,
`company_admin/manager/member/viewer/agency_approver/it_admin@companyA`, cross-scope dedup, etc.)
are **unmodified and still pass** — proving this change is invisible to every already-correct path.

## 6. Cerbos probe — verbatim

Restarted `gaiada-test-cerbos` first (policy does not hot-reload):

```
$ docker restart gaiada-test-cerbos
gaiada-test-cerbos
$ curl -s http://localhost:3592/_cerbos/health
{"status":"SERVING"}
```

**(a) Isolated payload probe** — `kind: "user"`, action `"read"` (`resource_user.yaml` wires BOTH a
role-arm rule, `company_admin`/`manager` only — `platform_admin` has only the wildcard `"*"` rule,
gated by its own global-scope-only condition — AND a perm-arm mirror `perm_user_read`, checking
`attr.perms` for `core.user.read` at global-or-company scope). Same grant
(`platform_admin@company:<tenant>`) in both requests; only `attr.perms` differs — BEFORE reproduces
exactly the shape the OLD (unfiltered) `assemblePrincipal()` used to emit; AFTER is the shape the
NEW, fixed one emits (empty):

```
--- BEFORE (simulated pre-fix assemblePrincipal): perms carries platform_admin's full bundle at the MIS-SCOPED company scope ---
request.principal.attr.perms = [
  { "key": "core.user.read", "scopeType": "company", "scopeId": "22222222-2222-2222-2222-222222222222" },
  { "key": "core.user.create", "scopeType": "company", "scopeId": "22222222-2222-2222-2222-222222222222" }
]
Cerbos response: { "results": [ { "actions": { "read": "EFFECT_ALLOW" } } ] }

--- AFTER (real, current assemblePrincipal(): IAM-SEC-06 filter drops perms for this mis-scoped grant) ---
request.principal.attr.perms = []
Cerbos response: { "results": [ { "actions": { "read": "EFFECT_DENY" } } ] }

SUMMARY: BEFORE=EFFECT_ALLOW  AFTER=EFFECT_DENY
PROVEN: the platform_admin@company principal WOULD have been ALLOWED (pre-fix perms shape) and IS NOW DENIED (post-fix perms shape) on the identical grant, kind, and action.
```

**(b) Full pipe, real code, real DB row** — `principal-scope-constrained-perms.db.test.ts`'s live
Cerbos describe block: a real `user_roles` row (`platform_admin` @ `company`) → the real
`assemblePrincipal()` → the real `principalPayload()`/`check()` → the real running Cerbos:

```
✓ the REAL assemblePrincipal() resolves zero perms for this grant (repeats the acceptance criterion, DB-verified)
✓ Cerbos DENIES 'read' on kind=user for this principal (perm-arm cannot fire: perms is empty; role-arm cannot fire: platform_admin's condition requires global scope, not company)
```

## 7. Perf — measured, before and after, on the real `assemblePrincipal()`

`principal-perf.db.test.ts`'s own `PERMS_SQL` literal is a fixed, unconnected "before" baseline for a
*different* comparison (roles-only vs. the original IAM-03a query) and is deliberately not wired to
`principal.ts`'s own query — so it can't measure *this* ticket's marginal cost by itself. To get a
genuine before/after for this specific change, I ran the full file twice against `principal.ts` at
two points: once with `principal.ts` reverted to `git show HEAD:platform-nest/src/rbac/principal.ts`
(pre-fix), once with my actual change restored (post-fix) — same seeded DB (18 member / 11 manager /
9 company_admin / 9 client / 1 each platform_admin/group_executive/it_admin/agency_approver, ~925
`role_permissions` rows), same machine, back to back:

**BEFORE** (`git show HEAD` version — no `roleName` JOIN, SQL-level `DISTINCT`, no JS filter/dedup):
```
member (74 perms) assemblePrincipal() end-to-end: mean=10.815ms p50=10.432ms p95=15.006ms max=24.677ms
company_admin (199 perms) assemblePrincipal() end-to-end: mean=10.125ms p50=9.896ms p95=13.643ms max=23.433ms
platform_admin (215 perms) assemblePrincipal() end-to-end: mean=10.675ms p50=10.355ms p95=15.218ms max=25.741ms
```

**AFTER** (this ticket's fix — extra JOIN + roleName column + JS filter/dedup loop):
```
member (74 perms) assemblePrincipal() end-to-end: mean=11.348ms p50=10.398ms p95=17.755ms max=32.210ms
company_admin (199 perms) assemblePrincipal() end-to-end: mean=10.916ms p50=10.292ms p95=16.035ms max=61.412ms
platform_admin (215 perms) assemblePrincipal() end-to-end: mean=12.391ms p50=11.201ms p95=20.881ms max=61.412ms
```

Marginal difference is +0.5 to +1.7ms mean (within normal run-to-run variance on this dev box — a
third, later re-run of the AFTER file alone measured *lower* absolute numbers than either of the
above, e.g. platform_admin mean=7.7ms), nowhere near the file's own `p95 < 50ms` gate (worst observed
p95 was 20.9ms). **Zero additional queries** — the added cost is one more JOIN clause in the existing
single query plus an O(n) in-process loop over at most ~250 rows. Both the file's own regression gate
(`p95 < 50ms` per persona) and the marginal-query-cost gate (`p95 < 25ms`) pass in both runs.

## 8. Gate results

Ran against `gaiada-test-pg` (55433) + `gaiada-test-cerbos` (3592/3593, restarted before probing),
targeted only per the ticket's instruction:

- `npm run typecheck` → **0 errors**.
- `MSYS_NO_PATHCONV=1 docker exec gaiada-test-cerbos /cerbos compile /policies` → exit 0, `0 tests
  executed` (no policy test files in this repo; compile itself is clean).
- `npx vitest run src/rbac/principal-permissions.db.test.ts src/rbac/principal-org-unit-scope.db.test.ts
  src/rbac/principal-perf.db.test.ts src/rbac/iam-04-reg1-mirror-reach-invariant.test.ts
  src/rbac/permission-arm-hazard-scan.test.ts src/rbac/role-permission-parity.db.test.ts
  src/rbac/scope-constrained-roles.test.ts src/rbac/principal-scope-constrained-perms.db.test.ts` →
  **8 files, 226/226 passed**.
- `npx vitest run src/rbac` (full directory) → **27 files, 605/605 passed**.
- `npx vitest run src/admin` (full directory, includes `org14-preflight-adversarial.test.ts`) →
  **18 files, 196/196 passed**.

**Mid-task transient, named precisely per the ticket's instruction not to dismiss without naming a
baseline**: `iam-04-reg1-mirror-reach-invariant.test.ts`'s own non-regression pin failed once,
between my first and second full `src/rbac` run — `expected {…62} to deeply equal {…52}`, a 10-entry
growth exactly matching `social_engagement.*`/`social_post.*` mirror entries. `git diff --stat HEAD --
cerbos/policies/` at that moment showed 144 uncommitted lines added to `derived_roles.yaml` plus 8
`resource_social_*.yaml`/`resource_portal.yaml` files — **not part of my diff**; I never staged,
edited, or touched any Cerbos policy file (per the ticket's own constraint). That test's only imports
are `vitest`/`node:fs`/`node:path`/`js-yaml` — it reads zero files I created or modified. This was a
concurrent session (this checkout is shared, per `CLAUDE.md`) actively landing the SMM/social module's
own IAM registration mid-task; by my next run its own baseline update had landed and the file passed
25/25 (both counts confirmed via direct re-run, §8 above reflects the settled state). Baseline commit
for this comparison: `21b21f2` ("feat(social): the SMM module's IAM registration…").

## 9. Files touched

- `platform-nest/src/rbac/principal.ts` — the fix: one JOIN + one column added to the existing perms
  query; filtering + de-duplication moved into a JS loop; comment rewritten to explain both.
- `platform-nest/src/rbac/scope-constrained-roles.ts` — new; the production consumer
  (`isGrantScopeReachable`).
- `platform-nest/src/rbac/scope-constrained-roles.json` — new; the checked-in, machine-generated
  artifact.
- `platform-nest/scripts/generate-scope-constrained-roles.mjs` — new; the derivation script
  (`derive()`/`generate()`/`serialize()`, `--check`/`--stdout` CLI, mirrors
  `generate-role-bundles.mjs`'s conventions).
- `platform-nest/scripts/generate-scope-constrained-roles.d.mts` — new; hand-written type
  declaration for the `.mjs` script (mirrors `generate-role-bundles.d.mts`'s existing convention —
  without it, `tsc --noEmit` fails with TS7016 on the test file's import).
- `platform-nest/src/rbac/scope-constrained-roles.test.ts` — new; static drift-guard + fail-open/
  closed pins (8 tests).
- `platform-nest/src/rbac/principal-scope-constrained-perms.db.test.ts` — new; every acceptance
  criterion against the real test DB, plus the live-Cerbos end-to-end proof (11 tests).
- `platform-nest/package.json` — added `gen:scope-constrained-roles` npm script.
- `docs/superpowers/plans/2026-08-13-iam-sec-06-report.md` — this report.

Not touched: Cerbos policies, migrations, `cerbos.ts`, `platform-ui/`, `admin-identity.controller.ts`
(its `ROLE_SCOPE_CONSTRAINTS` is a separate, already-machine-checked artifact serving a different
layer — see §2). Tree left dirty; not committed, not pushed.

## 10. Blockers / follow-ups

- None blocking this ticket's own scope.
- The IAM-04c ruling's `appraisal`/`report_document` question stays **OPEN per owner decision**
  (option C, permanently unwired) — I did not wire a `perm_*` arm on either kind, and
  `permission-arm-hazard-scan.test.ts:722`'s reachability assertion is untouched (confirmed still
  passing).
- Optional future consolidation (not requested, not done here): `admin-identity.controller.ts`'s
  `ROLE_SCOPE_CONSTRAINTS` could be regenerated from the same `scope-constrained-roles.json`
  artifact instead of being independently hand-written, collapsing two machine-checked-but-separate
  sources into one. Left alone this round to avoid touching a file outside this ticket's ownership
  in a checkout another session was concurrently editing.
