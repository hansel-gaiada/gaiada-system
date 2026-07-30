# 2026-07-30 — Migration-backfill RLS silent-failure audit (estate-wide)

**Owner:** senior-db · **Status:** DEV-VERIFIED (audit + guard); no new remediation migration needed
**Scope:** every migration in `platform-nest/migrations/` (all ~51 files), not one department's ticket.

## 0. The confirmed bug class (context, not re-litigated)

Migrations run as `platform_owner` (`MIGRATE_DATABASE_URL`), which does **not** have `BYPASSRLS`
(verified live: `rolbypassrls=f`, vs `postgres`'s `t`). Tenant tables carry **FORCE ROW LEVEL
SECURITY** with a `tenant_isolation` policy gated on `tenant_id = ANY(app_current_tenants())`,
reading the `app.current_tenant_ids` GUC. During a migration that GUC is unset → NULL → the
policy is false for every row. An `UPDATE` / `DELETE` / `INSERT ... SELECT` against such a table
then silently touches **zero rows** — no error, DDL in the same file still commits, the ledger
still records the file as applied. Confirmed instance: `0050_pm_short_codes.sql` shipped, ran
clean, left every project's `short_code` NULL; fixed by `0051_pm_short_codes_backfill_fix.sql`,
which wraps the backfill **per tenant** with `PERFORM set_config('app.current_tenant_ids', <company
id>::text, true)` before touching rows. `testing/setup.ts` migrates as the raw superuser (always
bypasses RLS), which is why this never showed up as a test failure — **a green suite is not
evidence a backfill worked.**

## 1. Re-deriving the candidate list (the given "27 of ~51" list was wrong — verified, not assumed)

The brief listed 27 candidate files: `0001, 0002, 0006, 0007, 0009, 0011, 0012, 0013, 0014, 0017,
0018, 0019, 0021, 0023, 0024, 0026, 0028, 0031, 0033, 0034, 0036, 0038, 0040, 0041, 0046, 0050,
0051`. Per the brief's own instruction ("verify that list is complete rather than trusting it"),
every file in `migrations/` (53 `.sql` files today, including the two grandfathered dual-prefix
pairs) was mechanically re-scanned: comments (`--` line comments and `/* */` block comments)
stripped, then searched for `UPDATE`, `INSERT INTO`, `SELECT INTO`, `MERGE INTO`, `ON CONFLICT`,
and `COPY` as real (non-comment) SQL keywords.

**Result: only 5 files contain an actual data-writing DML statement.** Spot-checked a sample of
the other 22 files named in the given list (`0001, 0002, 0006, 0007, 0009, 0011, 0013, 0014, 0017,
0018×2, 0019, 0021, 0023, 0028, 0031, 0033, 0034, 0036, 0038, 0040, 0041, 0046`) individually —
every one of them is pure DDL (`CREATE TABLE`/`ALTER TABLE`/`CREATE INDEX`/`CREATE POLICY`); the
"INSERT"/"UPDATE" tokens the naive first grep pass hit were column names (`updated_at`) or
comments describing DDL trigger clauses (`CREATE POLICY ... FOR UPDATE`, `BEFORE UPDATE ON ...`),
never a data-writing statement. **The given candidate list appears to have been produced by an
unfiltered keyword grep that didn't strip comments/DDL keywords** — re-deriving it was the right
call per the brief's own instruction, not a formality.

The real list of migrations with actual DML:

| File | DML |
|---|---|
| `0012_outbox_hlc.sql` | `UPDATE outbox_events ... FROM ordered` |
| `0024_module_backfill.sql` | `UPDATE companies SET enabled_modules = ...` |
| `0026_service_layer.sql` | `INSERT INTO roles (...) SELECT ... WHERE NOT EXISTS (...)` |
| `0050_pm_short_codes.sql` | `UPDATE projects`, `UPDATE pm_tasks`, `UPDATE projects` (task_seq) |
| `0051_pm_short_codes_backfill_fix.sql` | same three, per-tenant GUC-wrapped (the fix) |

## 2. Findings table

| Migration | Target table(s) | FORCE-RLS at run time? | GUC set? | Live data assertion | Verdict |
|---|---|---|---|---|---|
| `0012_outbox_hlc.sql` | `outbox_events` | **Yes** (`FORCE ROW LEVEL SECURITY` set in `0010_outbox_events.sql`, same table) | No | `schema_migrations.applied_at`: `0010` at `06:50:09.751125`, `0012` at `06:50:09.786778` — **35 ms apart, same boot**, meaning `outbox_events` had **zero rows** at the moment `0012`'s backfill ran (it was created by `0010` moments earlier with no app traffic in between). Live check today: `SELECT count(*) FILTER (WHERE hlc IS NULL) FROM outbox_events` → **`0` of 428 rows**. | **HARMLESS NO-OP** — vulnerable pattern, but the table was empty at execution time (created-by-an-earlier-file-in-the-same-boot case), so there was nothing to silently drop. Confirmed by ledger timestamps + a live query, not assumed. |
| `0024_module_backfill.sql` | `companies` | **No** — `companies` is `relrowsecurity=f, relforcerowsecurity=f` (deliberately exempt: tenant registry, not tenant-scoped data) | N/A | `SELECT id,name,enabled_modules FROM companies` → all 3 live companies (Gaia Digital Agency, D & A Syrowatka, Sanur Resort) carry `pm,it,billing,clients,knowledge,automation-console` (plus their pre-existing modules, e.g. Gaia also has `agency,hr,search`). | **CLEAR** — landed correctly (pre-established, re-confirmed). |
| `0026_service_layer.sql` | `roles` | **No** — `roles` has no `tenant_id` column at all (global table, `relrowsecurity=f`); confirmed no migration anywhere ever enables RLS on it (`grep -rn "TABLE roles\b" migrations/*.sql` → only the one `CREATE TABLE` in `0001`) | N/A | `SELECT id,company_id,name FROM roles WHERE name IN ('hr_staff','hr_manager')` → both rows present, `company_id` NULL (global role) as designed. | **CLEAR** — table isn't tenant-scoped, insert isn't subject to the bug class at all. |
| `0050_pm_short_codes.sql` | `projects`, `pm_tasks` (both created in `0001`/`0018`, long before `0050`) | **Yes** (via the `FOREACH t IN ARRAY ARRAY[...] LOOP ... FORCE ROW LEVEL SECURITY` idiom in `0001_core.sql` / `0018_pm.sql`) | **No** | Already-confirmed live (pre-audit): 5 projects, 0 with `short_code` before the fix. | **⚠ SILENT DATA GAP (CONFIRMED)** — the one real finding. Already remediated by `0051` (shipped before this audit started). |
| `0051_pm_short_codes_backfill_fix.sql` | `projects`, `pm_tasks` | Yes | **Yes** — `PERFORM set_config('app.current_tenant_ids', co.id::text, true)` per company, before every backfill loop | `SELECT count(*), count(*) FILTER (WHERE short_code IS NOT NULL) FROM projects WHERE deleted_at IS NULL` → **7 / 7**. `pm_tasks`: **42 / 44** with `seq` (see §3 — the 2-row gap is NOT an RLS issue, see below). | **CLEAR** — the fix. Confirmed correct via live query + a rolled-back re-run (see §4). |

**Total confirmed silent RLS data gaps found across the entire migration history: 1** (`0050`,
already fixed by `0051`). No other migration in the 53-file ledger writes data to a FORCE-RLS
table without the GUC set. This matches the brief's own callout that "only 0050" is a legitimate,
non-manufactured answer.

## 3. A real (but non-RLS) gap found during verification — flagged for the PM/webdev owners

While asserting `0051`'s live data state, `pm_tasks` showed **42/44** with `seq`, not 44/44. The 2
NULL rows (`d9470eac-a131-459d-ae97-adc86df2e02f`, `597b7397-f915-4562-88f1-13c194a5cb0e`, project
`019f648c-1777-76a6-beda-1669164ec7bf` / "Rebrand — Bali Beach") have `created_at` values of
2026-07-18 and 2026-07-24 — **before** `0051` ran (2026-07-30 02:29:14) — which at first looks like
`0051` itself missed them under RLS. It did not: re-running `0051`'s exact per-tenant-GUC-wrapped
logic in a rolled-back transaction (as `platform_owner`, proper semantics — see §4) **does** pick
up both rows and assigns them `seq 12` and `13`, immediately after the row created just before
`0051`'s real run (`seq 11`, created 02:16:37). If these two rows had existed at `0051`'s actual
run time, that run would have assigned them `seq 6`/`7` (chronological order) and pushed every
later row up — it did not, which proves the two rows **did not exist yet** when `0051` executed.
Their `created_at` is therefore backdated relative to their real insertion time, most likely by a
manual/demo SQL insert issued directly against `pm_tasks` after `0051` shipped, bypassing the
atomic allocator (`platform-nest/src/core/project-short-codes.ts`'s `allocateTaskSeq`) that every
real code path (`pm.controller.ts`) uses. **This is a data-hygiene gap, not an instance of the
audited bug class** — `0051`'s own correctness is not in question. Named precisely so the PM/
webdev team can decide whether to run the same idempotent backfill again (ready-to-use SQL is the
exact body of `0051`; re-running it is proven safe in §4) or investigate how those 2 rows were
inserted.

## 4. Verification performed (real output, not narrative)

Role/RLS facts (confirms the mechanism, doesn't re-litigate it):
```
 rolname        | rolbypassrls | rolsuper
postgres        | t            | t
platform_owner  | f            | f
platform_app    | f            | f

 relname               | relrowsecurity | relforcerowsecurity
 companies             | f              | f
 org_units             | t              | t
 outbox_events         | t              | t
 pm_tasks              | t              | t
 projects              | t              | t
 roles                 | f              | f
 service_assignments   | t              | t
 service_grant_claims  | t              | t
 work_activity         | t              | t
```

`outbox_events` harmlessness (ledger timing + live data):
```
name                    | applied_at
0010_outbox_events.sql  | 2026-07-15 06:50:09.751125+00
0012_outbox_hlc.sql     | 2026-07-15 06:50:09.786778+00
--
 total | null_hlc | earliest                      | latest
   428 |        0 | 2026-07-15 06:55:37.646123+00 | 2026-07-30 03:08:21.97169+00
```

`0024`/`0026` CLEAR (live data):
```
roles: hr_staff / hr_manager present, company_id NULL (both rows)
companies.enabled_modules: all 3 companies carry pm,it,billing,clients,knowledge,automation-console
```

`0051` correctness + idempotency — re-ran its exact DO-block logic as `platform_owner` (not
`postgres`; this is the role migrations actually run as) inside `BEGIN ... ROLLBACK`, twice-tested
in spirit (the ledger-recorded run already happened once for real; this is the "run it again"
proof, rolled back so it changes nothing on disk):
```
BEGIN
DO
                  id                  | seq
 d9470eac-a131-459d-ae97-adc86df2e02f |  12
 597b7397-f915-4562-88f1-13c194a5cb0e |  13
(2 rows)
ROLLBACK
```
The 2 rows discussed in §3 got picked up (proving `0051`'s logic is live-correct and would close
that gap too if re-run for real); everything else was already seq'd, so no other row changed
(seq/task_seq counts for the already-numbered rows were unchanged pre/post) — i.e. re-running is a
true no-op for everything `0051` already closed, and additive-only for anything new that slipped in
after. Rolled back on purpose — this audit does not silently mutate `pm_tasks` on the PM team's
behalf; see §3 for the handoff.

**Live projects/pm_tasks state today (via `postgres`, for a clean whole-DB read):**
```
projects: total=7, with_code=7
pm_tasks: total=44, with_seq=42   (the 2-row gap is §3, not an RLS gap)
```

## 5. The search-provider-pulls.test.ts RLS failure — investigated, not dismissed

Per the concurrency note, `search-provider-pulls.test.ts` was flagged as failing with an RLS error
in full-suite runs, owned by the SEO/search program. Checked whether it's another instance of this
bug class: **no `search` migration (`0034_module_search.sql`, `0045`–`0048`) contains any
UPDATE/INSERT...SELECT at all** — confirmed by the same comment-stripped scan as §1 — so there is
no migration-backfill mechanism in the search module that could silently no-op. Ran the file in
isolation to see the real behavior:

```
npx vitest run src/modules/search/search-provider-pulls.test.ts
 Test Files  1 passed (1)
      Tests  13 passed (13)
```

All 13 tests pass cleanly standalone — every DB call in the file correctly wraps in `withTenants([A],
..., { modules: ["search"] })`, including the raw seeding inserts. The failure the other team is
seeing is very likely a **test-parallelism issue** (this file mutates `config.search.providerMode`
and other fields on the shared, module-level `config.search` singleton in `beforeEach`/`afterEach`;
if it runs concurrently with another search-suite file doing the same, one file's cleanup can flip
mode/caps out from under the other's in-flight assertions) rather than an RLS/migration defect. This
is a distinct, real finding — named precisely for the SEO/search team to investigate (their file
ownership, not mine to fix): check whether their full-suite run has `fileParallelism` doing anything
non-default for search test files, or move `config.search.*` mutation into a per-test-scoped
fixture instead of a shared singleton.

## 6. Remediation migrations shipped

**None.** The only confirmed silent-RLS-backfill gap in the entire ledger is `0050`, and it was
already remediated by `0051` before this audit began (`0051` applied 2026-07-30 02:29:14, this
audit started after). Re-verifying `0051` (§4) confirms it is correct and idempotent. Per the
brief's own framing: "if the answer is only `0050`, that is a perfectly good result" — it is. No
new numbered migration was added to the ledger (next free number remains **`0052`**, re-verified
live: `schema_migrations` head is still `0051_pm_short_codes_backfill_fix.sql`, `ls migrations/`
head is still `0051_...sql`).

## 7. The durable guard — a static CI lint, implemented

**Options weighed:**

1. **Runner-level assertion** (e.g. `migrate.ts` checks affected-row counts post-hoc). Rejected as
   primary: it can only complain generically ("0 rows affected — is that expected?"), which is
   either a false-positive minefield (plenty of legitimate 0-row backfills, e.g. `0012`'s) or
   requires per-migration annotation anyway, at which point the CI lint below does the same job
   earlier and without touching the runner's hot path.
2. **Make `testing/setup.ts` migrate as a non-superuser role** (mirroring `platform_owner`'s
   `NOBYPASSRLS`). Considered seriously — it's the most "reproduce prod exactly" option — but
   **it would not have caught 0050's actual bug**: the harness gives every test file a **fresh,
   empty** per-file database (`src/testing/setup.ts` header, "per-file physical databases"), and
   `migrate()` always applies the **entire ledger back-to-back in one call**, with zero app traffic
   between files. `0050`'s real bug required *pre-existing* rows (created by `0001`/`0018` weeks
   earlier, with real production traffic in between) for a *later* migration's backfill to
   silently skip. A fresh-DB test run can never reproduce "a table that already has un-backfilled
   legacy rows by the time migration N ships" — by construction, nothing has written to `projects`
   yet when `0050` runs in a test DB, so 0 rows would need backfilling regardless of which role ran
   the migration. This option is real defense-in-depth for *other* RLS bugs (any test assertion
   that queries data through `withTenants`/app-role paths would now be exercising real RLS instead
   of superuser bypass end-to-end), but it doesn't close the specific hole this audit is about, and
   it adds real cost (a `NOBYPASSRLS` role must exist in every dev/CI Postgres, `GRANT` bootstrap
   changes). Deferred, not implemented here — noted for a future ticket if the team wants the
   broader hardening.
3. **A static CI lint over `migrations/*.sql`.** Chosen. It is the only option that is loud
   **at authoring time** — it needs no Postgres, no test DB, no fresh-vs-populated distinction; it
   flags the anti-pattern the moment a new migration file is written, before a PR is even opened.
   It also directly encodes the exact fix the team already adopted in `0051` (wrap the DML in a
   per-tenant `set_config` call) rather than a generic "0 rows, are you sure?" runtime nag.

**Implemented:** `platform-nest/scripts/lint-migration-rls.mjs` (mirrors the existing
`scripts/lint-withtenants.mjs` convention — same house style: pure static analysis, no new
dependency, content/structural matching instead of a full SQL parser, an explicit grandfather
baseline for already-applied files per migrations `README.md` rule 4).

**What it does:** for every migration file, in ledger order, it tracks (a) which tables get
`FORCE ROW LEVEL SECURITY` — including via the dynamic `FOREACH t IN ARRAY ARRAY[...] LOOP ...
EXECUTE format('ALTER TABLE %I ... FORCE ROW LEVEL SECURITY', t)` idiom this codebase uses almost
everywhere (0001, 0018, etc. — a naive literal-text regex alone misses nearly every table, since
the identifier is filled in at runtime via `%I`, not present as literal text next to the phrase);
(b) which tables are `CREATE TABLE`'d in the *same* file (zero pre-existing rows, so a same-file
backfill is harmless per the audit's own carve-out); (c) whether `set_config('app.current_tenant_ids'`
(or `SET [LOCAL] app.current_tenant_ids`) appears earlier in the same file. It flags any
`UPDATE`/`DELETE FROM`/`INSERT INTO ... SELECT` (the SELECT/WHERE-visibility-dependent, silently-
zero-rowable shapes — a literal `INSERT ... VALUES` is excluded because it fails LOUDLY instead,
a `WITH CHECK` violation, not silently) against an already-FORCE-RLS table with no GUC-setting call
earlier in the file.

**Baseline:** everything at or before `0051_pm_short_codes_backfill_fix.sql` is grandfathered
(already applied to real databases — cannot be edited, README rule 4). New migrations (`0052+`) are
fully enforced.

**Verification (real output, `SELFTEST=1 node scripts/lint-migration-rls.mjs`, which runs the
detector with the baseline OFF against the real ledger to prove it actually distinguishes the
real cases from this audit):**
```
  [PASS] 0050_pm_short_codes.sql (the CONFIRMED bug) is flagged (3 finding(s): projects@L75, pm_tasks@L99, projects@L102)
  [PASS] 0051_pm_short_codes_backfill_fix.sql (the fix, per-tenant GUC wrapped) is CLEAN
  [PASS] 0012_outbox_hlc.sql ... is flagged: true   (conservative over-flag — see limitation note in the script header; harmless in this case per §2, but the lint can't know a table was empty, only that it wasn't CREATEd in the same file, so it correctly asks a human to use the safe pattern anyway)
  [PASS] 0024_module_backfill.sql (companies, not FORCE-RLS at all) is CLEAN
  [PASS] 0026_service_layer.sql (roles, not FORCE-RLS at all) is CLEAN

[lint-migration-rls] SELFTEST OK
```
Real (non-selftest) run against the current ledger, baseline applied:
```
[lint-migration-rls] OK -- scanned 53 migrations (53 baselined, 0 enforced); no unguarded FORCE-RLS backfills found.
```
Synthetic future-migration proof (detector exercised directly, not touching the real ledger) — an
unguarded `UPDATE projects ...` is flagged, the same statement wrapped in `0051`'s per-tenant
`set_config` loop is not:
```
bad (expect 1 finding):  [{"file":"0099_bad_backfill.sql","line":2,"table":"projects","kind":"UPDATE"}]
good (expect 0 findings): []
```

**Wired into CI:** `npm run lint:migration-rls` added to `platform-nest/package.json`; a step added
to the `platform-nest` job in `.github/workflows/ci.yml` (next to the existing `lint:withtenants`
step) and to `infra/scripts/test-all.sh` (local CI parity, `platform-nest`-only like the withTenants
lint next to it).

**Known limitation (documented in the script header, not hidden):** the "GUC set earlier in the
file" check is file-scoped, not loop/block-scoped — a migration that correctly GUC-wraps one
table's backfill and then adds a SECOND, unguarded backfill against a different table later in the
same file would not be re-flagged for the second table. Tightening this would need a real SQL
parser; the printed file:line:table:kind in a CI failure is meant to make a human reviewer the
backstop for that residual gap, not to claim full completeness.

## 8. Summary / explicit count

- **Confirmed silent RLS data gaps found across the full ~51-migration history: 1** (`0050`),
  already remediated by `0051` before this audit started. No new remediation migration required.
- **Non-RLS finding, named for the PM/webdev owners:** 2 `pm_tasks` rows with NULL `seq`, inserted
  after `0051` with backdated `created_at`, bypassing the atomic allocator — not this bug class,
  flagged in §3 with ready-to-use (proven-idempotent) fix SQL.
- **Non-RLS finding, named for the SEO/search owners:** `search-provider-pulls.test.ts`'s reported
  RLS failure did not reproduce standalone (13/13 green); no search migration performs any data
  backfill, so it isn't this bug class. Likely a parallel-test shared-config race — flagged in §5.
- **Durable guard implemented:** `platform-nest/scripts/lint-migration-rls.mjs`, a static CI lint
  (chosen over a runner assertion and over converting the test harness to a non-superuser migrator,
  both considered and rejected/deferred with reasons in §7), wired into `package.json`, CI, and
  local test-all.sh, self-test-verified against the real ledger with real output above.
