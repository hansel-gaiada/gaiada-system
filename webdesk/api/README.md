# webdesk/api — WSK-05 (API keys)

Zone B NestJS service (Fastify adapter). This ticket built: API key mint/rotate/revoke, the
scoped-auth guard that resolves a key into `{tenant, env, scope}` and runs the request under the
`webdesk.tenant_ctx` GUC, per-tenant read quotas, and a minimal demonstrative content route to
prove the guards actually gate something real. Status: **DEV-VERIFIED** against a throwaway
Postgres — see the verification runbook below. Not wired into `../docker-compose.yml` (that file
is WSK-01's; see the ticket report for why and what changes it needs).

## Object storage is RustFS (WSK-52 / WSK-D42) — read this before running any storage-touching suite

MinIO is gone; storage is `rustfs/rustfs:1.0.0` (pinned by digest in `../docker-compose.yml`). The image has no `mc`, so everything `mc` did is done by **`../scripts/storage-bootstrap.mjs`** over the S3 API + RustFS admin API. Run it (root credential, once, idempotent — a second run prints `changes=0`) after `npm ci` in this directory:

```bash
STORAGE_ENDPOINT=http://<host>:9000 RUSTFS_ROOT_USER=... RUSTFS_ROOT_PASSWORD=... \
STORAGE_ACCESS_KEY_ID=<api service key> STORAGE_SECRET_ACCESS_KEY=<its secret, >= 8 chars> \
  node ../scripts/storage-bootstrap.mjs
```

It creates the buckets (`media` `video` `uploads` `artifacts`, plus `backups`) with object lock + versioning + GOVERNANCE default retention (1 day; `backups` 30), and the least-privilege service user the api (and the test suites) authenticate as. **The api never gets the root credential and refuses to boot without `STORAGE_ACCESS_KEY_ID`/`STORAGE_SECRET_ACCESS_KEY`** (no fallback). The api only verifies buckets on boot; it no longer creates or configures them.

Env renames (WSK-52): `MINIO_ENDPOINT`→`STORAGE_ENDPOINT`; `MINIO_BUCKET_{MEDIA,VIDEO,UPLOADS,ARTIFACTS}`→`STORAGE_BUCKET_*`; `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`→`RUSTFS_ROOT_USER`/`RUSTFS_ROOT_PASSWORD` (bootstrap/compose only). The per-ticket verification runbooks below were rewritten to RustFS recipes; their dated result notes remain the records of those (MinIO-era) runs.

## Layout

- `src/db/` — `tenant-context.ts` (AsyncLocalStorage, anchored on `globalThis`) +
  `tenant-pool.ts` (the `pg.Pool` subclass that stamps/scrubs `webdesk.tenant_ctx` /
  `webdesk.platform_ctx` on every checkout/release) + `db.service.ts`/`db.module.ts`.
- `src/crypto/api-key-hash.ts` — key generation + `sha256(key + pepper)`.
- `src/api-keys/` — mint/rotate/revoke service + controller (`/internal/tenants/:tenantSlug/api-keys`).
- `src/auth/` — `ApiKeyAuthGuard` (resolves the key, sets tenant context) + `ScopeGuard` +
  `RequireScope` decorator.
- `src/rate-limit/` — `TenantQuotaService` (Redis fixed window, per tenant, shared by every api replica; per-process fallback if Redis is down) + `TenantQuotaGuard`.
- `src/content/` — RETIRED by WSK-48a (was a demo read/write route that existed to prove the guards
  gate a "content route"; the guard coverage now runs against `src/delivery/` and media upload — see
  "Delivery (WSK-48a)" at the end of this file).
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

### Forms API contract additions (M5-L1 / M5-L2) — attribution, visitor consent, submission read, subject refs

Additive to `POST /v1/t/:tenantSlug/forms/:formId/submit`. Status: PROTOTYPED (unit-tested; the DB and HTTP
specs and migration 0015 await the Linux gate).

**Two optional top-level members**, beside `fields`, `consent`, `turnstileToken`, `attachments`:

```jsonc
"attribution": {                    // best-effort; NEVER causes a refusal
  "landing": "/services/web/", "form_page": "/contact/",        // paths, <= 512 chars
  "referrer": "www.google.com",                                  // external host only, <= 253
  "utm_source": "...", "utm_medium": "...", "utm_campaign": "...", "utm_term": "...", "utm_content": "...",  // each <= 200
  "gclid": "...", "gbraid": "...", "wbraid": "...", "fbclid": "...", "msclkid": "...", "li_fat_id": "...",    // each <= 200
  "fbp": "...", "fbc": "...",                                    // <= 200; send only with marketing consent
  "sections_seen": ["home.hero"]                                 // <= 50 items, each <= 64, [A-Za-z0-9_.:-]
},
"visitor_consent": { "analytics": true, "marketing": false, "version": "3", "decided_at": "2026-10-11T09:00:00Z",
                     "consentId": "3f2b8c1e-5a4d-4e6f-9a0b-1c2d3e4f5a6b" }   // consentId optional (M5-G6): the id from POST .../consent
```

Drop rules (`src/forms/attribution.ts`; the submission always succeeds):
- Unknown keys are dropped. A value over its limit, of the wrong type, empty, or containing a control character drops that key.
- `landing` / `form_page`: anything from the first `?` or `#` is cut off; a value that is not then a `/`-path (a URL, `//host`) is dropped.
- `referrer`: a bare host name only (no scheme, path or port); lower-cased.
- `sections_seen`: more than 50 items drops the key; a bad single item is filtered out.
- A serialized `attribution` over 4096 bytes is dropped whole. An object with no surviving key is stored as null.
- `visitor_consent` needs both flags as booleans, a `version` of 1-32 chars and an ISO-8601 `decided_at` with a zone (stored in UTC); anything else is stored as null. null or absent means unknown, which every reader treats as NO consent.
- M5-G6: `visitor_consent.consentId` is OPTIONAL and allow-listed: the uuid the browser got from `POST /v1/t/:tenantSlug/consent` (below). A missing or non-uuid value drops that one key only (the snapshot stays valid); it is stored lower-cased inside `submissions.visitor_consent`, so a submission can be tied to the server-side proof of the banner decision. It is not checked against `consent_records` (a browser may submit before its consent post lands, and the log is evidence, not a gate).
- Drops are counted in one log line per submission, never with values.

### Form definitions: `forms.define` / `forms.def.list` / `forms.def.get` (M5-L1d, PROTOTYPED)

Before this, a `form_defs` row could only be created by raw SQL (the forms module only reads it). Status: PROTOTYPED
(the validator is unit-tested; `test/forms-define.spec.ts` needs the Linux gate). Code: `src/control/forms/form-definition.ts`
(validator), `form-defs.service.ts`, `form-defs.controller.ts`.

| Command | Route | Class / scope |
|---|---|---|
| `forms.define` | `PUT /control/v1/tenants/:tenantSlug/sites/:siteId/forms/:formKey` | medium / `webdesk:operate`, `Idempotency-Key` required |
| `forms.def.list` | `GET /control/v1/tenants/:tenantSlug/sites/:siteId/forms` | read / `webdesk:read` |
| `forms.def.get` | `GET /control/v1/tenants/:tenantSlug/sites/:siteId/forms/:formKey` | read / `webdesk:read` |

`forms.define` is an upsert by `(site, key)` (the table's own `UNIQUE (site_id, key)`; no migration). **Redefining keeps the
form's `id`**, because the site posts to `/v1/t/:tenantSlug/forms/:formId/submit`. It runs in the shared command envelope
(audit row `control.forms.define` first, effect, idempotency record, one transaction; a replay answers `replayed: true`).
It is MEDIUM, like `schema.apply`, whose family it belongs to: it changes what a public form accepts but never touches `/v1`
delivery or published content. It is **not an editorial command** (no content principal; on neither `EDITORIAL_COMMANDS` nor
`CLIENT_EDITOR_COMMANDS`), so a client-editor assertion cannot be expressed on it, exactly as for `schema.apply`; the ERP route
in front of it is staff-only. Reads are live SELECTs: no audit row.

Body (the key is the route parameter; a body `key` is refused with 400):

```jsonc
{
  "schema": {
    "fields": [ { "key": "email_address", "type": "email", "required": true, "maxLength": 320 }, ... ],
    "honeypotField": "_hp",                       // optional; default is the config's `_hp`
    "consentNotice": { "text": "..." },           // required, non-empty, <= 4000
    "attachments": { "allowed": false, "maxCount": 0 }   // optional
  },
  "notify": {},                                   // optional: { to: {email, name?}, templateKey?, autoresponder?, autoresponderTemplateKey? }
  "retentionDays": 90,                            // required, integer 1..3650
  "consentNoticeVersion": "site-2026-10-11"       // required, 1..64 of [A-Za-z0-9._:-]
}
```

Answer: `{ form: { formId, key, siteId, schema, notify, retentionDays, consentNoticeVersion, createdAt, updatedAt }, created, consentNoticeChanged, replayed }`.

Field types (`FORM_FIELD_TYPES`): `text`, `textarea`, `email`, **`tel`** (new, additive: a phone field, validated as short text), `number`,
`boolean`, `date`, `select` (needs `options`). Rules, every problem listed at once in a 422 `form-definition-invalid` (`issues: [{path, message}]`),
before anything is claimed or audited:
- (submit side, M5-L1d) a blank OPTIONAL value (`""` or whitespace) is treated as absent and not stored; a blank REQUIRED value is a 400 for every field type (a required text field used to accept `""`);
- field keys `[a-z0-9_]{1,64}`, unique, 1 to 60 fields; no unknown members anywhere (`format` is not a field member here);
- a field whose key looks like an email or a phone (`email_address`, `contact_phone`, ...) but is typed `text`/`textarea` is refused: the data-subject
  correlators (`privacy.find` / `erase`, `data_subject_ref`) come from the first `email` / `tel` TYPED field (M5-L1), so a mistyped one would make its
  submitters unfindable and its PAN/NIK scrub would also apply to it;
- the honeypot key is `[a-z0-9_]{1,64}`, is not a field key and is not a member of the submit body (`consent`, `fields`, ...);
- `consentNotice.text` is required for EVERY form (consent is universal on the submit route and every submission snapshots the notice); there is no consent-typed field;
- `retentionDays` 1 (the table's CHECK) to 3650 (a sanity cap; the purge compares `expires_at < now()` and has no ceiling). It applies to NEW submissions;
  rows already stored keep the `expires_at` they were given.

**The notice rule.** `form_defs` has a version column but no text column; the text lives in `schema.consentNotice.text`. Changing the text without
changing `consentNoticeVersion` is refused with 409 `consent-version-unchanged` (nothing changes), because each submission snapshots the text AND version
it was accepted under. The comparison is against what a submission would snapshot today (a raw-SQL form with no notice is compared against the defaults it
has been recording). A new version with identical text is accepted (`consentNoticeChanged: false`).

Other answers: 404 `site-not-found` (a site that is not this tenant's, the uniform wall), 404 `form-not-found`, 409 `idempotency-key-reused`,
409 `form-define-conflict` (two first-time definitions of one key racing; retry). The gaiada.com definitions are data in `webdesk/sites/gaiada-com/forms/`
(its README says how to apply them).

### Consent log API (M5-G6) — a server-side record of the visitor's banner decision

Status: PROTOTYPED (unit-tested; the DB and HTTP specs and migration 0017 await the Linux gate). Context: `legal/website-visitor-addendum.md` R-V3 / F17 / section 3.6 (consent snapshot) / section 5 (retention), WSK-D67. The site still keeps the choice in localStorage `gaia-consent`; this is the evidence the site cannot forge afterwards.

`POST /v1/t/:tenantSlug/consent` (public, like the forms route), `OPTIONS` for the preflight. The site posts on EVERY banner decision. `consent` is therefore a **reserved collection key** (`delivery/reserved-collection-keys.ts`), like `forms` and `media`.

```jsonc
// request (Content-Type: application/json, <= 2 KiB)
{ "consentId": "3f2b8c1e-...",   // optional uuid the browser generated; absent or not a uuid => the server mints one
  "analytics": true, "marketing": false,   // required booleans (never coerced)
  "version": "3",                           // required, 1-32 chars: the banner / notice version shown
  "action": "grant" }                       // grant | update | withdraw; absent => grant (new id) or update (supplied id)
// 201 response
{ "consentId": "3f2b8c1e-..." }             // keep it, send it with the next decision and on form submissions
```

- **Allow-list:** only those five keys; any other key is dropped (counted in a log line, never stored). A wrong type or a bad `version` / `action` is `400`; a body over 2 KiB is `413`. A `withdraw` is stored with both categories false whatever the body said.
- **Origin / CORS:** like forms. The `Origin` must be a domain of one of the tenant's environments (`environments.domain`, either scheme); that environment's site is recorded as the record's site. A missing or unlisted origin is `403`, an unknown or inactive tenant `404`. `Access-Control-Allow-Origin` echoes the allowed origin; methods `POST, OPTIONS`; header `Content-Type`.
- **Rate limit:** Redis fixed window, per client IP (default 60 per 10 min) and per tenant (default 3000 per 10 min), `429` when exceeded, `503` when Redis is unreachable (fail closed). Env: `WEBDESK_CONSENT_RATE_LIMIT_IP_PER_WINDOW`, `_IP_WINDOW_MS`, `_TENANT_PER_WINDOW`, `_TENANT_WINDOW_MS` (empty = default).
- **No cookies** are set. **Stored** in `consent_records` (migration 0017): consent id, tenant, site, the two categories, notice version, action, a server-clock `recorded_at`, and `user_agent_class` (desktop / mobile / tablet / bot / unknown, derived from the User-Agent which is itself never stored). **No IP, no raw User-Agent, no other identifier.**
- **Append-only:** the app role has SELECT, INSERT and DELETE on the table, no UPDATE; a decision changes by appending a row. DELETE is used by exactly two paths, both in the application: the retention purge and `privacy.erase`.
- **Retention:** the hourly maintenance job (the `forms-retention-purge` scheduler job, WSK-61) also deletes consent histories whose LATEST record is older than `WEBDESK_CONSENT_RETENTION_MONTHS` (default 26 = data lifetime 14 + 12; an empty value is the default, never 0; a value outside 1-120 fails the job loudly). The unit of purge is the consent id: a browser's history goes whole or not at all.
- **Data subject:** `privacy.find / export / erase` accept a consent id (a uuid) as the identifier, as well as an email, phone or field value. For a uuid, `find` adds `consentRecordCount`, `export` adds `consentRecords` (`consentId, siteId, action, analytics, marketing, noticeVersion, recordedAt, userAgentClass`, oldest first) and `erase` deletes the records and adds `consentRecordCount`. For every other identifier those keys are absent and the responses are unchanged. A consent id identifies a browser, not a person.

**Control read `consent.status`** (M5-V3-a, PROTOTYPED: the parser and registry unit-tested, the DB/HTTP spec `test/consent-status.spec.ts` awaits the Linux gate): `POST /control/v1/tenants/:tenantSlug/consent/status` with `{ "siteSlug"?: string, "consentIds": [uuid, ...] }`, 1 to 100 ids (a POST only so ids stay out of URLs; it changes nothing). It makes the consent log the proof of a visitor's consent for the ERP's visitor profiles (design `docs/plans/2026-10-12-m5-phase5-design.md` 4.3, D5): `200 { "statuses": [{ "consentId", "analytics", "marketing", "action", "noticeVersion", "recordedAt" }] }`, the LATEST record per id (`ORDER BY recorded_at DESC, id DESC`).
- **Absent id = no proof.** An id with no record, or one that belongs to another tenant, is simply OMITTED (200, never an error, so the answer confirms nothing). Consumers must treat a missing id as "no consent".
- **Key on `analytics`, never on `action`.** The site records an analytics-only withdrawal as `action: "update"` with `analytics: false`; only `analytics === true` is consent to build a profile.
- **Never returned:** `user_agent_class`, row ids, tenant or site ids (and the table holds no IP or raw User-Agent).
- **Class `read`, scope `webdesk:read`**, not job-tracked, no WS4, no editorial assertion, no audit row, no Idempotency-Key. Authorization runs before the body is parsed: a scopeless caller gets 403 whatever it sent.
- **Tenancy:** the slug is resolved first (unknown or archived: 404), then the read runs under that tenant's `webdesk.tenant_ctx` (RLS) with an explicit `tenant_id` filter. Served by `ix_consent_records_subject`; no migration.
- **`siteSlug`** follows the Zone B convention (it IS the tenant slug; a site row has no slug). Optional; when present it must equal the route's tenant slug, else `404 site-not-found`. Errors (RFC 9457): `400 invalid-request` (more than 100 ids, none, a non-uuid, an unknown member), `403`, `404`.

Stored in `submissions.attribution` / `submissions.visitor_consent` (jsonb, migration 0015). The tenant webhook `form.received` payload gains `attribution` and `visitorConsent` (camelCase, like the rest of that payload; always present, null when absent). The Zone B `form.received` envelope is unchanged (`siteSlug, formId, submissionId, hasAttachments`).

**Control read `forms.submission.get`**: `GET /control/v1/tenants/:tenantSlug/forms/submissions/:submissionId` (the Zone B `siteSlug` is the tenant slug). Class `read`, scope `webdesk:read` (the same as every control read of tenant data; no WS4, no editorial assertion, no audit row). Response, all top level: `submissionId, formId, formKey, siteSlug, createdAt, status, fields, consent {text, version, acceptedAt}, attribution, visitorConsent`. `formKey` is `form_defs.key` (the stable key, e.g. `contact`). Errors (RFC 9457): `404 submission-not-found` (unknown id, malformed id, other tenant's id, unknown or archived tenant: one uniform answer), `410 submission-gone` (status `purged` or `erased`), `400 invalid-request` (any query parameter).

**Data-subject refs come from the form definition** (`src/forms/subject-refs.ts`), not a field named `email`:
- Email ref (`data_subject_ref`) = the first field with `"format": "email"` (or the builder's `"type": "email"`), in `fields[]` order or JSON-schema `properties` order; if the definition declares none, the legacy `email` key. Trimmed, lower-cased.
- Phone ref (`data_subject_phone_ref`, new) = the first field with `"format": "tel"` (or `"type": "tel"`). There is no name-based fallback. Normalisation: digits only; a leading `+` or `00` is dropped (the digits that follow are the country code); 7 to 15 digits or no ref. A national leading `0` is NOT rewritten to a country code (no country is hard-wired; `0812...` and `+62 812...` are different refs, so look both up).
- `privacy.find / export / erase` match the email ref OR the phone ref (when the identifier parses as a phone number) OR a raw field value (unchanged). `privacy.export` now also returns `attribution` and `visitorConsent`. `privacy.erase` and the retention purge clear `attribution`, `visitor_consent` and `data_subject_phone_ref` and both also clear `data_subject_ref` (the purge used to leave it; personal data must not outlive retention).

**PAN / national-ID scrub** (`src/forms/pii-scrub.ts`): string values of free-text fields (`text`, `textarea`; never email/tel fields) have Luhn-valid 13-19 digit card numbers replaced by `[REDACTED-PAN]` and structurally valid 16-digit Indonesian NIKs by `[REDACTED-NIK]`, before persist, mail and webhook. Ported from platform-nest `scrubText`, with guards: Luhn, no `+` prefix, card-like grouping, NIK structure; emails are not redacted. Only a count is logged.

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

Reuses existing vars unchanged: `REDIS_URL` (WSK-11), `STORAGE_*`/`STORAGE_BUCKET_UPLOADS` (WSK-07; renamed by WSK-52),
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

# 4. RustFS (WSK-52; PRIVATE `uploads` bucket for attachments) — S3 API 55464 (one port).
docker run -d --name wsk10-rustfs -p 55464:9000 \
  -e RUSTFS_ROOT_USER=webdesk_root -e RUSTFS_ROOT_PASSWORD=changeme_root_password \
  rustfs/rustfs:1.0.0@sha256:8cc9801755448b71a786705ce76692c77e14936cccd87cf2fc31842e58f4d1ff
#    ...then provision it (buckets + versioning + lock + the api's service key; idempotent). Needs
#    `npm install` in webdesk/api first, so run it after step 8's `cd api && npm install`:
#      STORAGE_ENDPOINT=http://localhost:55464 RUSTFS_ROOT_USER=webdesk_root \
#      RUSTFS_ROOT_PASSWORD=changeme_root_password STORAGE_ACCESS_KEY_ID=webdesk_api \
#      STORAGE_SECRET_ACCESS_KEY=changeme_api_secret_key node scripts/storage-bootstrap.mjs

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
STORAGE_ACCESS_KEY_ID="webdesk_api" \
STORAGE_SECRET_ACCESS_KEY="changeme_api_secret_key" \
CLAMAV_HOST="localhost" \
CLAMAV_PORT="55466" \
  npx vitest run test/forms-abuse-battery.spec.ts test/forms-submit.spec.ts \
    test/forms-attachments.spec.ts test/forms-retention-purge.spec.ts test/forms-cross-tenant.spec.ts

# 9. Tear down.
cd ..
docker rm -f wsk10-db wsk10-redis wsk10-mailpit wsk10-rustfs wsk10-clamav
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

Containers torn down (`docker rm -f wsk10-db wsk10-redis wsk10-mailpit wsk10-minio wsk10-clamav` — MinIO-era names; the runbook above now uses `wsk10-rustfs`)
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
| `site.archive` | `POST /control/v1/tenants/:slug/sites/:siteId/archive` | **high** | `webdesk:promote` | **yes** | no — see "site.archive" below |
| `site.setDomain` | `POST /control/v1/tenants/:slug/sites/:siteId/domain` | **high** | `webdesk:promote` | **yes** | no — see "site.setDomain" below |
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
| `contract.regenerate` | `POST /control/v1/tenants/:slug/contract/regenerate` (one) / `POST /control/v1/contract/regenerate` (all active) | medium | `webdesk:operate` | no | no — queues runs, see "Live contract codegen" |

The full map lives in code at `src/control/command-types.ts`'s `COMMAND_REGISTRY` (the single
source of truth every guard and `test/control-command-registry.spec.ts` read from) — this table
is a restatement, not a second copy to keep in sync by hand.

Two documented departures from design §07's literal wording: `schema.propose` is classified
`read` (this ticket's own brief narrows the AC to three tiers; propose never persists anything,
which is what `read` means everywhere else in this map) and `job.get`/`job.list` are this
ticket's own addition (job-tracking wasn't in the original C-05 list).

### Live contract codegen (M6-P4r-b)

A tenant's `contracts/<slug>/latest.json` (what the ERP's contract mirror reads) is produced inside the api, no manual step.

- **Triggers.** `tenant.provision` and `schema.apply` enqueue a `contract-codegen` job **after** their command commits (the
  command envelope's post-commit `after` hook, via `ContractCodegenTrigger`). It is fail-soft: an enqueue error or timeout (3 s) is
  logged and changes nothing about the command's response, status or stored idempotency record. A replay enqueues nothing.
  `schema.apply` still refuses a MAJOR change (`409 contract-major-change`) before anything is enqueued.
- **Queue.** The job carries only `{ tenantSlug }`; its id is derived from the tenant, so a burst coalesces into one waiting job
  (a change that commits while a run is active queues exactly one follow-up). Attempts 3, exponential backoff from 10 s, per-attempt
  timeout 120 s, completed AND failed jobs removed (a failed job would otherwise occupy its id and swallow later enqueues).
- **Worker.** In the api process, concurrency 1. It takes a Postgres advisory lock keyed on the tenant, runs the compiled generator
  (`dist/codegen/generator.mjs`, loaded by `CompiledContractCodegenRunner` through a native `import()`), and releases the lock when
  the run really ends, even after a timeout. Output goes only to RustFS (the api's own `webdesk-api` key, `artifacts` bucket).
  A stored contract that already matches the tenant's composition and the vocabulary version is left alone (`unchanged`): the
  generator would otherwise mint a PATCH version for an identical composition.
- **Re-run and backfill.** `contract.regenerate` (above). Idempotent, never a deploy step. A run that failed all its attempts logs
  `... FAILED ... re-run it with the contract.regenerate control command`.
- **Config** (all optional): `WEBDESK_CONTRACT_CODEGEN_ENABLED` (default on; **off under `NODE_ENV=test`**),
  `_QUEUE_NAME`, `_TIMEOUT_SECONDS` (120), `_ATTEMPTS` (3), `_BACKOFF_SECONDS` (10), and `WEBDESK_CODEGEN_BUNDLE` (a bundle path
  override). Specs: `test/contract-codegen-{queue,processor,triggers}.spec.ts` need no services; `contract-codegen-live.spec.ts` needs
  Postgres, Redis, RustFS and `npm run build`.

### `tenant.provision` and the tenant's locales (WSK-D18, WSK-D48)

`POST /control/v1/tenants` takes `{ slug, companyRef }` and, optionally, `{ defaultLocale, locales }`.

- **Both or neither.** With neither, the tenant gets the column defaults exactly as before (`default_locale 'id-ID'`,
  `locales {id-ID}`), so every existing caller is unchanged. Only one of the two is a 400: guessing the missing half
  would be a silent contract decision.
- **Validation, the rule the rest of the service already applies** (`assertTenantLocales` in `src/control/dto.ts`; there
  is no BCP 47 grammar anywhere in WebDesk). A locale is an opaque non-empty string of at most 35 characters
  (`content-commands.controller.ts`), without surrounding whitespace (`delivery/vocabulary/locale.ts` reads a requested
  locale trimmed, so one with whitespace could never be asked for), compared by exact string equality with the tenant's
  declared set (content and media commands). `locales` is a non-empty array with no duplicates, and `defaultLocale` is
  one of its members. Any breach is a `400` before the command envelope, so it claims no idempotency key and creates no
  tenant.
- **Stored** in `tenants.default_locale` and `tenants.locales` (migration `0005_tenant_locales.sql`; no new migration).
  The 201 body's `tenant` carries both. The content composition check (`/locale`, 422) and the `/v1` reads resolve
  against these columns, so a tenant provisioned with `{ defaultLocale: "en", locales: ["en", "id"] }` takes content in
  `en` and `id` straight away (the live `gaiada` tenant was set this way by hand, WSK-D48).
- **Idempotent, and the locales are part of the hashed body.** The request hash covers them (the list as its JSON text, in
  the order given), only when declared, so a stored key from before this change still replays. The same key with the same
  body replays (`replayed: true`); the same key with different locales (or with none) is `409`, never silently accepted.

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
(`src/control/release/release-transport.ts`'s `ReleaseTransportAdapter`). No control-plane adapter will be
built (M6-P6j, WSK-D29/D79): delivery is per site, run by the site's own CI, and `delphi`/`helios`/Hostinger
are per-site targets reached that way. The shipped default binding (`NotYetAvailableReleaseTransport`)
always fails a job with a documented `TRANSPORT_NOT_AVAILABLE` error that points at the per-site delivery
binding (`POST sites/:id/delivery-binding`) and the runbook — the command's own machinery (idempotency,
audit, job creation) still completes correctly; only the transport itself is absent, by design.
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

### site.archive (built 2026-10-12, migration 0019)

`POST /control/v1/tenants/:slug/sites/:siteId/archive`, header `Idempotency-Key` required, HIGH, scope
`webdesk:promote`, WS4 assertion over `{tenantSlug, siteId}` required. It was an always-501 stub while `sites` had no
`status`; the owner ruled on 2026-10-12 that archiving a site takes an approval, and 0019 added
`sites.status` (`active | archived`). It runs in the shared command envelope exactly like `tenant.archive`
(audit row first, carrying the approval; one terminal `UPDATE ... SET status = 'archived' WHERE status = 'active'`;
durable replay record). Answers `201 {site:{id,name,status:"archived"}, replayed}`. A retry of the same key after
the archive replays the stored body; a FRESH key on an already-archived site is `409` (the audit row rolls back and
the approval stays unclaimed); another tenant's or an unknown site is `404`; a malformed id is `400`.

**Irreversible, like `tenant.archive`**: nothing moves a site back to `active`. What an archived site stops doing
(the site-scope mirror of an archived tenant; the status is read where the tenant's status already was):

| Surface | Archived site |
|---|---|
| `/v1` public reads, and every other API-key-guarded route (media, forms, consent) | its keys stop resolving (`ApiKeysService.resolve` returns null): `401 invalid-credentials`, the same body as a revoked key |
| `/v1/t/:slug/preview/:token` | the token's site is archived: the same uniform `404 not-found` |
| control-plane writes, publishes, schedules, media, editorial and form-definition routes | `409 site-archived` (RFC 9457 `.../errors/site-archived`), from `resolveTenantSite` |
| control-plane reads of the site (items, collections, media, editorial) | the same `409 site-archived` |
| `schema.apply`, `environment.provision`, `content.promote` on the site | `409` |
| content tick (scheduled publish, swaps, takedowns) | the archived site's items are skipped: a pending schedule stays pending and never fires |
| consent `Origin` resolution | an origin whose site is archived no longer resolves (`403`) |
| `GET /control/v1/tenants` | the site is still listed, with `status: "archived"` (new additive `sites[].status`) |

Stored content, versions and audit rows are kept (archiving is not deletion). Other sites of the tenant are untouched.

### site.setDomain (M6-P6i)

`POST /control/v1/tenants/:slug/sites/:siteId/domain`, header `Idempotency-Key` required, HIGH, scope `webdesk:promote`, WS4
assertion over `{tenantSlug, siteId, envId, domain}` required (route params first, then the body, as for every command; a
clear carries `domain: null`). The body is closed: `{envId, domain}` and nothing else (a stray key is `400`, because the WS4 hash
covers every key sent). It sets, or clears, ONE environment's `environments.domain`, in the shared command envelope (audit row
first, carrying the approval; one `UPDATE`; durable replay record). Answers `201 {environment:{id,name,domain,previousDomain,status},
replayed}`; `previousDomain` is what a rollback sets back.

**Why it is HIGH:** `environments.domain` is the only CORS allow-list there is. The forms guard compares the request's `Origin` with
`https://<domain>` and `http://<domain>` as whole strings, the consent repository compares the Origin's host with the column, and
the draft-preview route compares `https://<domain>` exactly. So this command decides which sites may call the tenant's public
endpoints from a browser, and it is the ERP's `webdesk.site.setDomain` approval (maker != checker, never self-approvable) that
reaches it.

**A lookalike is refused because the stored value is canonical** (`src/control/lifecycle/environment-domain.ts`): lowercase ASCII
labels, two or more, 253 characters at most, no scheme, port, path, userinfo, wildcard, whitespace, trailing dot or Unicode label
(an international name is stored as punycode, which is also what a browser sends), and not `.invalid`, `.local`, `.localhost` or
`.internal`. The command REFUSES a non-canonical value (`400`) rather than cleaning it up, so what the approver saw and what the
WS4 hash covers is exactly what is stored. Because every route matches the Origin as a whole string, `example.com.evil.test`,
`exampIe.com`, `evil-example.com`, `sub.example.com`, `example.com:8443` and a Cyrillic look-alike all fail against `example.com`.

Refusals decided inside the effect (each rolls the audit row back and leaves the approval unclaimed): another tenant's or an unknown
site `404`; an `envId` that is not THIS site's `404` (an approval for one site can never move another's domain); an archived site or
environment `409`; the value already being the environment's domain `409 domain-unchanged` (a no-op must not spend an approval);
another live environment of the SAME tenant already holding the domain `409 domain-in-use`.

**Known gap (reported, not built):** `environment.provision` still accepts a free-form `domain` without this check, and a domain
held by a DIFFERENT tenant is invisible here (RLS), so two tenants can hold one domain. A global unique index on
`lower(domain)` fixes the second, but it cannot be created until a duplicate-domain diagnostic has been run on the live database
(the D35 sequence: diagnostic, migration, ledger), so it is not part of this change.

**Rollback:** run `site.setDomain` again with `domain` set to the previous value (the earlier answer's `previousDomain`), or `null`
to clear. Both are ordinary HIGH commands (a new approval, a new WS4 assertion).

### What could not be built as specified

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

No Redis/object storage/Mailpit needed — the control module only touches Postgres (job/idempotency stores
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

### WS4 v2 — the asymmetric assertion (M4 F1)

v1 above needs the same HMAC key on both sides, so WebDesk held a secret that could mint approvals for
itself. v2 removes it: the ERP signs with an Ed25519 private key (platform-nest
`webdesk-ws4-assertion.ts`, `WEBDESK_CONTROL_WS4_SIGNING_KEY_FILE` + `WEBDESK_CONTROL_WS4_SIGNING_KID`) and
WebDesk holds only the public half, in its own pinned file `WEBDESK_WS4_JWKS_FILE`
(`/etc/webdesk/ws4/ws4.jwks.json`), separate from the editorial JWKS.

```
x-ws4-assertion: <b64url(header)>.<b64url(payload)>.<b64url(Ed25519 signature)>
header   = {"alg":"EdDSA","kid":"<kid>","typ":"ws4+jwt"}                       (this key order)
payload  = {"approvalId","commandHash","exp","aud":"webdesk-control-plane"}      (this key order)
signed   = ASCII of `<b64url(header)>.<b64url(payload)>` (RFC 7515)
```

- **Version by shape only:** two dot-separated parts is v1, three is v2.
- **v1** is accepted only while `WEBDESK_APPROVAL_ASSERTION_KEY` holds a real key. In production an unset
  key or a published placeholder retires it (logged at boot).
- **v2** is accepted only while the WS4 JWKS is installed. `alg` is pinned to `EdDSA` before any key is
  touched (`none`, `HS*`, `RS*`, `ES*` refused). The header must be exactly `{alg, kid, typ}`, `typ` must be
  `ws4+jwt`, the kid is looked up only in the WS4 set, and `aud` must be `webdesk-control-plane`.
- **Unchanged for both:** `exp` (`now < exp`, no extra skew), the `commandHash` comparison and single use
  by `approvalId`. One approval cannot be used once as v1 and again as v2.
- **Boot:** a malformed WS4 JWKS, or one sharing a kid or a key with the editorial JWKS, refuses boot. An
  absent one does not.
- **Audit:** `audit_entries.ws4_assertion_version` (migration 0018) records which version Layer 4 verified
  for the row's approval (1, 2, or NULL when not recorded).

Refusal codes and exact reasons: `auth/ws4-assertion.ts` header; matrix
`test/ws4-assertion-v2-matrix.spec.ts`; shared vectors `test/ws4-assertion-v2-vectors.spec.ts` (same
literals in `platform-nest/src/modules/webdev/webdesk-ws4-assertion.test.ts`). Keys, install, phases and
rotation: `infra/runbooks/webdesk-ws4-keys.md`.

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
| `WEBDESK_APPROVAL_ASSERTION_KEY` | HMAC key for WS4 **v1** assertions (§03 Layer 4) — shared with platform-nest, Zone A/B custody only. M4 F1: unset (or a published placeholder) in production retires v1 | `real-policy-decision-point.ts` |
| `WEBDESK_WS4_JWKS_FILE` | M4 F1: path of the pinned WS4 v2 public key set (1–2 Ed25519 keys). Absent → v2 unavailable; malformed or overlapping the editorial set → boot refused | `real-policy-decision-point.ts` (`auth/ws4-jwks.ts`) |
| `WEBDESK_CONTROL_MTLS_CA_PEM` | Pinned synccert CA public cert (PEM) — Zone B holds only the CA public, never a private key | `real-control-channel-authenticator.ts` |
| `WEBDESK_CONTROL_MTLS_ALLOWED_CN` | Comma-separated allow-list of client-cert CNs (default `platform-nest-webdesk`) | `real-control-channel-authenticator.ts` |
| `WEBDESK_CONTROL_OIDC_ISSUER` | Public Keycloak issuer URL(s) - comma-separated; during an issuer move list `old,new` (the JWKS URI derives from the first) (default `https://erp.gaiada.online/idp/realms/gaiada` — there is only one real issuer in this design, so the dev fallback IS the real one; harmless because it is read-only public key material) | `real-control-channel-authenticator.ts` |
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
canonical-serialization + per-artifact-hash `contentHash`; an artifact store in object storage (RustFS since WSK-52)
(WSK-07's `StorageAdapter`, no second S3 client); a **byte-identical double-run CI gate**; and the
real response for `GET /control/v1/tenants/:slug/contract` (replacing WSK-21's documented 501).

### Why this directory has TWO kinds of files

`src/codegen/*.ts` (plain files, e.g. `contract-read.service.ts`, `codegen.module.ts`,
`contract-manifest.types.ts`, `artifact-keys.ts`) are ordinary commonjs, part of `tsc`'s build,
zero vocabulary imports — the NestJS-facing read side.

`src/codegen/generator/*.mts` are ESM, run via `tsx` (`node --import tsx ...`, same tool
`webdesk/delivery/test/*.mjs` run under), and DO import `webdesk/delivery/vocabulary/**`
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
that touches Postgres), `storage-io.mts` (the only file that touches object storage — reuses
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
  { sdkTsUrl, sdkPhpUrl: null, openapiUrl, contractMdUrl, blockLibraryUrl, blockLibrarySha256 }, contentHash, generatedAt }`.
  M6-P4b0 added `blockLibraryUrl` (additive): the presigned GET of the `@gaiada/webdesk-blocks` tarball the api
  image baked, stored once per tarball under the SHARED, content-addressed key
  `blocks/<version>/<first 16 hex of its sha256>/gaiada-webdesk-blocks-<version>.tgz` (sidecar `.sha256`; a
  damaged object at that key fails the codegen run and is never overwritten). `null` for a pointer without it. The tarball's hash is
  kept out of `contentHash`; the pointer records it as `blockLibrarySha256`.
  M6-P4b0b added `artifacts.blockLibrarySha256` (additive): that pointer value, plain lowercase hex (64 chars, no
  `sha256:` prefix), so the ERP mirror can verify the tarball bytes it downloads. It is `null` when there is no
  `blockLibraryUrl` or the pointer value is absent or malformed (never fabricated); an older reader ignores it.
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

### Verification runbook — one throwaway Postgres + one throwaway RustFS (WSK-52; was MinIO), port block 55500-55501

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

# 2. RustFS (the `artifacts` bucket — WSK-07's platform-internal bucket, no new bucket added),
#    S3 API 55501. Provisioned by scripts/storage-bootstrap.mjs after `npm install` in api (step 5).
docker run -d --name wsk15-rustfs -p 55501:9000 \
  -e RUSTFS_ROOT_USER=webdesk_root -e RUSTFS_ROOT_PASSWORD=changeme_root_password \
  rustfs/rustfs:1.0.0@sha256:8cc9801755448b71a786705ce76692c77e14936cccd87cf2fc31842e58f4d1ff

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
STORAGE_ENDPOINT=http://localhost:55501 RUSTFS_ROOT_USER=webdesk_root \
RUSTFS_ROOT_PASSWORD=changeme_root_password STORAGE_ACCESS_KEY_ID=webdesk_api \
STORAGE_SECRET_ACCESS_KEY=changeme_api_secret_key node ../scripts/storage-bootstrap.mjs
npx tsc --noEmit
APP_DATABASE_URL="postgres://webdesk_app:throwaway_app@localhost:55500/webdesk" \
MIGRATE_DATABASE_URL="postgres://webdesk_migrator:throwaway_migrator@localhost:55500/webdesk" \
STORAGE_ENDPOINT="http://localhost:55501" \
STORAGE_ACCESS_KEY_ID="webdesk_api" \
STORAGE_SECRET_ACCESS_KEY="changeme_api_secret_key" \
  npx vitest run test/codegen-*.spec.ts

# 6. The real double-run CI gate against two real, differently-composed tenants (seed them first —
#    see any codegen-*.spec.ts's own `seedTenant` helper for the exact INSERT shape, or run the
#    live pipeline once with `codegen:run` against a tenant your own session already seeded).
APP_DATABASE_URL="postgres://webdesk_app:throwaway_app@localhost:55500/webdesk" \
  node --import tsx src/codegen/generator/double-run-gate.mts --tenants <slugA>,<slugB>

# 7. Tear down.
cd ..
docker rm -f wsk15-db wsk15-rustfs
```

### Exact env vars this ticket's code reads (all live getters, real names, no shadow prefix)

| Var | Read by | Default |
|---|---|---|
| `APP_DATABASE_URL` | `fetch-composition.mts`'s caller (`run-codegen.mts`/`generate-single.mts`), same var every other ticket uses | — (must be set) |
| `STORAGE_ENDPOINT` | `storage.config.ts` — `storageConfig.endpoint` (WSK-52: the `MINIO_ENDPOINT` alias is gone) | empty string |
| `STORAGE_ACCESS_KEY_ID` / `STORAGE_SECRET_ACCESS_KEY` | `storage.config.ts` — REQUIRED in every NODE_ENV (WSK-52: no root fallback) | none — boot refuses |
| `STORAGE_BUCKET_ARTIFACTS` | `storage.config.ts` — `storageConfig.bucketName("artifacts")` | `artifacts` |
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

Containers torn down (`docker rm -f wsk15-db wsk15-minio` — MinIO-era name; the runbook above now uses `wsk15-rustfs`) after the run.

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
backupPhase)`. Under **WSK-D23** (storage fully self-hosted — RustFS primary (WSK-D42, amending D23), no Cloudflare, no R2)
this is answerable in one real sentence, generated from the SAME config the system actually runs on
(`STORAGE_ENDPOINT`/`STORAGE_PUBLIC_BASE_URL`, `APP_DATABASE_URL`'s own host), not hand-typed policy
prose:

> All of tenant '\<slug>''s content, form submissions and uploaded media are stored on self-hosted
> infrastructure we operate — Postgres at \<host> and RustFS (S3-API object storage, self-hosted, never Cloudflare
> R2 or any third-party object store) at \<host> — with backups going to \<phase-specific target,
> e.g. "a nightly pull-model backup to a second estate-owned box (the server that hosts the content holds no credential
> for that box and cannot reach, overwrite, or delete it)">.

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
  (`APP_DATABASE_URL`, `MIGRATE_DATABASE_URL` via the migration runner, `STORAGE_*`/`STORAGE_BUCKET_UPLOADS`
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

### Verification runbook — one throwaway Postgres (5432→55530) + one throwaway RustFS (9000→55531, WSK-52; was MinIO), run INSIDE a Linux container

Owner rule (2026-08-26): tests run on Linux, never the Windows host. This runbook stands up
Postgres + RustFS as ordinary Windows-Docker-Desktop containers (host ports only needed for local
inspection), puts a `node:22-bookworm-slim` container on the SAME docker network, `docker cp`s
`src/`/`test/`/`package*.json`/`tsconfig.json`/`vitest.config.ts`/`.swcrc` in (never a `-v` bind
mount — Git Bash on Windows silently rewrites container-side paths; `docs/...gitbash-docker-path-
mangling.md`), runs `npm install` FRESH inside the container (a Windows-built `node_modules` has
native bindings — `@swc/core` — that will not load on Linux), and talks to Postgres/RustFS by their
container DNS names on the shared network, not `localhost`. Ports checked free via `docker ps`
first (2026-08-27): not 55432/55433/55435, not the 55450/55460-55466/55480-55481/55490/
55500-55502/55510-55511 blocks from prior tickets, and NOT 55520 (`wsk17-postgres`, a concurrent
session's own container observed still running at verification time).

```bash
# 1. Network + throwaway Postgres + throwaway RustFS.
docker network create wsk38-net
MSYS_NO_PATHCONV=1 docker run -d --name wsk38-db --network wsk38-net -p 55530:5432 \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=throwaway_super -e POSTGRES_DB=webdesk \
  -e POSTGRES_OWNER_USER=webdesk_owner -e POSTGRES_OWNER_PASSWORD=throwaway_owner \
  -e POSTGRES_MIGRATOR_USER=webdesk_migrator -e POSTGRES_MIGRATOR_PASSWORD=throwaway_migrator \
  -e POSTGRES_APP_USER=webdesk_app -e POSTGRES_APP_PASSWORD=throwaway_app \
  -v "$(pwd -W)/../postgres/init-roles.sh:/docker-entrypoint-initdb.d/10-init-roles.sh:ro" \
  postgres:16-alpine
docker run -d --name wsk38-rustfs --network wsk38-net -p 55531:9000 \
  -e RUSTFS_ROOT_USER=webdesk_root -e RUSTFS_ROOT_PASSWORD=changeme_root_password \
  rustfs/rustfs:1.0.0@sha256:8cc9801755448b71a786705ce76692c77e14936cccd87cf2fc31842e58f4d1ff

# 2. The Linux test runner — `docker cp`, never a bind mount (see header above).
MSYS_NO_PATHCONV=1 docker run -d --name wsk38-runner --network wsk38-net -w /work node:22-bookworm-slim sleep infinity
MSYS_NO_PATHCONV=1 docker exec wsk38-runner sh -c 'mkdir -p /work/webdesk/api /work/webdesk/migrations /work/webdesk/postgres /work/webdesk/scripts'
docker cp src wsk38-runner:/work/webdesk/api/src
docker cp test wsk38-runner:/work/webdesk/api/test
docker cp package.json package-lock.json tsconfig.json vitest.config.ts .swcrc wsk38-runner:/work/webdesk/api/
docker cp ../migrations/. wsk38-runner:/work/webdesk/migrations
docker cp ../postgres/init-roles.sh wsk38-runner:/work/webdesk/postgres/init-roles.sh
docker cp ../scripts/check-rls-integrity.mjs wsk38-runner:/work/webdesk/scripts/check-rls-integrity.mjs
docker cp ../scripts/storage-bootstrap.mjs wsk38-runner:/work/webdesk/scripts/storage-bootstrap.mjs
MSYS_NO_PATHCONV=1 docker exec wsk38-runner sh -c 'cd /work/webdesk/api && npm install --no-audit --no-fund'

# 2b. Provision RustFS (buckets/versioning/lock + the api's least-privilege service key; idempotent).
MSYS_NO_PATHCONV=1 docker exec -e STORAGE_ENDPOINT="http://wsk38-rustfs:9000" \
  -e RUSTFS_ROOT_USER=webdesk_root -e RUSTFS_ROOT_PASSWORD=changeme_root_password \
  -e STORAGE_ACCESS_KEY_ID=webdesk_api -e STORAGE_SECRET_ACCESS_KEY=changeme_api_secret_key \
  wsk38-runner sh -c 'cd /work/webdesk/api && node ../scripts/storage-bootstrap.mjs'

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
  -e STORAGE_ENDPOINT="http://wsk38-rustfs:9000" \
  -e STORAGE_ACCESS_KEY_ID="webdesk_api" \
  -e STORAGE_SECRET_ACCESS_KEY="changeme_api_secret_key" \
  -e STORAGE_BUCKET_UPLOADS="uploads" \
  wsk38-runner sh -c 'cd /work/webdesk/api && npx vitest run test/privacy-command-registry.spec.ts test/privacy-residency.spec.ts test/privacy-find-export.spec.ts test/privacy-erase.spec.ts'

# 6. tsc, then tear down.
MSYS_NO_PATHCONV=1 docker exec wsk38-runner sh -c 'cd /work/webdesk/api && npx tsc --noEmit -p tsconfig.json'
docker rm -f wsk38-runner wsk38-db wsk38-rustfs
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
down (`docker rm -f wsk38-runner wsk38-db wsk38-minio && docker network rm wsk38-net` — MinIO-era name, now `wsk38-rustfs`) after the
run.

## Delivery (WSK-48a) — the public `/v1` read path, `src/delivery/**`

Status: **DEV-VERIFIED** on `sumopod` (Linux containers; numbers below). Rehomed from the Payload
Next.js app (`webdesk/payload/collections/{router,content-read,redirects,auth,db}.ts` +
`app/(payload)/v1/[...slug]/route.ts` + `src/public-gateway.mjs`) into this service, per owner ruling
WSK-D37 (Payload is removed) and design OQ-3.5's default. The read code never needed Payload — it is
our own SQL (WSK-D24) — and the `payload-gateway` process that served it was down on the live box from
2026-09-09 until this move. Payload itself was deleted afterwards by WSK-48b (`webdesk/payload/` is gone; the vocabulary lives in `webdesk/delivery/`, migration `0011_drop_payload.sql` drops its tables).

Serves, GET only, with the frozen envelope (design §05):
`/v1/t/:tenantSlug/{:collection | :collection/:slug | search | sitemap.xml}`.

- `router.ts` — `createV1Handler(deps)`: the original `handleV1Request`, still a plain Web
  `Request -> Response` function, now taking the tenant lookup / key resolution / tenant pool as
  dependencies. Same check order, same statuses, same RFC 9457 problem bodies, same
  "unknown tenant and bad key are the same 401 shape" doctrine.
- `content-read.ts`, `redirects.ts` (sitemap only) — moved SQL, mechanical edits only (the pool).
- `delivery.gateway.ts` — the HTTP edge: one **raw Fastify route** (`/v1/*`, encapsulated plugin), not a
  Nest controller. It builds a Web `Request`, calls the router, and writes the `Response` to the Node
  socket itself (`reply.hijack()`), so Nest's exception filter, Fastify's charset suffixing, and
  Fastify's own 404/405/415/400-on-body cannot alter a byte. See the file header for each trap.
- `delivery-auth.service.ts` — tenant lookup (`DbService.withPlatformCtx`) + `ApiKeysService.resolve()`.
  **One key-hash implementation** (`crypto/api-key-hash.ts`); WSK-D24's "hash duplicated in two
  services" cost is retired. `db.ts` adapts `DbService.withTenant` to the one-client-per-request shape
  the read code needs; there is no second pool.
- Per-tenant read quota: the api's `TenantQuotaService` counter (same budget the guarded routes use),
  applied after the key resolves. In-quota responses are byte-identical and gain `X-RateLimit-*`
  headers; over quota is a `429` in the frozen problem+json envelope (slug `rate-limited`, `Retry-After`).
  Default is 300 requests/min/tenant (`WEBDESK_READ_QUOTA_PER_MIN`) — check that against a site build's
  fetch burst before enabling publicly. M3 T6: the counter is in Redis (aligned window, one Lua `INCR` +
  first-hit `PEXPIRE` on `webdesk:quota:<tenantId>:<windowStart>`), so the quota holds across replicas.
  If Redis errors or takes over 200 ms, that request falls back to a per-process window (fail open, one
  warning a minute): read availability beats quota precision. `X-RateLimit-Reset` is now the end of the
  aligned window.
- `vocabulary/` — **vendored, mechanically**, from `webdesk/delivery/vocabulary/` (this package is
  CommonJS and cannot import the ESM `.ts` files). `node src/delivery/vocabulary/vendor.mjs`
  regenerates; `test/delivery/vocabulary-vendor-drift.spec.ts` fails if any copy diverges.
  `webdesk/delivery/` stays the single source (WSK-48b renamed it from `webdesk/payload/vocabulary`
  rather than promoting this copy); see `webdesk/delivery/README.md`.
- WSK-05's demo `content` controller/module/service is **retired** (it owned `GET|POST
  /v1/t/:tenantSlug/content` and would have shadowed a collection keyed `content`). Its guard coverage
  moved: read-scope tests now drive the delivery routes; write-scope tests drive media upload
  (`POST /v1/t/:slug/media/:bucket`, `@RequireScope("write")`) — see the comments in
  `api-keys.scope-matrix.spec.ts` and `tenant-quota.spec.ts`.

### Read-path hardening (WebDesk M3 T1)

Five defects on the public `/v1` read path were fixed; no existing 2xx body changed (`envelope-contract.spec.ts`
is untouched). The one new 2xx is a non-integer `limit`, which used to 500.

- **Reserved collection keys.** `schema.apply` refuses a key that equals (case-insensitively) a fixed
  segment under `/v1/t/:tenantSlug/`: `forms`, `media` (static routes of other controllers) and
  `search`, `sitemap.xml` (the router's own endpoints), with `422 collection-key-reserved`, no collections
  row and no audit row. The list is `src/delivery/reserved-collection-keys.ts`;
  `test/delivery/reserved-collection-keys.spec.ts` boots the app and reads Fastify's registered routes,
  so a new static route under that prefix that is not reserved fails the suite. `schema.propose` does not
  refuse (it never persists).
- **Percent-decoding.** The router decodes each path segment after `/v1/t/` exactly once with
  `decodeURIComponent` (non-ASCII slugs such as `kafé-ü` are reachable by their encoded URL; `%2541` is the
  literal text `%41`, never decoded twice). A malformed escape inside a segment is `400 invalid-path-encoding`.
  A decoded segment containing `/` or NUL matches nothing: `404 not-found`, before any tenant lookup or SQL.
- **Cursors and 500s.** `decodeCursor` now accepts only what the encoder writes (a Postgres
  `timestamptz::text` value and a uuid, validated for real calendar/clock ranges); anything else is
  `400 invalid-cursor` on list and search (it used to be ignored or to reach SQL and 500 with the database's
  message). Every catch-all 500 (content query, `resolveApiKey`, and the gateway's request-build fallback)
  now carries the fixed detail "The server could not complete this request." and the real error goes to the
  server log (Nest `Logger`), never into the body.
- **Non-integer `limit`.** `limit` is truncated to an integer before it is clamped to 1-100, so `limit=2.5`
  lists 2 items. It used to reach `LIMIT $n` as `2.5` and 500.
- **Undecodable URL.** `createFastifyAdapter()` (`src/app.ts`, used by `buildApp()` and so by `main.ts`)
  sets Fastify's `frameworkErrors`, so `GET /v1/t/x/%E0%A4%A` (rejected by Fastify before routing,
  `FST_ERR_BAD_URL`) is `400 application/problem+json` (`invalid-path-encoding`) instead of Fastify's default
  body. Tests that build the full app with a bare `FastifyAdapter` would not get this; use the factory.
- **Differential gate (retired in WSK-48b).** The new behaviours differed from the old Payload router on a few
  corpus inputs; they were recorded as named, counted divergences. The old router is gone: those requests
  are annotated `intended` in `test/delivery/v1-contract/golden-corpus.ts` and the api's answers are in the
  golden files (see Verify).

No new env vars: `APP_DATABASE_URL`, `API_KEY_PEPPER` (must equal what the keys were minted with),
and the optional quota vars are all existing.

### Verify

In-repo (needs only Postgres, like the rest of the suite): `npx vitest run test/delivery` —
`delivery-routes.spec.ts` (byte-level adapter promises, router error shapes surviving the framework,
route precedence against media/forms, the quota), `vocabulary-vendor-drift.spec.ts`, and the two
/v1 contract gates, which run in CI's `webdesk-api` job as part of `npm test`:

- `envelope-contract.spec.ts` — the WSK-06 envelope contract (60 checks, names verbatim) against this
  service's `/v1` over real HTTP (`buildApp()` + `listen`, exactly what `main.ts` does).
- `v1-golden.spec.ts` (WSK-48b) — replaces the old byte-identity differential. WSK-48a had replayed two
  corpora against the old Payload router and this api and compared them byte for byte: the contract's own
  requests (24 + 1 outside `/v1/`) and an extra corpus of error paths and edge cases (662 + 6; the only
  coverage of `/v1`'s error paths), proving them identical apart from the named M3 T1 divergences. The
  Payload router is deleted, so the same requests now go to the api alone and each answer is compared with
  a committed golden recorded from the api: `test/delivery/v1-contract/golden/{contract,extra}.json`
  (status, `content-type`, `cache-tag`, and the normalised body, per request). Volatile values (ids,
  timestamps, tenant slug suffixes, keys, cursors) are normalised by the rules documented in
  `v1-contract/golden.ts`. To change `/v1`'s bytes on purpose, re-record with
  `WEBDESK_V1_GOLDEN_RECORD=1 npx vitest run test/delivery/v1-golden.spec.ts` and review the golden diff.
  The recording is deterministic (two recordings on two fresh databases are byte-identical).

The shared pieces are in `test/delivery/v1-contract/` (the contract suite as a function, the golden
recorder and normaliser, the extra corpus `golden-corpus.ts`, the fixtures).

## Scheduler (WSK-61) — `src/scheduler/**`

The read path already honours `publish_at` / `unpublish_at` by time (a `scheduled` item is live once
`publish_at <= now()`, any item stops being live at `unpublish_at`), so **visibility needs no worker**. The
scheduler exists for what time alone cannot do: make the stored state catch up with what production already
sees, swap a new version into an item that is live right now, and run two maintenance sweeps that had no caller.

Four BullMQ **job schedulers** on one queue (`webdesk-scheduler`; the fourth, `media-purge`, is WSK-43a's), one worker (concurrency 1), all in the api
process. Every replica registers on boot (`upsertJobScheduler` is idempotent) and runs a worker; BullMQ creates
one job per tick per scheduler id however many replicas run. Registration retries in the background until Redis
answers, so a Redis outage delays the schedule instead of failing the boot.

| Scheduler id (= job name) | Every | Runs |
|---|---|---|
| `content-tick` | `WEBDESK_SCHEDULER_TICK_SECONDS` (60) | `ContentTickService.runContentTick(now = new Date())` |
| `forms-retention-purge` | `WEBDESK_SCHEDULER_HOURLY_SECONDS` (3600) | `MaintenanceJobsService.runFormsPurge()` → `SubmissionsPurgeService.purgeDueSubmissions()` |
| `idempotency-sweep` | `WEBDESK_SCHEDULER_HOURLY_SECONDS` (3600) | `MaintenanceJobsService.runIdempotencySweep()` → `PgIdempotencyStore.sweepExpired()` |
| `media-purge` | `WEBDESK_SCHEDULER_HOURLY_SECONDS` (3600) | `MediaPurgeService.runMediaPurge()`: frees the stored versions of soft-deleted media assets once their retention has passed (see "Media library (WSK-43a)") |

The first job of each scheduler runs right after registration, so a fresh deploy makes one catch-up pass.

### Config

| Variable | Default | Allowed |
|---|---|---|
| `WEBDESK_SCHEDULER_ENABLED` | on, **except** under `NODE_ENV=test` | `true`/`false` (`1`/`0`/`yes`/`no`) |
| `WEBDESK_SCHEDULER_TICK_SECONDS` | 60 | whole seconds, 15 to 300 |
| `WEBDESK_SCHEDULER_HOURLY_SECONDS` | 3600 | whole seconds, 300 to 86400 |
| `WEBDESK_SCHEDULER_QUEUE_NAME` | `webdesk-scheduler` | any (a spec uses it to have a queue to itself) |

An **empty** variable means the default, never 0 (compose passes `${VAR:-}` through as an empty string; the
estate has been bitten by `Number("")` before). A value outside its range, or malformed, **refuses to boot** with a
message naming the variable, the value and the range. The check runs whether or not the scheduler is enabled.
The specs never start a worker implicitly: `NODE_ENV=test` defaults it off, and `test/scheduler-wiring.spec.ts`
enables it explicitly with its own queue name. Because of the compose pass-through rule, a variable set only in
`.env` reaches the container only if the service's `environment:` block names it; the defaults need nothing.

### What the content tick does

`now` is the **database's** clock when the job runs (the `/v1` read path judges visibility by the database's
`now()`, so an api host with a fast clock cannot flip an item early); a test passes its own.

Per active tenant, under that tenant's `webdesk.tenant_ctx`, in this order, **one transaction per item**:

1. **Due publishes.** `publish_state = 'scheduled' AND publish_at <= now AND deleted_at IS NULL` becomes
   `published`; `updated_at = greatest(updated_at, publish_at)`. The projection and `last_published_*` were set
   when the item was scheduled and are not touched.
2. **Due version swaps** (`content_schedules`, migration 0012). A pending row with `publish_at <= now`: lock the
   item; if it is deleted or no longer live the row is cancelled (`item-deleted` / `item-not-live`); the version is
   re-validated against the collection's *current* composition and, if it fails, the row is `failed` and nothing
   else changes; otherwise the projection takes the version (exactly `content.publish(v)`'s effect, from the same
   function) with `last_published_at = publish_at`, `last_published_by = requested_by` and `unpublish_at` from the
   row, and the row is `executed`.
3. **Due takedowns.** `publish_state IN ('published','scheduled') AND unpublish_at <= now AND deleted_at IS NULL`
   gets exactly `content.unpublish`'s effect (same function), and any pending swap of the item is cancelled.

`applyPublishEffect` / `applyUnpublishEffect` / `adoptLegacyItem` / `cancelPendingSwap` /
`announceContentEvent` live in `src/control/content/content-transitions.ts` and are the ONLY implementation:
`content-commands.service.ts` and the tick both call them.

Every executed transition writes one audit row `control.content.schedule.executed`, actor `system:scheduler`, in
the item's own transaction, with `ws4_approval_id` **NULL** (0009's single-use index must never see a second use of
an approval). The args hash covers `{kind: 'publish'|'swap'|'takedown', itemId, version, approvalId?}`; a swap's
original approval id goes there. After the commit, fail-soft, the tenant webhook goes out through the same path the
commands use (`content.published` for a publish or a swap, `content.unpublished` for a takedown, item refs only).

### The `schedule.fired` Zone B event (rebuild hint)

After a tenant's three steps finish, the tick tells the ERP what went live or came down, through
`ZoneBEventEmitterService` (kind `schedule.fired`, HMAC-signed like every Zone B event; `WEBDESK_ZONEB_EVENTS_ENABLED`
and an empty `WEBDESK_ZONEB_BRIDGE_URL` are honoured by the emitter). Only transitions whose transaction
**committed** are reported (a rolled-back item, a failed or cancelled swap reports nothing). Fail-soft: an emit
failure is logged and changes nothing about the tick, its counts or the tenant webhook.

- `tenantId` (envelope) = the tenant's `company_ref`; `originSite` = `WEBDESK_ZONEB_ORIGIN_SITE`.
- `data` is exactly `{tenantSlug, siteId, transition: 'publish'|'unpublish', approvalId: uuid|null, items: [{itemId, version, effectiveAt}]}`,
  1 to 100 items. Mapping: a due publish is `publish`/`null` with `effectiveAt = publish_at`; a swap is `publish` with the
  swap row's `ws4_approval_id` and its `publish_at`; a takedown is `unpublish`/`null` with `unpublish_at`. `effectiveAt` is
  `toISOString()` (UTC). `ws4_approval_id` is free text in this database: a value that is not a uuid is sent as `null`.
- One event per `(siteId, transition, approvalId-or-null)` group per tenant per tick; a larger group is chunked
  into 100s in `itemId` order.
- `eventId` = lowercase hex `sha256("schedule.fired|" + tenantSlug + "|" + siteId + "|" + transition + "|" + (approvalId ?? "-") + "|" + sorted(itemId:version:effectiveAt).join(","))`:
  deterministic, so a redelivery dedups at the ERP (`UNIQUE (tenant_id, event_id)`, `event_id` is text) and a later firing differs.
- Code: `src/scheduler/schedule-fired.ts` (pure grouping + id), `test/scheduler-schedule-fired.spec.ts`.

### `content.schedule` on a live item

A future `publishAt` on a **live** item no longer returns 409 `schedule-live-item-requires-worker` (the slug is
retired). It validates the version exactly as the non-live path does and inserts a pending `content_schedules` row
(`requested_by` = the principal, `ws4_approval_id` = the command's approval); the projection is untouched and the
response and `content.scheduled` webhook are unchanged. An earlier pending swap of the same item is cancelled
`superseded` in the same transaction (the newest approved decision wins). `content.publish`, `content.unpublish`
and `content.delete` cancel the item's pending swap in their own transaction (`superseded-by-publish`,
`unpublished`, `deleted`); `update` and `restoreVersion` do not, they never change what is live. Two more
cases keep the newest decision from being silently undone: scheduling a non-live item cancels a swap it left behind
(`superseded`), and a scheduled takedown written over a pending swap either becomes the swap's own `unpublish_at`
(takedown after the swap is due) or cancels the swap (takedown before it).

### Safe with more than one replica

- A tick claims each item with `FOR UPDATE OF ci SKIP LOCKED LIMIT 1` in its own transaction, so two ticks never
  process one item; at READ COMMITTED a row the first tick already committed is re-evaluated against its new state
  by the lock and drops out of the second tick's result. A swap row is read only after its item is locked, the
  same item-first order every command uses, so the tick cannot deadlock with `schedule`/`publish`/`unpublish`/`delete`.
- An item whose transaction throws rolls back alone, is logged and counted in `errors`, is not retried within the
  tick, and is still due next tick. A step is capped at 500 items per tenant per tick.
- `upsertJobScheduler` is idempotent; the two maintenance jobs are idempotent (an `UPDATE ... WHERE status <> 'purged'`
  and a `DELETE` of expired rows), so an overlap is wasted work, never a wrong result. Failures are logged and
  rethrown so BullMQ records the job as failed; nothing crashes the process.
- Shutdown closes the worker (it finishes a running job), then the queue, both awaited. `DbService.onBeforeEnd`
  makes that run before the pool ends (Nest destroys the deeper `DbModule` first otherwise).

### Not built here

The **static-site rebuild at publish time** (gaiada.com is static) is the ERP's half: a new Zone B event kind and a
WSK-60 dispatch under the schedule's original approval, after WSK-60 is live. Today a swap or a due publish only
produces the tenant webhook.

### Verify

`test/scheduler-content-tick.spec.ts` (behaviour, injected clock), `test/scheduler-wiring.spec.ts` (job schedulers,
boot, shutdown, config) and `migrations/tests/0012_content_schedules.test.mjs` (also in `qa/linux-gate.sh`'s
`migrations` suite and the CI `webdesk-api` job). They need Postgres and Redis like the rest of the suite.

## Editorial review (M5-W2b, PROTOTYPED) — `src/control/editorial/*`

The writers' room review flow (design: `docs/plans/2026-10-11-m5-writers-room-design.md` section 4). Tables are migration
`0016` (W2a). **Review is OFF by default**: a collection with no `editorial_policies` row is exactly "off", and every item
command then answers **409 `review-not-enabled`** and changes nothing. `editorial.policySet` is the way in.

| Route (under `/control/v1/tenants/:tenantSlug/sites/:siteId`) | Command | Class / scope | Body |
|---|---|---|---|
| `POST content/items/:itemId/editorial/submit` | `editorial.submit` | medium / operate | `{ version }` (the head) |
| `POST .../editorial/withdraw` | `editorial.withdraw` | medium / operate | `{}` |
| `POST .../editorial/request-changes` | `editorial.requestChanges` | medium / operate | `{ version, note }` |
| `POST .../editorial/seo-signoff` | `editorial.seoSignoff` | medium / operate | `{ version }` |
| `POST .../editorial/approve` | `editorial.approve` | medium / operate | `{ version }` |
| `POST .../editorial/assign` | `editorial.assign` | medium / operate | any of `{ authorSub, dueAt, plannedPublishAt, briefRef }`; `null` clears a date or the brief |
| `POST .../editorial/comments` | `editorial.comment` | medium / operate | `{ version, anchor?, body }` (201) |
| `POST .../editorial/comments/:commentId/resolve` | `editorial.commentResolve` | medium / operate | `{}` |
| `PUT collections/:key/editorial-policy` | `editorial.policySet` | medium / operate | `{ reviewRequired, seoSignoffRequired? }` |
| `GET editorial/board?state&collection&authorSub&dueBefore&cursor&limit` | `editorial.board` | read / read | items in the flow, per-state `counts`, the site's `policies` |
| `GET content/items/:itemId/editorial` | `editorial.history` | read / read | state, `events` (oldest first), `comments`, `seoSnapshot` |

`item.get` gains a top-level `editorial` member and every `item.list` row gains `editorial` (plus a `?reviewState=` filter);
both are control-plane only. Every write needs an `Idempotency-Key` and an editorial assertion, writes its audit row first
(`control.editorial.<cmd>`), and replays with `replayed: true`. None is on `CLIENT_EDITOR_COMMANDS`: a client editor gets
`403 client-command-not-allowed`. No tenant webhook event is emitted.

State machine (`editorial-model.ts`, walked pair by pair in `test/editorial-state-machine.spec.ts`): `draft` and
`changes_requested` -> **submit** -> `in_review`; `in_review` -> **withdraw** -> `draft`, **requestChanges** ->
`changes_requested`, **approve** -> `approved`; **seoSignoff** stamps a version and leaves the state. Any other pair is
**409 `review-state-conflict`** `{ currentState }`. Review is per immutable version: acting on a version other than the head
(submit) or the one in review (the rest) is **409 `review-version-mismatch`**; a collection that requires a sign-off refuses
approval of a version that was not signed (**409 `seo-signoff-required`**). A new version written during review keeps the state
and moves `submitted_version` to the new head (an older sign-off stops counting); one written after approval returns the item to
`draft` and leaves `approved_version` as it was. `policySet` with review off clears both flags; sign-off on with review off is a 400.

WebDesk enforces on its own, besides the ERP's Cerbos: approve and sign-off are **human** decisions (an `agent` or `automation`
principal gets **403 `review-principal-not-allowed`**), and **maker != checker**: the approver may not be the creator of the
version being approved (**403 `review-self-approval`**, against `content_versions.created_by`). The `editorial_events.kind`
vocabulary is `review.*` (`EDITORIAL_EVENT_KINDS`); `/v1` never reads these tables (`test/editorial-delivery-isolation.spec.ts`).
The publish gate that makes an unapproved version unpublishable is W2c (next section).

### The publish gate (M5-W2c, PROTOTYPED) — `src/control/editorial/review-gate.ts`

On a collection whose policy has review ON, the only version that may go in front of a production key is the one in
`editorial_items.approved_version`, compared to the EXACT version being published: not the head (promotion import and
rollback append versions without the review hooks, so the head can move under an approved item) and not the state alone
(an edit after approval returns the item to `draft`, and `approved_version` stays publishable). No review row, or no approved
version, is refused. Where it runs, always under the item locks and inside the command's own transaction:

| Path | When | Refusal |
|---|---|---|
| `content.publish` | after the WS4 claim (the envelope's audit row) and D62's client-path check, before any effect | **409 `review-not-approved`** `{ items: [{ itemIndex, itemId, version, approvedVersion }], total }` for the WHOLE batch; the transaction (claim included) rolls back |
| `content.schedule` with `publishAt` | the same | the same; a takedown-only schedule (`publishAt: null`) is not gated |
| scheduler, due version swap (WSK-61 step 2) | at fire time, after the composition re-check | the swap row is marked failed, `fail_reason = "review-not-approved: version N is not the approved version (approved: M \| nothing is approved)"`, counted in `swapsFailed`; the live version keeps serving |

It applies to every principal class, client editors included (a client cannot approve, so a client's self-publish on a
review-required collection needs an agency approval first; D62 still runs first and independently). Review OFF (no
policy row, the default) is one policy read and nothing else. Not gated: `content.unpublish`, `content.promote`,
`content.rollback`. A non-live item's scheduled publish (step 1) cannot be re-checked at fire time: the frozen `/v1` read
path shows it by time at `publish_at`, before any tick; it was gated when it was scheduled. Proof:
`test/editorial-publish-gate.spec.ts`.

## Draft preview (WSK-46) — `src/control/content/preview-token-*`, `src/delivery/preview-*`

Owner ruling WSK-D52: a draft preview is an instant page **on the site**. The site's page fetches the draft from
WebDesk with a short-lived token and renders it with the site's own components. This is the WebDesk api's half:
the tokens, and the public endpoint the site's page calls. (The ERP button and the site page are other tickets.)

**The token is a bearer capability. Anyone who holds the link sees that one draft until it expires or is revoked,
with no other credential and no login.** Treat a preview link like a password to an unpublished page: do not paste
it into a public channel, an issue or a ticket. It is deliberately short-lived (default one hour, at most 24) and
revocable, and it pins one version of one item, so a later edit never changes what an old link shows.

### Routes

| Route | Auth | What |
|---|---|---|
| `POST /control/v1/tenants/:tenantSlug/sites/:siteId/content/items/:itemId/preview-token` | control channel, scope `webdesk:operate`, editorial principal, `Idempotency-Key` | `content.previewToken` (MEDIUM). Body `{ version?, ttlSeconds? }`. 201 `{ tokenId, token, expiresAt, version, previewPath }` |
| `DELETE /control/v1/tenants/:tenantSlug/sites/:siteId/content/items/:itemId/preview-tokens/:tokenId` | same | `content.previewTokenRevoke` (MEDIUM). 200 `{ tokenId, itemId, revokedAt, alreadyRevoked }`. Idempotent |
| `GET /v1/t/:tenantSlug/preview/:token` | **none** (the token is the credential) | the pinned version as the frozen item envelope |
| `OPTIONS /v1/t/:tenantSlug/preview/:token` | none | CORS preflight |

The two control routes are internal (mTLS vhost, like every `/control/*` route) and pass the same gates as the other
content writes: L3 scope, then the L2e editorial assertion, then validation. Minting is MEDIUM and **not** read-only:
it exposes unpublished content to whoever holds the link, so it is audited (`control.content.previewToken`, naming the
token id and never the token), needs no WS4 approval, and carries an editorial principal (`created_by`).

### Token format and storage

32 random bytes from the OS CSPRNG, base64url (43 characters), generated server-side. Only its **sha256 (lowercase
hex)** is stored (`preview_tokens.token_hash`, unique, migration `0013`); the plaintext exists only in the mint
response. The mint runs in the shared command envelope with `withhold`, so the idempotency record is stored without
the token **and without `previewPath`** (which embeds it): a replay of a mint answers **409
`idempotency-response-withheld`** and mints nothing; mint again under a new `Idempotency-Key`. `ttlSeconds` defaults
to 3600, is capped at 86400, and 0 or empty means the default; a negative, fractional or non-numeric value is a 400.
`version` defaults to the item's head version; a missing version is 409 `version-not-found`, a deleted item 409
`item-deleted`, and an item that is unknown, malformed or on another site or tenant is one 404 `item-not-found`.

### The public endpoint

- **One failure, one answer.** An unknown, malformed, expired or revoked token, a slug that is not that token's tenant
  (or not a tenant, or an archived one), and a deleted item are all the **same 404 `not-found`** (the body of any
  unknown `/v1` path), apart from `requestId`. The endpoint reveals nothing about which part was wrong.
- **What it serves** is the pinned `content_versions` row's blocks and seo, wrapped by the same envelope builder the
  item route uses, with the item's collection, locale, slug and meta. `meta.draft` is true unless the pinned version is
  the one live right now. `localizations` lists only live siblings, so a preview never discloses other unpublished items.
  The envelope shape is the frozen one; nothing in `/v1` changed.
- **Headers** on every response of the route: `Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow`,
  `Vary: Origin`, and **no `Cache-Tag`** (a CDN must never hold a draft, and a cached 200 would outlive a revoke).
- **CORS.** `Access-Control-Allow-Origin` echoes the request `Origin` only when it equals `https://<domain>` for the
  `environments.domain` of an environment (staging or production) of the token's site; otherwise no CORS header.
  Never `Allow-Credentials`. The preflight answers 204 (`GET, OPTIONS`, `Access-Control-Max-Age: 600`); a preflight for a
  bad token is the same 404. Set `environments.domain` for the site, or no browser origin will be allowed.
- **Quota.** The per-tenant read quota applies, but is spent only after a token proves valid, so a stranger guessing
  tokens cannot exhaust a tenant's real reads.
- **Not leaked into logs or bodies.** `instance` and server log lines carry the path with the token replaced by
  `:token`. **Operators:** the token is in the request URL, so any access log in front of the api (Caddy, a CDN, a load
  balancer) records it. Redact `/v1/t/*/preview/*` in those logs, or accept that log readers can open a link until it
  expires.
- `preview` is a **reserved collection key** (`delivery/reserved-collection-keys.ts`): a collection with that key
  would be unreachable. Check that no existing site already has one before you deploy.

### Verify

`test/preview-token-commands.spec.ts` (mint, revoke, gates, storage), `test/delivery/preview-endpoint.spec.ts` (the
public route: draft not live, headers, CORS, every 404, api keys, quota), `test/delivery/preview-token.spec.ts` (pure
primitives), `test/delivery/reserved-collection-keys.spec.ts`, and `migrations/tests/0013_preview_tokens.test.mjs`
(also in `qa/linux-gate.sh`'s `migrations` suite and the CI `webdesk-api` job).

## Media library (WSK-43a) — `src/media/**`, `src/control/content/media-*`, `src/scheduler/media-purge.service.ts`

Owner rulings WSK-D53 (a library image reaches a static site through its build) and WSK-D54 (an image still used by
content cannot be deleted). This is the WebDesk api's half: the schema, the control commands, the public upload route
and the purge job. (The ERP's Cerbos kind and routes, and the UI, are WSK-43b and WSK-43c.)

A library asset is a `media_assets` row (migration `0014`): `title`, `alt` (a map locale to text), `tags`,
`original_filename`, `created_by`, `width`, `height`, `updated_at`, and a lifecycle: **live** (`deleted_at` null), **soft-deleted**
(`deleted_at` set, `purge_after = deleted_at + the bucket's GOVERNANCE retention`, the stored object still exists) and
**purged** (`purged_at` set: every stored version deleted). CHECKs make the lifecycle impossible to get wrong
(`purge_after` iff `deleted_at`, never before it; `purged_at` only after `deleted_at`). The asset's **canonical URL** is
`/v1/t/<tenantSlug>/media/<assetId>`: that is what an editor writes into a media field, and what the in-use scan looks for.

### Routes

| Route | Auth | What |
|---|---|---|
| `POST /control/v1/tenants/:t/sites/:s/media/upload-token` | control channel, `webdesk:operate`, editorial principal, `Idempotency-Key` | `media.uploadToken` (MEDIUM). Body `{ bucket, maxBytes?, mime? }`. 201 `{ tokenId, token, uploadPath, expiresAt, bucket, maxBytes, allowedMimes }` |
| `PATCH /control/v1/tenants/:t/sites/:s/media/:assetId` | same | `media.update` (MEDIUM). Body `{ title?, alt?, tags? }` (at least one). 200 `{ asset }` |
| `DELETE /control/v1/tenants/:t/sites/:s/media/:assetId` | same | `media.delete` (MEDIUM, soft). 200 `{ assetId, deletedAt, purgeAfter, alreadyDeleted }`; **409 `media-in-use`** while content uses it |
| `GET /control/v1/tenants/:t/sites/:s/media/:assetId/usage` | control channel, `webdesk:read` | `media.usage`. 200 `{ assetId, url, total, items: [{ itemId, collectionKey, locale, slug, in }] }` (at most 50 items) |
| `GET /control/v1/tenants/:t/sites/:s/media` | same | `media.list` (exists): gains `q`, `tag`, `includeDeleted` beside `mime`, and the library fields in each asset |
| `POST /v1/t/:tenantSlug/media/upload/:token?filename=` | **none** (the token is the credential) | the public upload; the body is the file, `Content-Type` its type. 201 with the asset |
| `OPTIONS /v1/t/:tenantSlug/media/upload/:token` | none | CORS preflight |

The control routes are internal (mTLS vhost) and pass the same gates as the other content writes: L3 scope, then the
L2e editorial assertion, then validation. All three writes are MEDIUM and need no WS4 approval. They are all on
`webdesk:operate`: unlike `content.delete` a media delete takes no takedown scope, because it is refused while content
uses the asset, so it cannot break a page.

### The contributor upload quarantine (M5-W1q, PROTOTYPED; owner ruling WSK-D84) — migration `0020_media_review_state.sql`

A contributor's upload is created **quarantined**: it has passed the same scan (WSK-D80) and is stored, but nothing serves it until a staff editor accepts it.

- **State.** `media_assets.review_state` is `accepted` (the default: every existing row, staff upload and API-key upload), `quarantined` or `rejected`, with
  `reviewed_by` / `reviewed_at`. It is fixed at MINT: `media.uploadToken` sets `media_upload_tokens.quarantine` from the signed principal (`xc`), the public upload
  route copies it onto the asset, and nothing in the upload request can change it. The asset's JSON carries `reviewState`, `reviewedBy`, `reviewedAt`.
- **Refused everywhere.** `MediaService.getPublicAsset` has `review_state = 'accepted'` in its WHERE, so the public media route and the transform route answer a
  quarantined or rejected asset as an unknown id (404), by id, upper-cased id or any guess of its path. `media.list` shows accepted assets by default; the
  ERP's review desk asks `reviewState=quarantined` (also `rejected`, `all`; `assetId=<uuid>` reads one asset's row). Promotion exports accepted assets only.
  `content.publish` / `content.schedule` (publishing) are **409 `media-not-accepted`** when a version names `/media/<assetId>` of an unaccepted asset
  (`control/content/media-review-gate.ts`); drafts may name it.
- **`media.review`** `POST /control/v1/tenants/:t/sites/:s/media/:assetId/review` body `{decision: "accept" | "reject"}`: MEDIUM / `webdesk:operate`, an editorial
  command, on neither `CLIENT_EDITOR_COMMANDS` nor `CONTRIBUTOR_COMMANDS` (a client editor and a contributor are refused 403). Only a quarantined asset is judged
  (409 `media-not-quarantined`, 409 `media-asset-deleted`); the uploader is refused again here (403 `media-self-review`; the ERP's Cerbos refuses first); the same
  decision again is a no-op (`alreadyDecided`); a decision is final. **Accept** serves it. **Reject** soft-deletes it exactly as `media.delete` does
  (`deleted_at`, `purge_after = now + the bucket's GOVERNANCE retention`): the object cannot be deleted before its lock lapses, it is served by nothing, and the
  existing `media-purge` job deletes every stored version once `purge_after` passes. There is no second purge path.
- **Tests.** `test/media-quarantine.spec.ts` (real Postgres, RustFS and ClamAV: state, every serving path, publishing, the scan, review, self-review, reject),
  `migrations/tests/0020_media_review_state.test.mjs`, and the updated pins `control-command-registry`, `contributor-editor-principal`, `contributor-editor-enforcement`,
  `client-editor-principal`.

### The upload token and the public upload route (an untrusted-input surface)

- **Mint.** 32 random bytes, base64url; only the sha256 is stored (`media_upload_tokens.token_hash`); valid ten minutes;
  bound to tenant, site, bucket (`media` or `video`, the public buckets), a byte cap and an allowed mime set. `maxBytes`
  defaults to and is capped by `WEBDESK_MEDIA_MAX_UPLOAD_BYTES`; `mime` (a string or an array) defaults to and is a
  subset of the bucket's allowlist. `withhold` keeps the token and `uploadPath` out of the idempotency record: a replay
  of a mint is 409 `idempotency-response-withheld`.
- **The token alone, first, then three short database steps (no pooled connection is held while bytes stream).**
  Nothing about the body is looked at before the token is proven. The route then (a) looks the token up and refuses what
  the headers alone decide: a declared type outside the token's set (415) or a declared `Content-Length` over the cap
  (413): the token stays unspent; (b) **claims** it in its own transaction, committed *before the body is read*:
  `UPDATE ... SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`: this single
  statement is what makes it single-use under concurrency (of two racing requests exactly one updates the row, the
  loser gets the 404 and has read and stored nothing); (c) reads, screens and stores the body with **no connection
  held**, then inserts the asset row (and its audit row) in a second short transaction. A slow or stalled sender
  therefore never pins one of the api's 10 pooled connections.
- **Fail closed.** From the claim on the token is spent whatever happens: a body over the cap, a wrong signature, an
  infected file, a quota refusal, a stalled sender (408), a storage or database error: the editor mints a new token.
  The scan runs before the store, so a refused or infected file never reaches storage. If the object was stored and
  the row insert then failed, the object is deleted at once and a soft-deleted row is written for it
  (`MediaService.recordTombstone`): on a locked bucket the delete only adds a marker, so that row (with `purge_after`)
  is what lets `media-purge` free the locked version later, and it keeps the quota honest until then.
- **Refusals are `application/problem+json` with a stable `type` slug.** Every refusal of `POST` and `OPTIONS` on this
  route answers `{ type: "https://webdesk.gaiada.online/errors/<slug>", title, status, detail }` (the shape the control
  routes use; `type` is the contract a client maps on, `detail` is prose that may be reworded), never Nest's
  `{ statusCode, message, error }`. Status codes are exactly what they were. CORS headers, `Vary: Origin` and
  `Cache-Control: no-store` are on these answers too (the browser reads them cross-origin), and `Retry-After` and
  `Connection: close` are kept. No body, header or log line carries the token. An answer that is not one of these
  is `invalid-request` or `internal-error` below, and the thrown message of an unexpected failure is never sent.

  | Slug | Status | Refusal |
  |---|---|---|
  | `upload-not-found` | 404 | The token is unknown, malformed, expired, already spent or another tenant's, or the tenant is unknown or archived. One body for all of them (no oracle), through `OPTIONS` too |
  | `upload-type-not-allowed` | 415 | The declared type is outside the token's set, has no parser at all, or is missing with a body. 400 when the bucket's allowlist refuses it after the body is read |
  | `upload-type-mismatch` | 400 | The declared type does not match the file's magic bytes |
  | `upload-too-large` | 413 | Over the cap by a declared `Content-Length`, or by a body that crossed it while streaming. 400 if the screen finds it over the cap |
  | `upload-empty` | 400 | An empty body |
  | `upload-quota-exceeded` | 403 | The tenant's storage quota would be exceeded |
  | `upload-infected` | 403 | The malware scan matched; `detail` names the signature |
  | `upload-scan-unavailable` | 503 | The scanner could not be reached (fail closed); a fixed `detail`, the scanner's error is not echoed |
  | `upload-busy` | 503 | The process or tenant upload slots are full; `Retry-After: 5` |
  | `upload-timeout` | 408 | The body did not arrive before `WEBDESK_MEDIA_UPLOAD_TIMEOUT_MS` |
  | `upload-interrupted` | 400 | The sender went away mid-body |
  | `invalid-request` | 400 | Anything else Fastify refuses before the handler, such as a malformed JSON body |
  | `internal-error` | 500 | An unexpected failure (storage, database); a fixed `detail` |

  There is no "bad filename" refusal: the filename is only a label, and an unusable one is cleaned to nothing and stored
  as `file`. The ERP's media UI (`platform-ui/src/lib/webdeskMediaModel.ts`) maps on the slug first and keeps status plus
  message as the fallback for an older WebDesk. The mechanism is `src/media/upload-problem.ts`: the refusals keep their Nest
  exception classes tagged with a slug (so the api-key upload route, which shares the screening code, still answers as it
  always did), `UploadProblemFilter` is bound to the two upload handlers only, and an `onSend` hook on the upload path
  (`media-upload-parser.ts`) rewrites the refusals Fastify makes before the handler runs.
- **One 404.** Unknown, malformed, expired, spent, another tenant's token, an unknown or archived tenant slug: the same
  bytes (`Connection: close`, so a sender is not read to the end). No oracle, through `OPTIONS` either.
- **Bounded while streaming.** The cap is `min(token max_bytes, WEBDESK_MEDIA_MAX_UPLOAD_BYTES)`. A declared
  `Content-Length` over it is 413 before a byte is read; a body without one is counted as it arrives and refused when it
  crosses the cap, so nothing larger is ever held. `WEBDESK_MEDIA_UPLOAD_TIMEOUT_MS` (60000) ends a stalled sender (408).
  The declared type must be in the token's set (415), then the **existing pipeline** runs unchanged (bucket allowlist,
  magic-byte sniff, quota, ClamAV fail-closed with the usual 403 and audit row, store, row).
- **Slots.** Defence in depth: they bound concurrent uploads (each holds a body of up to the cap in memory, a ClamAV
  socket and a storage write), not connections. A process runs at most `WEBDESK_MEDIA_UPLOAD_MAX_CONCURRENT` token
  uploads at once (default 4, 1 to 8) and `WEBDESK_MEDIA_UPLOAD_MAX_PER_TENANT` per tenant (default 2); the rest get
  **503 with `Retry-After: 5`**. The check comes before the token is looked at, so it is the same answer for every
  token (no oracle). Known limit: the slots are per process, so N replicas admit N times as many.
- **Body parsing** is scoped: a Fastify parser for exactly the public buckets' media types, handing the route the
  unread stream. On any other path it answers the 415 Fastify would (`media/media-upload-parser.ts`).
- **CORS** is configuration, not the preview rule: the upload is made from the ERP editor's origin (bytes never
  traverse Zone A), not the tenant site's. `WEBDESK_UPLOAD_CORS_ORIGINS` is a comma-separated list of exact origins
  (`https://erp.gaiada.online,https://erp.gaiada.com`), each `https://host[:port]` (host lower-cased; no path, no
  trailing slash, no `*`, not `null`). Unset or empty means **no CORS headers at all** (a server-side caller is
  unaffected); a malformed entry **refuses to boot**, naming the variable. The route (POST and its preflight) echoes
  `Access-Control-Allow-Origin` only when the request `Origin` equals one configured origin exactly; every answer, the
  404 included, carries `Vary: Origin` and `Cache-Control: no-store`; never `Allow-Credentials`. The preflight (204 only
  for a still-redeemable token, else the 404) allows `POST, OPTIONS` and the headers `content-type, x-request-id`
  (the body is the raw file, so `content-type` is the only non-simple header an upload needs), `Max-Age: 600`. The
  decision depends on the Origin alone, never on the token, so it is no oracle. The draft-preview route keeps its own
  site-domain rule, unchanged. The compose files pass the variable to the api (`${WEBDESK_UPLOAD_CORS_ORIGINS:-}`).
- **Attribution.** `media_assets.created_by` is the minting editorial principal (the token's `created_by`), so the
  library can show who uploaded what (`createdBy` in `media.list` and the upload response; null for rows that predate
  it); it is also the actor of the `webdesk.media.upload` audit row. `original_filename` is a cleaned label (last path segment,
  control characters removed, at most 255 characters); `width`/`height` are read from the header bytes for png, gif,
  jpeg and webp, else null.
- **Operators:** set `WEBDESK_UPLOAD_CORS_ORIGINS` to the ERP origin(s) on each environment, or no browser upload from
  the editor can work. The token is also in the request URL, so any access log in front of the api (Caddy, a CDN, a
  load balancer) records it. **Redact the upload path `/v1/t/*/media/upload/*` at the edge too, exactly as you redact
  `/v1/t/*/preview/*`** (the api's own `instance` and log lines already do). An unredacted log lets a reader upload one
  file into the library until the token expires (ten minutes) or is used.
- `media` was already a reserved collection key.

### `media.update`

`title` (null or "" clears; 200 characters), `alt` (the COMPLETE locale map: its keys must be locales the tenant
declares, an empty text drops its key, `{}` clears; 500 characters each), `tags` (the complete list, normalised:
trimmed, whitespace collapsed, lower-cased, de-duplicated; more than 20 or a tag over 40 characters is a 400, never
silently cut). A deleted asset is 409 `media-asset-deleted`; an unknown or malformed id, or one on another site or
tenant, is one 404 `media-asset-not-found`.

### `media.delete` and the in-use scan (D54)

Soft: `deleted_at = now()`, `purge_after = now() + WEBDESK_STORAGE_LOCK_DAYS days` (the variable
`scripts/storage-bootstrap.mjs` applies as every bucket's GOVERNANCE retention; default 1; the api reads the same one,
so the compose files pass it). The asset leaves `media.list`, stops being served (404) and **still counts in the quota**.
Deleting again is idempotent (200, `alreadyDeleted: true`, the original instants).

It is refused with **409 `media-in-use`** (`usage`: at most 50 items, `total`: all of them) while any non-deleted item
of the site uses it. The scan (`control/content/media-usage.ts`, shared with `media.usage`) looks for `/media/<assetId>`
(lower-cased substring: the id is a uuid, so any host, `/transform` suffix, case or block shape matches) in the `blocks`
and `seo` JSON of:

| `in` | where |
|---|---|
| `live` | the live projection of an item that is `published` or `scheduled` |
| `head` | the item's HEAD version (its working draft; older versions are history, not uses) |
| `scheduled` | the version of a pending live-item swap (WSK-61) |

```sql
SELECT t.*, count(*) OVER () AS total FROM (
  SELECT ci.id AS item_id, c.key AS collection_key, ci.locale, ci.slug,
         (ci.publish_state IN ('published','scheduled') AND (strpos(lower(ci.blocks::text), $3) > 0 OR strpos(lower(ci.seo::text), $3) > 0)) AS in_live,
         EXISTS (SELECT 1 FROM content_versions v WHERE v.content_item_id = ci.id AND v.version = ci.head_version AND v.tenant_id = $1
                   AND (strpos(lower(v.blocks::text), $3) > 0 OR strpos(lower(v.seo::text), $3) > 0)) AS in_head,
         EXISTS (SELECT 1 FROM content_schedules s JOIN content_versions v ON v.content_item_id = s.content_item_id AND v.version = s.version
                  WHERE s.content_item_id = ci.id AND s.tenant_id = $1 AND s.executed_at IS NULL AND s.cancelled_at IS NULL AND s.failed_at IS NULL
                    AND (strpos(lower(v.blocks::text), $3) > 0 OR strpos(lower(v.seo::text), $3) > 0)) AS in_scheduled
    FROM content_items ci JOIN collections c ON c.id = ci.collection_id
   WHERE ci.site_id = $2 AND ci.tenant_id = $1 AND ci.deleted_at IS NULL ) t
WHERE t.in_live OR t.in_head OR t.in_scheduled ORDER BY t.collection_key, t.slug, t.locale, t.item_id LIMIT 50   -- $3 = '/media/<assetId>'
```

Known limit: the scan is a snapshot. A content write that saves a draft naming the asset in the same instant as the
delete commits can slip past it (content writes do not lock the assets they name); the effect is a draft image that
404s until re-picked, never a published page.

### The purge job (`media-purge`, hourly) and the quota

A plain delete on a versioned, object-locked bucket only adds a delete marker; the locked versions used to stay forever.
Now, per tenant (its own `tenant_ctx`), one asset per transaction with `FOR UPDATE SKIP LOCKED` (safe with two
replicas), for every asset with `deleted_at` set, `purged_at` null and `purge_after <= now()` (the database's clock),
`StorageAdapter.deleteAllVersions` lists the object's versions and delete markers and deletes each by `VersionId`, then
`purged_at` is stamped and `webdesk.media.purged` audited. Retention has passed, so GOVERNANCE allows it without a bypass;
a version still locked is refused by the provider. **A storage error leaves the asset un-purged**, logged with its id and
retried next run; it is counted, never thrown. At most 200 assets per tenant per run.

**Deploy note (storage policy).** The api's storage key had no `s3:DeleteObjectVersion` or `s3:ListBucketVersions`.
`scripts/storage-bootstrap.mjs` now grants both on the **public buckets only** (media, video), never the lock bypass.
Re-run the bootstrap on each environment (it is idempotent and updates the `webdesk-api` policy); until then the purge
fails soft (every run logs the AccessDenied and nothing is freed). Set `WEBDESK_STORAGE_LOCK_DAYS` on the api to the same
value the bootstrap used if it is not the default 1.

`QuotaService` now sums `size_bytes` of every asset with `purged_at IS NULL`: live assets **and** soft-deleted ones still
inside their retention (storage really holds those bytes), not purged ones. The quota drops when the bytes are freed.

### Verify

`test/media-upload-token.spec.ts` (mint, gates, the public route: one-use under concurrency, no pooled connection held while a body streams, fail-closed failures, caps and streaming, types,
EICAR, quota, the identical 404, CORS, the scoped parser), `test/media-library-commands.spec.ts` (update, delete, the
in-use scan, usage, list filters and cursor, quota), `test/media-purge.spec.ts` (real RustFS: every version gone,
negative control under a live lock, two parallel runs, a storage error), `test/media-upload-unit.spec.ts` (dimensions
from hostile bytes, the bounded reader, cleaners), `test/scheduler-wiring.spec.ts` (four job schedulers),
`migrations/tests/0014_media_library.test.mjs` (in `qa/linux-gate.sh`'s `migrations` suite and the CI `webdesk-api` job).

## Client editors (WSK-49)

Rulings WSK-D58, WSK-D59, WSK-D60 (`docs/blueprints/webdesk-design-v2.md` §14). A client's own staff edit their company's site
through the ERP's client portal. A client write is the **least-trusted write in the system**, so WebDesk checks it itself in
addition to the ERP's portal BFF (D59: "enforced twice"). Vocabulary 1.2.0 (`../delivery/README.md`) adds the metadata; this is
the write plane's half.

### The marker: `ce` on the editorial assertion

The signed editorial assertion (WSK-40, `src/control/auth/editorial-assertion.ts`) gains one **optional** claim, `ce`, a boolean
("client editor"), written between `apr` and `iat`. The verifier accepts it; a present `ce` that is not a boolean is
`401 editorial-assertion-claims` (never coerced, never ignored); it is covered by the signature, so it can neither be added nor
stripped in transit; it is not part of `cmh`. The principal exposes `clientEditor: true` only for `ce: true`; for an absent or
`false` claim the principal is exactly what it was before WSK-49 (the dev-mode header stub takes the same optional boolean).
`test/editorial-assertion-vectors.spec.ts` pins a `ce` vector (v4) that the ERP signer (49c) must reproduce byte for byte.

> **The ERP must set `ce: true` on every assertion it mints for a client principal (ticket 49c).** The marker only ever
> restricts: an assertion without it is a full-power staff assertion, and WebDesk cannot tell that a client was left unmarked.

### Enforcement, only when `principal.clientEditor` is true

Without the marker none of this runs: the existing specs pass untouched (apart from five that pinned the vocabulary version).

| Rule | Where | Refusal |
|---|---|---|
| **create**: allowed only in a collection where something is client-editable (at least one field, or the collection itself is client-editable and allows generic blocks); never in the `redirect` system collection (its values live under `seo`); every non-editable part of the content must be absent or `null` (its default) and `seo` must be empty | `ContentCommandsService.createItem` | `422 field-not-client-editable`, the offending JSON pointers in `issues[]` (`/collectionKey` for a collection-level refusal) |
| **update / restoreVersion**: every path the new content changes against the item's HEAD version (`fields` props by pointer, generic blocks, `seo`) must be client-editable; **one** non-editable path refuses the **whole** write (nothing is written, not even the editable part) | `updateItem`, `restoreVersion` | `422 field-not-client-editable`, pointers listed |
| **publish (WSK-D62)**: for EACH item, every path that differs between its currently PUBLISHED version (an empty baseline when never published: all its non-empty paths count) and the version being published must be client-editable; one bad item refuses the **whole** publish (a batch publishes none) | `ContentCommandsService.publish`, a pre-pass after the guards, inside the transaction, before any projection change | `422 publish-not-client-editable`, `issues[].path` = `/items/<index>` + the pointer, `total` |
| a stale `baseVersion` is decided first | same | `409 version-conflict` (the head moved, so a diff against it would blame the client for someone else's change) |
| a client **command** outside the allow-list `CLIENT_EDITOR_COMMANDS` (`src/control/command-types.ts`) | `EditorialAssertionGuard` (every editorial route) and the top of each service method | `403 client-command-not-allowed` |

The rule that decides "client-editable" is the vocabulary's one function, `isClientEditable`
(`../delivery/vocabulary/client-editable.ts`, vendored into `src/delivery/vocabulary/`): a field is client-editable iff
`field.ui.clientEditable ?? <its parent group's effective value> ?? collection.ui.clientEditable ?? false`; a generic block iff
the collection is; **`seo` is never client-editable** (a design default: the agency keeps SEO-critical fields; D59's reason is
that agency-built sites keep structure and SEO-critical fields under the agency's control); an unknown field or malformed
pointer is not editable. The pointers are RFC 6901 into the stored content (`/blocks/0/props/faq/2/a`, `/blocks/1/props/content`,
`/seo/title`), the same coordinates `composition-violation` issues use. A new list item or object is checked leaf by leaf, so a
non-editable member inside it cannot hide behind an editable parent. A write that **omits `seo`** from an item that has one
removes it, which is a `seo` change: the portal must send the existing `seo` back unchanged.

The check runs **before** content validation and inside the command's transaction: an unauthorised change is never answered as
an ordinary 422 about something else, and a refusal writes nothing. A client's request never shares an idempotency record with a
staff request of the same key and body, its audit row carries `clientEditor: true`, and `content_versions.attribution` carries
`ce: "true"` for every version a client wrote.

### Publish (WSK-D62: "a client may publish only what a client could have changed")

A client's publish, single item or a batch the client approves, is diffed per item against what is currently published, with the same
`changedContentPointers` the update check uses (there is no second diff), and every changed path must pass `isClientEditable`. So a
draft that carries an agency's edit to a non-editable field, or any `seo` change, cannot be published by a client until the agency
publishes it; re-publishing the version already live is a no-change publish and is allowed. Without the marker a publish is
unchanged. D58's approval flow (who may approve) stays the ERP's; D62 is WebDesk's independent check of what goes live.

### Commands a client may and may not run (design defaults the owner may widen)

| Allowed | Refused (`403 client-command-not-allowed`) |
|---|---|
| `content.create`, `content.update`, `content.restoreVersion` (each held to the client-editable paths) | `content.delete` |
| `content.publish` (WS4 + the editorial `apr` binding as for staff, then **WSK-D62** below; **D58's approval flow is the ERP's**) | `content.unpublish` |
| `content.previewToken`, `content.previewTokenRevoke` | `content.schedule` |
| `media.uploadToken`, `media.update` | `media.delete` |

These are **defaults in the spirit of D59** ("schema, media deletion and other companies are never reachable"), not owner
rulings; widening one is one line in `CLIENT_EDITOR_COMMANDS` and a ruling. The list is an **allow-list**: an editorial command
added later is refused to a client until it is listed. `schema.apply`, `key.*`, lifecycle, releases and promotion carry **no
editorial assertion at all**, so a client principal cannot be expressed on those routes and WebDesk cannot refuse it there:
the ERP must never route a client to them (49c). "Other companies" is the ERP's too: WebDesk is tenant-scoped by the signed
`ten`/`site` claims and the RLS tenant context, and the assertion's scope is already the route's.

### Tests

`test/client-editor-enforcement.spec.ts` (the real resolver verifying signed `ce` assertions, the real commands, valid bodies
for every denial, every denial paired with the same call without `ce`), `test/client-editor-principal.spec.ts` (the claim, both
resolvers, the command allow-list over the whole registry), `test/editorial-assertion-matrix.spec.ts` rows 27-31 (malformed
`ce`, `ce: false`, `ce: true` exposed, an unknown claim still ignored, `ce` bound by the signature),
`test/editorial-assertion-vectors.spec.ts` v4.

## Contributors (M5-W1e, PROTOTYPED)

Ruling WSK-D84 (`docs/blueprints/webdesk-design-v2.md` §14); `docs/plans/2026-10-11-m5-writers-room-design.md` D10 and §3.1 item 7. A freelance
writer, translator or SEO reviewer has an ERP login (`users.kind = 'contributor'`). The ERP fences it (route fence, Cerbos DENYs, a role allow-list);
this is WebDesk's own wall, so the ERP's is not the only one. It is built exactly like the client editor of WSK-49 above and never combined with it.

### The marker: `xc` on the editorial assertion

The signed editorial assertion gains a second **optional** boolean claim, `xc` ("contributor"), written between `ce` and `iat`:
`...,"apr"?,"ce"?,"xc"?,"iat","exp","jti"`. The ERP signer (`platform-nest/src/modules/webdev/webdesk-editorial-signer.ts`) writes `xc: true` only
when the ASSEMBLED principal's `kind` is `contributor`, and never from a request body, header or argument (its `sign(input, principal)` takes the
principal, `EditorialAssertionRequest` has no `xc` field); an assertion for any other principal has no `xc` at all, never `false`.

| Rule | Where | Refusal |
|---|---|---|
| a present `xc` that is not a boolean (a string, a number, `null`, an array, an object) | `verifyEditorialAssertion`, step 6 | `401 editorial-assertion-claims` (never coerced, never ignored) |
| `xc` together with `ce`, whatever their values (a contributor is never a client editor) | the same step | `401 editorial-assertion-claims` |
| expiry, lifetime, replay, scope, `cmh`, `apr` | unchanged | unchanged |
| `xc` is covered by the signature, so it can be neither added nor stripped in transit; it is not part of `cmh` | | `401 editorial-assertion-invalid-signature` |

The principal exposes `contributor: true` only for `xc: true`; for an absent or `false` claim it is exactly what it was before W1e (the dev-mode header
stub takes the same optional boolean `xc`, and refuses it together with `ce`). Like `ce`, the marker only ever **restricts**: an assertion without it is
a full-power staff assertion, so the ERP's whole duty here is to set it on every contributor assertion.

### Commands a contributor may and may not run

`CONTRIBUTOR_COMMANDS` (`src/control/command-types.ts`) is an **allow-list**, checked by `EditorialAssertionGuard` on every editorial route and again at
the top of every service method (`assertContributorMayRun`, `src/control/auth/contributor-editor.ts`). A command added to `EDITORIAL_COMMANDS` later is
refused to a contributor until it is listed on purpose.

| Allowed | Why |
|---|---|
| `content.create`, `content.update`, `content.restoreVersion` | a writer drafts and edits; a translator restores a version |
| `content.previewToken`, `content.previewTokenRevoke` | a reviewer needs a draft link; revoke only withdraws one |
| `editorial.submit`, `editorial.withdraw` | hand a draft in for review, or take it back |
| `editorial.comment`, `editorial.commentResolve` | the review conversation |
| `editorial.requestChanges`, `editorial.seoSignoff` | the SEO reviewer's own decisions (Cerbos in the ERP still decides who) |
| `media.uploadToken` | M5-W1q (WSK-D84): a contributor may upload, INTO THE QUARANTINE: the token it mints quarantines what it uploads (see "The contributor upload quarantine") |

Refused with **`403 contributor-command-not-allowed`**: `content.publish`, `content.schedule`, `content.unpublish`, `content.delete`, `editorial.approve`,
`editorial.assign`, `editorial.policySet`, and the other media commands (`media.update`, `media.delete`, `media.review`). The body is the house's problem body, `application/problem+json`:
`{"type":"https://webdesk.gaiada.online/errors/contributor-command-not-allowed","title":"Command not allowed for a contributor","status":403,"detail":"A contributor may not run <command>. ... Nothing was changed."}`.
`schema.apply`, `key.*`, lifecycle, releases and promotion carry no editorial assertion, so a contributor cannot be expressed there (the ERP must never
route one); the two review reads carry none either. A contributor's idempotency record is its own (`__contributor` in the request hash) and its audit
row carries `contributor: true`.

**No contract, vocabulary or `contract.lock` version changed**: the editorial assertion is a control-channel header, not part of the delivery
contract or the composition vocabulary (unchanged; no vocabulary or `CONTRACT.lock` bump), and an optional claim is additive. **Deploy order: WebDesk first.** An older WebDesk ignores an unknown claim (the JWT convention), so it would treat a contributor's `xc` assertion as a staff one; the ERP's own walls still hold, but the third wall only exists once this verifier is live.

### Tests

`test/contributor-editor-principal.spec.ts` (no database: the claim, both resolvers, replay and expiry, the allow-list PIN over the whole registry, the
guard driven for every editorial command with signed assertions), `test/contributor-editor-enforcement.spec.ts` (real Postgres: each allowed command
succeeds with `xc`, each refused command is a valid 403 with nothing written and the same call as staff succeeds, a non-boolean `xc`, `xc` with `ce`,
replay, expiry), `test/editorial-assertion-vectors.spec.ts` v5 (shared byte for byte with the ERP signer's test).

## Content checks per site (M5-W3c, PROTOTYPED) — composition `lint.content`, vocabulary 1.3.0

The advisory editorial checks (`src/control/content/lint-rules/**`: one H1, meta lengths, alt text, sources, internal links, the ID twin,
answer-first, question headings, keyword placement, banned language, the AEO score) used to be tuned for gaiada.com only. A collection's
composition may now carry `lint.content`; WebDesk serves many sites, so each collection sets its own thresholds. **Vocabulary 1.3.0 is a
MINOR** (an optional key; the classifier computes it from `webdesk/delivery/test/fixtures/vocabulary-1.2.0.snapshot.json`, where `lint`'s
key set became a snapshot dimension, as `ui`'s did in 1.2.0). No migration: a composition is stored data (`collections.schema`).

- **Absent member or key = today's constants**, so a collection with no `lint.content` is byte-identical to before
  (`test/content-lint-site-settings.spec.ts` runs the fixtures through both paths and compares the JSON).
- **Validated at the composition write** (`schema.apply` -> `validateCollectionComposition`): unknown rule ids, unknown knobs, wrong types,
  out-of-range values and inverted min/max pairs are refused with a path, never ignored. The stored value is re-validated on resolve; an
  invalid stored value (only a hand-edited row) resolves to the defaults, wholesale, and never throws.
- **One resolution** (`resolveContentRulesFromComposition`, called inside `computeContentLint` and by the sign-off snapshot), so a save and
  `item.get` read the same settings (W3b's read == save invariant); `item.get` reflects the CURRENT composition.
- **Advisory**: no setting can make a save fail. A rule set `enabled: false` is skipped (not listed in `unavailable`); `aeo.enabled: false`
  gives `aeo: null`; `enabled: false` at the top removes the `content` member from the lint report (and from the sign-off snapshot).
- `question-headings.minShare`, `answer-first.*` and `aeo.shortParagraphMaxWords` also feed the AEO score, so they still apply to it
  when the finding rule itself is switched off. `id-twin.twin` and `banned-language.phrases` REPLACE the default maps.

| Key (under `lint.content`) | Type | Default (today's constant) | Allowed |
|---|---|---|---|
| `enabled` | boolean | `true` | |
| `longFormMinWords` | integer | `300` | 1..100000 |
| `h1Field` | field name | `"h1"` | `^[A-Za-z][A-Za-z0-9_]{0,63}$` |
| `primaryKeywordField` | field name | `"primary_keyword"` | same |
| `altFields` | field name[] | `["image_alt_texts"]` | <= 50 names |
| `rules.h1.enabled`, `rules.image-alt.enabled`, `rules.sources.enabled`, `rules.primary-keyword.enabled` | boolean | `true` | |
| `rules.meta.enabled` | boolean | `true` | |
| `rules.meta.titleMax` | integer | `60` | 1..1000 |
| `rules.meta.descriptionMin` / `descriptionMax` | integer | `120` / `155` | 0..1000, min <= max |
| `rules.internal-links.enabled` / `.min` | boolean / integer | `true` / `20` | min 0..10000 |
| `rules.id-twin.enabled` / `.twin` | boolean / `{lang: lang[]}` | `true` / `{en:["id"], id:["en"]}` | <= 20 languages, codes `[A-Za-z]{2,3}` |
| `rules.answer-first.enabled` / `.minWords` / `.maxWords` | boolean / integer | `true` / `40` / `60` | 0..1000, min <= max |
| `rules.question-headings.enabled` / `.minShare` / `.starters` | boolean / number / string[] | `true` / `0.3` / the 24 EN+ID starters | 0..1 / <= 200 entries of 1..120 chars |
| `rules.banned-language.enabled` / `.phrases` | boolean / `{lang: string[]}` | `true` / the 17 EN phrases | <= 20 languages, <= 200 phrases of 1..120 chars |
| `rules.aeo.enabled` / `.shortParagraphMaxWords` | boolean / integer | `true` / `80` | 1..10000 |

Not settings, on purpose: a "minimum sources" count and an "AEO warn level" do not exist in the rules today (sources.missing fires when a
paragraph quotes a percentage and the body cites nothing; the AEO score is shown, never thresholded), so there is no constant to expose.
Tests: `test/content-lint-site-settings.spec.ts` (no database), `webdesk/delivery/test/w3c-lint-content.test.mjs` (vocabulary suite), and
the DB-backed extension in `test/content-reads.spec.ts` ("per-site lint.content settings", needs the Linux gate).

## Public page path per collection (M5-W8b, PROTOTYPED) — composition `ui.routePattern`, vocabulary 1.4.0

A collection's composition may declare where its items are served on the public site: `ui.routePattern`, for example
`/blog/{slug}/` or `/{locale}/insights/{slug}/`. The writers dashboard (M5-W8) maps an item to its page with it to look up analytics and
Search Console figures. **Vocabulary 1.4.0 is a MINOR** (an optional key in the closed `ui` key set; the classifier computes it from
`webdesk/delivery/test/fixtures/vocabulary-1.3.0.snapshot.json`; a value edit inside a tenant contract is PATCH). No migration, no stored value changes.

- **Grammar** (refused at `schema.apply`, never ignored): starts with `/`; at most 200 characters; every segment is a literal of
  `[a-z0-9-]`, or exactly `{slug}` (required, once) or `{locale}` (optional, once); a trailing slash is allowed; no query, fragment, `..`,
  empty segment, uppercase, dot or in-segment token.
- **`pagePathFor(routePattern, { slug, locale, defaultLocale })`** (exported from the vocabulary, and from the copy vendored into
  platform-nest) fills it in and returns the path, or `null` for an invalid pattern or a slug/locale that cannot be a URL segment. For the
  tenant's DEFAULT language the `/{locale}` segment is left out (the site serves its default language at the root); a pattern without
  `{locale}` gives every language the same address.
- Tests: `webdesk/delivery/test/w8b-route-pattern.test.mjs` (`cd webdesk/api && node --import tsx ../delivery/test/w8b-route-pattern.test.mjs`).

## A/B variants: the `experiment` block (M5-V5-a, PROTOTYPED) — vocabulary 1.5.0

Design: `docs/plans/2026-10-12-m5-phase5-design.md` §5.1/§5.2. A new **block type**, `experiment`, lets an item carry an A/B test over its own fields or over one
of its generic blocks. **Vocabulary 1.5.0 is a MINOR** (`block type "experiment" added`; the classifier computes it from
`webdesk/delivery/test/fixtures/vocabulary-1.4.0.snapshot.json`). No migration (`blocks` is `jsonb` with no type CHECK), no new route, **the `/v1` envelope and the read SQL
do not change by a byte**: `/v1` serves the block as one more entry of `blocks`; an older consumer renders nothing for it (renderer invariant) and shows arm `a`, the control.

```jsonc
[ { "type": "fields", "props": { "heading": "Websites that win work" } },
  { "type": "experiment", "props": {
      "key": "home-hero-2026-11",                     // ^[a-z0-9][a-z0-9-]{2,47}$ (unique per property: the ERP enforces that, V5-c)
      "target": "fields",                             // or { "block": 2 }: a generic block by index
      "enrolment": "consented",                       // "consented" (default) | "all"
      "goal": { "event": "lead_form_start", "match": { "form_id": "contact" } },
      "arms": [ { "key": "a", "weight": 50 },         // arms a-d in order, 2 to 4; a is the control and never overrides
                { "key": "b", "weight": 50, "override": { "heading": "Your next client is searching now" } } ] } } ]
```

- **Write-time rules** (`validateItemContent` -> `validateExperimentBlock`, `delivery/vocabulary/item-fields.ts`): allowed in every collection without being listed (a composition
  that lists it in `blocks` is refused), at most one per item, never at index 0; props closed; integer weights >= 10 summing to 100; `goal.event` one of
  `generate_lead, lead_form_start, cta_click, click_whatsapp, click_phone, click_email, section_view`, `goal.match` at most one of `form_id, link_location, section_id`
  (`[A-Za-z0-9_.:-]{1,64}`); `target:"fields"` needs a collection that declares fields, every other arm's `override` names declared fields only and `{...fields, ...override}`
  passes the field rules (an issue is reported at the arm's own path, never on the control); `target:{block:i}` needs `blocks[i]` to be a generic block and every other arm's `replace`
  to be a block of the same type that passes `validateBlock`.
- **The publish lock: 409 `experiment-locked`.** An item whose **live** version carries an experiment has a running test (the test starts when the version carrying the block is
  published, so the live version IS the running state: no ERP flag is needed, and V5-c's `started_at` is just that publish). `content.publish`, and `content.schedule` with a `publishAt`,
  refuse (for every principal, the whole batch, before any effect) a version that changes the experiment, or changes a control value it overrides: the values of every field any
  arm overrides (`target:"fields"`), or the whole block under test (`target:{block}`). Everything else may change. **Removing the block (the stop), with or without the winner merged into `fields`,
  is always allowed**, and drafts may be edited freely (only a publish is locked). The comparison is the vocabulary's own `experimentLockViolations`; the guard is `assertExperimentNotLocked` in
  `control/content/content-commands.service.ts`. NOT covered: a due version swap executed by the scheduler (it was checked at schedule time and any publish cancels it) and `promotion import`.
- **Never client-editable.** An experiment block is refused to a client editor whatever the collection's `ui.clientEditable`: `isClientEditable(composition, pointer, [blocksBefore, blocksAfter])`
  answers false for any pointer into a block that is an experiment in either version, and `clientEditViolations` / `clientCreateViolations` always pass both sides, so adding, changing or
  removing it is 422 `field-not-client-editable` (create and publish by a client likewise). A caller without the content (a UI deciding whether to draw an input) gets the structural answer, as before.
- **Search**: `search-text.ts` skips a top-level `experiment` block, so `/v1` search indexes only the control.
- **Contract codegen** (`codegen/generator/openapi-builder.mts`): one shared `ExperimentBlock` component schema; every collection's item and list-item `blocks` allow it (a union branch; for a closed
  fields-only collection an `anyOf` of the two EXACT tuples `[FieldsBlock]` / `[FieldsBlock, ExperimentBlock]`, never one `[F, E]` tuple, which would make the block REQUIRED in the generated SDK type).
  `CONTENT-CONTRACT.md` gains a short section. Tenant contracts regenerate as MINOR (the SDK type is a superset).
- **Schema drafting**: the prompt tells the model never to put `experiment` in `blocks` (`schema-draft/prompt.ts`).
- **Renderers**: `webdesk/blocks` registers it as known and non-visual (`NON_VISUAL_BLOCK_TYPES`); the PHP theme (`webdesk/wordpress`, `webdesk/templates/wp`, and the generated copy in `ai-agents`)
  lists it and draws nothing.
- Tests: `webdesk/delivery/test/v5a-experiment.test.mjs` (100 checks, no database: `cd webdesk/api && node --import tsx ../delivery/test/v5a-experiment.test.mjs`); `test/codegen-openapi-builder.spec.ts`
  and `test/codegen-sdk-typecheck.spec.ts` (the generated SDK compiles, additive); `test/content-helpers.spec.ts` (search text); and the DB-backed `test/experiment-block.spec.ts` (publish lock, client editors,
  `/v1` serving; **needs the Linux gate**).
