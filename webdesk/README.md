# webdesk — Zone B project skeleton (WSK-01)

**Status: PLANNED/IN PROGRESS.** This is the standalone compose-and-ledger skeleton for
**WebDesk**, the Zone B (internet-facing, multi-tenant) Website-Backend-as-a-Service platform.
Nothing in this repo is production. Build document:
[`../docs/blueprints/webdesk-design.md`](../docs/blueprints/webdesk-design.md) (v1.1) — read §00,
§03, §04, §11, §11a, §12 before touching anything here. Live ticket status:
[`../docs/plans/2026-08-26-webdesk-PROGRESS.md`](../docs/plans/2026-08-26-webdesk-PROGRESS.md).

## What this is

A **separate component project** (per the estate rule: separate projects, never a monorepo
package), deliberately not wired into `platform-nest`/`platform-ui`/anything else in this repo.
It stands up the Zone B stack's *shape*:

```
proxy (Caddy) ── payload (Payload 3, stub)
             └── api (NestJS, stub) ── worker (BullMQ, stub)
postgres (own DB, own ledger, own role split) ── minio ── redis ── clamav ── otel-collector
```

Every service except Postgres/MinIO/Redis/ClamAV/OTel-collector is a **placeholder process**
right now (`sleep infinity` with a log line naming the ticket that replaces it). The stack shape
is this ticket's deliverable, not working application code — WSK-02 vendors Payload, WSK-21
builds the api's control plane, WSK-07/10/11 build the media/forms/mail surfaces, WSK-28 wires
real observability.

## The zone rule

This is **Zone B**. It is internet-facing, multi-tenant, and physically/logically separate from
the ERP (**Zone A** — `platform-nest`, `platform-ui`, etc.). The design's defining hazard here is
cross-tenant leakage and the boundary itself (§00). Concretely, for this project:

- **Zero Zone A credentials or hostnames anywhere in this project.** No `platform-nest`
  connection string, no live ERP hostname, no Keycloak realm secret. Every control-channel value
  in `.env.example` is a local placeholder for auth work that lands at WSK-21/22 — see that
  file's own header for the exact rule and why.
- **This is its OWN compose project** (`name: webdesk` at the top of `docker-compose.yml`),
  deliberately separate from every Zone A compose project, so the estate's `--remove-orphans`
  trap (any container in the SAME project whose profile isn't in the current command gets
  deleted) cannot reach it — same precedent as the n8n project split.
- **Its own Postgres, its own MinIO, its own Redis** — no shared infrastructure with Zone A, ever.
- The one channel that will eventually cross A→B (the control-plane call, mTLS + Keycloak
  client-credentials + WS4 assertion) and the two that cross B→A (signed fact webhooks, write-only
  OTLP push) are specified in design §03 and land at WSK-21/22/28 — none of that exists in this
  skeleton.

## The ledger rule

Zone B owns its **own migration ledger**, starting at `0001`, applied by its own `webdesk_migrator`
role — **not** platform-nest's ledger, and **not** platform-nest's naming rule. Platform-nest
moved to timestamp-named migrations (`YYYYMMDDHHMM_*.sql`, 2026-08-25); that rule is scoped to
platform-nest only (design §04, "two ledgers, never mixed"). This ledger stays sequential
(`0001_`, `0002_`, ...) — see `migrations/README.md` for the full naming/runner/lint rules.

`migrations/migrate.mjs` (`npm run migrate`) is the runner: applies `*.sql` files in ascending
filename order, records each in a `schema_migrations` ledger table, skips anything already
applied. Idempotent by construction — proven by running it twice against a disposable database
(see "What was verified" below).

`npm run lint:migrations` runs the RLS/backfill lint ported from platform-nest
(`scripts/lint-migration-rls.mjs`, adapted to this ledger's own `webdesk.tenant_ctx` GUC) — it
statically flags any migration statement that would silently write zero rows to a FORCE-RLS table
because the tenant GUC was never set in that file. Wired into `npm test`.

## Ports — the webdesk dev port block

`8380`–`8389`, chosen to avoid every published estate port (`platform-nest` :3004, `platform-ui`
:3005, `ai-gateway-go` :3002, `agent-runner` :3006) and the WSK-00 RLS-spike Postgres (:55432).
See `.env.example` for the full list and what each port fronts.

## Run it

```sh
cp .env.example .env      # never commit .env — see ../.gitignore
docker compose --profile dev up -d
docker compose --profile dev ps
```

Everything lives under the `dev` profile — a bare `docker compose up` with no profile starts
nothing, mirroring the estate's `COMPOSE_PROFILES` convention. To apply migrations once Postgres
is healthy:

```sh
npm install
npm run migrate     # reads MIGRATE_DATABASE_URL from your environment/.env
```

Tear down: `docker compose --profile dev down -v` (the `-v` also drops the dev volumes — this is
a throwaway dev stack, not anything holding real data).

## Test

```sh
npm test        # currently == npm run lint:migrations
```

## Known integration seam with WSK-03 (flagged, not fixed here)

`migrations/0001_platform_core.sql` (WSK-03's deliverable, landed in this shared checkout while
this ticket was in flight) contains its own "section 1" — role creation
(`webdesk_owner`/`webdesk_migrator`/`webdesk_app`) and `ALTER DATABASE ... OWNER TO webdesk_owner`
— run inline as part of the migration, because no cluster-init script existed yet when it was
written. Its own header says so explicitly: *"When WSK-01 lands a cluster-init script, hoist
section 1 out to it verbatim and this file should start directly at section 2."*

This ticket's scope was the skeleton only (compose/runner/lint/env/README), not editing another
ticket's migration content, so `postgres/init-roles.sh` (this ticket's cluster-init script) was
**not** made to replicate that exact role model, and `0001_platform_core.sql` was left untouched.
The two are not yet composed: running `npm run migrate` against a freshly-initialized container
today applies `postgres/init-roles.sh`'s own (simpler, LOGIN-owner) role bootstrap, and
`0001_platform_core.sql`'s inline section 1 then fails on `GRANT`/`ALTER DATABASE` (permission
denied) because `webdesk_migrator` isn't a superuser and isn't the database owner under this
bootstrap's model. Verified concretely: applying `0001_platform_core.sql` as-is against this
skeleton's Postgres fails at the `GRANT webdesk_owner TO webdesk_migrator` step; the failure
rolls back cleanly (no partial schema, ledger untouched) — the generic runner mechanism itself
(discovery, ledger, transaction wrapping, idempotent re-run) was verified separately against an
isolated probe database and a throwaway migration, and is not in question.

**Whoever picks up WSK-03 (or a coordinating ticket) needs to do the mechanical hoist** the
file's own comment describes: move its section 1 into `postgres/init-roles.sh` (this project's
already-correct place for a superuser-run bootstrap) and trim `0001_platform_core.sql` to start
at section 2. That is a coordination task across two tickets' deliverables, not something this
ticket should have guessed at unilaterally in a shared, concurrently-edited checkout.
