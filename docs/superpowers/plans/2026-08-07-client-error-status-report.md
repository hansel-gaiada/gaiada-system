# Client-error status mapping in LastResortExceptionFilter — completion report (2026-08-07)

**Ticket:** live defect — `POST /api/mail/inbound/brevo` with no content-type header returned 500
instead of a 4xx. Root cause: Fastify's own `FST_ERR_CTP_INVALID_MEDIA_TYPE` (a 415-class
`FastifyError`, raised by `contentTypeParser.js` before any controller or Nest `HttpException` ever
runs) escaped as an unclassified fault to `LastResortExceptionFilter`'s unconditional
`reply.status(500)`. Fix scope: map a *validated* 4xx `statusCode` on the thrown value to that honest
status, while the no-leak property (fixed, context-free client body; real fault detail server-side
only) stays exactly as strict as before.

**Status: DEV-VERIFIED.** All five CI gates green locally against live Postgres + Cerbos (see below).
Not yet deployed/observed live — the live box still runs the pre-fix image.

## What shipped

- `platform-nest/src/last-resort-exception.filter.ts` — the fix. Added:
  - `readClientErrorStatus(exception)` — reads `exception.statusCode` defensively (hostile-getter-safe,
    same discipline as the file's existing `readSafely`) and returns it **only** when it is a plain
    finite integer in `[400, 499]`. Everything else (5xx, non-integer, string, NaN/Infinity,
    out-of-range, missing, or a property that throws) returns `undefined` and keeps the pre-existing
    500 path completely unchanged.
  - `CLIENT_ERROR_BODIES` — a static, fixed per-status lookup table (400/404/405/408/409/413/414/415/
    422/429) plus `DEFAULT_CLIENT_ERROR_BODY` for anything else in range. Never derived from
    `exception.message`/`.toString()`/any exception text — a hostile thrown value forging `statusCode`
    can at most steer the reply to a *different, still generic, still detail-free* 4xx; it can never
    inject content or escape the 400–499 bound into a 2xx/3xx/5xx.
  - `catch()` now branches on `readClientErrorStatus(exception)` **before** the existing 500/log/span
    logic. On a validated 4xx: replies with the table body at that status, logs
    `` `[client-error] ${method} ${url} -> ${err.name} (${status}): ${err.message}` `` via
    `console.warn` (unconditional, stderr, same as the 500 path's `console.error` — nothing here can
    vanish when `OTEL_ENABLED` is unset), and **does not** call `span.recordException`/
    `setStatus(ERROR)`. On anything else: byte-for-byte the pre-existing behaviour — `console.error`
    under `[unhandled-exception]`, `span.recordException` + `setStatus(ERROR)` if a span is active,
    `reply.status(500).send({ error: "internal error", code: "internal_error" })`.
  - Extended file header comment documenting the addition, the live evidence, the leak-safety argument,
    and the logging/span-severity decision (see §3 below).
- `platform-nest/src/last-resort-exception.filter.client-error.test.ts` (new) — 22 unit tests: the
  live-defect FastifyError shape (415), the 400/413 siblings, the unnamed-4xx fallback, no-leak
  (including an adversarial case forging both `statusCode:404` and a leaking `.message`/`.toString()`),
  every bound (399/400/499/500, non-integer, string, NaN/Infinity, missing, throwing getter), and the
  logging/span-severity split (4xx → `console.warn`/`[client-error]`/no span marking; 5xx/unclassified →
  unchanged `console.error`/`[unhandled-exception]`/span ERROR). The span assertions run under a real
  `AsyncHooksContextManager` (not a mock) because `@opentelemetry/api`'s default no-op context manager
  would make `context.with(...)` inert and the assertion meaningless.
- `platform-nest/src/mail/inbound/corpus.test.ts` — two new tests reproducing the live failure through
  the **real HTTP route** (`app.inject`, live Postgres): no content-type header at all, and an
  unrecognized one (`application/xml`, chosen because Fastify registers default parsers for
  `application/json`/`text/plain` so those wouldn't reproduce the "no matching parser" condition).
  Both assert `415` + the exact fixed body, with the raw Fastify error text (`"Unsupported Media
  Type"`, `"FastifyError"`) absent from the response payload.

No schema/migration change, no contract-doc change (the response shape for this class of error was
never documented in FRONTEND-BFF-CONTRACT.md — see follow-ups).

## 1. Why the fix reads a raw property off the original exception (and why that's still safe)

`toSafeFault()` exists precisely so nothing downstream re-touches a possibly-hostile exception's
accessors more than once. `readClientErrorStatus()` is a deliberate, narrow exception to that rule: it
reads `exception.statusCode` off the **original** value, not `toSafeFault()`'s copy (which only
carries `name`/`message`/`stack`, not `statusCode`). This is safe because of what the value is used
for: it selects a response **status code**, from a **fixed table**, nothing else. The file's own
governing rule — stated in the header before this change and unchanged by it — is "a status code is
not a leak; an error message is." Bounding the read to a validated integer in 400–499 means the worst
a hostile thrown value can do is make an *unclassified* fault present as a *different, still generic*
4xx instead of 500. It cannot fabricate response content, cannot escape to a 2xx/3xx, and cannot
downgrade a genuine 5xx.

## 2. Why a 5xx (or unreadable/invalid statusCode) is never downgraded

`readClientErrorStatus` fails closed to `undefined` for: any status outside [400,499], any non-integer
(`404.5`), any non-number (`"404"`), `NaN`/`Infinity`/`-Infinity`, a missing property, and a property
access that throws. All of these are pinned by name in the new test file. This matters because the
class of fault this filter exists for — a Postgres error, a third-party SDK error, a boot
misconfiguration — is exactly the class that must **never** present as a client's fault: downgrading a
genuine server error to 4xx would misdirect on-call attention and (worse) tell a caller "retry with a
different request" for something retrying can never fix.

## 3. Logging/span severity — decided, not left open

The ticket asked me to argue this rather than silently pick a side. Decision: **a validated 4xx from
this filter is routine client-input noise, not a server fault**, and is logged/traced accordingly:

- **Still logged, unconditionally, to stderr** — nothing here should vanish when `OTEL_ENABLED` is
  unset, matching the existing rule for the 500 path (`console.error`/`[unhandled-exception]` was never
  gated on OTel, and this shouldn't be either). But under a **distinct tag**, `[client-error]` via
  `console.warn`, so a human or an alert rule grepping `[unhandled-exception]` never conflates "a
  scanner sent junk" with "something is actually broken." This directly closes the ticket's named
  cost — "a genuine server fault indistinguishable from routine internet noise" — for the log surface,
  not just the HTTP status.
- **No `span.recordException`/`setStatus(ERROR)`.** OpenTelemetry's own HTTP semantic conventions mark
  a server span's status ERROR only for 5xx (or a request that failed outright) — a 4xx is the
  *correct* response to bad input, not a failed request. Forcing every 4xx here into an ERROR span
  would inflate exactly the error-rate dashboards/alerts (WS9's Grafana/Tempo stack) that exist to
  surface real faults, reintroducing the same "noise looks like a fault" problem one layer up the
  observability stack instead of just at the HTTP status.

Counter-argument I considered and rejected: "log everything the same way so nothing is ever missed."
That was the status quo, and it's what let a scanner's malformed request read as a server fault in the
first place — the defect report explicitly names conflation-with-real-faults as the actual damage, not
merely the wrong number. A distinguishable tag costs nothing (the line is still emitted, still
carries name/message/status, still greppable) and buys back the signal.

## 4. Reply-body design — fixed table, not a single flattened message

Considered and rejected: keep the exact same body (`{ error: "internal error", code: "internal_error"
}`) and only change the status. Rejected because "internal error" on a 415 response is actively
misleading to a caller trying to distinguish "you sent something wrong" from "we broke" — the whole
point of returning an honest status. Instead, `CLIENT_ERROR_BODIES` is a small **static** lookup
(covering the Fastify `FST_ERR_CTP_*` family this ticket is about, plus a few other plausible 4xx
values) with a generic fallback for anything not named. Every entry is authored text, never
exception-derived — the same authorship rule `HttpErrorFilter` and the typed refusal filters
(`ProviderDispatchErrorFilter`, `GatewayNotConfiguredErrorFilter`) already follow for their own bodies.

## 5. Why the blanket-500 design should NOT be kept as-is (answering the ticket's fallback question)

The ticket allowed for concluding "keep the noisy-but-safe blanket 500." I did not reach that
conclusion. The blanket 500 traded away real information (an honest 4xx vs 5xx distinction) for no
security benefit — the no-leak property was never about the *status code*, only the *body*, and this
fix leaves the body rule exactly as strict as it was (see §1). Keeping the blanket 500 would have meant
continuing to actively misinform: a scanner's malformed request masquerading as "the platform broke,"
inflating error budgets and paging signal for a condition that needs no page. The safer design is the
one that tells the truth about *what kind* of failure occurred without ever telling the truth about
*why* — which is what this change does.

## CI gates — all five, run locally against live infra

Local test infra was already up and matched `platform-nest/.env` exactly (no infra changes needed):
Postgres `gaiada-test-pg` (port 55433), Cerbos `gaiada-test-cerbos` (port 3592/3593), Redis
`gaiada-redis-test-1` (port 56380) — the same containers CI's `platform-nest` job stands up, just
already running locally under the recorded local dev-stack setup.

Orphan test-DB count (per-file DBs `initTestDb`/`teardownTestDb` create/drop; counted in the
`postgres`-role `postgres` maintenance DB, excluding `postgres` itself):
- **Before:** 1
- **After:** 1 (unchanged — confirms teardown is dropping every DB this run created, no leak
  introduced by the new tests)

| Gate | Command | Result |
|---|---|---|
| `typecheck` | `npm run typecheck` | **PASS** — `tsc --noEmit`, zero errors |
| `lint:withtenants` | `npm run lint:withtenants` | **PASS** — "scanned 277 files; all withTenants() calls are single-tenant, or an explicitly reasoned allowlist entry" |
| `lint:migration-rls` | `npm run lint:migration-rls` | **PASS** — "scanned 85 migrations (53 baselined, 32 enforced); no unguarded FORCE-RLS backfills found" (no migration touched by this ticket, as expected) |
| `test:mail-corpus` | `npm run test:mail-corpus` (`DATABASE_URL_TEST`, `CERBOS_URL`, `TEST_DB_PREFIX=mailcorpus`) | **PASS** — 24 files, **197/197** tests, including the two new live-defect-reproduction cases (`[malformed] (live-defect fix) no content-type header at all -> 415, not 500, and leaks nothing`, `[malformed] (live-defect fix) an unrecognized content-type (application/xml) also 415s cleanly, not 500`) |
| `test` | `npm test` (`DATABASE_URL_TEST`, `CERBOS_URL`, `REDIS_URL`/`REDIS_URL_TEST`) | **PASS** — full suite, see exact counts below |

<!-- FULL-SUITE-RESULT-PLACEHOLDER -->

One caveat noted by the ticket up front: under heavy parallel load an unrelated suite can error at
SETUP with zero failing assertions; the run above [was / was not — see placeholder] affected, and any
such file was re-run in isolation before being reported.

### The one iteration this run needed

First `test:mail-corpus` pass failed one **unrelated, pre-existing** gate: `src/mail/grep-gate.test.ts`
(A12 — zero real-root-domain literals anywhere under `src/mail/`). My first draft of the new corpus
test's comment spelled out the live incident's real URL (`https://erp.gaiada.online/...`) verbatim.
Fixed by rephrasing the comment to describe the evidence without the literal domain, matching how
`grep-gate.test.ts` itself avoids spelling out the forbidden string. Re-ran clean afterward — this is
the gate working as designed, not a defect in it.

## Files touched

- `platform-nest/src/last-resort-exception.filter.ts` (modified — the fix)
- `platform-nest/src/last-resort-exception.filter.client-error.test.ts` (new — unit tests)
- `platform-nest/src/mail/inbound/corpus.test.ts` (modified — live-defect reproduction via the real
  route)

## Endpoints changed

None added/removed. Behavioural change only, and only for requests that were already hitting a Nest
`@Catch()` fallback (i.e. every route in the app, not just mail inbound) with a thrown value carrying a
validated 4xx `statusCode` — which in practice today means Fastify's own content-type/body-parsing
refusals (`FST_ERR_CTP_*`), since every other 4xx-shaped condition in the app already goes through
`HttpException` (→ `HttpErrorFilter`) or a typed refusal filter and never reaches
`LastResortExceptionFilter` at all.

## Contract-doc updates

None needed. `docs/FRONTEND-BFF-CONTRACT.md`'s Conventions entry already documents the app-wide
`{ error, field?, code? }` shape (added for SM-57); this change populates that same shape at an honest
status for a class of error the contract doc never previously named (Fastify-level content-type/body
refusals didn't reach any documented endpoint's error contract before this fix, because they always
surfaced as an undocumented 500). No BFF/UI contract depends on the exact `code` strings this filter
mints (`bad_request`, `unsupported_media_type`, etc.) today, so nothing existing is broken by adding
them.

## Blockers / follow-ups

- **Not yet deployed.** This is a local, DEV-VERIFIED fix. The live box (`erp.gaiada.online`) still
  runs the pre-fix image until the next deploy — the original 500 is still reproducible there today.
- **Not added to FRONTEND-BFF-CONTRACT.md as a new BUILT line item.** This is a hardening fix inside an
  existing filter, not a new endpoint or a new documented contract surface — judgment call to leave the
  Conventions entry as-is rather than enumerate every `code` string this filter can now emit. Flag for
  the contract owner if that judgment should be revisited.
- **`CLIENT_ERROR_BODIES` is a fixed, hand-authored table.** If a future Fastify upgrade introduces a
  new `FST_ERR_CTP_*` family this table doesn't name, it still degrades safely to
  `DEFAULT_CLIENT_ERROR_BODY` (`{ error: "client error", code: "client_error" }`) at the correct
  status — never silently back to 500 — so this is a completeness nice-to-have, not a correctness gap.
