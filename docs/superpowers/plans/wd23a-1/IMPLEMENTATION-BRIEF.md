# WD-23A-1 — implementation brief (design settled, code move outstanding)

**Companion to** [`../2026-08-01-wd23a-respec.md`](../2026-08-01-wd23a-respec.md) · **Date:** 2026-08-01

Everything in §1–§4 below was **verified against the tree**, not inferred. The implementer should not
re-derive any of it. What remains is the file move itself, which is large but mechanical.

> ### ⚠️ Read this first: the staged migration is deliberately NOT in `migrations/`
> `0070_core_google_oauth_states.sql.staged` sits in **this folder**, not `platform-nest/migrations/`,
> and must stay here until the code move in §3 is complete. Reason: the migration runner executes the
> **whole directory** in sorted order, and this migration `DROP`s `search_google_oauth_states`. Dropped
> in front of code that still writes to that table, it breaks every SEO Google flow on the next
> `migrate`. Move it into `migrations/` as the **last** step, re-verifying the ledger head first
> (it was `0069` on 2026-08-01; it drifted 20 slots in two days, so **verify, never inherit** — the
> Phase-3 plan's own LD-1).

---

## 1 · Verified facts (do not re-check)

| Fact | Evidence |
|---|---|
| Vault already accepts Drive | `0033_integration_connections.sql:40` CHECK lists `google_drive`; `:38` allows `owner_kind='user'` ⇒ **no vault DDL anywhere in WD-23A** |
| The only thing rejecting Drive | `0060_search_google_oauth_states.sql:64` provider CHECK |
| Module wall lives in the TABLE, not authz | `0060:106` policy hard-codes `app_module_allowed('search')`; `core/http.ts:13` `authorize()` is Cerbos-only and does **not** enforce module-enabled ⇒ dropping the table gate without replacement **would be a silent security regression**. Hence the staged migration's per-row `module` column. |
| The FK was never the tenant protection | `google/oauth.ts` (`bindPropertyConnection` header): *"FK checks run as the table owner, OUTSIDE RLS"* ⇒ replacing `client_id`/`property_id` FKs with polymorphic columns costs no tenant safety |
| State rows are ephemeral | 10-min TTL (`GOOGLE_OAUTH_STATE_TTL_SECONDS`, default 600) + the consume predicate itself refuses expired rows ⇒ **replace, never backfill** |
| Ledger head | `0069_report_module_roles.sql` (2026-08-01). `0058`/`0059` are the reports program's permanently-orphaned gaps — **do not fill** |
| Callback route today | `GET api/search/google/oauth/callback` (`search-google-oauth.controller.ts:61`) |
| No redirect URI registered with Google yet | `infra/compose/.env` holds no Google credential ⇒ choosing the core callback path is **free today** |

## 2 · The one thing `google/` does that the re-spec under-specified

The callback runs a **surface-specific Cerbos check** after the signature verifies —
`resource_search_property` + `update` (`search-google-oauth.controller.ts:96`), documented in that
file's header point 4 as defence-in-depth (it refuses a principal whose role was revoked *after*
starting the flow).

A shared core callback cannot hard-code that. **The surface registry must therefore carry the authz
check as a declared field**, not just scopes:

```
GoogleSurface = {
  provider:   'google_search_console' | … | 'google_drive'
  module:     string | null      // stamped onto the state row -> the per-row RLS gate
  scopes:     string[]           // DEFAULT_SCOPES for this surface
  authz:      { kind: string; action: string }   // post-signature defence-in-depth check
  ownerKind:  'user' | 'company' | 'client'
  onLinked?:  (tenantId, bindTargetId, provider, connectionId) => Promise<void>
}
```

- search registers 3 surfaces: `module:'search'`, `ownerKind:'client'`,
  `authz:{kind:'resource_search_property',action:'update'}`, and `onLinked` = the existing
  `bindPropertyConnection` — which is how `propertyId` / `PROPERTY_BINDING_COLUMN` /
  `search_properties` leave the core flow and stay in search, where they belong.
- webdev registers `google_drive`: `module:null`, `ownerKind:'user'`, scopes
  `drive.readonly` + `drive.file`, `authz:{kind:'resource_integration_connection',action:'update'}`
  (that policy already exists and already carries the exec carve-out), no `onLinked`.

## 3 · File plan

**Moves to `src/core/google-oauth/` (core must not import from `modules/`):**

| New core file | From | Notes |
|---|---|---|
| `hosts.ts` | `google/google-hosts.ts` | pure, move verbatim |
| `token-endpoint-client.ts` | `google/token-endpoint-client.ts` | pure HTTP; **not yet read by me** — the only file in this plan still needing a read before moving |
| `errors.ts` | OAuth-generic subset of `google/errors.ts`: `GoogleSurfaceError`, `GoogleOAuthNotConfiguredError`, `GoogleOAuthStateError`, `StateFailureReason`, `GoogleTokenEndpointError`, `GoogleApiError`, `GoogleConnectionNotLinkedError` | **stays in search:** `GooglePropertyNotBoundError`, `GoogleAdsCustomerNotLinkedError`, `GoogleAdsNotConfiguredError` (all search-specific), extending the core base class |
| `registry.ts` | new | §2 above |
| `state.ts` | `google/oauth-state.ts` | `GoogleProvider` union → registry-driven; table → `google_oauth_states`; `client_id`→`owner_kind`/`owner_id`; `property_id`→`bind_target_id`; stamp `module`; **drop the `{modules:["search"]}` option** (the gate is now the row's `module` column) |
| `flow.ts` | `google/oauth.ts` §§1–6 **minus** `PROPERTY_BINDING_COLUMN` / `resolvePropertyConnection` / `bindPropertyConnection` | `propertyId` → `bindTargetId`; post-link binding → `surface.onLinked` |

**Stays in / returns to search:** `api-client.ts`, `gsc-client.ts`, `ga4-client.ts`, `ads-client.ts`,
`freshness.ts`, `endpoint-guard.ts`, and a new `google/property-binding.ts` holding the three
property-binding exports + the search surface registrations.

**Shim layer — this is what makes the existing tests pass:** `google/oauth.ts`, `google/oauth-state.ts`,
`google/errors.ts`, `google/google-hosts.ts` become thin re-export files. Every current importer
(`search.controller.ts:94`, `search-google-ads.controller.ts`, `sem-executor-google-ads.ts:124-125`,
`search-google-oauth.controller.ts:58-59`, and 5 test files) then resolves unchanged.

**Controllers:** new core `GoogleOauthCallbackController` at `api/integrations/google/callback`
(provider → registry → `surface.authz` → `completeAuthorization`). Keep
`SearchGoogleOauthCallbackController` as a **permanent thin alias** delegating to it — load-bearing,
because `search-google-oauth.controller.test.ts:137,220` inject that exact path.

**Config:** `config.search.google` → `config.google`, with `config.search.google` kept as an alias
property. Env var **names** unchanged; only `GOOGLE_OAUTH_REDIRECT_URI`'s *value* moves to the core
path. Also fold `readConnectionSecrets` (`google/oauth.ts:281`) into
`core/integrations.service.ts` beside `readAccessToken` — discharging that file's own
`TODO(follow-up)` at `oauth.ts:14-19`.

**`.env.example`:** add `INTEGRATION_TOKEN_KEY` (absent — verified). It now gates OAuth **state-mint**,
not just token-sealing, because the state HMAC key derives from it (`oauth-state.ts:84-88`), so a fresh
box fails earlier than the stale note in the Phase-3 plan implies.

## 4 · Acceptance — and one honest amendment to the re-spec's own AC

The re-spec's controlling AC was *"the entire existing search Google suite passes **unmodified**."*
**That cannot hold literally, and pretending otherwise would be the dishonest kind of green.** Two test
files issue direct SQL against the table by name:

- `google/google-oauth-adversarial-qa.test.ts` (~6 references — forces expiry, forces consumption)
- `google/google-oauth.sandbox.test.ts` (~6 references)

**Amended AC:** in those two files the **table identifier is the only permitted edit**
(`search_google_oauth_states` → `google_oauth_states`, plus `client_id`→`owner_id` /
`property_id`→`bind_target_id` where a probe names a column). **Not one assertion, not one probe, not
one expected value may change.** Every other Google test file must pass byte-unmodified apart from
import paths. Any further edit is a behaviour change and must be justified line-by-line in the
evidence doc or reverted.

Two hard sub-ACs carried from the re-spec:

1. **Prove the module gate both ways.** A tenant with `search` **disabled** completes a `google_drive`
   link end-to-end, **and** the same tenant still reads zero rows for a `google_search_console` state
   (the positive control). Without the control this asserts nothing — *correct-but-unwired is
   indistinguishable from absent*, a pattern this estate has hit six times.
2. **The Keycloak oracle must execute, not skip.** `google-oauth-keycloak.test.ts` silently skips
   without `KEYCLOAK_OAUTH_TEST=1` **plus** `GOOGLE_DEV_CLIENT_SECRET` (from
   `GET /admin/realms/gaiada/clients?clientId=google-dev/client-secret`). Evidence must show it ran,
   with counts — a silent skip lands the refactor with its strongest oracle switched off.

**Test-env reminders** (from the SEO programme, cost real time twice): search suites need
`DATABASE_URL_TEST` (gaiada-postgres on host port **55433**), `CERBOS_URL`, `REDIS_URL`, a distinct
`TEST_DB_PREFIX`, and `--maxWorkers=4` (default concurrency exhausted PG shared memory and dropped the
container into WAL recovery). Also: `platform-nest` runs a compiled `dist/` image with **no source
bind-mount** — a live 500 on a brand-new endpoint is usually a stale image, not a bug; rebuild and
recreate with **both** compose files or `:3004` gets unpublished.

## 5 · Order of work

1. Read `google/token-endpoint-client.ts` (the one unread file).
2. Create `src/core/google-oauth/` (`hosts` → `errors` → `registry` → `token-endpoint-client` →
   `state` → `flow`).
3. Search-side: `property-binding.ts` + surface registrations + the 4 shim files + the search-specific
   error subclasses.
4. Core callback controller + search alias; register both in `app.module.ts`.
5. `config.ts` (+ alias), `core/integrations.service.ts` fold, `.env.example`.
6. `tsc` → fix import fallout → mechanical table-identifier edits in the two probe files.
7. **Last:** `git mv docs/superpowers/plans/wd23a-1/0070_core_google_oauth_states.sql.staged
   platform-nest/migrations/0070_core_google_oauth_states.sql` after re-verifying the ledger head, then
   `npm run lint:migration-rls` + apply to the dev DB.
8. Full `platform-nest` suite. Baseline: the 3 `search-notifications.test.ts` `REDIS_URL not set`
   failures are **pre-existing and SEO-owned** — do not chase them.
