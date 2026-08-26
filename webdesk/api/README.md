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
- `src/mail/` (WSK-11) — the C-03 mail service: provider adapter (`provider/`, SMTP via
  nodemailer + a dev-log fallback), `identity.ts` (THE IDENTITY RULE — Zone B's one sending
  identity, structurally incapable of referencing a Zone A stream), per-tenant template rendering
  under RLS, suppression checks (enqueue-time + worker-time), and `mail-sender.processor.ts` (the
  BullMQ worker: retry + exponential backoff).
- `src/queue/` (WSK-11) — shared BullMQ/Redis connection wiring, consumed by `src/mail/`.

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

---

## Mail (WSK-11) verification runbook — copy-pasteable, from a cold start

This ticket's suite is a SEPARATE Nest bootstrap (`test/helpers/mail-app.ts`, importing only
`DbModule` + `MailModule` — it does not depend on `MailModule` being wired into the shared
`AppModule`) but the SAME Zone B Postgres schema as WSK-05 above, plus a real Redis (BullMQ) and a
real Mailpit (the dev mail sink). All three are throwaway containers, torn down after.

**Every env var below is read by its REAL name — the name `mail.config.ts`/`queue.config.ts`/
`config.ts` actually call `process.env.X` with.** Earlier revisions of these specs read a
`WSK11_`-prefixed shadow variable instead (e.g. `WSK11_APP_DATABASE_URL`), so exporting the
*real* `APP_DATABASE_URL` had no effect — that indirection is gone; every spec now does
`process.env.X = process.env.X || "<default>"`, so exporting the real name here is guaranteed to
be honored.

```bash
cd webdesk

# 1. Fresh throwaway Postgres — SAME role bootstrap as WSK-05's runbook above, port 55450.
#    (If you already have wsk05-db running on 55450 from the WSK-05 runbook, reuse it — same
#    schema, same migrations — and skip straight to step 4.)
MSYS_NO_PATHCONV=1 docker run -d --name wsk11-db -p 55450:5432 \
  -e POSTGRES_PASSWORD=throwaway_superuser -e POSTGRES_DB=webdesk \
  -e POSTGRES_OWNER_USER=webdesk_owner -e POSTGRES_OWNER_PASSWORD=throwaway_owner \
  -e POSTGRES_MIGRATOR_USER=webdesk_migrator -e POSTGRES_MIGRATOR_PASSWORD=throwaway_migrator \
  -e POSTGRES_APP_USER=webdesk_app -e POSTGRES_APP_PASSWORD=throwaway_app \
  -v "$(pwd -W)/postgres/init-roles.sh:/docker-entrypoint-initdb.d/10-init-roles.sh:ro" \
  postgres:16-alpine

# 2. Redis (BullMQ), port 55451.
docker run -d --name wsk11-redis -p 55451:6379 redis:7-alpine

# 3. Mailpit (the dev mail sink) — SMTP on 55452, HTTP evidence API on 55453.
#    The container NAME matters: test/mail-retry-backoff.spec.ts stops/starts it by name (real
#    docker stop/start, not a mock) to prove retry+backoff against a real sink going down and
#    recovering. If you name it anything else, export MAILPIT_CONTAINER_NAME to match — the spec
#    detects the container up front and SKIPS with a clear console message if it can't find it,
#    it does not hang.
docker run -d --name wsk11-mailpit -p 55452:1025 -p 55453:8025 axllent/mailpit:latest

# 4. Apply migrations with the project's own runner (idempotent — a no-op if wsk05-db already
#    had them applied).
MIGRATE_DATABASE_URL="postgres://webdesk_migrator:throwaway_migrator@localhost:55450/webdesk" \
  node migrations/migrate.mjs

# 5. The RLS integrity gate must stay green.
DATABASE_URL="postgres://webdesk_migrator:throwaway_migrator@localhost:55450/webdesk" \
  node scripts/check-rls-integrity.mjs

# 6. Run the mail suite. Every env var the specs read, exported explicitly (values match the
#    containers above — change them together if you used different ports/names).
cd api
APP_DATABASE_URL="postgres://webdesk_app:throwaway_app@localhost:55450/webdesk" \
MIGRATE_DATABASE_URL="postgres://webdesk_migrator:throwaway_migrator@localhost:55450/webdesk" \
REDIS_URL="redis://localhost:55451" \
MAIL_SMTP_HOST="localhost" \
MAIL_SMTP_PORT="55452" \
MAILPIT_HTTP_URL="http://localhost:55453" \
MAILPIT_CONTAINER_NAME="wsk11-mailpit" \
  npx vitest run test/mail-zone-a-isolation.spec.ts test/mail-suppression.spec.ts \
    test/mail-delivery-mailpit.spec.ts test/mail-template-rls.spec.ts \
    test/mail-log-immutability.spec.ts test/mail-retry-backoff.spec.ts

# 7. Tear down.
cd ..
docker rm -f wsk11-db wsk11-redis wsk11-mailpit
```

### Every env var the mail suite reads (exact names)

| Var | Read by | Default if unset | Notes |
|---|---|---|---|
| `APP_DATABASE_URL` | `DbService` (via `config.ts`), and `test/helpers/mail-fixtures.ts`'s app-role DELETE probe | `postgres://webdesk_app:throwaway_app@localhost:55450/webdesk` | The Zone B app-role connection string. **This is the one that broke the first reproduction** — see the note above. |
| `MIGRATE_DATABASE_URL` | `migrations/migrate.mjs`, and every fixture helper (`test/helpers/fixtures.ts`, `mail-fixtures.ts`) that seeds rows as the migrator role | `postgres://webdesk_migrator:throwaway_migrator@localhost:55450/webdesk` | Same var WSK-05's own runbook uses. |
| `REDIS_URL` | `src/queue/queue.config.ts` | `redis://localhost:6379` (the specs override their own default to `:55451` — see the file headers) | BullMQ connection. |
| `MAIL_PROVIDER` | `src/mail/mail.config.ts` | `dev-log` | Every spec hardcodes this to `smtp` itself (they need a real send) — not yours to set. |
| `MAIL_SMTP_HOST` / `MAIL_SMTP_PORT` | `src/mail/mail.config.ts` | `mailpit` / `1025` (the specs override their own default to `localhost` / `55452`) | Where the SMTP adapter connects — must point at Mailpit's SMTP port. |
| `MAIL_FROM_ADDRESS` / `MAIL_FROM_NAME` | `src/mail/mail.config.ts` / `src/mail/identity.ts` | `no-reply@forms.gaiada.invalid` / `Gaiada WebDesk Forms` | Most specs hardcode the address themselves (their own assertions depend on the exact value) — not yours to override for those; `mail-zone-a-isolation.spec.ts` deliberately DOES override it per-test to probe the Zone A denylist. |
| `MAILPIT_HTTP_URL` | `test/helpers/mailpit-client.ts` | `http://localhost:55453` | Mailpit's evidence-surface HTTP API, not its SMTP port. |
| `MAILPIT_CONTAINER_NAME` | `test/mail-retry-backoff.spec.ts` only | `wsk11-mailpit` | The exact docker container name that spec stops/starts. Wrong name (or none running) → the spec **skips with a console message**, it does not hang (fixed 2026-08-26; the earlier version could stall for hours on a missing container). |
| `MAIL_QUEUE_NAME` / `MAIL_QUEUE_MAX_ATTEMPTS` / `MAIL_QUEUE_BACKOFF_DELAY_MS` | `src/mail/mail.config.ts` | — | Every spec sets these itself (a unique queue name per file, small attempt/backoff numbers for test speed) — **not meant to be overridden**; each file's own value is part of what makes its assertions correct. |
| `NODE_ENV` | `mail-app.ts`'s logger level | `test` (all specs set it if unset) | Cosmetic (log verbosity) only. |

### Cold-start reproduction (actually run, 2026-08-26, following this runbook verbatim after the fixes above)

No pre-existing `wsk11-*` containers (`docker ps -a` checked first). Steps 1–3 (fresh Postgres/
Redis/Mailpit) → step 4 (migrate: `5 file(s) discovered, 5 applied, 0 already in the ledger`) →
step 5 (`check-rls-integrity.mjs`: `OK — 14 tenant-scoped table(s) intact`) → step 6, run
EXACTLY as written above (only the documented env vars exported, nothing else). Real `vitest`
output (file order is vitest's own, not the command-line order):

```
✓ test/mail-zone-a-isolation.spec.ts (12 tests) 2060ms
✓ test/mail-retry-backoff.spec.ts (1 test) 4195ms
✓ test/mail-delivery-mailpit.spec.ts (3 tests) 1313ms
✓ test/mail-suppression.spec.ts (3 tests) 6039ms
✓ test/mail-log-immutability.spec.ts (3 tests) 1078ms
✓ test/mail-template-rls.spec.ts (3 tests) 917ms

 Test Files  6 passed (6)
      Tests  25 passed (25)
   Duration  23.25s
```

`check-rls-integrity.mjs` re-run afterward: still `OK — 14 tenant-scoped table(s) intact`.

**Missing-container skip proof** (the 2.8-hour-hang fix, separately verified against the same
live containers): `MAILPIT_CONTAINER_NAME="this-container-does-not-exist" npx vitest run
test/mail-retry-backoff.spec.ts` → `1 skipped`, with the console message quoted in the env-var
table above, total wall time `real 0m3.279s` (`time` builtin) — a fast, obvious skip, not a stall.

Containers torn down (`docker rm -f wsk11-db wsk11-redis wsk11-mailpit`) after the run.

---

## Forms (WSK-10) — the web3forms-kill endpoint

`src/forms/**` — the public, unauthenticated `POST /v1/t/:tenantSlug/forms/:formId/submit`
endpoint: per-tenant CORS origin allowlist, Turnstile verify (env-swappable dev stub), honeypot,
per-IP + per-form rate limits, size caps, a zod schema derived from `form_defs.schema`, sanitize,
persist under RLS, per-submission consent record (WSK-D22c), file attachments via WSK-07's PRIVATE
`uploads` bucket + ClamAV, notification/autoresponder mail via WSK-11's `MailService`, and a
retention purge sweep.

### Endpoint path deviates from the literal ticket brief — and why

The ticket brief's literal path is `POST /v1/forms/:formId/submit`. The actual route this ticket
ships is **`POST /v1/t/:tenantSlug/forms/:formId/submit`** — matching content/media's own
`v1/t/:tenantSlug/...` convention, not the brief. This is forced by the frozen schema, not a style
choice: `form_defs`'s `tenant_isolation` RLS policy (0003_forms.sql) is single-mode
(`tenant_id = webdesk_tenant_ctx()`) with **no** `OR webdesk_platform_ctx()` escape the way
`tenants`/`audit_entries` get in 0001 — so there is no way to read a `form_defs` row by id alone
before a tenant context already exists. The tenant slug has to be resolved first (exactly like
`PublicTenantGuard` does for media's public routes), which means it has to be in the URL. See
`src/forms/form-lookup.service.ts`'s header for the full reasoning. `OPTIONS
/v1/t/:tenantSlug/forms/:formId/submit` is the paired CORS-preflight route.

### What's built

- `form-context.guard.ts` — resolves `:tenantSlug` → tenant context (reuses `TenantLookupService`,
  WSK-05), resolves `:formId`'s `form_defs` row **under** that context, derives the per-tenant CORS
  origin allowlist from the form's site's `environments.domain` rows (see "underspecified" below),
  and 403s a missing/mismatched `Origin` header. Sets the CORS response headers on success for both
  the preflight and the real request.
- `form-rate-limit.guard.ts` + `form-rate-limit.service.ts` — Redis-backed fixed-window counters,
  per IP **and** per form (both independently enforced, both fail CLOSED on a Redis error — same
  doctrine as `media/clamav.service.ts`).
- `turnstile/` — `TurnstileVerifier` interface + `StubTurnstileVerifier` (default everywhere;
  accepts exactly one configured token, refuses everything else — including empty/missing, so the
  abuse battery can prove the seam actually fails) + `CloudflareTurnstileVerifier` (built, wired,
  **never activated** — `TURNSTILE_MODE` defaults to `stub` and this ticket sets it nowhere else;
  real keys are on the Staging Reopen Register, not this ticket's to activate).
- `honeypot.ts` — a per-form-overridable hidden field name (default `_hp`); a tripped honeypot
  returns the SAME success shape as a real submission (`{ ok: true }`, no `id`), before Turnstile
  is even called, so a bot never learns anything and never costs a Turnstile verification.
- `form-schema.service.ts` — builds a zod object schema from `form_defs.schema.fields` per request
  (not cached — the schema is tenant-editable data with no invalidation signal to key a cache on).
  Unknown keys are dropped (zod's default, not `.passthrough()`), which is most of what "hostile
  payload stored inert" relies on.
- `sanitize.ts` — strips `<script>` blocks and all remaining tags from every string field before
  storage. SQL injection is prevented structurally (every query in this module is parameterized);
  this file's job is markup, not SQL.
- `consent.ts` — `consent: true` is REQUIRED on every submission (not merely on forms whose author
  added a consent-typed field), stamped against `form_defs.consent_notice_version` (the real
  column) and `form_defs.schema.consentNotice.text` (a jsonb convention this ticket invented — see
  "underspecified" below), both falling back to a generic default so the `NOT NULL` columns are
  never blank.
- `submissions.repository.ts` / `submissions-purge.service.ts` — the insert path and the retention
  sweep. The sweep SCRUBS (`payload -> '{}'`, a tombstone consent text, `status -> 'purged'`)
  rather than deleting — a design choice, not a mandated one; see the service's own header. NOT
  wired to any scheduler — `main.ts`/the `worker` service's BullMQ bootstrap is out of this
  ticket's owned scope, same gap WSK-11 flagged for its own mail worker.
- File attachments reuse `MediaService.upload()` **in-process** (never a bespoke upload path) with
  a synthetic `ResolvedApiKey`-shaped object (`envId`/`envName`/`apiKeyId`/`scope` are typed but
  unused by `upload()` — only `tenantId`/`siteId` matter at runtime) — inherits WSK-07's size/mime
  sniff/ClamAV/quota pipeline for free, targeting the PRIVATE `uploads` bucket only.

### `0003_forms.sql` / §11 — what was underspecified (read before building on top of this)

- **No CORS-config column anywhere.** The design says "per-tenant CORS origin allowlist" but the
  frozen schema has no dedicated place to store one. This ticket derives it from
  `environments.domain` (both `staging` and `production`) — the closest existing concept to "which
  origins are legitimately this tenant's site." A dedicated `form_defs.allowed_origins` or
  `sites.allowed_origins` column would be a cleaner long-term home; flagged for senior-db, not built
  here (migrations are out of scope).
- **`form_defs` has `consent_notice_version` but NO `consent_notice_text` column**, even though
  `submissions.consent_notice_text` is `NOT NULL` and the 0003 header comment explicitly frames
  `consent_notice_version` as "what a new submission stamps itself with." This ticket stores the
  actual notice text at `form_defs.schema.consentNotice.text` (jsonb, no DDL needed) — workable, but
  a real `form_defs.consent_notice_text` column is the honest fix. Flagged, not built.
- **`form_defs.schema`'s shape for FORMS is this ticket's own invention** — nothing upstream (§05's
  vocabulary is for Payload content blocks, a different concept) defines a field-list contract for
  forms. See `form-schema.service.ts`'s `FormFieldDef`/`FormSchemaDef` types for the convention this
  ticket adopted (`fields: [{key,type,required,maxLength,...}]`, plus `honeypotField`,
  `consentNotice`, `attachments`). A future ticket that builds the console's form-builder UI should
  treat this as a starting proposal, not a frozen contract.
- **The wire body shape for `POST .../submit`** (`{ fields, consent, turnstileToken, attachments,
  <honeypotField> }`) is likewise this ticket's own design — nothing specifies it. Attachments are
  base64-in-JSON (`{ filename, contentType, contentBase64 }`), the same convention `media/dto.ts`
  already uses, for the same reason: a streaming multipart parser is a `main.ts` bootstrap change,
  out of this ticket's owned scope.
- **`request.ip` trusts the raw socket address** (`form-rate-limit.guard.ts`) — Fastify's
  `trustProxy` option is a `main.ts`/`app.ts` bootstrap concern, out of scope here. Behind a real
  reverse proxy without `trustProxy` configured, every request will appear to come from the proxy's
  own address and the per-IP limiter degrades to a per-box limiter. Flagged for whoever wires the
  real ingress.

### Required `app.module.ts` change (not made here — out of this ticket's owned scope)

```ts
import { FormsModule } from "./forms/forms.module";
@Module({ imports: [..., FormsModule] })
```

### Required `package.json` change (made here, flagged loudly)

Two dependencies were added to `webdesk/api/package.json` — `zod` (net-new; the ticket's own AC
says "zod schema derived from `form_defs.schema`") and `ioredis` (promoted from a transitive
dependency of `bullmq` to an explicit one, since `form-rate-limit.service.ts` imports it directly
rather than relying on hoisting). `package.json` is not on the ticket's explicit "do not edit" list
and no other in-flight worker appears to own it, but this is flagged here in case the coordinator
wants to review the addition before it ships alongside other concurrent work on this checkout.

### Required env vars this ticket needs that are not yet in `../.env.example`

`.env.example` is WSK-01's file (out of this ticket's owned scope) — reported here instead, exact
names, all read as live getters (`forms.config.ts`):

| Var | Default | Purpose |
|---|---|---|
| `WEBDESK_FORMS_MAX_FIELDS_BYTES` | `65536` | Cap on the JSON-serialized `fields` object. |
| `WEBDESK_FORMS_MAX_ATTACHMENTS` | `5` | Attachments per submission, absent a per-form override. |
| `WEBDESK_FORMS_MAX_ATTACHMENT_BYTES` | `10485760` | Per-attachment byte cap (tighter than storage's own bucket-wide cap, if desired). |
| `WEBDESK_FORMS_HONEYPOT_FIELD` | `_hp` | Default honeypot field name; per-form override at `schema.honeypotField`. |
| `WEBDESK_FORMS_RATE_LIMIT_IP_PER_WINDOW` / `_WINDOW_MS` | `20` / `600000` | Per-IP fixed window. |
| `WEBDESK_FORMS_RATE_LIMIT_FORM_PER_WINDOW` / `_WINDOW_MS` | `120` / `600000` | Per-form fixed window. |
| `WEBDESK_FORMS_DEFAULT_CONSENT_TEXT` / `_DEFAULT_CONSENT_VERSION` | generic sentence / `unspecified-v0` | Fallback consent record when a form defines none. |
| `WEBDESK_FORMS_MAX_FIELD_TEXT_LENGTH` | `5000` | Default `maxLength` for a text/textarea field with none declared. |
| `TURNSTILE_MODE` | `stub` | `stub` or `live`. **Never set to `live` without a real `TURNSTILE_SECRET_KEY`** — real keys are on the Staging Reopen Register. |
| `TURNSTILE_SECRET_KEY` | *(empty)* | Only consulted in `live` mode. |
| `TURNSTILE_VERIFY_URL` | Cloudflare's real siteverify URL | Override for tests. |
| `TURNSTILE_STUB_PASS_TOKEN` | `stub-pass` | The ONE token the stub verifier accepts. |
| `TURNSTILE_REQUEST_TIMEOUT_MS` | `5000` | Live-mode HTTP timeout. |

Reuses existing vars unchanged: `REDIS_URL` (WSK-11), `STORAGE_*`/`MINIO_BUCKET_UPLOADS` (WSK-07),
`CLAMAV_HOST`/`CLAMAV_PORT` (WSK-07), `MAIL_*` (WSK-11).

### Verification runbook — five throwaway containers, a NEW port block (55460-55466)

Deliberately NOT WSK-05/11's own `55450-3` range and not `55432`/`55435`/`56380` (other concurrent
sessions' spike/test containers, checked via `docker ps` first) — so this suite never collides with
a stack another session brings up at the same time.

```bash
cd webdesk

# 1. Postgres — same role bootstrap as WSK-05/11's own runbooks, port 55460.
MSYS_NO_PATHCONV=1 docker run -d --name wsk10-db -p 55460:5432 \
  -e POSTGRES_PASSWORD=throwaway_superuser -e POSTGRES_DB=webdesk \
  -e POSTGRES_OWNER_USER=webdesk_owner -e POSTGRES_OWNER_PASSWORD=throwaway_owner \
  -e POSTGRES_MIGRATOR_USER=webdesk_migrator -e POSTGRES_MIGRATOR_PASSWORD=throwaway_migrator \
  -e POSTGRES_APP_USER=webdesk_app -e POSTGRES_APP_PASSWORD=throwaway_app \
  -v "$(pwd -W)/postgres/init-roles.sh:/docker-entrypoint-initdb.d/10-init-roles.sh:ro" \
  postgres:16-alpine

# 2. Redis (rate limiting), port 55461.
docker run -d --name wsk10-redis -p 55461:6379 redis:7-alpine

# 3. Mailpit (notification/autoresponder proof) — SMTP 55462, HTTP evidence API 55463.
docker run -d --name wsk10-mailpit -p 55462:1025 -p 55463:8025 axllent/mailpit:latest

# 4. MinIO (PRIVATE `uploads` bucket for attachments) — API 55464, console 55465.
docker run -d --name wsk10-minio -p 55464:9000 -p 55465:9001 \
  -e MINIO_ROOT_USER=webdesk_minio -e MINIO_ROOT_PASSWORD=changeme_minio_password \
  minio/minio:latest server /data --console-address ":9001"

# 5. ClamAV (attachment scan) — port 55466. SLOW first boot (freshclam DB download, can take
#    several minutes) — wait for `docker inspect --format='{{.State.Health.Status}}' wsk10-clamav`
#    to report `healthy` before running the attachments spec.
docker run -d --name wsk10-clamav -p 55466:3310 clamav/clamav:stable

# 6. Migrations (idempotent — a no-op if this DB already had them).
MIGRATE_DATABASE_URL="postgres://webdesk_migrator:throwaway_migrator@localhost:55460/webdesk" \
  node migrations/migrate.mjs

# 7. RLS integrity gate must stay green.
DATABASE_URL="postgres://webdesk_migrator:throwaway_migrator@localhost:55460/webdesk" \
  node scripts/check-rls-integrity.mjs

# 8. The forms suite. Every env var read by its REAL name (forms.config.ts, mail.config.ts,
#    storage.config.ts, media.config.ts) — no shadow-var indirection anywhere in this ticket.
cd api
APP_DATABASE_URL="postgres://webdesk_app:throwaway_app@localhost:55460/webdesk" \
MIGRATE_DATABASE_URL="postgres://webdesk_migrator:throwaway_migrator@localhost:55460/webdesk" \
REDIS_URL="redis://localhost:55461" \
MAIL_SMTP_HOST="localhost" \
MAIL_SMTP_PORT="55462" \
MAILPIT_HTTP_URL="http://localhost:55463" \
STORAGE_ENDPOINT="http://localhost:55464" \
STORAGE_ACCESS_KEY_ID="webdesk_minio" \
STORAGE_SECRET_ACCESS_KEY="changeme_minio_password" \
CLAMAV_HOST="localhost" \
CLAMAV_PORT="55466" \
  npx vitest run test/forms-abuse-battery.spec.ts test/forms-submit.spec.ts \
    test/forms-attachments.spec.ts test/forms-retention-purge.spec.ts test/forms-cross-tenant.spec.ts

# 9. Tear down.
cd ..
docker rm -f wsk10-db wsk10-redis wsk10-mailpit wsk10-minio wsk10-clamav
```

### Cold-start reproduction (actually run, 2026-08-26)

No pre-existing `wsk10-*` containers (`docker ps -a` checked first; one **other concurrent
session's** `wsk04b-v` container was up on port `55481` — untouched, no collision). Steps 1-5
(fresh containers) → ClamAV reported `healthy` after ~80s → step 6
(`5 file(s) discovered, 5 applied, 0 already in the ledger`) → step 7
(`OK — 14 tenant-scoped table(s) intact`) → step 8, run exactly as written above. Real `vitest`
output:

```
✓ test/forms-abuse-battery.spec.ts (13 tests) 582ms
✓ test/forms-attachments.spec.ts (3 tests) 475ms
✓ test/forms-submit.spec.ts (2 tests) 758ms
✓ test/forms-retention-purge.spec.ts (3 tests) 454ms
✓ test/forms-cross-tenant.spec.ts (2 tests) 363ms

 Test Files  5 passed (5)
      Tests  23 passed (23)
   Duration  8.40s
```

`check-rls-integrity.mjs` re-run afterward: still `OK — 14 tenant-scoped table(s) intact`.

**No-regression check**: WSK-05's own suite (`api-keys.scope-matrix`, `no-key`, `revoked-key`,
`plaintext-dump-grep`, `tenant-pool-leak`, `tenant-quota`) re-run against the SAME migrated DB
afterward — **26/26 passed**, confirming this ticket's additions did not disturb the existing
schema/RLS/auth paths (this ticket touches none of their owned files, so this is a sanity check,
not an expected-risk area).

**One real bug found and fixed during this run** (documented, not silently absorbed): the first
full-suite pass had the per-IP rate-limit test use a fixed literal IP (`10.0.9.1`). Because the
limiter is Redis-backed with a real fixed window (10 minutes by default) and Redis was NOT flushed
between runs, a second run within the same 10-minute window inherited the first run's count and the
test failed immediately with `429` instead of the expected `201, 201, 201, 429` sequence. Fixed by
deriving a fresh pseudo-IP from `Date.now()` per run (`forms-abuse-battery.spec.ts`) rather than
flushing Redis globally between test files (which would risk interfering with a concurrent session
sharing the same Redis container in a real dev-box scenario). All 23 tests green on the re-run
immediately after the fix, with no other containers or state touched.

Containers torn down (`docker rm -f wsk10-db wsk10-redis wsk10-mailpit wsk10-minio wsk10-clamav`)
after the run.
