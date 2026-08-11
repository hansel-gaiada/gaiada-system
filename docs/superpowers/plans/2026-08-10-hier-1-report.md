# HIER-1 report — `org_unit` scope substrate (`user_roles.scope_type`/`scope_id`)

**Status: PROTOTYPED / DEV-VERIFIED** (migration + tests written, applied and exercised against a
fresh test database AND a real copy of the live `gaiada_platform` database; not deployed).
**Ticket:** HIER-1 (`docs/superpowers/plans/2026-08-10-iam-hier-01-plan.md`, DR-8/DR-10 — owner
decisions locked 2026-08-10, implemented exactly, not relitigated). **Date:** 2026-08-10.

---

## 1. Migration added

`platform-nest/migrations/0100_user_roles_org_unit_scope.sql` — verified free (`ls migrations |
sort | tail` showed head `0099_iam_dr5_company_admin_appraisal_read.sql`, `0100` genuinely open).

### DDL summary

1. **Count-assert zero rows** for `scope_type IN ('team','record')` before touching the CHECK —
   `RAISE EXCEPTION` (not a silent skip) if either is non-zero. Live-verified 2026-08-10:
   `team`/`project`/`record` are all 0; `company`=51, `global`=4.
2. **`scope_type` CHECK**: `('global','company','team','project','record')` →
   `('global','company','org_unit','project')`. Drops `team` AND `record`, adds `org_unit`, in
   this one migration, exactly as DR-10 specifies.
3. **`scope_id` widened `uuid` → `text`**: `ALTER COLUMN scope_id TYPE text USING scope_id::text`
   (DR-8). Lossless — every existing value was already a real uuid.
4. **Per-scope shape CHECK** (`user_roles_scope_id_shape_check`):
   - `global` → `scope_id IS NULL`
   - `company` / `project` → `scope_id IS NOT NULL AND scope_id ~ '^[uuid regex]$'`
   - `org_unit` → `scope_id IS NOT NULL AND btrim(scope_id) <> ''`
   Each branch explicitly tests `scope_id IS NOT NULL` before its shape test — **not** just
   `scope_id ~ regex`. Postgres CHECK constraints treat a NULL boolean result as *satisfied*, not
   violated; a naive `(scope_type IN ('company','project') AND scope_id ~ regex)` branch would
   have evaluated to NULL (not FALSE) for a `company`-scoped row with `scope_id IS NULL`, silently
   passing exactly the gap this CHECK exists to close. Verified this matters, not just asserted it
   — see §4 below (a live app-layer path that used to produce that exact NULL combination).
5. **Closing assertions**: re-verifies `scope_id`'s `information_schema` type is `text`, both new
   constraints exist by name, `to_regclass('user_roles_global_scope_uniq')` (0092's partial unique
   index) is not null, and zero `team`/`record` rows exist post-change. All fail loudly
   (`RAISE EXCEPTION`) rather than silently, per the ticket's "assert, don't trust" instruction.

`user_roles` carries **no RLS at all** (0092's own header confirms this, re-verified live via
`pg_class.relrowsecurity/relforcerowsecurity` — both `f`), so the RLS-empty-set backfill trap does
not apply here — no tenant GUC exists on this table's path to forget.

Idempotency: every `ADD CONSTRAINT` is guarded by an existence check in a `DO` block; the `ALTER
COLUMN TYPE text` is a no-op if the column is already `text` (Postgres permits retyping a column
to its current type); the count-assertions and closing assertions are themselves side-effect-free
re-checks.

---

## 2. Zero-row assertions (live-verified)

```
gaiada_platform @ gda-aicenter, 2026-08-10, SELECT-only:
  scope_type='company' : 51
  scope_type='global'  : 4
  scope_type='team'    : 0
  scope_type='project' : 0
  scope_type='record'  : 0
```
Re-confirmed via a full `pg_dump`/`pg_restore` copy (see §5) — same counts, and the migration's own
`RAISE EXCEPTION` guards did not fire (meaning the assertions passed against real data, not just a
point-in-time SELECT I trusted).

**The abort path itself was forced open, not just trusted by inspection** — a green migration run
against zero-row data proves the guard *didn't need to fire*, not that it *would* fire. So a
dedicated test (`src/db/user-roles-org-unit-scope-abort.db.test.ts`) plants a real poisoned
`scope_type='team'` row on a database that has already run 0100 once (by temporarily dropping the
two 0100 constraints — the only way to make a `'team'` row insertable again), then re-executes
0100's REAL file text (read from disk, not re-typed) inside its own transaction and asserts:

```
✓ a poisoned scope_type='team' row makes a re-run of 0100 RAISE and change NOTHING
  → caught.message matches /still carry scope_type='team'.*refusing to drop 'team'/
  → pg_constraint count for the two 0100 constraints == 0 immediately after the throw
    (proves the RAISE fired in STEP 1, before the DROP/ADD CONSTRAINT statements ever ran)
  → the poisoned row is still there, byte-for-byte, after the throw (nothing silently deleted)
```

Also manually reproduced once, end-to-end, outside the test harness, against a disposable Docker
Postgres database (migrated to 0099, `0100` file staged out of the directory, poison row inserted
via raw SQL, `0100` file staged back in, `tsx src/db/migrate.ts` re-run):

```
$ npx tsx src/db/migrate.ts
migration 0100_user_roles_org_unit_scope.sql failed: 0100: 1 user_roles row(s) still carry
scope_type='team' — refusing to drop 'team' from the scope_type CHECK while a live grant would
be orphaned by it. Aborting; this migration changes nothing until the offending row(s) are resolved.
EXIT CODE: 1
```
Post-failure inspection of that database confirmed **zero commitment**: `0100` is absent from
`schema_migrations`, `user_roles.scope_id` is still `uuid` (not `text`), and the ORIGINAL
`user_roles_scope_type_check` (still permitting `team`/`project`/`record`) is unchanged — the
migrate.ts runner's `BEGIN`/`ROLLBACK` wrapper rolled back the whole file atomically on the
`RAISE EXCEPTION`, exactly as designed.

---

## 3. `scope_id` full-repo grep — every comparison/cast/binding site reviewed, with verdict

Ran `grep -rn "scope_id\|scopeId"` across the whole repo (92 files matched, docs + code). Every
**code** site (platform-nest + platform-ui) was opened and read. Verdicts:

### Sites reviewed and found SAFE (no change needed)

| File | What's there | Why safe |
|---|---|---|
| `platform-nest/src/rbac/principal.ts:95,100` | `SELECT ... ur.scope_id AS "scopeId" ...` (assemblePrincipal) | Plain column read, no cast. Text or uuid, node-pg returns a string either way. |
| `platform-nest/src/rbac/cerbos.ts:38,47` | `principalPayload`/perms mapping `scopeId: g.scopeId ?? ""` | Generic string handling, no type assumption. |
| `platform-nest/src/admin/service-reconciler.ts:271,280,286` | `scope_type='company' AND scope_id=$N`; `INSERT ... VALUES (...,'company',$4,...)` | Untyped parameter binding — Postgres infers the param type from context; identical behavior whether the column is `uuid` or `text`. Always `scope_type='company'` here, never `team`/`record`. |
| `platform-nest/src/core/approval-deciders.ts:54,56,70` | `ur.scope_id = $1` bound to a real company id | Same — untyped param, no cast. |
| `platform-nest/src/modules/reports/checkins.controller.ts:969` | `ur.scope_id = $1` (company id) | Same pattern. |
| `platform-nest/src/modules/reports/report-seal.ts:171` | `ur.scope_id = $1` (company id) | Same pattern. |
| `platform-nest/src/core/service-scopes.ts:42-52` | `SELECT DISTINCT scope_id FROM user_roles WHERE ... scope_type='company' AND scope_id IS NOT NULL` | Plain read, filtered into a JS array, no cast. |
| `platform-nest/src/testing/fixtures.ts:102` (INSERT), `admin-identity.controller.ts:216,295,314` (INSERT/lookup) | Parameterized INSERT/SELECT, no `::uuid` cast anywhere | Grepped explicitly for `scope_id.{0,20}::uuid` and the reverse ordering across the **entire repo** — zero matches. No site casts `scope_id` (or a parameter compared against it) to `uuid`. |
| `platform-nest/src/admin/*.test.ts`, `src/modules/hr/wsd7-acceptance.test.ts`, `src/rbac/principal-perf.db.test.ts`, `src/rbac/principal-permissions.db.test.ts` | Various `scope_type='company' AND scope_id=$N` reads/asserts | All company-scoped; unaffected by the type widening (untyped params) or the CHECK narrowing (company stays valid). |
| `platform-nest/src/rbac/cerbos.test.ts`, `cerbos-webdev-matrix.test.ts`, `cerbos-permission-dual-match.test.ts`, `cerbos-assistant.test.ts`, `cerbos-agent-run.test.ts`, `modules/reports/reports-cerbos.test.ts`, `modules/pm/pm-adversarial-authz.test.ts` | Hand-constructed `Principal` literals with `scopeType: "team"`/`"project"`/`"company"` | **Never touch the DB** — pure in-memory Cerbos-decision tests. Unaffected by the DB CHECK change; still compile because `RoleGrant.scopeType`/`PermissionGrant.scopeType` were **widened**, not narrowed (see §4). |
| `platform-ui/src/lib/*.ts`, `RoleManager.tsx`, `demoFixtures.ts`, `adminData.ts`, `platform.ts` | UI-side `scopeType`/`scopeId` strings over the JSON/HTTP boundary | Out of this ticket's file ownership (separate project); JSON has no `uuid` type — a Postgres column's type change is invisible across the HTTP boundary. `RoleManager.tsx`'s own `SCOPE_TYPES` dropdown still offers `team` (stale, HIER-3's W3) — worst case an admin's stale selection now gets a **clean 400** from the backend (see §4) instead of previously succeeding into a dead grant; no UI crash. |
| `docs/**/*.md` (13 files) | Prose | Not code. |

### Sites reviewed and found to REQUIRE a fix — fixed in this ticket

| File | Finding | Fix |
|---|---|---|
| `platform-nest/src/rbac/principal.ts:19,34` | `RoleGrant.scopeType`/`PermissionGrant.scopeType` TS unions did not include `org_unit` | **Widened** (additive) to add `org_unit`, keeping `team`/`project`/`record` — see rationale in §4. Required for the new round-trip test to type-check. |
| `platform-nest/src/testing/fixtures.ts:97` | `grantRole()`'s `scopeType` param type, same gap | Same widening. |
| `platform-nest/src/rbac/cerbos.ts:32` | `principalPayload()` was module-private, so nothing outside `cerbos.ts` could assert `attr.grants` against the *real* mapping | Exported (visibility-only, zero behavior change) so the round-trip test calls the real function, not a hand-duplicated copy that could drift. |
| `platform-nest/src/admin/admin-identity.controller.ts:17` (`SCOPE_TYPES`) | App-layer allowlist still accepted `team`/`record` on the generic role-assign endpoint. Post-0100, submitting either now hits the new DB CHECK and raises an **unhandled Postgres 23514 → 500**, not this endpoint's own clean 400 — exactly the failure mode the ticket calls out. | Removed `team`/`record`; **deliberately did not add `org_unit` yet** (nothing consumes an org_unit grant until HIER-2 ships `org_unit_lead` + its Cerbos rule — exposing it here first would let an admin mint an inert grant, the exact vestigial-scope pattern this program exists to retire). |
| `platform-nest/src/admin/admin-identity.controller.ts` `assignRole` | `scopeId` defaulted to `null` for any non-global, non-company scope when the client omitted it (`body.scopeId ?? (scopeType==="company" ? tenantId : null)`). Before 0100 this silently inserted a dead, unreachable `project`-scoped row with `scope_id=NULL`; after 0100 the new shape CHECK genuinely rejects it (`company`/`project` require `scope_id IS NOT NULL`) — the exact NULL-satisfies-a-branch trap §1.4 above discusses, confirmed here as a REAL reachable pre-existing app path, not just a theoretical one. Left unfixed, this becomes another unhandled 500. | Replaced the defaulting ternary with explicit branches: `global`→null, `company`→default to `tenantId`, anything else→`BadRequestException` if `scopeId` is omitted. Converts the failure into a clean 400. |

### Known-critical files named in the ticket — explicit verdicts

- **`platform-nest/src/rbac/principal.ts`** — fixed (type widening, see above). `assemblePrincipal()`'s two SQL queries (`RoleGrant`/`PermissionGrant` reads) needed no SQL change — plain column reads.
- **`platform-nest/src/admin/admin-identity.controller.ts`** — fixed (`SCOPE_TYPES` + `assignRole`'s scopeId defaulting), both described above.
- **`platform-nest/src/admin/service-reconciler.ts`** — reviewed, SAFE. Always writes/reads `scope_type='company'` with a real company-id `scope_id`; never touches `team`/`record`/`org_unit`. No cast anywhere (checked lines 268-289 directly).
- **`platform-nest/src/modules/reports/person-scope.ts`** — reviewed, **deliberately left untouched**. Its `UNIT_SCOPED_ROLES`/tier-condition logic (`g.scopeType === "team"`, `"project"`, `"record"`) still compiles because the `RoleGrant` union was widened, not narrowed. Rewriting this file's semantics to consume `org_unit`/`unit_lead` is explicitly HIER-2's job (the file's own header already documents *why* a unit grant was unstorable — this ticket is the fix for that substrate fact, but the *consumption* of the fix is HIER-2/HIER-3's, per the plan's own W11 assignment). Touching it now would be scope creep into a ticket that depends on a role (`org_unit_lead`) that does not exist yet.

---

## 4. Why the TS type union was WIDENED, not narrowed (a deliberate, load-bearing choice)

The plan doc's own decomposition (§3, W11) assigns "type unions + narrowing" to **HIER-3**, not
HIER-1 — sequenced *after* HIER-2 builds the `org_unit_lead` replacement. Two things forced a
decision here regardless: (a) my own acceptance bar requires a new test proving an
`org_unit`-scoped grant round-trips `assemblePrincipal()` → `attr.grants`, which needs
`RoleGrant.scopeType` to admit `"org_unit"` as a valid TS value; (b) `npm run typecheck` — a hard
CI gate that **includes test files** — must stay at 0 errors.

Narrowing `RoleGrant.scopeType`/`PermissionGrant.scopeType` to drop `team`/`record` (matching the
new DB CHECK exactly) would have broken compilation of every test file that still constructs an
in-memory `Principal` literal with `scopeType: "team"` — `cerbos.test.ts`, `cerbos-webdev-
matrix.test.ts`, `cerbos-permission-dual-match.test.ts`, `principal-permissions.db.test.ts`,
`person-scope.test.ts` — none of which touch the database (so none of them are affected by the DB
CHECK at all), but all of which would need editing *today* purely to satisfy a narrower TS type.
That is squarely HIER-3's mechanical sweep (its own W12 enumerates exactly these files), not mine.

So this ticket **widened** the union instead — added `org_unit`, kept `team`/`record` — matching
`PermissionGrant`'s own pre-existing comment ("adding `org_unit` later is a pure union-widening
change here, nothing about this shape forecloses it"). The DB is authoritative on what can be
**stored** (0100's CHECK enforces the real boundary); the TS union is authoritative on what a
caller can **construct in memory**; the two are allowed to diverge during the phased retirement.
Net effect: `npm run typecheck` stays green with zero HIER-3 files touched, and the acceptance
test still proves the new capability end to end.

---

## 5. Verification performed (real output, not narrated)

### 5.1 Fresh DB
`initTestDb()` (the repo's own per-file-database test harness) ran migrations 0001→0100 clean on
every test file below — no separate "fresh DB" step was needed since every `.db.test.ts` already
does this on every run.

### 5.2 Copy of live
Pulled a real `pg_dump -Fc` of `gaiada_platform` from `gda-aicenter` (SELECT/dump only, read-only
per the ticket's constraint), restored it into a disposable database on the local test Postgres
(`gaiada-test-pg`, port 55433), and ran the real `migrate()` runner (via `tsx src/db/migrate.ts`,
`MIGRATE_DATABASE_URL` pointed at the restored copy) forward from its actual head:

```
applied: 0091_iam_02d_ungrantable_roles.sql, 0092_user_roles_global_scope_unique.sql,
0093_iam_permission_catalog.sql, 0094_iam_02a_role_permission_bundles.sql,
0095_iam_02e_baseline_roles.sql, 0096_iam_agency_approver_role.sql,
0097_webdev_module_roles.sql, 0098_iam_02g_webdev_role_permission_bundles.sql,
0099_iam_dr5_company_admin_appraisal_read.sql, 0100_user_roles_org_unit_scope.sql
```

(Live was at `0090`; `0091`-`0099` had never been deployed. This run exercised 0092's real dedupe
against real duplicate rows AND my 0100 in the same sequence a real deploy would use.) Post-migration
inspection of the restored copy:

```
\d user_roles →
  scope_id  | text   (was uuid)
  Indexes: ... "user_roles_global_scope_uniq" UNIQUE, btree (user_id, role_id, scope_type)
           WHERE scope_id IS NULL                                    ← 0092's index, SURVIVED
  Check constraints:
    "user_roles_scope_id_shape_check" CHECK (...)                    ← new
    "user_roles_scope_type_check" CHECK (scope_type = ANY (ARRAY['global','company','org_unit','project']))

scope_type counts: company=51, global=2   (was global=4 — 0092's real dedupe removed the
                                            2 genuine live duplicate rows this session's
                                            memory already documented: exec@gaiada.test and
                                            hansel@gaiada.com each had 2 rows, now 1 each)
duplicate (user_id, role_id) pairs at scope_id IS NULL: 0 rows   ← 0092 fully deduped real data
```
Scratch database + downloaded dump deleted after verification; nothing written back to live.

### 5.3 New tests (21 total, all green)

`src/db/user-roles-org-unit-scope.db.test.ts` (18 tests):
- scope_type CHECK rejects `team`/`record`, accepts `org_unit`.
- shape CHECK: rejects org_unit with NULL / empty / whitespace-only scope_id; accepts real node
  ids (`d-hr`, `dv-web`, `d-legal`).
- shape CHECK: rejects company/project with non-uuid-shaped or NULL scope_id; accepts real uuids.
- shape CHECK: rejects global with a non-NULL scope_id; accepts NULL.
- 0092's index: present by name AND functionally rejects a real duplicate global-scope insert
  post-0100; confirms `scope_id`'s `information_schema.columns.data_type` is now `text`.

`src/rbac/principal-org-unit-scope.db.test.ts` (3 tests) — **the ticket's named acceptance test**:
- `grantRole(userId, roleId, "org_unit", "d-hr")` → `assemblePrincipal()` → `p.roles` contains
  `{role, scopeType:"org_unit", scopeId:"d-hr"}` verbatim.
- The SAME principal through the real (now-exported) `principalPayload()` → `attr.grants`
  contains the identical triple verbatim — proving the round trip all the way to what Cerbos
  actually receives.
- A second org_unit grant at a different node id (`dv-web`) confirms this isn't a single-row
  fluke.

```
✓ src/db/user-roles-org-unit-scope.db.test.ts (18 tests)
✓ src/rbac/principal-org-unit-scope.db.test.ts (3 tests)
Test Files  2 passed (2) | Tests  21 passed (21)
```

### 5.4 Required-green suites

```
✓ src/rbac/role-permission-parity.db.test.ts (24 tests)
✓ src/rbac/role-permission-bundles.db.test.ts (7 tests)
✓ src/rbac/iam-215-boundary-pin.test.ts (66 tests)
✓ src/rbac/role-bundle-completeness.db.test.ts (3 tests)
Test Files  4 passed (4) | Tests  100 passed (100)
```

### 5.5 `npm run typecheck` → **0 errors** (clean, no output beyond the tsc invocation).

### 5.6 `npm run lint:migration-rls` → **OK** — scanned 99 migrations (53 baselined, 46 enforced);
no unguarded FORCE-RLS backfill found (moot for this file anyway — `user_roles` has no RLS — but
the lint ran clean regardless).

### 5.7 Collateral breakage — found, confirmed, and it is EXACTLY the set predicted by the grep sweep, nothing more

Per DR-10 ("removes BOTH `team` AND `record` — in this one migration") and my file-ownership
boundary (forbidden from touching `teams.controller.ts`, `testing/personas.ts`, `seed/personas.ts`,
or any Cerbos policy naming `team_lead`), landing this migration standalone makes every
still-existing write path that inserts `scope_type='team'` fail with a CHECK violation. I
identified every such call site by grep (`grantRole(..., "team", ...)` and the two raw INSERTs in
`teams.controller.ts`) **before** running anything, then ran the affected files to confirm the
failure mode was exactly what the grep predicted — no surprises, no additional files affected:

```
❌ src/core/teams.test.ts (5 tests | 2 failed)
   × "promoting a member to lead activates team-scope authority" — expected 500 to be 201
   × "team detail lists the members" — knock-on (the PATCH in the prior test never ran)
❌ src/testing/personas.test.ts (8 tests | 1 failed)
   × "DENY — team_lead is TEAM-scoped..." — CHECK violation inside seedPersonaTenant(["team_lead"])
❌ src/admin/managed-by-invariant.test.ts (6 tests | 1 failed)
   × "promoting a team lead never produces a managed_by-set user_roles row" — expected 500 to be 201
```
All 4 failures trace to the SAME root cause: `teams.controller.ts:119`'s
`INSERT INTO user_roles (..., 'team', ...)` (and the identical shape in
`testing/personas.ts`/`seed/personas.ts`'s `team_lead` persona) now violates
`user_roles_scope_id_shape_check`/`user_roles_scope_type_check`. **This is not a defect in this
migration** — it is DR-10 doing exactly what it says, landing before its own replacement
(HIER-2's `org_unit_lead`) and retirement sweep (HIER-3, which owns reworking these exact three
files — see plan §3 W1/W4/W5/W12). Zero live rows are affected (both `team` and `record` counts
are 0, asserted in the migration itself); zero UI surfaces call `/api/:t/teams*` (grepped — none).

**Confirmed this is the FULL blast radius**, not a partial check: grepped the entire `src/`
tree for every `grantRole(...)` call and raw `user_roles` INSERT with a literal `'team'` scope
before running anything (`teams.controller.ts:119`, `testing/personas.ts:141`,
`seed/personas.ts:184` — the only three write sites), and cross-checked every test file matching
`team_lead`/`"team"` from the original 92-file grep to separate the ones that touch the DB
(these three) from the ones that construct in-memory `Principal` literals and never reach it
(`cerbos.test.ts`, `cerbos-webdev-matrix.test.ts`, `cerbos-permission-dual-match.test.ts`,
`reports-cerbos.test.ts`, `pm-adversarial-authz.test.ts` — all confirmed unaffected, all still
green in the runs below).

### 5.8 Broader confirmatory sweep

Ran `src/rbac`, `src/admin`, `src/db`, `src/testing`, `src/modules/reports`, `src/modules/pm`,
`src/modules/search`, `src/modules/hr`, `src/core` together as one background `vitest run`
(this is the single biggest slice of the suite that could plausibly touch `user_roles`/
`scope_id`/`team_lead`, so it is the confirmatory sweep, not a sample). **IN PROGRESS AS OF THIS
WRITE-UP** — it is a genuinely large run (the platform-nest suite is hundreds of files touching
live Postgres/Cerbos per file); partial output through >2100 log lines shows every file green
except the 3 already identified and explained in §5.7, including the full PM subsystem (132
tests), search-marketing (dispatch/simulation/rank/SEM-apply/ahrefs/semrush/GSC-GA4, several
hundred tests), the TR-07/TR-15 report fact-job and seal suites (live PG+RLS+Cerbos),
`d14-17-assistant-write-registry.test.ts`, `client-contacts-http.test.ts`,
`webdev-change-requests-portal.controller.test.ts`, `module-webdev-provisioned-sites-rls.test.ts`,
`report-periods-rls.test.ts`, and `hr.test.ts` — **no new, unpredicted failure has surfaced
anywhere in the swept directories so far.** This section will be updated with the final
`Test Files X passed | Y failed` summary the moment the run completes; until then, treat "the
sweep is clean beyond the 3 known files" as strongly-supported-but-not-yet-100%-closed, per the
honesty bar below.

---

## 5.9 What is verified vs. still open, stated plainly

**Verified, with real output, as of this write-up:**
- Migration applies clean on a fresh DB and on a real live-data copy (§5.2).
- Count-assert ABORT path genuinely aborts and commits nothing, demonstrated twice — once as a
  permanent automated test, once manually end-to-end through the real runner (§2).
- 0092's index survives AND fires post-migration (§5.3, §5.10).
- The org_unit round-trip through `assemblePrincipal()` → real `principalPayload()` → `attr.grants`
  (§5.3).
- Shape CHECK rejects malformed `scope_id` for every scope type, accepts the valid shape for every
  scope type (§5.3).
- The 4 named required suites: 100/100 green (§5.4).
- `npm run typecheck`: 0 errors (§5.5).
- `npm run lint:migration-rls`: OK, 99 migrations scanned (§5.6).
- The exact, bounded collateral-breakage set (3 files, 4 tests), root-caused and cross-checked
  against every other `team_lead`-referencing file in the repo to confirm none of the others touch
  the DB (§5.7).
- `admin/assign-role-global-scope-idempotent.test.ts`, `admin/admin.test.ts`,
  `core/authz-permissions.controller.test.ts` — re-run directly after the `assignRole` scopeId-
  defaulting edit, specifically because that edit changes runtime behavior on a shared endpoint;
  all green (10 + 31 = 41 tests).

**Still open at the moment this section was last edited:** the full background sweep across
`src/rbac`, `src/admin`, `src/db`, `src/testing`, `src/modules/{reports,pm,search,hr}`, `src/core`
had not yet printed its final `Test Files`/`Duration` summary line. §5.8 above states this
explicitly rather than rounding up to "all green" before it has. This report will be edited again
the moment that line appears, with the exact final counts — not narrated from memory.

### 5.10 0092 index — the "demonstrate the fire, don't just check `pg_indexes`" proof, verbatim

Two independent demonstrations, not one:

1. **Live-data copy** (§5.2) — `\d user_roles` on the restored live copy shows
   `"user_roles_global_scope_uniq" UNIQUE, btree (user_id, role_id, scope_type) WHERE scope_id IS
   NULL` present by name after the real `ALTER COLUMN scope_id TYPE text` ran against 55 real
   rows. This is existence, on real data — necessary but not sufficient by itself, which is why
   test #2 exists.
2. **Functional fire, automated test** (`user-roles-org-unit-scope.db.test.ts`, "0092's partial
   unique index survives the scope_id type change and still FIRES" describe block) — inserts one
   global-scope grant `(user, role, scope_type='global', scope_id=NULL)`, then inserts the
   IDENTICAL tuple again on the SAME (now-`text`) table, post-0100, and asserts the second insert
   **throws** `/duplicate key|unique constraint|violates/i`. Re-run just now for this report:

```
✓ 0100 — 0092's partial unique index survives the scope_id type change and still FIRES
    > the index object itself is present under its original name post-0100 (existence)
✓ 0100 — 0092's partial unique index survives the scope_id type change and still FIRES
    > a genuine duplicate global-scope grant is still rejected (functional proof, not just presence)
✓ 0100 — 0092's partial unique index survives the scope_id type change and still FIRES
    > scope_id is genuinely text now — a text org_unit value coexists with the pkey/unique
      constraints without a uuid cast error
```
An existence check alone (`to_regclass(...) IS NOT NULL`) is present too (in the migration's own
closing assertion AND as this test's first assertion) — but the SECOND assertion above is the one
that proves the index still does its job, not merely that the catalog still lists it.

## 6. Rollout notes

- **Deploy order**: this migration is additive-plus-narrowing on one table with zero affected live
  rows (counts asserted in-migration). It can deploy independently; no backfill, no application
  code MUST change for it to land safely on live **except** the two defensive fixes in
  `admin-identity.controller.ts` (§3) — those ship in the SAME deploy as this migration, or a
  narrow window exists where a caller of the generic role-assign endpoint could hit a raw 500
  instead of a 400 for a `team`/`record`/NULL-scopeId submission. Both are in this ticket's diff.
- **Known regression, by design, sequenced**: `POST /api/:t/teams/:teamId/members` with
  `role:"lead"` will 500 the instant this migration lands (was previously a working, if dead-end,
  201). This is `teams.controller.ts`'s ONLY affected path, has zero live callers (no UI surface,
  zero live `teams` rows), and is HIER-3's ticket to fix by deleting the controller outright (per
  the consolidation plan's W1) — HIER-3 depends on HIER-2 landing first specifically so this
  window is as short as the program's own sequencing allows, not indefinite.
- **Rollback**: no reversible-migration file was written (repo convention — corrections ship as a
  new higher-numbered migration per `migrations/README.md` rule 4, never an edit/revert of an
  applied one). If HIER-1 needed to be undone before HIER-2/3 land, the fix is a new migration
  reversing the CHECK/type (uuid values are still round-trippable from text; org_unit/never-team
  rows would need a decision, but zero are expected to exist in that window).

## 7. Blockers

None. DR-8/DR-10 implemented exactly as specified; no conflict found with an existing invariant
that wasn't already anticipated and explicitly authorized by the owner decisions themselves.

## 8. Files touched (all within this ticket's ownership)

- `platform-nest/migrations/0100_user_roles_org_unit_scope.sql` (new)
- `platform-nest/src/db/user-roles-org-unit-scope.db.test.ts` (new)
- `platform-nest/src/db/user-roles-org-unit-scope-abort.db.test.ts` (new — forces the count-assert ABORT path open against a real database)
- `platform-nest/src/rbac/principal-org-unit-scope.db.test.ts` (new)
- `platform-nest/src/rbac/principal.ts` (type widening: `RoleGrant`/`PermissionGrant.scopeType` gain `org_unit`)
- `platform-nest/src/testing/fixtures.ts` (type widening: `grantRole()`'s `scopeType` param gains `org_unit`)
- `platform-nest/src/rbac/cerbos.ts` (visibility only: `principalPayload` exported)
- `platform-nest/src/admin/admin-identity.controller.ts` (`SCOPE_TYPES` drops `team`/`record`; `assignRole`'s scopeId defaulting made explicit, closing the NULL-satisfies-shape-CHECK gap)
- `docs/superpowers/plans/2026-08-10-hier-1-report.md` (this file)
