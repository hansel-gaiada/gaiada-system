# platform-nest migrations — numbering protocol (LOCKED)

**Owner:** DevOps · **Established by:** WS0-1 (Backbone Program, 2026-07-17) · **Status:** NORMATIVE

This directory holds the ordered SQL migrations for `gaiada_platform`. The rules below are binding
for every ticket in the program. New migrations that violate them must not be merged.

## How the runner works (read before adding a migration)

`src/db/migrate.ts` is the runner. It is invoked on every platform boot (`main.ts` → `migrate()`)
and can be run standalone (`node dist/db/migrate.js`).

- **Discovery + ordering:** `readdirSync(migrations/).filter(.sql).sort()`. The sort is JavaScript's
  default lexicographic (UTF-16 code-unit) order — **deterministic and platform-independent**. Files
  run in ascending filename order.
- **Ledger:** every applied file is recorded by its **full filename** in the `schema_migrations`
  table (`name text PRIMARY KEY`). A file whose name is already in the ledger is skipped; a file whose
  name is not is applied inside a single transaction, then inserted into the ledger.
- **Privilege:** migrations run as the **owner** (`MIGRATE_DATABASE_URL` → `platform_owner`), so every
  `CREATE TABLE` auto-grants DML to `platform_app` via `ALTER DEFAULT PRIVILEGES` (see
  `infra/db/init-cluster.sh`). After all files apply, the runner runs `RUNTIME_GRANTS_SQL` (idempotent):
  the tight `sync_app` footprint + the `platform_app` REVOKE on sync-internal tables. **You normally do
  not need to write GRANTs in a migration** — default privileges cover new `platform_owner` tables.

## The numbering rules (LOCKED)

1. **Format:** `NNNN_snake_case_description.sql`, zero-padded 4-digit prefix, one concept per file.
2. **Monotonic + unique from 0025 onward.** `0023` was consumed out-of-band by
   `0023_meeting_recordings.sql` (WS11 capture-edge work landed before this reservation could be
   drawn down) and `0024` was consumed by `0024_module_backfill.sql` (WSA-2 module registration
   backfill). Both merged before the ORG-CORE tickets started, so **the ORG-CORE reservation is
   rebased to 0025**: ORG-1 = `0025_rls_empty_set_hardening.sql`, ORG-2 =
   `0026_service_layer.sql`. The design doc
   (`docs/superpowers/specs/2026-07-17-org-core-shared-services-design.md`) has been updated to
   match (WS0-1, 2026-07-22). Take the next unused number; never reuse one.
   **2026-07-22 update (ORG-3):** `0027` was drawn down by
   `0027_service_assignment_unit_guard.sql` (ORG-3's security micro-migration — the
   `service_assignments.unit_id` composite-FK tenant guard), which merged before ORG-10 started.
   Per rule 5, **ORG-10's `module_hr` migration is rebased to `0028_module_hr.sql`** (not `0027` as
   previously recorded here). Whoever picks up ORG-10 next: use `0028`, and check this file again
   first in case a later ticket has since drawn that down too.
3. **Duplicate prefixes are FORBIDDEN going forward.** Two files must never share a numeric prefix.
   (See the grandfather clause for the two historical exceptions.)
4. **Never rename, renumber, edit, or delete a migration that has been applied to any database.**
   The ledger keys on the exact filename — renaming an applied file orphans its ledger row, so the
   runner re-applies the (renamed) file on the next boot and its DDL fails against the objects that
   already exist, breaking startup. Corrections ship as a **new, higher-numbered** migration.
5. **Coordinate numbers across parallel tickets.** If two in-flight tickets both need "the next
   number", the second to merge bumps to the following free slot. When in doubt, ask the coordinator.

## Grandfather clause — the two existing dual-prefix pairs

Two numeric prefixes are shared by two files each. Both pairs pre-date this protocol and are
**already applied on every existing database**, so they are LEFT AS-IS by design (renaming them would
orphan ledger rows and break boot per rule 4). They are safe because the runner keys on full filenames
and orders deterministically, and because within each pair the two files are **independent** (no
cross-dependency, so their relative order is immaterial):

| Prefix | Files (lexical run order) | Independence |
|---|---|---|
| `0003` | `0003_idp_subject.sql` → `0003_user_title.sql` | different tables/columns |
| `0018` | `0018_pipeline_portal.sql` → `0018_pm.sql` | portal alters `pipeline_runs`/`clients` (from 0017/0001); pm creates fresh `pm_*` — disjoint |

These are the **only** permitted duplicate prefixes, ever. No new duplicates.

## WS0-1 resolution of the 0018 collision (rationale of record)

The 0018 collision (`0018_pipeline_portal.sql` vs `0018_pm.sql`) was resolved by **formally accepting
deterministic dual-prefix lexical ordering** (the 0003 precedent), **not** by renumbering. The
decision was forced by the ledger state: both files were already recorded in `schema_migrations` on
the live dev DB, so a rename would have orphaned those rows and re-run the DDL on next boot (rule 4).
Accepting the ordering is ledger-safe, requires no stateful surgery on the dev DB, and was verified:

- **Fresh empty-DB migrate:** green — all 24 files applied in deterministic order (real runner against
  a throwaway `gaiada_migtest` DB), `0018_pipeline_portal.sql` before `0018_pm.sql`.
- **Existing dev-DB re-migrate:** `up to date` (no-op) against the live `gaiada_platform`.

Verification is repeatable: create a fresh DB owned by `platform_owner`, point `MIGRATE_DATABASE_URL`
at it, run `node dist/db/migrate.js`, confirm the ordered `applied:` list and exit 0, then drop it.
