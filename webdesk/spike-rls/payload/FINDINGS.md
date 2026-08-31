# WSK-00 · Layer 2 findings — Payload on top of the mechanism

**Date:** 2026-08-26 · **Status:** PROTOTYPED (probes P8–P13 written, run, and observed against a
live Payload 3.88.0 + Postgres 16 instance)

## Verdict up front

**PROCEED with WSK-04 as designed, for the paths that matter for RLS enforcement — Local API,
REST, background jobs, and migrations all correctly carry `webdesk.tenant_ctx` through Payload's
own internals, with no patch to `@payloadcms/db-postgres`.** One path — the admin panel's
server-rendered initial list view — does **not** carry the GUC as currently wired, but it fails
**closed** (renders nothing, for every tenant) rather than leaking, and the cause is a Next.js
module-instantiation quirk, not a defect in the Postgres mechanism or in the Payload adapter
itself. Section "P10" below explains why this does not trigger the WSK-D16 fallback trigger as
literally written, and what would need to happen to close the gap.

## Per-path verdict table

| Path | Probe | Result | Rows checked / evidence |
|---|---|---|---|
| Local API (`payload.find/create/update`) | P8 | **PASS** 5/5 | Cross-tenant read/write/update all correctly scoped; fail-closed with no context |
| REST (`/api/pages` via `app/(payload)/api/[...slug]/route.ts`) | P9 | **PASS** 9/9 | Auth + CSRF handled; cross-tenant create refused (sanitized 500, confirmed no row landed); concurrent requests isolated |
| Admin panel SSR (initial list-view render, `/admin/collections/pages`) | P10 | **FAIL (fail-closed, not a leak)** 4/6 | Page renders 200 for every tenant but shows **zero** documents regardless of tenant cookie — see mechanism below |
| Jobs / queue (`payload.jobs.queue` + `runByID`) | P11 | **PASS** 2/2 | A task that re-threads tenant context from `job.input` sees only its own rows; a task that omits this fails closed (zero rows), not leaked |
| Migrations (`payload migrate:create` / `migrate` / `migrate:status`, as `webdesk_migrator`) | P12 | **PASS** 3/3 | DDL runs fine under the NOBYPASSRLS migrator role; `tenantAwarePg` wrapper does not interfere when no ALS context is active |
| Pooled-connection reuse under Payload's own call patterns (both read and write paths) | P13 | **PASS** 6/6, including a negative control that reproduces a real leak | Forced connection reuse (pigeonhole: 3 checkouts / pool max 2) proven via connection-id tagging; no residual tenant context observed on reuse in either direction |

**31 individual checks total: 29 PASS, 2 FAIL (both P10, both fail-closed).**

## The mechanism that worked

`payload/src/tenant-pg.mjs` does not patch `@payloadcms/db-postgres`. It uses the adapter's own
documented, typed extension point: `postgresAdapter({ pg, pool, ... })` accepts a `pg` option
(`PgDependency`), and `node_modules/@payloadcms/db-postgres/dist/connect.js` does exactly
`this.pool = new this.pg.Pool(this.poolOptions)` — confirmed by reading that file directly, not
assumed. Passing a subclassed `Pool` through that option is using the adapter's own contract, not
bypassing it.

That subclass overrides `Pool.prototype.connect()` (both the promise form used by
`drizzle.transaction()` for create/update/delete, and the callback form `pg-pool`'s own `query()`
convenience method uses internally for plain, non-transactional reads) and on **every** checkout:
stamps `set_config('webdesk.tenant_ctx', tenantId ?? '', false)` from whatever value is active in
Node's `AsyncLocalStorage` at that instant, and on release, resets it to `''` before the physical
connection is visible to the next borrower. This is exactly layer 1's **SESSION** strategy — not
TX/`SET LOCAL` — pushed one layer down from "every caller must remember to wrap itself" to "every
connection checkout goes through one class, once."

**This answers WSK-D16's central question more precisely than "yes/no does Payload run every
operation in a transaction we control."** It does not: `getTransaction()` in
`@payloadcms/drizzle/dist/utilities/getTransaction.js` falls back to the adapter's plain,
non-transactional `drizzle` instance whenever `req.transactionID` isn't set, which is the case for
every ordinary `find`/`findByID` (Local API, REST, admin, jobs). Only create/update/delete run
inside `this.drizzle.transaction()`. So the honest answer is **no, not every operation is
transactional** — but that turned out not to matter, because the SESSION strategy was pushed down
to the one place *every* operation, transactional or not, must pass through: `Pool.connect()`.
P13's forced-reuse test with a real Payload instance (not our own explicit wrapper, unlike layer
1's P4) proves this holds under both call patterns, and its negative control (a deliberately
broken variant that skips the release-scrub) reproduces a real leak on cue — the same discipline
that proved decisive in layer 1.

## P10 — the one path that did not carry the GUC, and why

The admin list view's SSR data load renders `"No Results"` for **every** tenant cookie tested,
including ACME's own. This was investigated to a definite root cause (instrumentation added,
observed, then fully reverted — none of it ships in the probe suite):

1. `app/(payload)/admin/[[...segments]]/page.tsx` correctly resolves `tenantId` from the request
   cookie and calls `runWithTenant(tenantId, ...)`. Diagnostic checkpoints placed at every `await`
   inside that callback (through `import('payload')`, `getPayload({config})`, and `p.find(...)`)
   all showed `tenantStore.getStore()` returning the correct tenant UUID, every time. **Our own
   AsyncLocalStorage write and read are internally consistent within this file.**
2. Yet a diagnostic `p.find({ collection: 'pages' })` issued from inside that exact scope also
   returned zero rows — and, decisively, `tenantCheckoutLog` (the module-level array
   `tenant-pg.mjs`'s `TenantAwarePool.connect()` pushes to on every checkout) recorded **zero new
   entries** during that call. The query genuinely ran (no error, a real empty result from
   Postgres) but did **not** pass through the same `TenantAwarePool` instance that this file's own
   import of `tenant-pg.mjs` binds to.
3. The REST path (`route.ts`) uses the identical wrapping pattern (`runWithTenant` from the same
   relative import, `config` from the same `@payload-config` alias) and works correctly (P9, 9/9).

The strongly-supported explanation: Next.js's App Router compiles Route Handlers and Page/RSC
components as separate build "layers." Payload's `getPayload()` caches one shared
adapter/pool/singleton per process, but *which* module instantiation of
`tenant-pg.mjs`/`../../src/tenant-pool.mjs` (and hence which `AsyncLocalStorage` object) ends up
wired into that one real pool is whichever layer's code path first triggered `payload.config.ts`'s
evaluation. Every *other* layer's `runWithTenant()` writes to its own layer-local, disconnected
copy of the same source file — a copy the real pool's checkout hook never reads from. Within P10's
own script, seeding runs through the REST route first, so that layer wins the race; the admin
page's own layer is left writing to a dead end. This is a **Next.js module-graph duplication
effect acting on a plain ES-module singleton**, not a flaw in `@payloadcms/db-postgres`, and not a
security defect — the observed failure mode is fail-closed (nothing shown), never
cross-tenant (nothing "leaked" from another tenant landed in the wrong response either).

**Does this trigger WSK-D16's exit criterion?** Read literally, no: the criterion is "cannot carry
the GUC *without patching `@payloadcms/db-postgres`*." Nothing here requires touching that
package. A plausible fix exists — anchor the `AsyncLocalStorage` instance on `globalThis` inside
`src/tenant-pool.mjs` so every Next.js layer necessarily shares the same object regardless of how
many times the module graph is duplicated around it — but that file is layer 1's, frozen for this
ticket, and applying an unproven fix mid-spike is exactly the "workaround invented mid-ticket" the
ruling says to avoid. This is reported as evidence, not patched.

**Practical scope of the gap:** the admin panel's interactive behaviors (search, pagination, save)
all go through the *client-side* fetch to `/api/pages` — the same `route.ts` P9 already drove
end-to-end successfully. Only the *very first, server-rendered paint* of a collection list is
affected. An admin visiting `/admin/collections/pages` would see an empty list on first load
today; whether that is tolerable, needs a targeted fix (e.g. force the REST layer to initialize
`payload.config.ts` first, or the `globalThis` anchor above once layer-1 is unfrozen), or needs a
different mechanism for this one surface is a product/architecture call, not something this probe
suite should decide unilaterally.

## Operational hazards found resuming this spike (not RLS findings, but cost real time)

- **Windows batch-shim spawn (`EINVAL`)**: Node's `spawn()`, on this patched Node version, refuses
  to exec a `.cmd` shim directly without `shell:true` (the CVE-2024-27980 fix). Affected both
  `next dev` and the `payload` CLI invocations in `lib-server.mjs` / `p12-migrations.mjs`. Fixed
  with `shell: process.platform === 'win32'`.
- **Orphaned process trees on Windows**: `child.kill()` on a `shell:true`-spawned child only
  signals the `cmd.exe` wrapper, not the real `next dev` server it forks — every probe run that
  errored before a clean `finally` left the port held. Fixed with `taskkill /PID <pid> /T /F`
  (`lib-server.mjs`'s `killTree`).
- **Port collision with an unrelated concurrent session**: port 3111 was already bound by a
  `platform-ui` `next dev` server from a different session on this shared box (confirmed via
  `Get-CimInstance Win32_Process`). The original readiness probe only checked `res.status` truthy
  and happily "passed" against that *other app's* login page HTML. Moved to port 34117 and
  tightened readiness to require the body to parse as JSON.
- **Payload's default access control is `Boolean(user)` for every collection**, including `users`
  itself, with no built-in "table is empty, allow the first create" exception at the plain
  `POST /api/users` endpoint — that exception is a *separate* operation
  (`POST /api/<slug>/first-register`), and even that one gates on "does ANY doc exist in the
  collection," not "does this specific email exist," so it 403s for every email once a single
  prior probe run (in this shared, multi-run spike) has created any user at all. Bootstrap now
  goes through Local API (idempotent find-or-create, bypasses access control by design) and only
  the login itself goes over real REST.
- **CSRF on cookie-based auth**: `config/sanitize.js` unconditionally pushes `serverURL` onto
  `payload.config.csrf`, so the allowlist is never empty for this app. `extractJWT`'s cookie
  strategy therefore requires either an `Origin` header matching that allowlist or a
  `Sec-Fetch-Site` header — neither of which a plain Node `fetch()` sends. The cookie was silently
  discarded (identical response to "logged out," no error) until every authenticated probe call
  added `Origin: <baseUrl>`. This is Payload's CSRF protection working as designed for a real
  browser; it just needs mimicking from a script.
- Both of these auth traps produced *misleadingly plausible* failures (403s that read like an RLS
  refusal, a `null` user that read like an expired session) — worth flagging because the natural
  first instinct is to suspect the tenant-context mechanism, when the actual gate was Payload's
  ordinary, unrelated access-control/auth layer.

## What design §04/§05 gets wrong (or under-specifies)

- **"Wrap the request in `runWithTenant()`" is not a uniform recipe across Payload/Next.js entry
  point types.** It is sufficient for Route Handlers, Local API callers, and job handlers. It is
  *not* sufficient, as wired, for Next.js Server Component pages (the admin panel's own SSR
  shell), because the singleton the wrapper depends on can be silently duplicated by Next's
  layer-based module graph. Any future design leaning on this same pattern for a *new* Server
  Component surface should assume it needs the same investigation, not copy the admin-page.tsx
  pattern as a known-good template.
- **The GUC-carrying mechanism actually shipped is SESSION-at-the-pool-level, not TX**, even for
  the operations (create/update/delete) that do run inside a Postgres transaction. The pool
  subclass stamps `set_config(..., false)` (session-scoped) on every checkout regardless of
  whether the caller is inside `drizzle.transaction()` or not — it does not use `SET LOCAL`. That
  is a deliberate, reasonable choice (it is what makes one mechanism cover both transactional and
  non-transactional paths without knowing which is which), but it means the *entire* safety story
  for §04/§05's tenancy model rests on one `finally` block's reset call inside
  `tenant-pg.mjs`'s `Pool.connect()` override remaining correct forever, on every future
  `@payloadcms/db-postgres` upgrade that might change how or whether `pool.connect()` is the
  actual internal chokepoint. Layer 1's own README named this risk category explicitly; layer 2
  confirms the risk is real and now lives in exactly one file, not scattered across call sites —
  smaller surface, but still a single point that must never regress silently. A regression test
  pinned to `tenantCheckoutLog` (as P13 already does) is cheap insurance worth keeping if WSK-04
  proceeds.
- **Design docs should not assume the admin panel's SSR initial paint is a "free" corollary of the
  REST wrapping.** It looked identical in shape to the REST fix and turned out to need separate,
  non-obvious diagnosis. Any staging/build-out ticket that inherits this pattern should budget for
  that specifically rather than treating "wrap `route.ts`" as covering "the admin panel" as a
  whole.

## Reproduce

```bash
cd webdesk/spike-rls/payload
node probes/p8-local-api.mjs      # Local API — 5/5
node probes/p9-rest.mjs           # REST — 9/9
node probes/p10-admin.mjs         # Admin SSR — 4/6 (2 documented, fail-closed)
node probes/p11-jobs.mjs          # Jobs/queue — 2/2
node probes/p12-migrations.mjs    # Migrations — 3/3
node probes/p13-leak.mjs          # Pooled-connection leak, incl. negative control — 6/6
```

Container `webdesk-spike-spikedb-1` on port 55432 must already be up with `sql/001_schema.sql`
applied and `scripts/setup-schema.ts` run once (both already true for the container reused here).
Each `p9`/`p10` run spawns its own `next dev` child on port 34117 and tears it down; if a prior
run was killed mid-flight, check `netstat -ano | grep 34117` and `taskkill /PID <pid> /T /F`
before rerunning (see "operational hazards" above).

## Honest scope limits

- P10's root-cause diagnosis is a strongly-evidenced hypothesis (module-graph duplication across
  Next.js layers), pinned down via direct instrumentation of the actual checkout log and ALS
  reads, not a guess from symptoms alone — but the exact webpack/Turbopack internal mechanism that
  produces the duplication was not traced past that point. It does not need to be, to answer the
  question this spike asks: the path either carries the GUC correctly or it does not, and this one
  does not, in a way that does not implicate the Postgres adapter.
- This spike did not drive the admin panel's *interactive* client-side behavior (search,
  pagination, save-then-reload) through a real browser. That is out of scope by design (see P10's
  probe file header): every one of those interactions calls the same `/api/pages` REST endpoint
  P9 already exercised end-to-end, so a browser-driven pass would not add evidence beyond what P9
  already established.
- No status stronger than PROTOTYPED is claimed anywhere above.

---

# Addendum (coordinator, 2026-08-26) — a reproduced hazard, and a correction

Two items the probe suite above does not cover. The first is a **correction of a claim I made and
got wrong**; the second is the corrected, reproduced version of it.

## Correction

I earlier reported — to the owner, and into WSK-04's ticket conditions — that **`payload migrate`
silently drops hand-applied RLS policies**. **That is wrong.** Direct test: policy present before
`probes/p12-migrations.mjs`, policy present after, `rls=true force=true` unchanged. `migrate` is
clean. I had attributed a real observation to the wrong cause without testing it.

## What actually causes it (reproduced, twice)

**Payload's dev schema push — `PAYLOAD_ALLOW_PUSH=true`, i.e. an ordinary dev boot — disables row
security on the table and drops the policy.** Minimal repro: boot Payload as the DB owner with push
enabled, nothing else, then read `pg_class`/`pg_policy`:

| | before push | after push |
|---|---|---|
| `pg_policy` for `pages` | `tenant_isolation` | **NONE** |
| `relrowsecurity` | `true` | **`false`** |
| `relforcerowsecurity` | `true` | `true` *(unchanged)* |

This is **worse than what I originally claimed**, in two specific ways:

1. **RLS is not merely policy-less, it is switched OFF** (`relrowsecurity = false`). A FORCE-RLS
   table with zero policies denies everything — annoying but safe. RLS *disabled* means **every
   tenant's rows are visible to every caller.** Fail-open, not fail-closed.
2. **`relforcerowsecurity` stays `true`**, so the table still *looks* protected to any check that
   only inspects the FORCE flag. This is the residue that makes the failure invisible.

That fully explains the mid-run false positive: P11 reported both tenants' rows visible and read as
a catastrophic jobs leak. It was not a jobs defect at all — RLS was simply off underneath it, having
been silently disarmed by a dev boot several steps earlier. Re-applying via
`scripts/setup-schema.ts` and re-running gave 2/2 PASS.

## Consequence for WSK-04 — condition 1, sharpened

The CI/gate assertion must check **all three** facts per tenant-scoped table, not the FORCE flag
alone:

```sql
-- every tenant-scoped table must satisfy ALL of:
relrowsecurity      = true   -- RLS actually ENFORCED (the one a dev push turns off)
relforcerowsecurity = true   -- owner not exempt
(SELECT count(*) FROM pg_policy WHERE polrelid = c.oid) >= 1
```

A gate that checks only `relforcerowsecurity` and policy count would have passed the disarmed table
in condition 2 above and missed it in condition 1. Run it after **every** schema operation, and in
the M0 gate.

Operationally: **RLS applied out of band cannot survive Payload owning the schema.** Either the
policy is (re)applied by a Payload migration that runs after every schema change, or dev push is
forbidden against any database that matters and `setup-schema.ts`-equivalent re-application is a
mandatory post-push step. WSK-04 should pick one and encode it; the spike does not decide it.

## Also carried into WSK-04: the P10 admin gap

The admin SSR list view does not carry the GUC (fails closed, root-caused above to Next.js
module-graph duplication of the ALS singleton). It does not trip WSK-D16's literal fallback trigger
— no adapter patch is needed — but it is a real functional gap on a surface staff will use, and the
proposed fix (anchor the `AsyncLocalStorage` instance on `globalThis`) is untested. WSK-04 owns
proving it.
