# webdesk/payload — Payload 3 vendored + rebranded (WSK-02)

Status: **PROTOTYPED**. Boots against a real Zone B-shaped Postgres, stores/serves items through
the tenancy mechanism, and the GraphQL/raw-REST/admin lockdown is grep-provable and test-covered.
Not the WSK-04 RLS wall itself (that ticket owns the full cross-tenant probe suite and the
CI RLS-integrity gate across every tenant table) — this ticket ports the mechanism and proves one
collection end-to-end.

**One item is explicitly CANNOT-VERIFY, not silently passed:** the admin panel's SSR first paint
(the P10 path) does not show a freshly tenant-scoped row in this ticket's testing, even with the
`globalThis`-anchored AsyncLocalStorage applied. See "The tenancy mechanism" and "admin SSR
(P10) — what was actually found" below for the full, reproduced evidence trail. Local API and
REST — the two paths WSK-06's future `/v1` envelope and every client site will actually use — are
both cleanly PASS.

This is **not** `webdesk/spike-rls/payload/` (the WSK-00 spike, frozen evidence — do not edit).
This directory is the real service WSK-02 builds, informed by that spike's FINDINGS.md.

## Internal vs public listener (WSK-D20 lockdown)

Two separate Node processes, on purpose:

| Process | Entry point | Carries |
|---|---|---|
| **Internal listener** | `next dev`/`next start` (`npm run dev:internal` / `start:internal`), reading `payload.config.ts` + `app/(payload)/**` | Admin panel, Payload's generic/unscoped collection REST (`/api/<collection>`). GraphQL is wired nowhere (no route file exists) and is additionally disabled at the framework level (`graphQL: { disable: true }` in `payload.config.ts`). |
| **Public listener** | `src/public-gateway.mjs` (`npm run gateway`) | A hardcoded denylist blocks `/admin`, `/api/graphql`, and `/api/*` unconditionally, before anything else runs. An allowlist (`/healthz`, `/v1/*`) is what may proxy through to the internal listener. `/v1` does not exist yet (WSK-06); today the allowlist effectively serves only `/healthz`. |

**The public listener imports neither `payload` nor `next`.** It is not "REST disabled by
middleware" — it is a process with no code path that could reach those routes even if the
denylist array were deleted, because nothing in the file wires to them. That is what makes the
lockdown structural rather than configuration-dependent.

### GraphQL lockdown — three independent layers

1. `payload.config.ts`: `graphQL: { disable: true }` — disabled at the framework level.
2. No `app/(payload)/api/graphql/route.ts` (or `graphql-playground`) exists anywhere in this
   project — nothing wires `@payloadcms/next/routes`' `GRAPHQL_POST`/`GRAPHQL_PLAYGROUND_GET`.
   `grep -rn "GRAPHQL_POST\|graphql-playground" app/` returns nothing.
3. The public gateway's denylist additionally blocks `^/api/graphql(/|$)` even though, per (1)
   and (2), nothing would answer it on any listener regardless.

### Raw/unscoped REST lockdown

- Internal listener: `app/(payload)/api/[...slug]/route.ts` — Payload's real, working collection
  REST. This is intentional; the admin panel's own client-side fetches (search, pagination, save)
  go through it, same as the WSK-00 spike's P9-proven pattern.
- Public listener: `^/api(/|$)` is in `DENYLIST_ALWAYS`, checked before the allowlist, on every
  request. Grep-provable: `grep -n "DENYLIST_ALWAYS\|ALLOWLIST" src/public-gateway.mjs`.

### Admin lockdown (design §11/D-5: "never public")

Same shape as REST: `/admin` exists only on the internal listener; the public listener's
denylist blocks `^/admin(/|$)` unconditionally.

### Proving it — `test/lockdown.test.mjs`

Boots the internal Next.js app and the public gateway as real child processes against a live
Postgres, then asserts (this is the test the ticket's AC calls for — "add a test that fails if
either is exposed"):

- `GET  <public>/admin` → 404, never proxied
- `GET  <public>/api/pages` → 404, never proxied
- `POST <public>/api/graphql` → 404, never proxied
- `GET  <public>/healthz` → 200
- `GET  <internal>/api/graphql` → **not** 200 with a GraphQL response (proves layers 1+2 above:
  the route does not exist internally either — the public gateway isn't the only thing standing
  between an attacker and it)
- `GET  <internal>/admin` → reachable (200/302; the internal listener is not the thing under
  test — the point is proving the split exists, not that the internal app is broken)

Run: `npm run test:lockdown` (needs `DATABASE_URI` pointed at a Postgres with the schema already
pushed + RLS'd — see "Local verification" below).

## The tenancy mechanism (ported from WSK-00's FINDINGS.md)

`src/tenant-pg.mjs` subclasses `pg.Pool` and passes it through `postgresAdapter({ pg })`'s own
documented, typed `pg` option — not a patch of `@payloadcms/db-postgres`. On every checkout
(covers both the promise form `drizzle.transaction()` uses for create/update/delete, and the
callback form `pg-pool`'s own `query()` uses for plain `find`) it stamps
`set_config('webdesk.tenant_ctx', tenantId ?? '', false)` from Node's AsyncLocalStorage; on
release it resets to `''` before the connection is visible to the next borrower. This is the
SESSION strategy pushed down to the one place every operation must pass through, exactly as
FINDINGS.md describes — no mechanism change from the spike.

**The one change from the spike:** `src/tenant-pool.mjs` anchors the AsyncLocalStorage instance
on `globalThis` instead of a plain `export const`. FINDINGS.md's P10 section found the admin SSR
page's initial data load did not see the GUC, root-caused it to Next.js's App Router duplicating
the plain ES-module singleton across build "layers" (Route Handlers vs Server Components), and
named the `globalThis` anchor as a plausible, untested fix — explicitly left untested there
because layer 1's file was frozen for that ticket. This project's `tenant-pool.mjs` is a new file
(not an edit to the frozen spike), and `test/boot-rest-admin.test.mjs` drives the admin SSR path —
the exact path P10 found broken — to check whether the anchor actually closes the gap.

### admin SSR (P10) — what was actually found (CANNOT-VERIFY, not silently closed)

Diagnostic instrumentation was added directly to `app/(payload)/admin/[[...segments]]/page.tsx`
(logged, observed, then reverted — the same discipline FINDINGS.md's own P10 investigation used),
and it settled two separate questions:

1. **The `globalThis` anchor itself works.** `tenantStore.getStore()` reads back the correct
   tenant id at every point inside this file's own execution, including immediately before
   calling `RootPage(...)`. This is the exact thing the anchor was meant to fix, and it does — the
   cross-Next.js-layer module duplication P10 diagnosed is closed.
2. **A second, previously-undocumented issue sits on the same surface.** Payload's list view
   throws Next's internal `NEXT_REDIRECT` on a bare `/admin/collections/pages` request whenever
   the SSR request's auth cookie is not accepted — the same CSRF/Origin requirement FINDINGS.md
   documents for REST (`extractJWT` needs an `Origin` header or `Sec-Fetch-Site`; a real browser
   navigation sends these automatically, a script must set them explicitly). Adding `Origin` to
   the test request stops that redirect from firing. **Even with the redirect gone, a row freshly
   created via REST for the same tenant, in the same test run, still did not appear in the
   rendered list.** Instrumentation showed execution reaching the point immediately before
   `RootPage(...)` correctly tenant-scoped, but neither a "resolved OK" nor a "threw" diagnostic
   placed immediately after `await RootPage(...)` ever printed for that specific request —
   meaning whatever happens inside `RootPage`'s own rendering after that point could not be
   pinned down further inside this ticket's time-box.
3. **Ruled out as explanations, with direct evidence, before stopping:** RLS itself (REST against
   the identical row, same tenant, same process, correctly returns it — `totalDocs` and the row
   both present); a missing/wrong tenant cookie (confirmed correct via the diagnostic); the FIRST
   render of `page.tsx` running twice (confirmed it runs exactly once per request via a log-count
   check); and a bare "shows literally nothing ever" (older rows from earlier test runs verifiably
   do render in some passes — ruled out as a full-render crash, though this observation later
   turned out to double as a red herring: some earlier "it's showing content" readings in this
   investigation were actually React Server Components' dev-mode console-replay channel
   (`self.__next_f.push(...)`) echoing THIS FILE's OWN diagnostic strings into the HTML, not real
   list content — worth naming so a future investigator doesn't repeat that specific
   misinterpretation).

**Practical scope of the gap, restated honestly:** Local API and REST — the two paths this
ticket's own tests, WSK-06's future `/v1` envelope, and every real client site actually use — are
both cleanly PASS with fail-closed cross-tenant behavior proven (`test/boot-local-api.test.mjs`,
`test/boot-rest-admin.test.mjs`). Only the admin panel's very first, server-rendered paint of a
collection list carries this open question forward — the same practical-scope note FINDINGS.md
already made about P10 ("admin's interactive behaviors — search, pagination, save — go through
the same REST route P9 already proved") still applies; this finding narrows what's still open on
that one surface rather than reopening what REST already answered.

## Dev-push safety (the FINDINGS.md addendum hazard)

An **ordinary** dev boot with `PAYLOAD_ALLOW_PUSH=true` disables row security
(`relrowsecurity=false`) and drops the `tenant_isolation` policy on every table Payload pushes,
while leaving `relforcerowsecurity=true` — the table still *looks* protected to a check that only
inspects the FORCE flag. Reproduced twice against the WSK-00 spike; not a hypothetical.

This project makes that impossible to trigger by accident:

- `payload.config.ts` requires **two** environment variables, both true, before `push` is passed
  to `postgresAdapter`: `PAYLOAD_ALLOW_PUSH=true` **and**
  `PAYLOAD_ALLOW_PUSH_I_UNDERSTAND_THIS_DISABLES_RLS=true`. The exact combination FINDINGS.md
  calls "an ordinary dev boot" — `PAYLOAD_ALLOW_PUSH=true` alone — now does **nothing**; it only
  prints a warning and push stays off.
- Push is additionally gated on `NODE_ENV !== 'production'`. There is no environment variable
  combination that enables push when `NODE_ENV=production`.
- Neither flag is set anywhere in this project's own files, defaults, or scripts, except
  transiently inside `scripts/setup-schema.mjs`, which sets both for the duration of one push and
  then, as its unconditional last step, re-applies FORCE RLS + the policy and verifies all three
  RLS facts (`relrowsecurity`, `relforcerowsecurity`, `policy_count >= 1`) before exiting non-zero
  on failure. That script is the ONLY sanctioned way to push against this project's schema.
- **This is an interim mitigation for this ticket's one collection, not the permanent answer.**
  WSK-04 owns deciding how RLS survives Payload owning the schema for every future collection and
  every future boot (a migration that reapplies the policy after every schema operation, or
  forbidding push entirely against any database that matters) — see FINDINGS.md's addendum,
  "Consequence for WSK-04."

## Local verification (what was actually run for this ticket — see the ticket report for output)

1. A fresh, throwaway Postgres container (NOT the WSK-00 spike's `:55432`, NOT infra's `:55434`),
   initialized with this project's own `../postgres/init-roles.sh` (unmodified) to get the real
   `webdesk_owner` / `webdesk_migrator` / `webdesk_app` role split, then `../migrations/0001-0004`
   applied via `../migrations/migrate.mjs` (unmodified) as the migrator role — the same real
   platform-core schema WSK-03 ships, so Payload's tables share a database with tables it does
   not own, matching the shared-instance model (WSK-D16).
2. `OWNER_URI=... node --import tsx scripts/setup-schema.mjs` — pushes `pages`/`users`, then
   FORCE-RLS + policy + grants.
3. `PAYLOAD_INTERNAL_PORT=... DATABASE_URI=<app role> npm run dev:internal` — boots the internal
   listener with push **disabled** (the app role cannot push anyway — it lacks CREATE).
4. `PAYLOAD_PUBLIC_PORT=... PAYLOAD_INTERNAL_PORT=... npm run gateway` — boots the public
   listener.
5. `npm run test:boot` — Local-API + REST create/read round-trip, cross-tenant isolation, and the
   admin-SSR-first-paint check (the P10 path).
6. `npm run test:lockdown` — the GraphQL/REST/admin unreachability proof.
7. An egress check during boot (see the ticket report) — no external network calls beyond the
   Postgres connection itself; `telemetry: false` is set in `payload.config.ts`.

## Required changes to files outside `webdesk/payload/` (reported, not applied — out of scope)

- `webdesk/docker-compose.yml`'s `payload` service is currently a placeholder single process on
  one published port (`WEBDESK_PAYLOAD_PORT`). The real service needs **two** processes/ports:
  the internal listener (never published to the public proxy vhost — reachable only inside the
  compose network, or via the office-IP-allowlisted admin vhost per design §11/D-5) and the
  public gateway (the only one Caddy's public vhost should ever forward to). This ticket does not
  edit `docker-compose.yml` per the hard constraint that file is out of scope; whoever wires the
  real compose service should split it into two service entries (e.g. `payload` for the internal
  listener, `payload-gateway` for `src/public-gateway.mjs`) or run both processes in one
  container and publish only the gateway's port.
- `webdesk/.env.example` has no env vars yet for `PAYLOAD_INTERNAL_PORT`, `PAYLOAD_PUBLIC_PORT`,
  or `PAYLOAD_ALLOW_PUSH_I_UNDERSTAND_THIS_DISABLES_RLS`. Also out of scope for this ticket.
