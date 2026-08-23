# CLAUDE.md — platform-nest

Scope: `platform-nest/` — **THE platform backend**. NestJS on the **Fastify adapter**, port
`3004`. Standalone project; the repo root is deliberately not a monorepo. Root `../CLAUDE.md`
carries program-wide rules; this file governs here.

The Fastify adapter is kept on purpose: it preserves the perf profile **and** `app.inject(...)`,
so the pre-port test suite still runs against the Nest app as a contract-parity oracle.
`buildApp()` (`src/main.ts`) is the testable seam; `bootstrap()` is the process.

## Commands

```
npm ci                       # node_modules may be absent; tsc/vitest are not global
npm run typecheck            # tsc --noEmit
npm test                     # vitest run — needs DATABASE_URL_TEST (see below)
npx vitest run src/modules/pm/pm.test.ts            # one file
npx vitest run src/core/approvals.test.ts -t "name" # one case
npm run build && npm start   # tsc, then node dist/main.js
npm run migrate              # node dist/db/migrate.js (bootstrap() also migrates on boot)
npm run lint:withtenants     # RLS-discipline linters — treat as gates, not suggestions
npm run lint:migration-rls
npm run gen:role-bundles     # regenerates Cerbos role bundles from the permission catalog
```

Seeds: `seed:agency` (first-deploy vertical), `seed:personas`, `seed:departments`,
`seed:automation`, `seed:claude-seats`, `seed:search`, `seed:portal-clients`.

### Tests need real infrastructure

- **`DATABASE_URL_TEST`** — a **superuser** URL to a disposable Postgres. Suites *skip silently*
  without it, so "all green" can mean "nothing ran". Check the skip count.
- **Cerbos must be running with published ports** (`-p 3592:3592 -p 3593:3593`). A portless
  container fails every authz check.
- `src/testing/setup.ts` gives **every test file its own physical database** (name = hash of the
  file path, recreated `WITH (FORCE)`). Fixtures reuse literal emails like `admin@a.test` against
  a globally-unique `users.email`, so a shared schema can never pass a full run. Don't "optimize"
  this to a shared DB or re-enable `fileParallelism`.
- The harness then repoints the app at a **NOSUPERUSER NOBYPASSRLS** role (`platform_app_test`) —
  a superuser bypasses RLS and would test nothing.

## The three walls of isolation (D5) — the core invariant

1. **`withTenants(tenantIds, fn, {modules})`** (`src/db/index.ts`) is the *only* way to touch
   tenant data. It opens a transaction and sets `app.current_tenant_ids` via
   `set_config(..., true)` (SET LOCAL semantics) so a pooled connection can never leak tenant
   context between requests. `withGlobal` is the deliberate escape hatch — justify each use.
2. **`opts.modules`** sets the `app.scopes` GUC. Module-owned tables compose their policy as
   `tenant_id = ANY(app_current_tenants()) AND app_module_allowed('<mod>')`. **Omit it and those
   tables read/write ZERO rows with no error** — fail-closed by construction, and the single most
   common way a handler "mysteriously returns nothing". Core tables have no such predicate.
3. **FORCE RLS in Postgres**, enforced against the app role.

Consequences worth internalizing before writing a migration or a backfill:

- **A backfill or a verification query with no BYPASSRLS role and an unset GUC returns zero rows
  and reports success.** Set the tenant context explicitly, then assert a row count.
- `npm run lint:withtenants` and `lint:migration-rls` exist because these failures are silent.
- `jsonb_set(..., create_missing := true)` creates only the **last** path segment — no ancestors.
- `UNIQUE (company_id, name)` never constrains rows where `company_id IS NULL` (SQL NULLs are
  distinct). Global rows need a partial unique index.
- Unordered `LIMIT 1` constraint lookups in a migration pass locally and pick a different row on
  the server. Order explicitly.

## Seeds — the rename trap

**Renaming anything a seed resolves BY NAME requires a migration.** `agency.ts`'s `ensureCompany()`
/ `ensureUser()` / `ensureClient()` are all `SELECT ... WHERE name = $1`, else `INSERT`. So changing
a name in the seed does **not** rename the row on an existing database — it creates a SECOND one and
leaves the original holding all the history. Every test still passes, because `testing/setup.ts`
gives each file a FRESH database where the seed creates the row from nothing and the new name is
simply the name.

This shipped once (`Sanur Resort` → `Viceroy Bali`, caught on the live box before the seed was run;
migration `202608230612` fixes it in place). When you rename, write the migration in the same change,
and test it against a database that **already has the old name** — a fresh-DB assertion passes with
the migration deleted.

**Before running any seed against a real estate, look at what is already there — and make sure the
look is not lying to you.**

⚠ **`set_config(..., true)` inside `withGlobal` IS A NO-OP.** `is_local = true` scopes a setting to
the current transaction, and `withGlobal` opens none (it just leases a client), so each statement is
its own implicit transaction and the GUC is gone before the next query runs. Every RLS-guarded count
then returns **zero and reports success**. This produced a confident, wrong survey of production on
2026-08-23 ("the estate is clean") which was then used to justify a design decision; the estate
actually held 4 clients, 17 projects, 8 invoices and 19 employee rows. Use `withTenants` — it opens
the transaction — and pass `{ modules: [...] }` for module-owned tables.

⚠ **Grep is not a census.** `grep "INSERT INTO employees"` over `src/` finds only tests, and that was
read as "nothing has ever written to this table". Nineteen rows existed; the department seed reaches
the table through a helper. Ask the database what a table contains, never the source.

`seed:agency` is a full demo vertical (clients, projects, invoices, IT devices, files). For "give
these people access" use `seed:roster-access`, and for HR records `seed:employee-files` — not because
production is clean (it is not), but because access, employment and business data are separable
changes and should stay that way.

## Migrations

`migrations/NNNN_*.sql`, applied in order by `src/db/migrate.ts` (and on every boot).
**The head, the next free number and the dead reservations are in `../docs/MAP.md`** (generated —
this file deliberately does not name them, because a hardcoded head is stale within a day).
**Reserve your number by creating the file** — concurrent sessions share this checkout and collide
otherwise, and the unused numbers below head are dead reservations, not gaps to backfill.
Tenant-scoped FKs are mixed (some composite, some not) — match the table you're extending rather
than "fixing" its neighbours.

## Authorization

**Cerbos is authoritative.** `src/rbac/` holds the policy-side plumbing plus the alignment
suites that keep the DB permission catalog, the Cerbos policy, and each module's declared
permissions in agreement (`npm run test:iam-chain-alignment`). `docs/PERMISSION-CONTRACT.md` is
the frozen Phase 1 contract other departments build against — changing a permission name is a
contract change.

- **`validateModulePermissions()` refuses boot** if any `ModuleContract.permissions` entry
  doesn't resolve to a `class='grantable'` catalog row. That guard is the point; don't soften it.
- Automation/bot principals are deliberately rows in `users` — Cerbos authorizes *principals*,
  and a second principal table would fork every policy.
- Every automation principal is minted `assurance: "low"` by construction.
- `isElevated` means owner/superadmin, **not** staff.

## Modules

`src/modules/registry.ts` + `contract.ts`. Registered in `bootstrap()`:
`agency · pm · it · billing · clients · knowledge · automation-console · hr · assistant ·
search · reports · webdev`. A module contributes routes, permissions, event handlers, rollup
providers and `mcpTools` (aggregated by the hub over `GET /mcp/tool-defs` — nothing is hardcoded
hub-side).

`isModuleEnabled(tenant, key)` is true when the key is in the company's `enabled_modules` **OR**
an *active* `service_assignment` serves it to that tenant (the shared-service path; the served
company's own `enabled_modules` is never mutated). That OR-clause lives in exactly one query on
purpose — the guard, the event consumer and the rollups engine all call it, so a second
hand-written copy is how a served tenant ends up authorized on one path and denied on another.

## Events

Transactional **outbox → Redis Streams relay → consumers**. `outbox_events` doubles as the
sync-engine's `sync_outbox`, and HLC is stamped on every emit (`src/events/hlc.ts`;
`seedClockFromDb` on boot so a restart can't regress the clock).

Background loops in `bootstrap()` are **each individually gated** and most are dark by default.
Redis-gated: relay, module consumer, service-assignment reconciler, n8n bridge, graph bridge,
work-activity consumer. Plain-Postgres sweeps outside that gate: drift sweep, burndown snapshots,
IT stale reaper, search pull scheduler, mail sender. Two rules that have already broken:

- **A registered event handler whose entity-type stream is not in the `startConsumerLoop([...])`
  list is never invoked** — the event is written, relayed, and read by nobody. Add the stream.
- The search pull scheduler **spends vendor money**, so its flag is a hard gate, not a perf opt-in.

## Error filters — order is not cosmetic

`app.useGlobalFilters(...)` in `main.ts`: Nest **reverses** the array before storing it, so the
**first argument is checked last**. `LastResortExceptionFilter` (`@Catch()`, matches everything)
must therefore stay **first in the list** to be genuinely last-resort; "tidying" it to the end
silently shadows every other filter. The type-scoped filters (`HttpErrorFilter`,
`ProviderDispatchErrorFilter`, `GatewayNotConfiguredErrorFilter`, `GoogleOAuthErrorFilter`,
`ClientAccessErrorFilter`) may sit in any order among themselves. Error bodies are
`{ error: msg }` — the UI and bot read `.error`.

A plain `Error` thrown from a module escapes as a body-less 500 unless a filter maps it. That has
been the same bug four times; add the error to a typed family rather than a one-off try/catch.

## Boot-time refusals (deliberate)

Simulated-vs-live provider provenance, live vendor base URLs pointed at private hosts, live
Google endpoints pointed at a private issuer, and `SEARCH_ADS_WRITE_MODE=live` with no live
executor are all **boot errors, not warnings** — the reasoning is that a request-time failure
happens *after* a one-shot approval has been spent. Keep them at boot and keep
`wireSearchProviderModeAndAdsWriteMode`'s two SM-26 lines at function scope, outside the
mode branch (they were nested once, and the guard read as enforced while enforcing nothing).

## Contracts you must keep in sync

- `../docs/FRONTEND-BFF-CONTRACT.md` — update the relevant § when you add or change an endpoint
  the UI consumes.
- `../docs/PERMISSION-CONTRACT.md` — the IAM Phase 1 freeze.
- `../docs/modules/MODULES.md` + `../docs/modules/CHANGELOG.md` — bump the module, append an
  entry. Vocabulary is `PLANNED · IN PROGRESS · PROTOTYPED · DEV-VERIFIED`; nothing is production.
- `lib/reports.ts` in `platform-ui` is the canonical `ReportDocument` shape —
  `src/modules/reports/report-document.ts` mirrors *it*, not the reverse.

## Local + live verification

Bring the backend up with **both** compose files, or `platform:3004` is unpublished and the
host-run UI can't reach it:

```
docker compose -f ../infra/compose/docker-compose.vps.yml \
               -f ../infra/compose/docker-compose.local.yml up -d
```

On the server, Postgres and Redis run on the **host**, so the VPS compose file alone is an
invalid project — see `../infra/CLAUDE.md`. To verify against the live API as a real user, use
`../scripts/sso-login.sh` (real auth-code + PKCE, no Keycloak change). Only ~7 platform users
have Keycloak accounts — a `users` row is not a login.
