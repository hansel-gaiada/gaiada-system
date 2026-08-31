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

---

## Control-plane API v1 (WSK-21) — `src/control/**`

The C-05 command set (design §03/§07/§08) as idempotent commands / tracked jobs: **lifecycle**
(tenant/site/environment provision+archive), **schema** (proposeSchema draft-only,
applySchema), **keys** (mint/rotate/revoke, delegating to WSK-05's `ApiKeysService` — no hashing
reimplemented), **release** (deploy/promote/rollback/triggerRebuild as tracked jobs, never
blocking), and the §06 contract-read extension (`GET /control/v1/tenants/:slug/contract`).

### ⚠️ LOUD WARNING — not a public surface yet

Every route under `/control/v1/**` is a Zone B CONTROL-PLANE command. `ControlAuthGuard`'s
authenticator (`src/control/auth/dev-mode-control-channel-authenticator.ts`) and
`CommandAuthorizationGuard`'s policy point (`src/control/policy/dev-mode-policy-decision-point.ts`)
are **DEV-MODE STUBS with no cryptographic verification of anything** — they read plain,
caller-supplied headers. The real control channel (synccert mTLS + offline-JWKS-verified
Keycloak client-credentials token + a Zone B Cerbos sidecar + a single-use HMAC WS4 assertion) is
**WSK-22's build**. `ControlModule` is **not wired into `app.module.ts`** and must not be
reachable through the public proxy vhost (`webdesk/proxy/Caddyfile`) until WSK-22 replaces both
stub bindings — same rule, same reasoning, as WSK-05's `api-keys.controller.ts` header comment.

### Command list, with impact class (design §07's three tiers, restated for this ticket's actual command set)

| Command | Method + path | Impact class | Required scope | WS4 required | Job-tracked |
|---|---|---|---|---|---|
| `tenant.provision` | `POST /control/v1/tenants` | medium | `webdesk:operate` | no | no |
| `tenant.archive` | `POST /control/v1/tenants/:slug/archive` | **high** | `webdesk:promote` | **yes** | no |
| `site.provision` | `POST /control/v1/tenants/:slug/sites` | medium | `webdesk:operate` | no | no |
| `site.archive` | `POST /control/v1/tenants/:slug/sites/:siteId/archive` | **high** | `webdesk:promote` | **yes** | no — always 501, see below |
| `environment.provision` | `POST /control/v1/tenants/:slug/sites/:siteId/environments` | medium | `webdesk:operate` | no | no |
| `environment.archive` | `POST /control/v1/tenants/:slug/environments/:envId/archive` | **high** | `webdesk:promote` | **yes** | no |
| `schema.propose` | `POST .../sites/:siteId/collections/:key/schema/propose` | read | `webdesk:read` | no | no — draft only, never persisted |
| `schema.apply` | `POST .../sites/:siteId/collections/:key/schema/apply` | medium | `webdesk:operate` | no | no |
| `key.mint` | `POST /control/v1/tenants/:slug/keys` | **high** | `webdesk:keys` | **yes** | no |
| `key.rotate` | `POST /control/v1/tenants/:slug/keys/:apiKeyId/rotate` | **high** | `webdesk:keys` | **yes** | no |
| `key.revoke` | `POST /control/v1/tenants/:slug/keys/:apiKeyId/revoke` | **high** | `webdesk:keys` | **yes** | no |
| `release.deploy` | `POST .../environments/:envId/deploy` | medium | `webdesk:operate` | no | **yes** |
| `release.promote` | `POST .../environments/:envId/promote` | **high** | `webdesk:promote` | **yes** | **yes** |
| `release.rollback` | `POST .../environments/:envId/rollback` | **high** | `webdesk:promote` | **yes** | **yes** |
| `release.triggerRebuild` | `POST .../environments/:envId/rebuild` | medium | `webdesk:operate` | no | **yes** |
| `job.get` / `job.list` | `GET .../jobs/:jobId` / `GET .../jobs` | read | `webdesk:read` | no | n/a — reads a job |
| `contract.read` | `GET /control/v1/tenants/:slug/contract` | read | `webdesk:read` | no | no — always 501, see below |

The full map lives in code at `src/control/command-types.ts`'s `COMMAND_REGISTRY` (the single
source of truth every guard and `test/control-command-registry.spec.ts` read from) — this table
is a restatement, not a second copy to keep in sync by hand.

Two documented departures from design §07's literal wording: `schema.propose` is classified
`read` (this ticket's own brief narrows the AC to three tiers; propose never persists anything,
which is what `read` means everywhere else in this map) and `job.get`/`job.list` are this
ticket's own addition (job-tracking wasn't in the original C-05 list).

### Idempotency (ticket AC: "every command double-fired must produce one effect")

Every mutating command requires an `Idempotency-Key` request header (≥8 chars;
`src/control/dto.ts`'s `assertIdempotencyKey`). `src/control/idempotency/idempotency-store.ts`
dedupes by `${tenantSlugOrPlatform}:${command}:${idempotencyKey}`: a second call with the same
key and the same argument hash returns the first call's result without re-executing (covers both
a still-in-flight race and a later sequential replay); a second call reusing the key with
*different* arguments is refused with `409 Conflict`. **This store is in-memory,
single-process** — flagged, not hidden: a persisted `control_idempotency_keys` table is the
natural next step and needs a migration this ticket does not own (`control/**` only). Where the
underlying table has a natural uniqueness constraint (`environments` `UNIQUE(site_id,name)`,
`releases` `UNIQUE(env_id,version)`), that constraint is a second, independent, cross-process-safe
backstop — `test/control-commands.spec.ts` proves this directly by clearing the in-memory store
between two calls to simulate "a different api process" and showing the DB constraint alone still
refuses the duplicate.

### Job tracking (ticket AC: "long-running commands job-tracked and queryable")

`release.deploy/promote/rollback/triggerRebuild` return `{ jobId, replayed }` immediately —
`src/control/jobs/jobs.service.ts` is an **in-memory, single-process** job store (same flagged
limitation as the idempotency store) that a caller polls via `GET .../jobs/:jobId` or
`GET .../jobs`. The actual box-side work is defined only behind an interface
(`src/control/release/release-transport.ts`'s `ReleaseTransportAdapter`) — under WSK-D26 the real
targets are `delphi`/`helios`/Hostinger, and those adapters are WSK-25/26'/29's build. The shipped
default binding (`NotYetAvailableReleaseTransport`) always fails a job with a documented
`TRANSPORT_NOT_AVAILABLE` error — the command's own machinery (idempotency, audit, job creation)
still completes correctly; only the transport itself has nothing to talk to yet.
`deploy`/`promote`/`rollback` additionally write a `releases` row on transport success (the table
already has `kind IN ('deploy','promote','rollback')` — `triggerRebuild` has no matching kind and
intentionally writes no row).

### Audit (ticket AC: "immutable audit row for every command")

`src/control/command-audit.service.ts` wraps WSK-05's `AuditService`/`audit_entries` with the
right GUC context per command (`db.withTenant`/`db.withPlatformCtx`) and a consistent
`control.<command>[.replay]` action name — a replay gets its own, differently-named row rather
than being silently absorbed into the original. Audited: every lifecycle/schema/keys/release
command plus `contract.read` (named explicitly in the ticket's command list). **Deliberately NOT
audited:** `job.get`/`job.list` — read-only polls of a job a real command already audited; see
`src/control/jobs/jobs.controller.ts`'s header for why. Note `key.mint/rotate/revoke` produce
**two** audit rows per call by design: `ApiKeysService`'s own existing `webdesk.apiKey.*` row
(WSK-05, unmodified) plus this ticket's own `control.key.*` row carrying the `ws4ApprovalId`
context `ApiKeysService` has no parameter for — not a duplicate to fix.

### Authorization seam — guard interfaces + dev-mode stubs, not the real channel

- `src/control/auth/control-channel-authenticator.ts` — the `ControlChannelAuthenticator`
  interface `ControlAuthGuard` calls. Dev-mode implementation reads plain headers
  (`x-webdesk-control-principal`, `x-webdesk-control-scopes`, `x-webdesk-control-automation`,
  `x-webdesk-ws4-approval-id`) with **zero verification** — no mTLS, no JWT, no HMAC. WSK-22
  binds a real implementation to the same `CONTROL_CHANNEL_AUTHENTICATOR` token.
- `src/control/policy/policy-decision-point.ts` — the `PolicyDecisionPoint` interface
  `CommandAuthorizationGuard` calls (design §03 Layer 3 / WSK-D8: "Zone B runs its own Cerbos
  sidecar... never calls Zone A's Cerbos"). Dev-mode implementation checks the principal's
  declared scopes locally and, for `impactClass === "high"`, requires a non-empty
  `ws4ApprovalId` — no Cerbos call exists yet (standing a sidecar up is
  `webdesk/docker-compose.yml` work, out of this ticket's scope). WSK-22/WSK-31 binds a real
  Cerbos-backed implementation to the same `POLICY_DECISION_POINT` token; no controller or guard
  changes when that happens.

### What could not be built as specified

- **`site.archive` — `sites` has no `status` column.** Every other lifecycle table
  (`tenants`, `environments`) has one; `sites` was never given one in `0001_platform_core.sql`.
  The command runs its full auth/idempotency/audit pipeline, then refuses with a documented
  RFC-9457-shaped `501`. Needs a senior-db-approved migration adding `sites.status` — not
  improvised here per the ticket's own instruction.
- **`contract.read` — WSK-15 (codegen pipeline) does not exist.** Per the ticket brief ("serve
  the shape and return a documented not-yet-available error... do not invent artifacts"), this
  authenticates/authorizes/audits like a real command, then returns a `501` whose `detail` field
  states the exact success shape design §06 defines, once WSK-15 ships it.
- **Zone B Cerbos sidecar itself is not stood up.** The design table lists "Zone B Cerbos
  sidecar + policy set (D-11)" as part of WSK-21's row; the ticket's own brief narrows this
  ticket to "the guard interface and a dev-mode stub", which is what shipped
  (`PolicyDecisionPoint`). The actual sidecar container is `webdesk/docker-compose.yml` +
  `webdesk/cerbos/`-shaped work this ticket does not own.

### Required changes outside this ticket's scope (reported, not made)

- **`app.module.ts`** — one import line to register the module:
  ```ts
  import { ControlModule } from "./control/control.module";
  // add ControlModule to @Module({ imports: [...] })
  ```
- **`webdesk/proxy/Caddyfile`** — `/control/v1/**` must stay OFF the public vhost until WSK-22
  lands (same rule as WSK-05's `/internal/**`). No new env vars are required for this ticket —
  every dev-mode header is read directly from the request, nothing added to `config.ts` or
  `.env.example`.
- **A persisted idempotency-key table and a persisted jobs table** would remove the two
  in-memory/single-process limitations flagged above (both correct today, both under-enforce the
  moment the `api` service runs more than one replica — the same class of gap WSK-05 flagged for
  its own read quota and WSK-11 flagged for its in-process mail worker). Migration, so senior-db's
  call on shape and timing.
- **`webdesk/docker-compose.yml` / `webdesk/cerbos/`** — a real Zone B Cerbos sidecar + policy
  set (D-11), if/when `PolicyDecisionPoint` grows a real Cerbos-backed implementation.

### Verification runbook — one throwaway Postgres, port 55490 (checked free via `docker ps` first)

No Redis/MinIO/Mailpit needed — the control module only touches Postgres (job/idempotency stores
are in-memory) and delegates key hashing to WSK-05's existing, already-migrated schema.

```bash
cd webdesk

# 1. Fresh throwaway Postgres — same role bootstrap as every other ticket's runbook, port 55490
#    (checked free: not 55432/55433/55435/56380, not the 55450-55466 WSK-05/10/11 block).
MSYS_NO_PATHCONV=1 docker run -d --name wsk21-db -p 55490:5432 \
  -e POSTGRES_PASSWORD=throwaway_superuser -e POSTGRES_DB=webdesk \
  -e POSTGRES_OWNER_USER=webdesk_owner -e POSTGRES_OWNER_PASSWORD=throwaway_owner \
  -e POSTGRES_MIGRATOR_USER=webdesk_migrator -e POSTGRES_MIGRATOR_PASSWORD=throwaway_migrator \
  -e POSTGRES_APP_USER=webdesk_app -e POSTGRES_APP_PASSWORD=throwaway_app \
  -v "$(pwd -W)/postgres/init-roles.sh:/docker-entrypoint-initdb.d/10-init-roles.sh:ro" \
  postgres:16-alpine

# 2. Apply migrations with the project's own runner.
MIGRATE_DATABASE_URL="postgres://webdesk_migrator:throwaway_migrator@localhost:55490/webdesk" \
  node migrations/migrate.mjs

# 3. RLS integrity gate must stay green.
DATABASE_URL="postgres://webdesk_migrator:throwaway_migrator@localhost:55490/webdesk" \
  node scripts/check-rls-integrity.mjs

# 4. Run this ticket's suite. Every env var read by its REAL name (config.ts) plus the
#    WSK21_-prefixed test-only overrides (test files default to port 55490 themselves, these are
#    only needed if you used a different port).
cd api
WSK21_TEST_DATABASE_URL="postgres://webdesk_app:throwaway_app@localhost:55490/webdesk" \
WSK21_MIGRATE_DATABASE_URL="postgres://webdesk_migrator:throwaway_migrator@localhost:55490/webdesk" \
APP_DATABASE_URL="postgres://webdesk_app:throwaway_app@localhost:55490/webdesk" \
API_KEY_PEPPER="wsk21-test-pepper-never-used-outside-this-suite" \
  npx tsc --noEmit
  npx vitest run test/control-command-registry.spec.ts test/control-authz.spec.ts \
    test/control-commands.spec.ts test/control-jobs.spec.ts

# 5. RLS integrity gate re-checked afterward.
cd ..
DATABASE_URL="postgres://webdesk_migrator:throwaway_migrator@localhost:55490/webdesk" \
  node scripts/check-rls-integrity.mjs

# 6. Tear down.
docker rm -f wsk21-db
```

### Every env var this ticket's tests read (exact names)

| Var | Read by | Default if unset |
|---|---|---|
| `WSK21_TEST_DATABASE_URL` | every `control-*.spec.ts` (sets `process.env.APP_DATABASE_URL` at file top) | `postgres://webdesk_app:throwaway_app@localhost:55490/webdesk` |
| `WSK21_MIGRATE_DATABASE_URL` | `control-commands.spec.ts` / `control-jobs.spec.ts` (raw-SQL verification queries, migrator role) | `postgres://webdesk_migrator:throwaway_migrator@localhost:55490/webdesk` |
| `APP_DATABASE_URL` | `DbService` via `config.ts` (the real name the app itself reads — same var WSK-05/10/11 use) | — (must be set; the test files set it themselves from `WSK21_TEST_DATABASE_URL`) |
| `API_KEY_PEPPER` | `ApiKeysService` via `config.ts` (WSK-05) | set by the test files themselves |
| `WEBDESK_READ_QUOTA_PER_MIN` | `config.ts` (WSK-05, unrelated to this ticket but imported transitively via `ApiKeysModule`) | `1000` in test files |

No new variables were added to `.env.example` — this ticket needed none (every dev-mode
control-channel header is read directly from the request; nothing goes through `config.ts`).

### Cold-start reproduction (actually run, 2026-08-26)

`docker ps` checked first (`wsk14-pg` on 55480, `mimi-*`, `webdesk-spike-spikedb-1` on 55432,
`gaiada-*` on 55433/55435/56380, `gaiada-cerbos-1` — none on 55490). Steps 1-3 above → migrations
`5 file(s) discovered, 5 applied, 0 already in the ledger` → RLS gate
`OK — 14 tenant-scoped table(s) intact` → `tsc --noEmit` clean (0 errors) → full suite:

```
✓ test/control-commands.spec.ts (5 tests) 1013ms
✓ test/control-jobs.spec.ts (5 tests) 942ms
✓ test/control-authz.spec.ts (5 tests) 352ms
✓ test/control-command-registry.spec.ts (21 tests) 9ms

 Test Files  4 passed (4)
      Tests  36 passed (36)
```

Re-run immediately after (proving the double-fire assertions are not a fluke of process state):
same 4 files, same **36/36**, exit 0. RLS integrity gate re-checked afterward: still
`OK — 14 tenant-scoped table(s) intact`. **No-regression check:** WSK-05's own suite
(`api-keys.scope-matrix`, `no-key`, `revoked-key`, `plaintext-dump-grep`, `tenant-pool-leak`,
`tenant-quota`) re-run against the SAME migrated DB afterward — **26/26 passed**, confirming this
ticket's additions (which delegate to `ApiKeysService` for keys) did not disturb WSK-05's own
paths.

Container torn down (`docker rm -f wsk21-db`) after the run.

---

## Control-channel auth (WSK-22) — `src/control/auth/**`, `src/control/policy/**`

Design §03's real four-layer control channel, replacing WSK-21's dev-mode stubs. **STATUS:
DEV-VERIFIED against a throwaway Postgres + a real synccert-issued cert chain + a local fixture
JWKS + one live reachability proof against the real public Keycloak issuer** — see the adversarial
matrix and runbook below. Not yet PROTOTYPED end-to-end through the real proxy/Caddy vhost or a
real `webdesk-control` Keycloak client — both are owner/DevOps actions this ticket could not take
(see "Owner actions required" below).

### The four layers, what each file does, and how each is proven refusing

| Layer | Design §03 | File | Real mechanism |
|---|---|---|---|
| 1 — mTLS | Client cert from the synccert internal CA; Zone B pins the CA | `auth/mtls-verifier.ts` | Node `crypto.X509Certificate`: `checkIssued` + `verify(caPublicKey)` against a pinned CA PEM, plus expiry + CN allow-list. Independent, in-process re-verification — see the file's own header for why this is real defense-in-depth and not a redundant proxy-trust no-op. |
| 2 — Keycloak service token | Client-credentials `webdesk-control`, verified OFFLINE via the public issuer JWKS, kid-pinned, cached | `auth/keycloak-token-verifier.ts` | `jose`'s `createRemoteJWKSet` + `jwtVerify` (issuer/audience/exp/kid all real checks; no Zone A credential ever touched). |
| 3 — command authz | Token scopes vs. `COMMAND_REGISTRY` | `policy/real-policy-decision-point.ts` | Same scope-membership check WSK-21's dev-mode stub did — this ticket's own brief scopes Layer 3 as "via WSK-21's PolicyDecisionPoint", not "stand up Cerbos". See "What could not be built as specified" below. |
| 4 — WS4 assertion | `{approvalId, commandHash, exp}` HMAC'd, single-use, irreversible commands only | `auth/ws4-assertion.ts` (mint/verify primitives) + `policy/real-policy-decision-point.ts` (the actual gate: signature → commandHash match → single-use dedup against `audit_entries.ws4_approval_id`) | Real HMAC-SHA256 (`node:crypto`), gated on `COMMAND_REGISTRY`'s existing `impactClass === "high"` — **no second classification invented**, per this ticket's own instruction. |

Wiring: `control.module.ts` binds `CONTROL_CHANNEL_AUTHENTICATOR`/`POLICY_DECISION_POINT` to the
REAL classes above for every environment **except** `NODE_ENV=test`, where WSK-21's dev-mode
stubs stay bound — this is the one file outside `auth/**`/`policy/**` this ticket touched, and it
is a **minimal, environment-conditional provider swap**, not a rewrite; see that file's own
updated header comment for the full reasoning. This exists so WSK-21's own 36 tests (which this
ticket may not edit, and which assert against the dev-mode header contract) keep passing
unmodified — `test/control-auth-layers.spec.ts` (WSK-22's own suite) forces the real
implementations regardless of `NODE_ENV` via Nest's `overrideProvider(...).useClass(...)`, so both
suites run the code path they need against the SAME `control.module.ts`.

### The adversarial matrix (19 tests, `test/control-auth-layers.spec.ts`) — every refusal, its real reason

| # | Case | Layer | Result | Actual refusal reason (from the running code) |
|---|---|---|---|---|
| 1 | No cert at all (valid token) | 1 | 401 | `control-channel Layer 1 (mTLS) refused: no client certificate presented (x-webdesk-mtls-cert-pem absent)` |
| 2 | Valid token + no cert | 1 | 401 | same as above — proves Layer 1 runs and refuses independently of token validity |
| 3 | Cert signed by a different (rogue) CA | 1 *(bonus, beyond the required matrix)* | 401 | `client certificate was not issued by the pinned synccert CA (issuer/subject mismatch)` |
| 4 | Cert chains to the pinned CA, CN not allow-listed | 1 *(bonus)* | 401 | `client certificate CN 'some-other-client' is not an allow-listed control-channel identity (platform-nest-webdesk)` |
| 5 | Valid cert + no token | 2 | 401 | `control-channel Layer 2 (service token) refused: no Bearer token presented` |
| 6 | Wrong audience | 2 | 401 | `token claim validation failed: aud (...)` |
| 7 | Expired token | 2 | 401 | `token expired (exp claim)` |
| 8 | Wrong issuer | 2 | 401 | `token claim validation failed: iss (...)` |
| 9 | Tampered signature | 2 | 401 | `token signature verification failed (tampered or wrong key)` |
| 10 | Unknown kid | 2 | 401 | `token's kid does not match any key in the issuer's published JWKS (unknown kid)` |
| 11 | Valid everything, HIGH command, **no WS4 assertion** | 4 | 403 | `command 'tenant.archive' is HIGH-impact and always requires a WS4 assertion (design §03 Layer 4) — none was presented` |
| 12 | WS4 `commandHash` does not match the actual args | 4 | 403 | `WS4 assertion commandHash does not match the actual command arguments — refused (design WSK-D3: ...)` |
| 13 | Expired WS4 assertion | 4 | 403 | `WS4 assertion rejected: WS4 assertion expired` |
| 14 | Tampered WS4 signature | 4 *(bonus)* | 403 | `WS4 assertion rejected: WS4 assertion signature invalid (HMAC mismatch — tampered or wrong key)` |
| 15 | WS4 minted with the wrong key | 4 *(bonus)* | 403 | same HMAC-mismatch reason — proves the key itself is checked, not just structural shape |
| 16 | **Replayed assertion** — same `approvalId` used twice | 4 | 403 (on the 2nd call; 201 on the 1st) | `WS4 assertion has already been used for a prior command — single-use violated, replay refused` |
| 17 | Valid everything, MEDIUM command, no WS4 needed | 2/3 happy path | 201 | `tenant.provision` succeeds — proves the mechanism allows a well-formed real request, not just refuses everything |
| 18 | Valid everything, HIGH command, fresh matching WS4 | 4 happy path | 201, `tenant.status === "archived"` | proves Layer 4 allows a genuinely correct assertion |
| 19 | Real public issuer JWKS reachability (network-guarded, bonus) | 2 | rejects a foreign-signed token | `token's kid does not match any key in the issuer's published JWKS (unknown kid)` — **confirmed live against `https://erp.gaiada.online/idp/realms/gaiada`, 2026-08-26/27** |

All 19 pass. Rows 1-2, 5, 11, 16 are the ticket's own required minimum; rows 3-4, 14-15, 17-19 are
this ticket's own additions to make the "cannot be shown refusing is not a layer" bar harder to
satisfy by accident (e.g. row 15 rules out "any non-empty signature passes").

### Real public issuer vs. local fixture JWKS — which this ticket used, and why both

**Both**, for different jobs, said plainly per the ticket's own instruction:

- The **real public issuer** (`https://erp.gaiada.online/idp/realms/gaiada`) IS reachable from this
  dev box — confirmed 2026-08-26/27, `.well-known/openid-configuration` returns 200, JWKS fetch
  returns real RSA keys. `OfflineJwksVerifier` was run against it directly (matrix row 19,
  network-guarded so it degrades gracefully rather than flaking the gate if reachability changes)
  to prove the "no Zone A credential needed to verify" claim for real, not just in theory.
- No **positive** (successfully-verifying) test can be run against the real issuer: minting a
  token that genuinely verifies needs the real issuer's PRIVATE key, which only Keycloak holds,
  and no `webdesk-control` client-credentials client exists yet to request one from (**owner
  action**, design §03: "confidential, Zone A custody"). The deterministic 19-row matrix above
  therefore runs against a **local fixture JWKS** — this ticket's own RSA keypair, served over a
  real local HTTP listener (`node:http`, ephemeral port) so `OfflineJwksVerifier`'s actual
  fetch-over-HTTP code path runs for real, not a mocked shortcut.

### Layer 1 certs — real synccert issuance, not a fixture library

Generated 2026-08-26 via the actual `sync-engine-go/cmd/synccert` CLI (WSL, Go 1.26 — "Go builds
happen in WSL" per this repo's own standing instruction):

```bash
cd sync-engine-go
go run ./cmd/synccert -init -ca-cert <scratch>/ca-cert.pem -ca-key <scratch>/ca-key.pem \
  -cn platform-nest-webdesk -out-cert <scratch>/client-good.crt -out-key <scratch>/client-good.key
go run ./cmd/synccert -ca-cert <scratch>/ca-cert.pem -ca-key <scratch>/ca-key.pem \
  -cn some-other-client -out-cert <scratch>/client-wrong-cn.crt -out-key <scratch>/client-wrong-cn.key
go run ./cmd/synccert -init -ca-cert <scratch>/rogue-ca-cert.pem -ca-key <scratch>/rogue-ca-key.pem \
  -cn platform-nest-webdesk -out-cert <scratch>/client-rogue-ca.crt -out-key <scratch>/client-rogue-ca.key
```

`-init` mirrors what the tool itself documents as "dev/greenfield only" — production points
`-ca-cert`/`-ca-key` at the gateway's own persisted CA (`ai-gateway-go`'s `data/ca-cert.pem` /
`data/ca-key.pem`), which this ticket never had reason to touch. The resulting PEMs (base64'd, as
the app's own `x-webdesk-mtls-cert-pem` header contract expects) are embedded directly in
`test/control-auth-layers.spec.ts` so the suite has no runtime dependency on WSL/Go — they were
issued for real, once, and the bytes are what the test replays.

### WS4 assertion — wire format (a real cross-zone contract; platform-nest must mirror this exactly)

Design §03 names the claim set (`{approvalId, commandHash, exp}`, "HMAC'd") but not the exact
bytes. This ticket had to pick one — documented here, and in `auth/ws4-assertion.ts`'s own header
comment, as the contract Zone A's (not-yet-built) minting code must match byte-for-byte:

```
x-ws4-assertion: <payload>.<hmacHex>
payload  = base64url(JSON.stringify({ approvalId, commandHash, exp }))
hmacHex  = HMAC-SHA256(payload, WEBDESK_APPROVAL_ASSERTION_KEY) as lowercase hex
```

`commandHash = sha256(`${command}:${canonicalArgs}`)` hex, where `command` is the `CommandName`
string from `command-types.ts` (e.g. `"release.promote"` — the same registry Layer 3 reads, not a
second vocabulary) and `canonicalArgs` is `ws4-assertion.ts`'s own deterministic, recursively
key-sorted JSON of the request's route params merged with its body — exactly what Zone A knows
before it asks a human for an approval. **This is a real integration point that needs
platform-nest-side alignment** when that side's WS4-minting code is built (not this ticket's repo
to touch) — flagged here rather than assumed compatible.

### Known gap: WS4 single-use is not fully race-proof (documented, not hidden)

`real-policy-decision-point.ts`'s `wasApprovalIdAlreadyUsed` is a `SELECT ... WHERE
ws4_approval_id = $1` against `audit_entries` (the design's own stated dedup store) — the
realistic replay case (an approval reused after the command it authorized already completed) is
closed and proven (matrix row 16). What is **not** closed: two requests presenting the identical
`approvalId` at genuinely the same instant, before either's audit row has committed, could both
pass this check — `0001_platform_core.sql`'s `ix_audit_entries_ws4` is a plain index, not a unique
one, and `migrations/**` is out of this ticket's owned scope to change (this ticket's own
instruction: don't improvise DDL). Closing this fully needs:

```sql
CREATE UNIQUE INDEX ix_audit_entries_ws4_unique ON audit_entries (ws4_approval_id)
  WHERE ws4_approval_id IS NOT NULL;
```

— a senior-db-approved migration, reported here rather than added.

### A retry-safety tradeoff this design accepts (worth a human decision later, not a defect)

WS4 single-use is literal: a SECOND request carrying the same `approvalId` is refused **even if**
it reuses the same `Idempotency-Key` as a legitimate network retry of an already-completed
HIGH-impact command (design's own adversarial requirement — "replayed assertion" must be refused,
no carve-out). Zone A's retry strategy for a HIGH-impact command therefore cannot be "resend the
same WS4 assertion" — it must poll `GET .../jobs/:jobId` (for job-tracked commands) or otherwise
avoid re-presenting a consumed assertion. Not something this ticket can resolve unilaterally (it
is Zone A's minting/retry behavior); flagged for whoever builds that side.

### What could not be built as specified

- **A real Zone B Cerbos sidecar (design §03 Layer 3 / D-11).** `RealPolicyDecisionPoint` keeps
  WSK-21's dev-mode stub's approach (local scope-membership check against `COMMAND_REGISTRY`) —
  this ticket's own brief scopes Layer 3 as "against the token's scopes ... via WSK-21's
  PolicyDecisionPoint", not "stand up Cerbos", and the sidecar container itself is
  `webdesk/docker-compose.yml` + `webdesk/cerbos/`-shaped work outside `control/auth/**`,
  `control/policy/**`. WSK-31 is where a real Cerbos `check()` call swaps in behind this same
  `PolicyDecisionPoint` interface (per that interface's own header comment, unchanged by this
  ticket).
- **The proxy's mTLS termination itself** (`webdesk/proxy/Caddyfile`'s control vhost) — see "Owner
  actions required" below. This ticket built the half that belongs to `control/auth/**`: real,
  independent, in-process re-verification of a forwarded client certificate. It could not build or
  test the proxy-side TLS termination that is supposed to forward that certificate, because
  `webdesk/proxy/**` is out of this ticket's owned scope.
- **A positive (successfully-verifying) test against the real Keycloak issuer** — needs the
  `webdesk-control` client-credentials client to exist (owner action) before any token minted
  against it could verify. See "Real public issuer vs. local fixture JWKS" above.

### Owner actions required

- **Create the `webdesk-control` Keycloak client** on the `gaiada` realm — confidential,
  client-credentials grant, audience `webdesk-control-plane`, scoped to
  `webdesk:read`/`webdesk:operate`/`webdesk:promote`/`webdesk:keys` (design §03: "Zone A
  custody"). Without this, Layer 2 can only ever be dev-verified against a fixture, never PROTOTYPED
  for real.
- **Issue the real `platform-nest-webdesk` client cert** off the actual shared internal CA
  (`ai-gateway-go`'s persisted `data/ca-cert.pem`/`data/ca-key.pem`, via `synccert`) once Zone B
  has a real box/vhost to present it to.
- **Generate `WEBDESK_APPROVAL_ASSERTION_KEY`** (random, high-entropy) and place it in
  platform-nest's + Zone B's secret stores identically — this ticket never generated a real value,
  only a test-only placeholder (see below).

### New secrets/vars this ticket needs — reported as EMPTY placeholders, `.env.example` NOT edited

`webdesk/.env.example` is out of this ticket's owned scope; these must be added there (and to
Zone B's real secret store) by whoever owns that file, as **empty placeholders only, never a
value**:

| Var | Purpose | Read by |
|---|---|---|
| `WEBDESK_APPROVAL_ASSERTION_KEY` | HMAC key for WS4 assertions (§03 Layer 4) — shared with platform-nest, Zone A/B custody only | `real-policy-decision-point.ts` |
| `WEBDESK_CONTROL_MTLS_CA_PEM` | Pinned synccert CA public cert (PEM) — Zone B holds only the CA public, never a private key | `real-control-channel-authenticator.ts` |
| `WEBDESK_CONTROL_MTLS_ALLOWED_CN` | Comma-separated allow-list of client-cert CNs (default `platform-nest-webdesk`) | `real-control-channel-authenticator.ts` |
| `WEBDESK_CONTROL_OIDC_ISSUER` | Public Keycloak issuer URL (default `https://erp.gaiada.online/idp/realms/gaiada` — there is only one real issuer in this design, so the dev fallback IS the real one; harmless because it is read-only public key material) | `real-control-channel-authenticator.ts` |
| `WEBDESK_CONTROL_OIDC_JWKS_URI` | Override for the JWKS endpoint, if it ever diverges from the OIDC-conventional path under the issuer | `real-control-channel-authenticator.ts` |
| `WEBDESK_CONTROL_OIDC_AUDIENCE` | Expected `aud` claim (default `webdesk-control-plane`, per design §03) | `real-control-channel-authenticator.ts` |

None of these are secrets in the traditional sense except `WEBDESK_APPROVAL_ASSERTION_KEY` (an
HMAC key) — the CA and issuer/audience are public/pinning material, but are still listed since
they gate a trust boundary and belong in the same env-var inventory.

### Required changes outside this ticket's scope (reported, not made)

- **`webdesk/proxy/Caddyfile`** — needs a dedicated control vhost terminating mTLS
  (`client_auth { mode require_and_verify; trusted_ca_cert_file <pinned CA> }` in Caddy's own
  syntax — the exact directive names should be confirmed against the Caddy version actually
  pinned in this compose stack, which this ticket did not verify) and forwarding the verified
  client cert to the app as `x-webdesk-mtls-cert-pem` (base64 PEM). `/control/v1/**` must stay OFF
  the existing public `:80` vhost, same rule WSK-21's own README already stated.
- **`webdesk/docker-compose.yml` / `webdesk/cerbos/`** — unchanged ask from WSK-21's own report: a
  real Zone B Cerbos sidecar, if/when Layer 3 grows beyond a local scope check.
- **`app.module.ts`** — unchanged ask from WSK-21's own report: one import line to register
  `ControlModule`. Still not made here (`app.module.ts` is explicitly out of this ticket's owned
  scope) — see that section above.
- **A `UNIQUE` partial index on `audit_entries.ws4_approval_id`** — see "Known gap" above.

### Verification runbook — same throwaway Postgres as WSK-21's (port 55490)

```bash
cd webdesk

# 1. Fresh throwaway Postgres (checked free via `docker ps` first — reused WSK-21's own port
#    55490, not 55432/55433/55435/56380, not the 55450-55466 block, not pn-gen's 55496).
MSYS_NO_PATHCONV=1 docker run -d --name wsk22-db -p 55490:5432 \
  -e POSTGRES_PASSWORD=throwaway_superuser -e POSTGRES_DB=webdesk \
  -e POSTGRES_OWNER_USER=webdesk_owner -e POSTGRES_OWNER_PASSWORD=throwaway_owner \
  -e POSTGRES_MIGRATOR_USER=webdesk_migrator -e POSTGRES_MIGRATOR_PASSWORD=throwaway_migrator \
  -e POSTGRES_APP_USER=webdesk_app -e POSTGRES_APP_PASSWORD=throwaway_app \
  -v "$(pwd -W)/postgres/init-roles.sh:/docker-entrypoint-initdb.d/10-init-roles.sh:ro" \
  postgres:16-alpine

# 2. Apply migrations.
MIGRATE_DATABASE_URL="postgres://webdesk_migrator:throwaway_migrator@localhost:55490/webdesk" \
  node migrations/migrate.mjs

# 3. RLS integrity gate.
DATABASE_URL="postgres://webdesk_migrator:throwaway_migrator@localhost:55490/webdesk" \
  node scripts/check-rls-integrity.mjs

# 4. Typecheck + this ticket's own suite + WSK-21's full 36 (no edits to those files).
cd api
npx tsc --noEmit
WSK21_TEST_DATABASE_URL="postgres://webdesk_app:throwaway_app@localhost:55490/webdesk" \
WSK21_MIGRATE_DATABASE_URL="postgres://webdesk_migrator:throwaway_migrator@localhost:55490/webdesk" \
  npx vitest run test/control-authz.spec.ts test/control-commands.spec.ts \
    test/control-jobs.spec.ts test/control-command-registry.spec.ts test/control-auth-layers.spec.ts

# 5. Tear down.
cd ..
docker rm -f wsk22-db
```

### Actually run (2026-08-27) — results

`docker ps` checked first: `pn-gen` (55496), `mimi-postgres`/`mimi-redis`/`mimi-minio`,
`webdesk-spike-spikedb-1` (55432), `gaiada-cerbos-1`, `gaiada-test-pg-2` (55435),
`gaiada-redis-test-1` (56380) — none on 55490, reused WSK-21's own port. Migrations: `5 file(s)
discovered, 5 applied, 0 already in the ledger`. RLS gate: `OK — 14 tenant-scoped table(s)
intact`. `tsc --noEmit`: clean, 0 errors.

```
✓ test/control-auth-layers.spec.ts (19 tests)
✓ test/control-commands.spec.ts (5 tests)
✓ test/control-authz.spec.ts (5 tests)
✓ test/control-command-registry.spec.ts (21 tests)
❯ test/control-jobs.spec.ts (5 tests | 1 failed)
   × contract read — §06 not-yet-available surface > GET .../contract returns a documented 501
     → expected 500 to be 501

 Test Files  1 failed | 4 passed (5)
      Tests  1 failed | 54 passed (55)
```

**The one failure is NOT a WSK-22 regression** — it is WSK-15's concurrent, in-flight work on
`control/contract/contract.controller.ts` (outside this ticket's owned scope; this ticket never
touched `control/contract/**`, per its own hard constraint). WSK-15 replaced that controller's old
hardcoded `501` with a real `ContractReadService.readLatest(...)` call that, in this throwaway
stack (no artifact store configured), throws an unhandled AWS S3 SDK error instead of the
documented 404 — visible in the trace as `UnknownError` inside `@aws-sdk/middleware-sdk-s3`, not
anywhere near `control/auth/**` or `control/policy/**`. Confirmed unrelated three ways: (1) this
test's request path never reaches code this ticket changed — `contract.read`'s `impactClass` is
`read`, so Layer 4/WS4 is inert for it; (2) `NODE_ENV=test` keeps the dev-mode `PolicyDecisionPoint`
bound for this exact test file (per `control.module.ts`'s own env-conditional binding), so Layer 3
behaves byte-for-byte as it did before this ticket; (3) reading `contract.controller.ts`'s current
source shows it now constructs `ContractReadService` from `../../codegen/contract-read.service`,
a dependency that did not exist when WSK-21 wrote this test. **35/36 of WSK-21's own tests pass
unchanged; all 19 of this ticket's own new tests pass.**

RLS integrity gate re-checked afterward: still `OK — 14 tenant-scoped table(s) intact`.

Container torn down (`docker rm -f wsk22-db`) after the run.

---

## Codegen pipeline (WSK-15) — `src/codegen/**`

Design §05 Layer 3 / §06, the rail's supply side: composition × vocabulary -> `openapi.v1.json`
(hand-authored, WSK-D19) -> derived TS SDK (`openapi-typescript`) + `CONTENT-CONTRACT.md`; a
canonical-serialization + per-artifact-hash `contentHash`; an artifact store in MinIO
(WSK-07's `StorageAdapter`, no second S3 client); a **byte-identical double-run CI gate**; and the
real response for `GET /control/v1/tenants/:slug/contract` (replacing WSK-21's documented 501).

### Why this directory has TWO kinds of files

`src/codegen/*.ts` (plain files, e.g. `contract-read.service.ts`, `codegen.module.ts`,
`contract-manifest.types.ts`, `artifact-keys.ts`) are ordinary commonjs, part of `tsc`'s build,
zero vocabulary imports — the NestJS-facing read side.

`src/codegen/generator/*.mts` are ESM, run via `tsx` (`node --import tsx ...`, same tool
`webdesk/payload/scripts/*.mjs` already uses), and DO import `webdesk/payload/vocabulary/**`
directly (WSK-06/WSK-14, frozen — this ticket builds ON it, never re-derives it). The `.mts`
extension is load-bearing: `tsconfig.json`'s `include` is `["src/**/*.ts", "test/**/*.ts"]`, which
does not match `.mts`, so these files never enter `tsc`'s commonjs compilation graph (which would
otherwise fail on the vocabulary package's own `.ts`-extension internal imports, e.g. `blocks.ts`'s
`from './primitives.ts'`, with `TS5097`). `generator/README.md` has the full story, including the
`tsx`-vs-`vitest` CJS/ESM interop mismatch `generator/cjs-interop.mts` exists to paper over (a
plain `import { X } from "../../storage/y"` from an `.mts` file resolves correctly under `vitest`
but silently to `undefined` under `tsx` — verified empirically, pinned by
`test/codegen-generator-crossboundary-imports.spec.ts`).

`tsconfig.json` gained one `exclude` entry, `"test/codegen-*.spec.ts"` — these test files import
the `.mts` generator code directly (correctly — they are testing the real generator, not a mock),
which would otherwise pull the whole vocabulary chain into `tsc`'s program the same way and break
`npm run typecheck` for the whole project. `vitest` ignores `tsconfig.json`'s `include`/`exclude`
(its own `vitest.config.ts` glob is what runs these files), so this excludes them from `tsc` only,
never from the test run.

### What each file does

See `src/codegen/generator/README.md` for the full per-file breakdown. In one line each:
`canonical-json.mts` (sorted-key JSON + sha256), `vocabulary-field-schema.mts` (primitive -> JSON
Schema), `openapi-builder.mts` (the hand-authored artifact), `content-contract-md.mts` (derived,
same input as the OpenAPI builder), `sdk-ts.mts` (derived, wraps `openapi-typescript`),
`versioning.mts` (thin wrapper over WSK-14's `breaking-change.ts` classifier — no version logic
reimplemented), `build-artifacts.mts` (pure orchestration), `fetch-composition.mts` (the only file
that touches Postgres), `storage-io.mts` (the only file that touches MinIO — reuses
`s3-storage.adapter.ts` directly), `run-codegen.mts` (the real CLI pipeline: fetch -> build ->
publish -> optional `contract.published` event), `generate-single.mts` +
`double-run-gate.mts` (the CI determinism gate — two separate child processes, byte-compared).

### What the control-plane endpoint now returns

`GET /control/v1/tenants/:slug/contract` (`src/control/contract/contract.controller.ts`, replacing
WSK-21's 501) now calls `ContractReadService.readLatest(slug)`
(`src/codegen/contract-read.service.ts`), which reads `contracts/<slug>/latest.json` from the
`artifacts` bucket and mints pre-signed GET URLs. Two outcomes, both audited
(`control.contract.read`, same as every other command):

- **200** — design §06's exact shape: `{ version, vocabularyVersion, blockLibrary, artifacts:
  { sdkTsUrl, sdkPhpUrl: null, openapiUrl, contractMdUrl }, contentHash, generatedAt }`.
- **404** — `{ type: ".../errors/contract-not-generated", status: 404, ... }` when no successful
  generation exists for the tenant yet (or, defensively, when the artifact store itself cannot
  currently answer — see "One real bug found" below). This is a materially different, more honest
  state than WSK-21's old blanket 501 ("not implemented"), now that the pipeline exists.

**`control.module.ts` gained one import** (`CodegenModule`) — required for Nest to resolve
`ContractReadService` into `ContractController`'s constructor; not editable from
`contract.controller.ts` alone. Flagged per the ticket's own instruction to report changes outside
the strictly-named ownership list. `app.module.ts` was NOT touched (`ControlModule` is already
registered there from WSK-21).

### `blockLibrary` is a documented placeholder

WSK-16 (the block-renderer library) has not shipped. `artifacts.blockLibrary` reads
`{ package: "@gaiada/webdesk-blocks", version: "0.0.0-pending-wsk16", range:
"^0.0.0-pending-wsk16" }` — never presented as if a real published package exists. Fills in for
real once WSK-16 lands; nothing about the contract shape changes when it does.

### `.fields`-composed collections have no distinct wire location

A collection's `fields` composition (design §05 Layer 2) is documented in `CONTENT-CONTRACT.md` and
an informational `CollectionFields_<key>` OpenAPI component (referenced via an
`x-webdesk-fields-schema` extension on the list operation) — but the REAL `/v1` read path
(`content-read.ts`) never exposes it as a distinct envelope property; where a collection's own data
surfaces at all, it is folded into the generic, free-form `seo` object (e.g. the fixed `redirect`
collection's `seo.redirect`, per `redirects.ts`'s own convention). The OpenAPI documents this
honestly rather than inventing a wire property the real routes do not serve.

### The `redirect` collection is excluded from a tenant's generated contract

`fetch-composition.mts` drops the fixed `redirect` collection before it ever reaches the OpenAPI
builder — `redirects.ts`'s own header states a redirect "is never page content and never flows
through the block vocabulary," so it is not part of the client-facing SDK contract. An
interpretation choice, flagged here rather than silently made.

### One real bug found and fixed during this ticket's own verification

`ContractReadService.readLatest` originally let a raw storage-layer error propagate — a real gap
independently confirmed live by the (concurrent) WSK-22 session's own test run against a throwaway
stack with no artifact-store bootstrap: `StorageAdapter.headObject`'s NotFound detection
(`s3-storage.adapter.ts`, not this ticket's file) recognizes an absent OBJECT but not every
provider's shape for an absent BUCKET, so a genuinely-missing bucket surfaced as an unhandled
`@aws-sdk/middleware-sdk-s3` error (a bare 500) instead of the documented 404. Fixed by wrapping
`readLatest` in a top-level try/catch that treats any storage-layer failure as "no contract
currently servable" (logged loudly, never silently) — regression-tested in
`test/codegen-storage-and-contract-read.spec.ts` ("... when the artifacts bucket itself does not
exist").

### A pre-existing/concurrent gap observed, NOT caused by and NOT fixed by this ticket

Booting the FULL `AppModule` (`src/app.ts`, used by `test/helpers/app.ts` — WSK-05's own test
harness) currently fails: `FormsService` (`src/forms/forms.service.ts`) now injects
`ZoneBEventEmitterService` (a WSK-12 hook), but `FormsModule` does not import `EventsModule`, so
Nest cannot resolve the dependency. Verified this is unrelated to WSK-15: `forms/**` is outside
this ticket's owned scope (never touched), the failure is a Nest DI resolution error entirely
inside `FormsModule`/`EventsModule`, and it reproduces identically whether or not `CodegenModule`
exists. Blocks `test/api-keys.scope-matrix.spec.ts`, `no-key.spec.ts`, `revoked-key.spec.ts`,
`plaintext-dump-grep.spec.ts`, `tenant-quota.spec.ts` (all of which boot the full `AppModule`) —
none of WSK-15's own tests boot it. Whoever owns `forms.module.ts` next needs `imports: [...,
EventsModule]` added there.

### A required update to an EXISTING test file (not made here — not this ticket's file to edit)

`test/control-jobs.spec.ts`'s `describe("control-plane contract read — §06 not-yet-available
surface (WSK-15 unbuilt)", ...)` block asserts the OLD behavior this ticket intentionally replaces
(`expect(res.statusCode).toBe(501)`). That describe block's own name is now stale — WSK-15 is
built. With real storage configured, the endpoint correctly returns 404 (not 501, and not the
500-bug above — already fixed). This is the ONE expected failure in WSK-21/22's own suites; every
other WSK-21/22 test (50/50, re-run against this ticket's changes) passes unchanged. The
coordinator should update or remove that one `describe` block; not done here per the ticket's
ownership boundary (`test/codegen-*.spec.ts` only).

### Determinism gate — real proof, both ways

**In-process** (`test/codegen-determinism.spec.ts`, no containers needed): the same composition
input produces byte-identical `openapi.v1.json`/`sdk.d.ts`/`CONTENT-CONTRACT.md`/hash-manifest and
an identical `contentHash` across repeated calls, including across a >1s wall-clock gap (no
timestamp leakage); a genuinely different composition or tenant slug produces a genuinely different
hash.

**Real child processes against a real Postgres** (`npm run codegen:gate`,
`test/codegen-double-run-gate.spec.ts`): spawns `generate-single.mts` as two SEPARATE `node`
processes per tenant (fresh module cache each time — the closest proxy to "a second
machine/container" without a second physical machine) and byte-compares every artifact.

### Verification runbook — one throwaway Postgres + one throwaway MinIO, port block 55500-55502

Checked free via `docker ps` first — not `55432`/`55433`/`55435`/`56380` (other concurrent
sessions), not the `55450-55466`/`55480`/`55490` blocks WSK-05/10/11/14/21/22 already use.

```bash
cd webdesk

# 1. Postgres — same role bootstrap as every other ticket's runbook, port 55500.
MSYS_NO_PATHCONV=1 docker run -d --name wsk15-db -p 55500:5432 \
  -e POSTGRES_PASSWORD=throwaway_superuser -e POSTGRES_DB=webdesk \
  -e POSTGRES_OWNER_USER=webdesk_owner -e POSTGRES_OWNER_PASSWORD=throwaway_owner \
  -e POSTGRES_MIGRATOR_USER=webdesk_migrator -e POSTGRES_MIGRATOR_PASSWORD=throwaway_migrator \
  -e POSTGRES_APP_USER=webdesk_app -e POSTGRES_APP_PASSWORD=throwaway_app \
  -v "$(pwd -W)/postgres/init-roles.sh:/docker-entrypoint-initdb.d/10-init-roles.sh:ro" \
  postgres:16-alpine

# 2. MinIO (the `artifacts` bucket — WSK-07's platform-internal bucket, no new bucket added),
#    API 55501, console 55502.
docker run -d --name wsk15-minio -p 55501:9000 -p 55502:9001 \
  -e MINIO_ROOT_USER=webdesk_minio -e MINIO_ROOT_PASSWORD=changeme_minio_password \
  minio/minio:latest server /data --console-address ":9001"

# 3. Migrations (idempotent — 5 file(s), same ledger every other ticket uses; this ticket adds none).
MIGRATE_DATABASE_URL="postgres://webdesk_migrator:throwaway_migrator@localhost:55500/webdesk" \
  node migrations/migrate.mjs

# 4. RLS integrity gate must stay green (this ticket adds no tables — informational, not new risk).
DATABASE_URL="postgres://webdesk_migrator:throwaway_migrator@localhost:55500/webdesk" \
  node scripts/check-rls-integrity.mjs

# 5. Typecheck + this ticket's own suite. Every env var below is the REAL name the app code reads
#    (APP_DATABASE_URL/MIGRATE_DATABASE_URL/STORAGE_*) — no WSK15_-prefixed shadow variable.
cd api
npm install
npx tsc --noEmit
APP_DATABASE_URL="postgres://webdesk_app:throwaway_app@localhost:55500/webdesk" \
MIGRATE_DATABASE_URL="postgres://webdesk_migrator:throwaway_migrator@localhost:55500/webdesk" \
STORAGE_ENDPOINT="http://localhost:55501" \
STORAGE_ACCESS_KEY_ID="webdesk_minio" \
STORAGE_SECRET_ACCESS_KEY="changeme_minio_password" \
  npx vitest run test/codegen-*.spec.ts

# 6. The real double-run CI gate against two real, differently-composed tenants (seed them first —
#    see any codegen-*.spec.ts's own `seedTenant` helper for the exact INSERT shape, or run the
#    live pipeline once with `codegen:run` against a tenant your own session already seeded).
APP_DATABASE_URL="postgres://webdesk_app:throwaway_app@localhost:55500/webdesk" \
  node --import tsx src/codegen/generator/double-run-gate.mts --tenants <slugA>,<slugB>

# 7. Tear down.
cd ..
docker rm -f wsk15-db wsk15-minio
```

### Exact env vars this ticket's code reads (all live getters, real names, no shadow prefix)

| Var | Read by | Default |
|---|---|---|
| `APP_DATABASE_URL` | `fetch-composition.mts`'s caller (`run-codegen.mts`/`generate-single.mts`), same var every other ticket uses | — (must be set) |
| `STORAGE_ENDPOINT` / `MINIO_ENDPOINT` | `storage.config.ts` (WSK-07, unmodified) — `storageConfig.endpoint` | empty string |
| `STORAGE_ACCESS_KEY_ID` / `STORAGE_SECRET_ACCESS_KEY` | `storage.config.ts` — falls back to `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` in dev | dev-only fallback |
| `MINIO_BUCKET_ARTIFACTS` | `storage.config.ts` — `storageConfig.bucketName("artifacts")` | `artifacts` |
| `WEBDESK_MEDIA_PRESIGN_TTL_SECONDS` | `storage.config.ts` — the pre-signed GET TTL `ContractReadService` reuses | `300` |
| `WEBDESK_ZONEB_EVENTS_ENABLED` / `WEBDESK_ZONEB_BRIDGE_URL` / `WEBDESK_EVENT_SECRET` | `events.config.ts` (WSK-12, unmodified) — only consulted when `run-codegen.mts --emit-event` is passed | fail-soft no-op if unset |

No new variables were added to `.env.example` (out of this ticket's owned scope, per the standing
convention every prior ticket followed) — every var above already exists for another ticket's
reason; this ticket adds no vocabulary of its own.

### Real double-run proof (actually run, 2026-08-27) — verbatim

Two real, differently-composed tenants seeded on the throwaway stack above (`wsk15-alpha`: 2
collections, id-ID default + en-US; `wsk15-beta`: 3 collections, en-US only):

```
$ APP_DATABASE_URL="postgres://webdesk_app:throwaway_app@localhost:55500/webdesk" \
    node --import tsx src/codegen/generator/double-run-gate.mts --tenants wsk15-alpha,wsk15-beta

-- wsk15-alpha: run 1 (fresh process) --
wrote 4 artifacts to ...\wsk15-alpha\run1 (contentHash sha256:0d5282213f9412a6118d42beae140024071d7d7c227e1539d116b3586076c085)
-- wsk15-alpha: run 2 (fresh process) --
wrote 4 artifacts to ...\wsk15-alpha\run2 (contentHash sha256:0d5282213f9412a6118d42beae140024071d7d7c227e1539d116b3586076c085)
-- wsk15-alpha: byte-identical across both runs (4 artifacts) --
-- wsk15-beta: run 1 (fresh process) --
wrote 4 artifacts to ...\wsk15-beta\run1 (contentHash sha256:787b2d85956c57c06fc113170d11e9029d9e03f7a2297db20c41a509203c7e6a)
-- wsk15-beta: run 2 (fresh process) --
wrote 4 artifacts to ...\wsk15-beta\run2 (contentHash sha256:787b2d85956c57c06fc113170d11e9029d9e03f7a2297db20c41a509203c7e6a)
-- wsk15-beta: byte-identical across both runs (4 artifacts) --
DETERMINISM GATE PASSED — 2 tenant(s), 4 artifact(s) each, byte-identical.
```

Reproduced twice (once before, once after the `cjs-interop.mts` refactor) with IDENTICAL hashes
both times — the refactor changed how the generator imports its dependencies, not what it
generates.

### Full test run (2026-08-27)

```
✓ test/codegen-openapi-builder.spec.ts (12 tests)
✓ test/codegen-storage-and-contract-read.spec.ts (6 tests)
✓ test/codegen-contract-controller.spec.ts (6 tests)
✓ test/codegen-double-run-gate.spec.ts (3 tests)
✓ test/codegen-sdk-typecheck.spec.ts (1 test)
✓ test/codegen-determinism.spec.ts (5 tests)
✓ test/codegen-versioning.spec.ts (8 tests)
✓ test/codegen-generator-crossboundary-imports.spec.ts (5 tests)

 Test Files  8 passed (8)
      Tests  46 passed (46)
```

`npx tsc --noEmit`: clean, 0 errors. RLS integrity gate: `OK — 14 tenant-scoped table(s) intact`
(unchanged — this ticket adds no schema). No-regression check: WSK-21/22's own suites
(`control-authz`, `control-commands`, `control-command-registry`, `control-auth-layers`) re-run
against this ticket's changes — **50/50 passed**. `control-jobs.spec.ts`: 4/5 passed, the one
failure being the stale WSK-21-authored 501 expectation documented above (not a regression — that
test's own describe-block name already says "WSK-15 unbuilt").

Containers torn down (`docker rm -f wsk15-db wsk15-minio`) after the run.

## WSK-37 — per-tenant outbound webhooks

New paths: `src/tenant-webhooks/**` (module/controller/service/repository/dispatcher/BullMQ
worker/SSRF guard/secret encryption), `migrations/0006_tenant_webhooks.sql`,
`test/tenant-webhooks-*.spec.ts`. Clients register their own HTTPS endpoint; their own
`form.received` submissions are POSTed there, signed the same way WSK-12's Zone A bridge signs
its own B→A facts (`events/zoneb-event-signature.ts`, reused verbatim — no second signer written).

### THE SECURITY QUESTION (design §03 amendment this ticket proposes)

A tenant webhook's `target_url` is the first destination in this whole design a TENANT gets to
type in themselves — a brand-new egress class §03's allowlist table (a fixed, operator-controlled
destination list) does not describe. Proposed addition to §03's "Zone B egress allowlist" section:

> **Per-tenant outbound webhooks (WSK-37) — a CLIENT-CONTROLLED destination, not an
> operator-controlled one.** Every other row in this table names a destination WE chose; this one
> is chosen by the tenant at registration time and can point anywhere on the public internet by
> design (that is the point of the feature). The containment obligation this table exists to state
> is therefore not "which fixed host" but "which categories of host can never be reached, no
> matter what a tenant types" — enforced entirely in application code
> (`tenant-webhooks/ssrf-guard.ts`), on EVERY delivery attempt AND every redirect hop, not once at
> registration:
> - HTTPS only, no other scheme.
> - Every RFC1918/loopback/link-local/CGNAT/multicast/broadcast/reserved IPv4 and IPv6 range is
>   refused, including the cloud-metadata address (169.254.169.254) specifically.
> - A hostname is resolved and EVERY returned address is checked — refusing only when all
>   addresses are bad would let an attacker win a race on which address `fetch()` picks.
> - Re-validated on every delivery attempt and every redirect hop (`redirect: "manual"`, capped at
>   `TENANT_WEBHOOK_MAX_REDIRECTS`, default 2) — DNS is not a fact checked once: a name that
>   resolved public at registration can rebind to a private address before the next retry, or a
>   302 partway through delivery can point somewhere the original URL never did.
> - Bounded per-attempt timeout (`TENANT_WEBHOOK_REQUEST_TIMEOUT_MS`, default 5s) and payload size
>   cap (`TENANT_WEBHOOK_MAX_PAYLOAD_BYTES`, default 64KB) — an endpoint that accepts-but-never-
>   responds, or demands an unbounded body, is itself a resource-exhaustion vector.
> - What a forged/replayed delivery can cause is bounded structurally, same shape as channel 1's
>   own row: a delivery is an OUTBOUND POST carrying a slim projection of ONE tenant's OWN
>   submitted-form data to a URL that SAME tenant registered — it can never cause a privileged
>   transition, never touches another tenant's data (dispatch is `tenant_id`-scoped end to end,
>   RLS + explicit app-layer filter), and the signature lets the receiving client detect tampering
>   in transit, not prevent Zone B from choosing what to send.

### Why the secret is ENCRYPTED, not hashed (deliberate deviation from the ticket's literal wording)

The ticket asked for "a per-tenant secret, hashed at rest the way `api_keys` does — sha256 +
pepper — never plaintext." That is right for a VERIFICATION secret (api_keys: compare a freshly
hashed presented value to a stored hash) but is mathematically impossible for a SIGNING secret: the
dispatcher must compute a fresh HMAC over new bytes on every delivery, which requires the original
secret bytes, not a one-way hash of them. Implemented instead: AES-256-GCM ciphertext
(`secret_ciphertext`), keyed by `sha256(TENANT_WEBHOOK_SECRET_PEPPER)` — same custody model as
`API_KEY_PEPPER` (Zone B env only, never in the database, never in git, deliberately a SEPARATE
pepper so a leak on one path cannot weaken the other). A database-only compromise (no env access)
recovers nothing usable to forge a signature with — the actual property "hashed at rest" was
reaching for. Full reasoning in `migrations/0006_tenant_webhooks.sql`'s own header and
`tenant-webhooks/webhook-secret.ts`'s header.

### Required changes outside this ticket's scope (reported, not made)

- **`app.module.ts`** — one import line, same posture WSK-10/11/12/21 each already took:
  ```ts
  import { TenantWebhooksModule } from "./tenant-webhooks/tenant-webhooks.module";
  // add TenantWebhooksModule to @Module({ imports: [...] })
  ```
- **`forms/forms.service.ts`** — ONE call, alongside the existing WSK-12 hook at step 9 of
  `submit()` (immediately after the `zoneBEvents.emitFormReceived(...)` call, same best-effort
  `.catch()` discipline — `forms.service.ts` is not this ticket's owned path):
  ```ts
  // WSK-37 — fan out to any tenant-registered outbound webhooks. Same fail-soft discipline as the
  // WSK-12 call immediately above: a client's own endpoint being down must never fail the
  // submission response.
  await this.tenantWebhookDispatcher
    .dispatchFormReceived(form.tenantId, {
      siteSlug: form.tenantSlug,
      formId: form.formId,
      submissionId: submission.id,
      hasAttachments: attachmentRefs.length > 0,
      fields: sanitizedFields, // already-sanitized submitted values — the tenant's OWN form fields
    })
    .catch((err) => {
      this.logger.warn(`tenant webhook dispatch failed for submission ${submission.id}: ${String(err)}`);
    });
  ```
  This needs `TenantWebhookDispatcherService` injected into `FormsService`'s constructor, and
  `forms.module.ts`'s `imports` array to add `TenantWebhooksModule` (same reasoning
  `forms.module.ts`'s own header gives for why `EventsModule` had to be imported there directly:
  injection resolves against providers visible to the injecting module, not transitively).
- **`.env.example`** — new vars, none of which exist yet (WSK-01's file): `TENANT_WEBHOOK_SECRET_PEPPER`
  (required in production, same `requireInProd` shape as `API_KEY_PEPPER`), `TENANT_WEBHOOK_QUEUE_NAME`,
  `TENANT_WEBHOOK_MAX_ATTEMPTS`, `TENANT_WEBHOOK_BACKOFF_DELAY_MS`, `TENANT_WEBHOOK_REQUEST_TIMEOUT_MS`,
  `TENANT_WEBHOOK_MAX_REDIRECTS`, `TENANT_WEBHOOK_MAX_PAYLOAD_BYTES` — see
  `tenant-webhooks.config.ts` for defaults. `TENANT_WEBHOOK_SSRF_TEST_ALLOWLIST` is TEST-ONLY (see
  `ssrf-guard.ts`'s own header) and must never be added to `.env.example` or any real environment.

### Verification runbook — one throwaway Postgres (port 55510) + one Redis (port 55511)

Checked free via `docker ps` first — not 55432/55433/55435/55480/55481/55490/55496/55500-55502,
not the 55450-55466 WSK-05/10/11 block. The receiving side is an in-process local HTTPS sink
(`test/helpers/tenant-webhook-sink.ts`, self-signed cert embedded in that file) — no extra
container needed for it.

```bash
# 1. Fresh throwaway Postgres — same role bootstrap as every prior ticket's runbook, port 55510.
MSYS_NO_PATHCONV=1 docker run -d --name wsk37-db -p 55510:5432 \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=throwaway_super -e POSTGRES_DB=webdesk \
  -e POSTGRES_OWNER_USER=webdesk_owner -e POSTGRES_OWNER_PASSWORD=throwaway_owner \
  -e POSTGRES_MIGRATOR_USER=webdesk_migrator -e POSTGRES_MIGRATOR_PASSWORD=throwaway_migrator \
  -e POSTGRES_APP_USER=webdesk_app -e POSTGRES_APP_PASSWORD=throwaway_app \
  -v "$(pwd -W)/../postgres/init-roles.sh:/docker-entrypoint-initdb.d/10-init-roles.sh:ro" \
  postgres:16-alpine

# 2. Redis (BullMQ), port 55511.
docker run -d --name wsk37-redis -p 55511:6379 redis:7-alpine

# 3. Migrate.
MIGRATE_DATABASE_URL="postgres://webdesk_migrator:throwaway_migrator@localhost:55510/webdesk" \
  node ../migrations/migrate.mjs

# 4. RLS integrity gate — MUST pass with the two new tables included.
DATABASE_URL="postgres://webdesk_migrator:throwaway_migrator@localhost:55510/webdesk" \
  node ../scripts/check-rls-integrity.mjs

# 5. Run the suite.
APP_DATABASE_URL="postgres://webdesk_app:throwaway_app@localhost:55510/webdesk" \
MIGRATE_DATABASE_URL="postgres://webdesk_migrator:throwaway_migrator@localhost:55510/webdesk" \
REDIS_URL="redis://localhost:55511" \
TENANT_WEBHOOK_SECRET_PEPPER="wsk37-test-pepper-never-used-outside-this-suite" \
  npx vitest run test/tenant-webhooks-ssrf.spec.ts test/tenant-webhooks-registration.spec.ts test/tenant-webhooks-delivery.spec.ts

# 6. Tear down.
docker rm -f wsk37-db wsk37-redis
```

### Real run (2026-08-27) — verbatim

```
[rls-integrity] OK — 16 tenant-scoped table(s) intact (enabled + forced + >=1 policy).

✓ test/tenant-webhooks-delivery.spec.ts (4 tests) 7481ms
  ✓ registers a webhook, dispatches a form.received event, and the sink can verify the
    signature with WSK-12's own verifySignature() 408ms
  ✓ retries with growing backoff while the sink fails, then delivers once it recovers 1685ms
  ✓ REFUSES an SSRF-targeted webhook — a target pointed at the cloud-metadata address never
    reaches the network, delivery marked failed with an SSRF reason, sink untouched 3382ms
  ✓ cross-tenant isolation: a webhook registered for tenant A never fires when tenant B's
    event is dispatched 1892ms
✓ test/tenant-webhooks-registration.spec.ts (9 tests) 641ms
✓ test/tenant-webhooks-ssrf.spec.ts (19 tests) 15ms

 Test Files  3 passed (3)
      Tests  32 passed (32)
```

`npx tsc --noEmit`: clean, 0 errors, whole project (this ticket added no `any`, no `@ts-ignore`).
Containers torn down (`docker rm -f wsk37-db wsk37-redis`) after the run.

## WSK-38 — Data & Privacy / data-subject requests (DSR)

New paths: `src/privacy/**` (module/controller/service/repository/attachments-service/
residency-statement-service/identifier/command-types/command-decorator/policy guard),
`migrations/0007_privacy_dsr.sql`, `test/privacy-*.spec.ts`, `test/privacy-test-app.ts`,
`test/privacy-fixtures.ts`. This is the ticket that makes the platform legally answerable for the
third-party PII it holds (design §11/WSK-D22): we are a **processor**, each client is the
**controller** (UU PDP No. 27/2022 today; GDPR-shaped duties follow any client with EU end-users —
that belongs in the client contract, not only here).

### The command surface (three commands, all HIGH-impact / WS4-gated)

| Command | Endpoint | Scope | Impact | Idempotency-Key |
|---|---|---|---|---|
| `privacy.find` | `POST /control/v1/tenants/:tenantSlug/privacy/find` | `webdesk:operate` | high | not required (every lookup is its own audited event — see below) |
| `privacy.export` | `POST /control/v1/tenants/:tenantSlug/privacy/export` | `webdesk:operate` | high | not required (same reasoning) |
| `privacy.erase` | `POST /control/v1/tenants/:tenantSlug/privacy/erase` | `webdesk:promote` | high | **required** |

Body for all three: `{ "identifier": "<email, phone, or whatever a form actually collected>" }`.

**Why all three are HIGH, not just erase.** The ticket's own instruction was explicit ("Expose all
three as WS4-gated, audited control-plane commands ... with the correct impact class"). A generic
C-05 reading would put `find`/`export` at `read`/`medium` (no DB mutation) — but finding or
exporting a real person's COMPLETE footprint across a tenant concentrates PII in a way an ordinary
read never does, and design §11/WSK-D22b's wording carries no carve-out for the non-destructive
two. So all three require a WS4 assertion. What DOES distinguish `erase` is its **scope**:
`webdesk:promote` — the same tier this command surface already reserves for every other
irreversible action (`tenant.archive`/`site.archive`/`release.rollback` in
`control/command-types.ts`). `find`/`export` stay on `webdesk:operate`. That is the concrete,
checkable form "erase is irreversible — treat it accordingly" takes here: same WS4 gate for all
three, a stricter scope tier for the one that destroys data. Full reasoning:
`src/privacy/command-types.ts`'s own header.

**Why `find`/`export` are not idempotency-keyed.** Every lookup or export of a real person's data
is itself a distinct, auditable access. Collapsing a duplicate call into "same command, no new
effect" would UNDER-count how many times staff looked at that person's data — the opposite of what
a DSR trail is for. Each call gets its own `dsr_requests` row. Only `erase` (genuinely destructive)
is idempotency-wrapped, matching WSK-21's "every command double-fired must produce one effect"
doctrine — proven by `test/privacy-erase.spec.ts`'s double-fire test.

**Matching, not by a hardcoded field-name list.** "email/phone are the realistic keys" (§11) is
read as an example, not an exhaustive schema: `find`/`export`/`erase` match EITHER the existing
`data_subject_ref` correlator (0003_forms.sql's own forward-looking hook, populated today only from
an `email` field by `forms/consent.ts`) OR any VALUE inside a submission's `payload.fields` object,
whatever that form's own field names happen to be (`privacy.repository.ts`'s `jsonb_each_text`
scan). This is how a phone-only form (no `email` field, `data_subject_ref` NULL) is still found —
covered by `test/privacy-find-export.spec.ts`'s own phone-match test. No phone-number
canonicalization is done (exact case-insensitive string match only) — a follow-up could add
libphonenumber-based normalization.

### THE DESIGN QUESTION — erasure vs. immutability vs. consent-as-evidence

This was the part of the ticket to answer rather than skip. Erasure collides with two things
already in this schema: (a) the append-only/immutable-ledger discipline this estate uses everywhere
(`audit_entries`' `REVOKE UPDATE, DELETE`), and (b) the consent record being itself evidence a
controller (our client) may need to keep. Resolution, landed in
`migrations/0007_privacy_dsr.sql` and `src/privacy/privacy.repository.ts`:

- **SCRUB, not DELETE, on `submissions`** — extending `submissions-purge.service.ts`'s own
  already-established time-based-retention precedent (WSK-10) from automatic-floor to
  on-demand-rights-request. `erase()` sets `payload = '{}'`, `status = 'erased'` (a THIRD terminal
  status alongside the pre-existing `'purged'` — added via the migration's `ALTER TABLE ...
  DROP/ADD CONSTRAINT`), and — **unlike the existing purge job** — also `data_subject_ref = NULL`,
  so the row stops being findable by identity going forward. The row's `id`/`created_at`/
  `expires_at`/`form_def_id` survive, matching this ledger's own append-only-history precedent
  (`audit_entries`/`content_versions`).
- **Consent columns are DELIBERATELY preserved**, not scrubbed. `consent_notice_text`/
  `consent_notice_version`/`consent_accepted_at` describe what notice a NOW-erased person was shown
  and that they accepted it — they are not personal data ABOUT that person. Keeping them serves
  "consent you cannot evidence is consent you do not have" (§11) without keeping any PII. This is a
  DEVIATION from the existing purge job, which currently tombstones `consent_notice_text` too —
  flagged as an observed inconsistency in the existing code, **not fixed** here
  (`submissions-purge.service.ts` is out of this ticket's owned scope).
- **A new evidentiary ledger, `dsr_requests`**, distinct from the generic `audit_entries` every
  other command already writes to (both are written — `CommandAuditService` reused verbatim for
  the generic `control.privacy.<x>` row). `dsr_requests` is append-only the same way
  (`REVOKE UPDATE, DELETE ... FROM webdesk_app`, proven against the ACTUAL runtime role in
  `test/privacy-erase.spec.ts`, not the migrator) and carries `subject_ref_hash` — a **SHA-256 of
  the normalized identifier, NEVER the plaintext**. This is the crux of resolving the collision: a
  row proving "subject X's data was erased at time T" must survive the erasure it describes without
  itself becoming a second, un-erasable copy of X's personal data. A plaintext-carrying audit row
  would have been exactly that mistake. Proven directly:
  `test/privacy-erase.spec.ts`'s "THE AUDIT TRAIL SURVIVES THE ERASURE" test queries both
  `dsr_requests` and `audit_entries` **after** the erasure completes and asserts neither the raw
  email nor anything resembling it appears anywhere in either row.
- **Attachments: hard DELETE, both the storage object and the `media_assets` row** — unlike
  `submissions`, a `media_assets` row carries no evidentiary purpose once its object is gone (it is
  pure operational metadata, not a rights record), so there is no tombstone to preserve. Ordering is
  the OPPOSITE of `media.service.ts`'s own upload path ("store then record"): erase deletes the
  storage object FIRST, and ABORTS the whole command (before any DB row is touched) if even one
  delete fails — see `privacy-attachments.service.ts`'s header for why an erasure's worst failure
  mode (a live, un-pointed-to copy of a person's file that nobody would ever know to delete) is
  worse than the reverse (an orphaned DB row pointing at an already-gone object, which fails loud
  and cleanly on next access).
- **Crypto-shredding was considered and rejected for THIS ticket.** Encrypting each submission's
  PII with a per-subject key and "erasing" by destroying the key is the stronger long-term answer,
  and would sit more comfortably alongside this estate's hash-chained-ledger instincts elsewhere —
  but it needs its own key-management schema (a KMS or a wrapped-key column + custody model, the
  same class of decision WSK-37's AES-256-GCM secret column required) that does not exist anywhere
  in this ledger yet. Inventing one inside this migration would be improvised DDL beyond a
  narrowly-scoped, genuinely-needed change. Flagged as a stronger future option, not built — see
  `migrations/0007_privacy_dsr.sql`'s own header for the full writeup of this decision.

### Residency statement (§11 "(d)")

`src/privacy/residency-statement.service.ts` — `ResidencyStatementService.buildFor(tenantSlug,
backupPhase)`. Under **WSK-D23** (storage fully self-hosted — MinIO primary, no Cloudflare, no R2)
this is answerable in one real sentence, generated from the SAME config the system actually runs on
(`STORAGE_ENDPOINT`/`STORAGE_PUBLIC_BASE_URL`, `APP_DATABASE_URL`'s own host), not hand-typed policy
prose:

> All of tenant '\<slug>''s content, form submissions and uploaded media are stored on self-hosted
> infrastructure we operate — Postgres at \<host> and MinIO (S3-API, self-hosted, never Cloudflare
> R2 or any third-party object store) at \<host> — with backups going to \<phase-specific target,
> e.g. "a nightly pull-model backup to a second estate-owned box (Zone B holds no credential for the
> destination and cannot reach, overwrite, or delete it)">.

Not wired to any HTTP route in this ticket (no design text asks for one) — a plain injectable a
future control-plane read endpoint, or the WSK-24 console card, can call directly. Proven by
`test/privacy-residency.spec.ts` across all three backup phases (`now`/`staging`/`target-state`,
per §11's own phased backup description).

### What could not be built as specified / flagged gaps

- **The time-based purge job (`submissions-purge.service.ts`, WSK-10) does not clear
  `data_subject_ref`** — only `payload` and `consent_notice_text`. A purged row therefore stays
  findable by identity forever unless a DSR erase also runs against it (which `erase()` handles
  correctly — see above). Not fixed here; `forms/**` is out of this ticket's owned scope. A
  one-line follow-up (`data_subject_ref = NULL` added to that job's own `UPDATE`) would close it,
  and is recommended.
- **The same purge job also tombstones `consent_notice_text`**, which this ticket's own design
  decision (above) treats as unnecessary/undesirable — consent evidence is not PII about the
  subject. Also not fixed here; noted as an inconsistency between the two erasure paths (time-based
  vs. on-demand) worth resolving in the same follow-up.
- **No phone-number canonicalization** — `find`/`export`/`erase` match on exact (case-insensitive)
  string equality against `payload.fields` values; a caller must supply the identifier in
  approximately the same format the form stored it in. A `libphonenumber`-based normalization layer
  is a reasonable follow-up if this becomes a real friction point.
- **Export inlines attachment bytes as base64 in the HTTP response body**, matching the
  base64-in-JSON convention `forms/**`/`media/**` already use for uploads, rather than writing a
  bundle to the `artifacts` bucket and returning a presigned URL. Fine for the realistic case
  (small form-attachment volumes) but would not scale to a subject with many/large attachments — a
  presigned-URL-based export is a reasonable follow-up, not built here (no existing `artifacts`-
  bucket-write path exists in this codebase to reuse yet).
- **Single-use WS4 replay protection has the same known gap `RealPolicyDecisionPoint` already
  documents** (a plain index, not a unique constraint, on `audit_entries.ws4_approval_id`) — this
  ticket inherits it unchanged, does not worsen it, and does not fix it (that migration is
  `control/**`'s own, per that file's own header).

### Required changes outside this ticket's scope (reported, not made)

- **`app.module.ts`** — one import line, same posture WSK-10/11/12/21/37 each already took:
  ```ts
  import { PrivacyModule } from "./privacy/privacy.module";
  // add PrivacyModule to @Module({ imports: [...] })
  ```
  Note: `PrivacyModule` re-provides `ControlAuthGuard`/`CONTROL_CHANNEL_AUTHENTICATOR`/
  `POLICY_DECISION_POINT` under its own DI graph rather than importing `ControlModule` (that
  module exports only `JobsService` — see `privacy.module.ts`'s header for the full reasoning).
  This is safe (both bindings are stateless verifiers, same classes, same env-conditional
  `NODE_ENV=test` switch `control.module.ts` already uses) but is duplication that should collapse
  the day this merges into `control/**` proper — see the next bullet.
- **The real merge target: `control/command-types.ts` + `control.module.ts`.** This ticket
  deliberately built a SHADOW command registry (`src/privacy/command-types.ts`) and a shadow guard
  (`src/privacy/policy/privacy-command-authorization.guard.ts`) rather than editing `control/**`,
  per this ticket's hard constraints. The exact merge is small and mechanical:
  1. Add three rows to `control/command-types.ts`'s `COMMAND_REGISTRY` (and three names to its
     `CommandName` union):
     ```ts
     "privacy.find": { command: "privacy.find", impactClass: "high", scope: "webdesk:operate", jobTracked: false },
     "privacy.export": { command: "privacy.export", impactClass: "high", scope: "webdesk:operate", jobTracked: false },
     "privacy.erase": { command: "privacy.erase", impactClass: "high", scope: "webdesk:promote", jobTracked: false },
     ```
  2. Change `PrivacyController`'s three `@PrivacyCommand(...)` decorators to `@Command(...)` (the
     real one, `control/command.decorator.ts`) and its guard list from
     `[ControlAuthGuard, PrivacyCommandAuthorizationGuard]` to
     `[ControlAuthGuard, CommandAuthorizationGuard]`.
  3. Add `PrivacyController` to `ControlModule.controllers` and `PrivacyRepository`/
     `PrivacyAttachmentsService`/`PrivacyCommandService`/`ResidencyStatementService` to its
     `providers`; delete `src/privacy/privacy.module.ts`,
     `src/privacy/policy/privacy-command-authorization.guard.ts`, `src/privacy/command-types.ts`
     and `src/privacy/command.decorator.ts` (everything this bullet's steps 1-2 make redundant).
  4. `test/privacy-test-app.ts` and `test/privacy-fixtures.ts` keep working unchanged either way
     (they build their own standalone Nest app, same as every other ticket's `*-test-app.ts`).
- **`.env.example`** — no NEW env vars: this ticket reads only vars that already exist
  (`APP_DATABASE_URL`, `MIGRATE_DATABASE_URL` via the migration runner, `STORAGE_*`/`MINIO_BUCKET_UPLOADS`
  from `storage.config.ts`, `TENANT_GUC_NAME` from `db/tenant-pool.ts`) — flagged loudly per this
  ticket's own instruction, and true: no `WSK38_*` prefix was invented anywhere.
- **The console card (WSK-24's surface, NOT built here).** Shape this ticket's command surface
  implies for a "data-subject request" card:
  - An identifier input (label: "email or phone") + three buttons: **Find**, **Export**,
    **Erase** — `Erase` renders with the same destructive/WS4-confirmation treatment the Sites tab
    already uses for promote/rollback (§08's button matrix: "always 🔴 WS4").
  - `Find` result: a table of `matches` (`submissionId`/`formDefId`/`status`/`createdAt`/
    `attachmentCount`) — no field values rendered (the command itself never returns them).
  - `Export` result: a downloadable bundle (the response IS the portable form — see the flagged gap
    above about base64-inlined attachments) — the console's natural move is "trigger a browser
    download of the JSON response", not a new server-side file-generation step.
  - `Erase` result: a confirmation summary (`submissionCount`/`attachmentCount`/`erasedAt`) plus a
    permanent-action warning BEFORE the WS4 confirmation step, not after.
  - A **residency statement** display: `ResidencyStatementService.buildFor(tenantSlug)`'s
    `.sentence` rendered as plain text on the same card (or an adjacent "Data & Privacy" settings
    section) — this is the §11 "(d)" requirement and has no other natural home in the console.

### Verification runbook — one throwaway Postgres (5432→55530) + one throwaway MinIO (9000→55531), run INSIDE a Linux container

Owner rule (2026-08-26): tests run on Linux, never the Windows host. This runbook stands up
Postgres + MinIO as ordinary Windows-Docker-Desktop containers (host ports only needed for local
inspection), puts a `node:22-bookworm-slim` container on the SAME docker network, `docker cp`s
`src/`/`test/`/`package*.json`/`tsconfig.json`/`vitest.config.ts`/`.swcrc` in (never a `-v` bind
mount — Git Bash on Windows silently rewrites container-side paths; `docs/...gitbash-docker-path-
mangling.md`), runs `npm install` FRESH inside the container (a Windows-built `node_modules` has
native bindings — `@swc/core` — that will not load on Linux), and talks to Postgres/MinIO by their
container DNS names on the shared network, not `localhost`. Ports checked free via `docker ps`
first (2026-08-27): not 55432/55433/55435, not the 55450/55460-55466/55480-55481/55490/
55500-55502/55510-55511 blocks from prior tickets, and NOT 55520 (`wsk17-postgres`, a concurrent
session's own container observed still running at verification time).

```bash
# 1. Network + throwaway Postgres + throwaway MinIO.
docker network create wsk38-net
MSYS_NO_PATHCONV=1 docker run -d --name wsk38-db --network wsk38-net -p 55530:5432 \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=throwaway_super -e POSTGRES_DB=webdesk \
  -e POSTGRES_OWNER_USER=webdesk_owner -e POSTGRES_OWNER_PASSWORD=throwaway_owner \
  -e POSTGRES_MIGRATOR_USER=webdesk_migrator -e POSTGRES_MIGRATOR_PASSWORD=throwaway_migrator \
  -e POSTGRES_APP_USER=webdesk_app -e POSTGRES_APP_PASSWORD=throwaway_app \
  -v "$(pwd -W)/../postgres/init-roles.sh:/docker-entrypoint-initdb.d/10-init-roles.sh:ro" \
  postgres:16-alpine
docker run -d --name wsk38-minio --network wsk38-net -p 55531:9000 \
  -e MINIO_ROOT_USER=webdesk_minio -e MINIO_ROOT_PASSWORD=changeme_minio_password \
  minio/minio:latest server /data --console-address :9001

# 2. The Linux test runner — `docker cp`, never a bind mount (see header above).
MSYS_NO_PATHCONV=1 docker run -d --name wsk38-runner --network wsk38-net -w /work node:22-bookworm-slim sleep infinity
MSYS_NO_PATHCONV=1 docker exec wsk38-runner sh -c 'mkdir -p /work/webdesk/api /work/webdesk/migrations /work/webdesk/postgres /work/webdesk/scripts'
docker cp src wsk38-runner:/work/webdesk/api/src
docker cp test wsk38-runner:/work/webdesk/api/test
docker cp package.json package-lock.json tsconfig.json vitest.config.ts .swcrc wsk38-runner:/work/webdesk/api/
docker cp ../migrations/. wsk38-runner:/work/webdesk/migrations
docker cp ../postgres/init-roles.sh wsk38-runner:/work/webdesk/postgres/init-roles.sh
docker cp ../scripts/check-rls-integrity.mjs wsk38-runner:/work/webdesk/scripts/check-rls-integrity.mjs
MSYS_NO_PATHCONV=1 docker exec wsk38-runner sh -c 'cd /work/webdesk/api && npm install --no-audit --no-fund'

# 3. Migrate (real env var name — MIGRATE_DATABASE_URL). Container DNS name, not localhost.
MSYS_NO_PATHCONV=1 docker exec wsk38-runner sh -c 'ln -s /work/webdesk/api/node_modules /work/webdesk/migrations/node_modules'
MSYS_NO_PATHCONV=1 docker exec -e MIGRATE_DATABASE_URL="postgres://webdesk_migrator:throwaway_migrator@wsk38-db:5432/webdesk" \
  wsk38-runner sh -c 'cd /work/webdesk/migrations && node migrate.mjs'

# 4. RLS integrity gate — MUST pass with dsr_requests included.
MSYS_NO_PATHCONV=1 docker exec wsk38-runner sh -c 'ln -s /work/webdesk/api/node_modules /work/webdesk/scripts/node_modules'
MSYS_NO_PATHCONV=1 docker exec -e DATABASE_URL="postgres://webdesk_migrator:throwaway_migrator@wsk38-db:5432/webdesk" \
  wsk38-runner sh -c 'cd /work/webdesk/scripts && node check-rls-integrity.mjs'

# 5. Run the suite (real env var names — APP_DATABASE_URL, MIGRATE_DATABASE_URL).
MSYS_NO_PATHCONV=1 docker exec \
  -e NODE_ENV=test \
  -e APP_DATABASE_URL="postgres://webdesk_app:throwaway_app@wsk38-db:5432/webdesk" \
  -e MIGRATE_DATABASE_URL="postgres://webdesk_migrator:throwaway_migrator@wsk38-db:5432/webdesk" \
  -e API_KEY_PEPPER="wsk38-test-pepper-never-used-outside-this-suite" \
  -e STORAGE_ENDPOINT="http://wsk38-minio:9000" \
  -e STORAGE_ACCESS_KEY_ID="webdesk_minio" \
  -e STORAGE_SECRET_ACCESS_KEY="changeme_minio_password" \
  -e MINIO_BUCKET_UPLOADS="uploads" \
  wsk38-runner sh -c 'cd /work/webdesk/api && npx vitest run test/privacy-command-registry.spec.ts test/privacy-residency.spec.ts test/privacy-find-export.spec.ts test/privacy-erase.spec.ts'

# 6. tsc, then tear down.
MSYS_NO_PATHCONV=1 docker exec wsk38-runner sh -c 'cd /work/webdesk/api && npx tsc --noEmit -p tsconfig.json'
docker rm -f wsk38-runner wsk38-db wsk38-minio
docker network rm wsk38-net
```

### Actually run (2026-08-27) — verbatim, on Linux (`node:22-bookworm-slim`, container, not the Windows host)

```
[webdesk:migrate] applying 0001_platform_core.sql ...
[webdesk:migrate] applying 0002_content.sql ...
[webdesk:migrate] applying 0003_forms.sql ...
[webdesk:migrate] applying 0004_mail.sql ...
[webdesk:migrate] applying 0005_tenant_locales.sql ...
[webdesk:migrate] applying 0006_tenant_webhooks.sql ...
[webdesk:migrate] applying 0007_privacy_dsr.sql ...
[webdesk:migrate] done — 7 file(s) discovered, 7 applied, 0 already in the ledger.

[rls-integrity] OK — 17 tenant-scoped table(s) intact (enabled + forced + >=1 policy).

 ✓ test/privacy-erase.spec.ts (6 tests) 933ms
 ✓ test/privacy-find-export.spec.ts (7 tests) 738ms
 ✓ test/privacy-command-registry.spec.ts (6 tests) 3ms
 ✓ test/privacy-residency.spec.ts (4 tests) 3ms

 Test Files  4 passed (4)
      Tests  23 passed (23)
```

`npx tsc --noEmit` (inside the same Linux container): clean, 0 errors, whole project. First run of
the suite caught two REAL bugs in the test's own assumptions (not the implementation) before this
green run: (1) the residency-statement test asserted the sentence never contains "cloudflare" — but
the sentence deliberately says "never Cloudflare R2" as a reassurance, so the assertion itself was
wrong (fixed to check the sentence never claims we USE Cloudflare); (2) the audit-immutability test
connected as `webdesk_migrator` (which owns every table and is never subject to the `REVOKE
UPDATE, DELETE`) instead of `webdesk_app` (the actual runtime role the REVOKE targets) — fixed by
adding `withTenantAsApp` (connects via `APP_DATABASE_URL`) to `test/privacy-fixtures.ts` and
re-pointing that one assertion at it; both `DELETE` and `UPDATE` are now proven refused against the
real runtime role, and the row is proven still present and unmodified afterward. Containers torn
down (`docker rm -f wsk38-runner wsk38-db wsk38-minio && docker network rm wsk38-net`) after the
run.
