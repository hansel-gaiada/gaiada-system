# webdesk/migrations — Zone B's own ledger (WSK-01)

**This ledger is separate from platform-nest's.** Design §04 (`docs/blueprints/webdesk-design.md`,
"D-1 · Two ledgers, never mixed"): Zone B owns its own migration ledger, applied by its own
migrator role against its own Postgres. Platform-nest's ledger, naming rules (it moved to
`YYYYMMDDHHMM_*` timestamps on 2026-08-25 — see its own `migrations/README.md`), and lints do
**not** govern this directory. Do not import that convention here.

## The naming rule for THIS ledger

```
NNNN_snake_case_description.sql        # four-digit sequential, starting 0001
```

Sequential, not timestamped — a deliberate choice for Zone B (small team, one project, no
history yet of the collision pressure that pushed platform-nest off sequential numbers). If this
ledger ever sees the same multi-concurrent-session pressure platform-nest documented (four
real collisions, described in painful detail in `platform-nest/migrations/README.md`), revisit
the scheme then — don't pre-emptively borrow platform-nest's timestamp fix, because doing so
would make the two ledgers indistinguishable by name and defeat the "never mixed" rule above.

Until then:

- **Reserve a number by creating the file before writing DDL**, and re-run
  `ls migrations | sort | tail` immediately before you actually write it — a number that was free
  five minutes ago may not be now if someone else is also touching this ledger.
- **Never rename, renumber, edit, or delete a migration that has been applied to any database.**
  The ledger (`schema_migrations`) keys on the exact filename; renaming an applied file orphans
  its ledger row and the runner re-applies the (renamed) file on next boot. Corrections ship as a
  new, higher-numbered file.
- **One concept per file.**
- **Content ownership:** the actual `0001_*.sql` (platform-core schema) and everything after it
  is a separate ticket's deliverable (WSK-03+), not this one. This directory currently holds only
  the runner and this README — that is deliberate, per WSK-01's scope.

## How the runner works

`migrate.mjs` (`npm run migrate`, reads `MIGRATE_DATABASE_URL`):

- **Discovery + ordering:** `readdirSync(migrations/).filter(f => f.endsWith('.sql')).sort()` —
  plain lexicographic order, deterministic and platform-independent. Same shape as
  platform-nest's runner, on purpose (a reader who knows one knows the other).
- **Ledger:** every applied file is recorded by its full filename in `schema_migrations
  (name text PRIMARY KEY, applied_at timestamptz)`. A file already in the ledger is skipped; a
  new file runs inside a single transaction, then is inserted into the ledger. Re-running the
  migrator against an up-to-date database is a no-op — **idempotent by construction.**
- **Privilege:** migrations run as the **`webdesk_migrator`** role (`MIGRATE_DATABASE_URL`), never
  as `webdesk_owner` and never as `webdesk_app`. `webdesk_app` is `NOBYPASSRLS` at runtime — see
  `../docker-compose.yml`'s `postgres` service and `../postgres/init-roles.sh` for how the three
  roles (`webdesk_owner` / `webdesk_migrator` / `webdesk_app`) get created and how default
  privileges hand new tables to the app role automatically (mirrors platform-nest's
  `ALTER DEFAULT PRIVILEGES` pattern — you should not normally need a `GRANT` inside a migration
  either).

## The RLS/backfill lint — adopted from platform-nest

`../scripts/lint-migration-rls.mjs` (wired into `npm test` via `npm run lint:migrations`) ports
platform-nest's migration-backfill RLS lint (`platform-nest/scripts/lint-migration-rls.mjs`,
"CONFIRMED BUG CLASS" header) to this ledger's own tenant GUC:

> Migrations run as `webdesk_migrator`, a `NOBYPASSRLS` role (design §04). A table under
> `FORCE ROW LEVEL SECURITY` gates every row on the `webdesk.tenant_ctx` GUC (`TENANT_GUC_NAME` in
> `.env.example`). During a migration that GUC is unset, so an `UPDATE`/`DELETE`/`INSERT ...
> SELECT` against an existing FORCE-RLS table silently matches **zero rows** — no error, ledger
> still records the file as applied. A bare `INSERT ... VALUES` is not in this bug class (it
> fails loudly against `WITH CHECK`, per the same reasoning as the platform-nest original).

The lint is pure static analysis over `migrations/*.sql` — no DB connection required, so it is
loud at authoring time. It flags a DML statement against a table that:

1. already carries `ALTER TABLE ... FORCE ROW LEVEL SECURITY` from an earlier file (or an earlier
   statement in the same file) that did **not** create that table in the same file, AND
2. has no `set_config('webdesk.tenant_ctx', ...)` (or `SET [LOCAL] webdesk.tenant_ctx`) call
   earlier in the same file.

A table `CREATE TABLE`'d in the same migration that also DML's it is exempt (zero pre-existing
rows by construction). `DO $$ ... $$` blocks are scanned (they execute during the migration);
stored-function/procedure bodies are not (they run later, under whatever GUC the *caller* set).

Run it directly with `npm run lint:migrations`, or `SELFTEST=1 node ../scripts/lint-migration-rls.mjs`
to exercise the detector against synthetic fixtures proving both directions (a real unguarded
backfill is flagged; a GUC-wrapped one and a function-body statement are not).

There is no baseline cutoff yet — this ledger has no applied migrations to grandfather. The first
real migration that needs a backfill against an already-FORCE-RLS'd table should follow
platform-nest's `0051_pm_short_codes_backfill_fix.sql` as the reference pattern: wrap the
statement with `PERFORM set_config('webdesk.tenant_ctx', <tenant>::text, true)` per tenant first.
