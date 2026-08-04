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

---

## 6 · The Keycloak oracle now EXECUTES — recipe + evidence (2026-08-04)

§4's second hard sub-AC was *"the Keycloak oracle must execute, not skip"*. It skipped. It no longer
has to, and this is the exact recipe — recorded because the failure mode is silent: without
`KEYCLOAK_OAUTH_TEST=1` **and** a reachable issuer **and** `GOOGLE_DEV_CLIENT_SECRET`,
`google-oauth-keycloak.test.ts` reports a clean pass having run **nothing**.

### Evidence (pre-refactor baseline, so the refactor has something to be compared against)

| Run | Result |
|---|---|
| `npx vitest run src/modules/search/google/ --maxWorkers=4` | **120 passed / 4 skipped** — the 4 were this oracle |
| the oracle, enabled per below | **4 passed / 0 skipped** — real auth-code+PKCE round trip · refresh with ROTATION (chain of 3) · RFC-7009 revocation WITH client auth |

### Recipe

```sh
# 1. The dedicated test DB + Cerbos. These do NOT come back after a Docker restart, and test-pg needs
#    ~5 min of WAL recovery afterwards — until then every suite dies with "the database system is
#    starting up", which looks like a code failure and is not one.
docker start gaiada-test-pg gaiada-test-cerbos     # publish 55433 / 3592 = what platform-nest/.env wants
docker exec gaiada-test-pg pg_isready -U postgres  # poll until ready

# 2. A REAL Keycloak issuer, standalone. Deliberately NOT the compose `auth` profile:
#    - that service depends_on `postgres`, and the dev Postgres can be hours into an fsync after an
#      unclean shutdown (it was, here — fallout from the 615-orphan-test-database incident);
#    - it passes `KC_PROXY_HEADERS: ${KC_PROXY_HEADERS:-}`, and Keycloak 26 REFUSES to boot on an
#      empty value ("Expected values are: forwarded, xforwarded"), crash-looping. That var is set on
#      the server, so this only bites a local bring-up.
#    The oracle asserts nothing about Keycloak's persistence, so the embedded DB is sufficient.
#    MSYS_NO_PATHCONV=1 is required on Git Bash or the CONTAINER path is rewritten to a Windows one
#    and the realm mount silently lands somewhere else (the import then never happens).
MSYS_NO_PATHCONV=1 docker run -d --name gaiada-kc-oracle -p 127.0.0.1:8080:8080 \
  -e KC_BOOTSTRAP_ADMIN_USERNAME=admin -e KC_BOOTSTRAP_ADMIN_PASSWORD=admin \
  -v "<abs>/infra/compose/keycloak:/opt/keycloak/data/import:ro" \
  quay.io/keycloak/keycloak:26.0 start-dev --import-realm

# Verify with -f: `curl -s -o /dev/null` exits 0 on a 404, so a readiness loop without -f reports
# "up" for a realm that was never imported. Confirm the log line "Realm 'gaiada' imported".
curl -fs http://localhost:8080/realms/gaiada/.well-known/openid-configuration

# 3. The realm JSON carries only gaiada-platform + gaiada-ui and ZERO users, so both are needed:
cd infra/compose/keycloak
KC_URL=http://localhost:8080 KEYCLOAK_ADMIN_PASSWORD=admin GOOGLE_DEV_CLIENT_SECRET=google-dev-secret \
  python provision-google-dev-client.py
KC_URL=http://localhost:8080 KEYCLOAK_ADMIN_PASSWORD=admin DEV_USER_PASSWORD='Passw0rd!' \
  python provision-dev-users.py      # creates owner@gaiada-creative.test, the oracle's KC_TEST_USER

# 4. Run it. Confirm the output says 4 passed — NOT "4 skipped".
KEYCLOAK_OAUTH_TEST=1 GOOGLE_DEV_CLIENT_SECRET=google-dev-secret KC_URL=http://localhost:8080 \
  SEARCH_ALLOW_PRIVATE_GOOGLE_ENDPOINT=1 \
  npx vitest run src/modules/search/google/google-oauth-keycloak.test.ts --maxWorkers=4
```

**What this does and does not prove**, restating the provisioning script's own warning so it is not
lost: a green round trip validates OUR OAuth machinery against a real issuer that enforces PKCE and
client authentication. It does **not** validate the Google integration — that still needs a real
Google client (OQ-9 / SM-41G).

---

## 7 · Landed 2026-08-04 — what changed, and the one design correction

The promotion is in. `google_oauth_states` is a core table (**migration 0076**, renumbered from the
staged `0070` after re-verifying the head — five migrations landed while this sat parked), the state
machine and token client live in `src/core/google-oauth/`, and the old paths are re-export shims so no
search call site or probe assertion changed.

### THE CORRECTION — the module gate needs BOTH halves, and the first draft only had one

The re-spec said the per-row `module` column replaces `0060`'s hard-coded
`app_module_allowed('search')`, and that the `{modules:['search']}` option on `withTenants` could
therefore be dropped. **Dropping it broke every write immediately** — `new row violates row-level
security policy` on every INSERT — and the reason is the important part:

`app_module_allowed(mod)` (migration 0028) reads the **REQUEST-DECLARED `app.scopes` GUC**. It is *not*
a lookup of which modules a company has enabled. So the row's `module` and the request's declared module
scope must **MATCH**. The gate is a two-sided handshake, not a row property:

- a surface that stamps `module:'search'` must keep declaring `{modules:['search']}` on every read and
  write of its own rows — that is what makes 0060's wall byte-equivalent after the promotion;
- a core surface stamps `module: null`, declares nothing, and its rows carry no module requirement.

That is why `consumeAuthorizationState` takes `module` as an **expectation** rather than reading it off
the row: the row cannot be read at all without declaring the scope first, which is the whole point. A
caller declaring the wrong module (or none, for a module row) matches zero rows and receives the same
coarse `unknown_or_expired` as a forged state — it must not be able to distinguish "exists but not
mine" from "does not exist". One `moduleScope()` helper expresses the rule at all four call sites so
they cannot drift.

Worth stating plainly: the failure mode of getting this wrong in the *safe-looking* direction — dropping
`module` from the ROW — is silent, and would have deleted search's third wall in a refactor. Getting it
wrong the other way fails loudly on the first INSERT. The loud one is the one that happened.

### A second consequence the type system caught

Widening the provider union with `google_drive` meant `isGoogleProvider` started admitting it — and
search's two request-boundary validators used that guard while their error messages promised only
search's three providers. They would have silently accepted a Drive value. Both now use a new
`isSearchGoogleProvider`, and search's provider-keyed records (`DEFAULT_SCOPES`,
`PROPERTY_BINDING_COLUMN`) are keyed by `SearchGoogleProvider`, so a Drive provider can no longer reach
a property-binding column even in principle. The search adapter also *proves* a consumed row is a
search row rather than assuming it.

### Evidence

| Check | Result |
|---|---|
| Google suite, pre-refactor baseline | 120 passed / 4 skipped |
| Google suite, post-refactor | **120 passed / 4 skipped — identical** |
| Keycloak oracle (executing, not skipped) | **4 passed** — auth-code+PKCE · refresh WITH rotation · RFC-7009 revocation |
| Module gate BOTH ways (new, `core/google-oauth/module-gate.db.test.ts`) | **5 passed** — core surface completes with no scope declared; the positive control proves a `module='search'` row is unreachable without the scope, and reachable with it; a *different* module does not work either |
| Negative control on that gate | stamping `module: null` on the row (the "simplify it away" defect) **reds 3 of the 5**, so the gate is load-bearing, not decorative |
| `tsc`, `lint:withtenants`, `lint:migration-rls` | clean |

The two probe files were edited **only** as the amended AC permits: 8 + 6 table-identifier references,
14 lines total, no assertion, probe or expected value touched. Neither names the state table's
`client_id`/`property_id`, so no column edit was needed at all.

### A third consequence: an egress-inventory row became a lie

SM-39's `modules/search/egress-inventory.test.ts` listed `google/token-endpoint-client.ts` as approved
outbound egress and asserted it referenced `config.search.google`. After the move that path is a 4-line
shim: no network call, no config reference. Three of its assertions failed — correctly.

Deleting the row would have quietly retired a security control during a refactor. Instead the guarantee
**moved with the code**: new `core/google-oauth/egress.test.ts` pins the same two properties for
`core/google-oauth/` (exactly one file originates outbound calls; it reads its own `config.google` and no
foreign vendor namespace), and the search inventory now carries a comment saying where the egress went
and what to do if more network code leaves the module.

Worth recording because the new test caught a defect in ITSELF on first run: my detector matched only
`fetch(`, and the token client actually does `const doFetch = fetchImpl ?? fetch` then calls `doFetch(...)`.
It reported **zero** egress in the one file that has it — passing its own allowlist while proving nothing,
the precise failure mode the suite exists to prevent. The "a stale allowlist row is a lie" assertion is
what surfaced it; the detector now matches any callee ending in fetch/Fetch plus the `?? fetch` idiom, and
strips `typeof fetch` so a type-only reference is not counted as an outbound call.

### Still open (not in this ticket)

- The **core callback controller** at `api/integrations/google/callback` and webdev's Drive surface
  registration — that is WD-23A-2, which needs a real Google client (OQ-9). Search's own callback is
  untouched and still serves its existing path.
- One brief item was already done and its note is stale: §3 says `.env.example` lacks
  `INTEGRATION_TOKEN_KEY` ("absent — verified"). It is present, and already documents that the key
  derives the OAuth state signature.
