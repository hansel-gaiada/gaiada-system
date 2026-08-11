# IAM-DR5 — grant `company_admin` appraisal READ in Cerbos

**Status: DEV-VERIFIED.** This is a real authorization WIDENING (owner-decided, DR-5,
2026-08-10) — unlike every other ticket in this program, it is not decision-neutral. Treated
accordingly: narrowest possible grant, reconciler-reach question answered explicitly (below,
loudly), and every downstream chain link re-verified against a freshly-restarted, live-probed
Cerbos before any test was trusted.

## 1. The exact rule added

`platform-nest/cerbos/policies/resource_appraisal.yaml` — one new rule, inserted between the
`hr_people_ops` block and the `group_executive` (exec) block:

```yaml
    - actions: ["read"]
      effect: EFFECT_ALLOW
      derivedRoles: ["company_admin"]
      condition: { match: { expr: "variables.inTenant && variables.notLow" } }
```

Preceded by a ~15-line comment block citing DR-5, the drift-register finding #6 / IAM-05b-3
report, and stating explicitly what stays denied and why the reconciler cannot reach a served
company through it (reproduced in the file; see §3 below for the underlying reasoning).

Before this change, Cerbos had **no rule at all** naming `company_admin` on the `appraisal`
kind — confirmed by reading the full file (the only rules present were `platform_admin`
wildcard, `hr_people_ops`, `group_executive`, `manager`/`team_lead`, and the two `member`-self
rules). `rbac.ts`'s `company_admin → appraisal.read` capability was therefore a dead button for
all 9 live holders.

## 2. Confirmation that only `read` widened

- The new rule's `actions:` list is `["read"]` — a single string, no others.
- No other rule in the file was touched (diff is a pure insertion: `git diff --stat` shows
  `resource_appraisal.yaml | 27 ++++++++++++++++++++++`, 27 insertions, 0 deletions — the
  pre-existing `hr_people_ops`/`group_executive`/`manager,team_lead`/self-read/self-ack rules are
  byte-identical).
- Live-probed against a freshly restarted `gaiada-test-cerbos` (see §5) with `company_admin`
  scoped to its own company: `read` → `EFFECT_ALLOW`; `write`, `submit`, `finalize`,
  `cycle_admin`, `confirm_evidence`, `ack` → all `EFFECT_DENY`. Verbatim result:
  ```
  "own-company": { "read": "EFFECT_ALLOW", "write": "EFFECT_DENY", "submit": "EFFECT_DENY",
                    "finalize": "EFFECT_DENY", "cycle_admin": "EFFECT_DENY",
                    "confirm_evidence": "EFFECT_DENY", "ack": "EFFECT_DENY" }
  "other-company": { "read": "EFFECT_DENY" }
  ```
- The migration's closing assertion (`0099`) independently enforces the same narrowness at the
  DB-mirror layer: it asserts `company_admin`'s `reports.appraisal.*` count is **exactly 1** and
  that the one key is `reports.appraisal.read` — a hand re-run of this migration adding
  `reports.appraisal.write` (or any other appraisal verb) to `company_admin` would fail its own
  assertion, not just look wrong on inspection.
- `role-permission-bundles.json`, regenerated from the live policy files (not hand-edited),
  shows `company_admin`'s bundle gained exactly one key: `reports.appraisal.read`. No other
  `reports.appraisal.*` key, and no other role's bundle changed at all (diffed the full
  regeneration output against the pre-change run: only `company_admin`'s array and the `_meta`
  counts changed).

## 3. Finding on reconciler / served-company reach — READ THIS FIRST

**A `company_admin` grant can NEVER be reconciler-materialized onto a served company.** Verified
by reading `platform-nest/src/admin/service-reconciler.ts` end to end, not assumed:

- The only grant the reconciler ever writes is produced by `moduleRoleId(c, row.module_key, kind)`
  (line 89), which looks up a role row named **literally** `${moduleKey}_staff` or
  `${moduleKey}_manager` (line 92: `` `${moduleKey}_${kind}` ``) — `kind` is the TypeScript union
  `"staff" | "manager"` (line 89's signature), nothing else is a legal value.
- The desired-grants map (`desired`, line 127) is populated at line 197 with exactly two possible
  role kinds: `u === row.lead_user_id ? "manager" : "staff"` (A12: "manager to the lead, staff to
  the rest"). There is no third branch, no fallback, no code path anywhere in this file that ever
  passes `"company_admin"` (or any string other than `"staff"`/`"manager"`) into `moduleRoleId`.
- Therefore the reconciler can only ever grant `<module>_staff` or `<module>_manager` roles
  (`hr_staff`, `search_manager`, `webdev_staff`, etc.) at the served company's scope — it has no
  mechanism to grant `company_admin` anywhere, served or otherwise.
- The only way a principal ever holds `company_admin` scoped to a company is a **direct** admin
  grant made at that company (via the admin identity/role-assignment path) — which, by
  definition, is what makes that company the admin's own company, not a served-company side
  effect. `derived_roles.yaml`'s `company_admin` derived role matches
  `g.scopeType == "global" || (g.scopeType == "company" && g.scopeId == resource.tenantId)` —
  this rule adds no new scope semantics of its own; it rides that same, pre-existing cascade.

**So the new grant's reach is exactly what DR-5 approved: a company's own administrator, in
their own company (or a global `company_admin` grant, which by design covers every company —
the same scope shape every other `company_admin` rule in this file already uses; asserted
directly, see the fourth test in §6). No service-assignment path widens it further.** This was
checked, not assumed, per the ticket's explicit instruction, and is reported here regardless of
the answer — the answer happens to be "it does not reach," which is why this ships as scoped.

## 4. Files touched

- `platform-nest/cerbos/policies/resource_appraisal.yaml` — the one new rule (§1).
- `platform-nest/migrations/0099_iam_dr5_company_admin_appraisal_read.sql` — new migration,
  idempotent, joins on `permissions.key` per the 0094/0098 idiom, closing `DO $$ ... $$` assertion
  block checks: `company_admin`'s total bundle is exactly 200, its `reports.appraisal.*` count is
  exactly 1, that key is `reports.appraisal.read` specifically, and (defense-in-depth,
  Ruling 3) it never leaked in as `class='relationship'`.
- `platform-nest/src/rbac/role-permission-bundles.json` — regenerated via
  `npm run gen:role-bundles` (not hand-edited). `company_admin` 199 → 200; total 935 → 936;
  `_meta.counts` updated in the same run.
- `platform-nest/src/rbac/iam-dr5-company-admin-appraisal-read.test.ts` — new test file (§6).
- This report.

No other file was edited. `platform-ui/` was not touched at all, per the constraint — the
concurrent agent's `ROLE_CAPS.company_admin` (which already contains `appraisal.read`) now
agrees with Cerbos without any UI-side change.

## 5. Cerbos staleness — handled, not assumed

- `docker inspect gaiada-test-cerbos --format '{{.State.StartedAt}}'` showed the container had
  started **before** this session's edit (2026-08-10T07:09:53Z, vs. the edit made ~47 minutes
  later) — exactly the stale-serving risk the ticket warned about.
- `docker restart gaiada-test-cerbos`; waited for `docker inspect --format
  '{{.State.Health.Status}}'` to report `healthy`.
- Probed `POST http://localhost:3592/api/check/resources` directly (not through a test runner)
  with a `company_admin` principal scoped to `companyA`, against an `appraisal` resource at
  `tenantId=companyA` and a second at `tenantId=companyB`, requesting all seven appraisal
  actions. Result reproduced verbatim in §2 — `read` on the own company is the only `ALLOW` in
  either resource. This is the "believe the live decision API, not the diff" check the ticket
  required before trusting anything downstream.
- `docker exec gaiada-test-cerbos /cerbos compile /policies` — clean (no errors; `0 tests
  executed`, since this repo keeps no `.txt`/YAML Cerbos test-suite files, only the TypeScript
  suites that hit the running server).

## 6. New test — `src/rbac/iam-dr5-company-admin-appraisal-read.test.ts`

Two `describe` blocks:

1. **Live-Cerbos block** (`describe.skipIf(!live)`, same skip idiom as every other
   `*-cerbos.test.ts`/`cerbos-permission-dual-match.test.ts` in this codebase):
   - `company_admin` CAN `read` an appraisal in its own company.
   - `company_admin` still CANNOT `write`/`submit`/`finalize`/`cycle_admin`/`confirm_evidence`/
     `ack` — the entire reason this grant is safe to ship.
   - A `company_admin` grant scoped to T1, evaluated against a T2-tenant appraisal (with T2 also
     in the principal's authorized company set, isolating "does the grant itself cascade" from
     "is the resource's tenant even reachable" — mirrors `reports-cerbos.test.ts`'s
     `wrongCompanyLead` shape) — denied on every action, including `read`.
   - A GLOBAL-scope `company_admin` grant (the D-1/D-8 platform-managed shape) reaches `read` on
     any company's appraisals, consistent with every other `company_admin` rule in this file
     already using that same global-or-company cascade — and is still denied `write`.
2. **Bundle-artifact block** (no live Cerbos or DB needed, runs unconditionally): asserts
   `role-permission-bundles.json`'s `company_admin` array contains `reports.appraisal.read`,
   contains **no other** `reports.appraisal.*` key, and totals exactly 200 permissions — the
   same three invariants the migration's own `DO $$` block enforces at the DB layer, pinned here
   against the regenerated JSON artifact so a careless future regen can't silently widen it.

## 7. Verification results (actual output, real runs)

All against the freshly-restarted, live-probed `gaiada-test-cerbos` (§5) and a fresh
per-test-file disposable Postgres database (`src/testing/setup.ts`'s `initTestDb()`, which runs
every migration including the new `0099` before each `.db.test.ts` file's suite).

```
npx vitest run src/rbac/role-permission-parity.db.test.ts src/rbac/role-permission-bundles.db.test.ts \
  src/rbac/role-bundle-completeness.db.test.ts src/rbac/iam-215-boundary-pin.test.ts \
  src/rbac/cerbos-permission-dual-match.test.ts src/rbac/iam-dr5-company-admin-appraisal-read.test.ts \
  src/modules/reports/reports-cerbos.test.ts

 ✓ src/modules/reports/reports-cerbos.test.ts (42 tests) 3351ms
 ✓ src/rbac/role-permission-parity.db.test.ts (24 tests) 2469ms
 ✓ src/rbac/cerbos-permission-dual-match.test.ts (16 tests) 675ms
 ✓ src/rbac/role-permission-bundles.db.test.ts (7 tests) 2471ms
 ✓ src/rbac/iam-215-boundary-pin.test.ts (66 tests) 11ms
 ✓ src/rbac/role-bundle-completeness.db.test.ts (3 tests) 2116ms
 ✓ src/rbac/iam-dr5-company-admin-appraisal-read.test.ts (7 tests) 230ms

 Test Files  7 passed (7)
      Tests  165 passed (165)
```

`src/modules/reports` (the full directory, including `reports-cerbos.test.ts`'s existing
`"company_admin does NOT get score write/submit either"` case, which this change does not
touch — it only ever asserted write/submit denial, never read, so it remains correct
unmodified):

```
npx vitest run src/modules/reports
 Test Files  28 passed (28)
      Tests  562 passed (562)
```

`npm run gen:role-bundles` output:
```
[generate-role-bundles] wrote .../role-permission-bundles.json — 20 roles, 936 total (role, permission) pairs.
```
`company_admin`: 199 → 200. Total: 935 → 936. No other role's count changed.

**Honest gaps:**
- `npm run build` (full `tsc -p tsconfig.json`) currently fails on pre-existing type errors in
  `principal-permissions.db.test.ts` and two other files this ticket does not own — these belong
  to concurrent in-flight work per `docs/superpowers/plans/2026-08-10-iam-phase1-tickets.md`'s
  Wave 5 notes, confirmed unrelated by `git status` showing them already modified before this
  session started. `npm run migrate` was therefore not run via the compiled `dist/`; instead,
  migration `0099` was exercised (and passed its own closing assertions) through every
  `.db.test.ts` file's own `initTestDb()`, which imports and runs `migrate()` from source via
  vitest/SWC on a disposable database — the same path every other `.db.test.ts` file in this
  suite already depends on. Not run: an actual `node dist/main.js` boot against `0099` (this
  matches this program's own already-documented "honest verification gap" pattern for prior
  migrations in this family).
- The full non-reports, non-rbac test suite (the other ~150+ files) was not re-run — out of
  scope for a single-rule, single-migration widening with no other file touched, and the affected
  chains (rbac + reports/appraisal) were run in full.

## 8. Contract-doc updates

None required. `docs/FRONTEND-BFF-CONTRACT.md` tracks BFF endpoints, not Cerbos rules; no
endpoint was added or changed by this ticket.

## 9. Blockers / follow-ups

None for this ticket. Everything DR-5 asked for landed narrowly and is proven narrow four
independent ways (live Cerbos probe, live-Cerbos test file, DB migration assertion, regenerated
bundle-artifact test). Nothing else in the IAM-01a..07b decomposition was touched.
