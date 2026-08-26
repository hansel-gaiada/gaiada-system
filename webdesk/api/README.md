# webdesk/api — WSK-05 (API keys)

Zone B NestJS service (Fastify adapter). This ticket built: API key mint/rotate/revoke, the
scoped-auth guard that resolves a key into `{tenant, env, scope}` and runs the request under the
`webdesk.tenant_ctx` GUC, per-tenant read quotas, and a minimal demonstrative content route to
prove the guards actually gate something real. Status: **DEV-VERIFIED** against a throwaway
Postgres — see the verification runbook below. Not wired into `../docker-compose.yml` (that file
is WSK-01's; see the ticket report for why and what changes it needs).

## Layout

- `src/db/` — `tenant-context.ts` (AsyncLocalStorage, anchored on `globalThis`) +
  `tenant-pool.ts` (the `pg.Pool` subclass that stamps/scrubs `webdesk.tenant_ctx` /
  `webdesk.platform_ctx` on every checkout/release) + `db.service.ts`/`db.module.ts`.
- `src/crypto/api-key-hash.ts` — key generation + `sha256(key + pepper)`.
- `src/api-keys/` — mint/rotate/revoke service + controller (`/internal/tenants/:tenantSlug/api-keys`).
- `src/auth/` — `ApiKeyAuthGuard` (resolves the key, sets tenant context) + `ScopeGuard` +
  `RequireScope` decorator.
- `src/rate-limit/` — `TenantQuotaService` (in-memory fixed window, per tenant) + `TenantQuotaGuard`.
- `src/content/` — a minimal read/write content route wired behind the three guards above, to
  prove the middleware actually gates a "content route" end to end. The real `/v1` envelope
  (vocabulary, blocks, locale) is WSK-06's frozen design — this is not it.
- `src/tenants/tenant-lookup.service.ts` — resolves a tenant slug to an id under
  `webdesk.platform_ctx` (the one legitimate cross-tenant read in this service).
- `test/` — the scope matrix, revoked-key probe, no-key probe, plaintext dump-grep proof, per-tenant
  quota tests, and a direct `TenantAwarePool` leak probe (mirrors WSK-00's P13).

## Required env vars this ticket needs that are not yet in `../.env.example`

`.env.example` is WSK-01's file (out of this ticket's scope to edit) — reported here instead:

- `API_KEY_PEPPER` — the server pepper for `sha256(key + pepper)`. Never in the DB, never in git.
- `WEBDESK_READ_QUOTA_PER_MIN` (default `300`) / `WEBDESK_READ_QUOTA_WINDOW_MS` (default `60000`)
  — the per-tenant content-read quota.
- `WEBDESK_API_INTERNAL_PORT` (default `3000`) / `WEBDESK_API_DB_POOL_MAX` (default `10`) — optional.

## Known gap, flagged loudly

`/internal/tenants/:tenantSlug/api-keys*` has **no caller authentication of its own**. The real
control channel (mTLS + Keycloak client-credentials + Cerbos scopes + a WS4 assertion) is
WSK-21/22's build, not this ticket's. Until that lands, this controller must not be reachable
through the public proxy vhost — see `api-keys.controller.ts`'s header comment.

## Verification runbook (what this ticket actually ran)

```bash
# 1. Fresh throwaway Postgres, on a port that isn't 55432 (WSK-00's spike) or 55434.
cd webdesk
MSYS_NO_PATHCONV=1 docker run -d --name wsk05-db -p 55450:5432 \
  -e POSTGRES_PASSWORD=throwaway_superuser -e POSTGRES_DB=webdesk \
  -e POSTGRES_OWNER_USER=webdesk_owner -e POSTGRES_OWNER_PASSWORD=throwaway_owner \
  -e POSTGRES_MIGRATOR_USER=webdesk_migrator -e POSTGRES_MIGRATOR_PASSWORD=throwaway_migrator \
  -e POSTGRES_APP_USER=webdesk_app -e POSTGRES_APP_PASSWORD=throwaway_app \
  -v "$(pwd -W)/postgres/init-roles.sh:/docker-entrypoint-initdb.d/10-init-roles.sh:ro" \
  postgres:16-alpine

# 2. Apply the project's own migrations with its own runner.
MIGRATE_DATABASE_URL="postgres://webdesk_migrator:throwaway_migrator@localhost:55450/webdesk" \
  node migrations/migrate.mjs

# 3. Run this ticket's suite (api/package.json's "test" script).
cd api && npm install && npm run typecheck && npm test

# 4. Tear down.
docker rm -f wsk05-db
```

`WSK05_TEST_DATABASE_URL` overrides the app-role connection string the tests use, in case 55450
is ever taken by something else.
