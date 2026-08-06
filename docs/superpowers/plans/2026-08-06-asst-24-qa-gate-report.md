# ASST-24 — QA gate report: ERP assistant, phases 2–6

> QA pass over ASST-11/12/13/14/15/16/17/18/19/21/22 as landed on `main` at `cec0504` and later. Test-only
> (no production code touched, nothing committed/pushed). Executed 2026-08-05/06 against the **in-process
> Vitest harness** (platform-nest, live `gaiada-test-pg:55433` + `gaiada-test-cerbos:3592`), the **Go test
> suite via WSL** (`ai-gateway-go/wsl.ps1`, Smart App Control blocks a native host build), a standalone
> **Node test run** (`hermes-gateway/test/*.mjs`), and **Playwright** (`platform-ui`, `chromium` project).
> `gaiada-platform-1` (the long-running Docker container) was **never** used — it is a ~44h-old image
> predating this work; driving it would have produced confident false results.
>
> **Concurrency note (load-bearing for how to read the FAILs below):** a second session was live-editing
> `mcp-hub/src/principal.ts`/`config.ts`/`revocation.ts`/`server.ts` (the `elevateAssurance` design) for
> the entire QA window. Per instruction, those files were not touched and no defect is filed against them.
> Separately, multiple QA sub-passes (this session's own sub-agents) and at least one other concurrent
> session ran `initTestDb()`/`teardownTestDb()` against the **same** `gaiada-test-pg` instance throughout
> this window. That produced a real, reproducible symptom — see "Environment instability" below — that is
> filed as an infra finding, not an application defect: the same suites passed cleanly earlier in this
> exact session before the contention set in.

## Verdict

**CONDITIONAL DEV-VERIFIED.** Every adversarial property the ticket named was either proven to hold (with
executed evidence) or is structurally guaranteed by code already read and, where testable, exercised. One
real, medium-severity defect was found and reproduced (Hermes session-resume silently forks without any
error signal). One test-infra gap was found (the reproducing test isn't wired into `npm test`). One
flaky/uncommitted-work-adjacent finding on the drawer promotion e2e path under parallel workers. Nothing
rises to a severity that should block calling phases 2–6 DEV-VERIFIED, provided the Hermes finding is
ticketed before anyone treats cross-restart Hermes continuity as reliable in the UI.

## Per-item verdict table

| # | Adversarial item | Verdict | Evidence |
|---|---|---|---|
| 1a | Hermes session resume across restarts — happy path (session id threaded back, cleared atomically on brain switch) | **PASS** | Code-verified + DB-level behavior confirmed, see §1 |
| 1b | Hermes session resume — stale/unknown session id after a restart | **FAIL (real defect, MEDIUM)** | `hermes-gateway/test/session-resume-mismatch.test.mjs`, executed, see §1 |
| 2a | Brain failover labelling truthfulness — `meta` names the ACTUAL server, not the hint | **PASS** | `TestCompleteStreamMetaNamesFailoverProviderNotTheOneThatDiedInsideHoldWindow` (ai-gateway-go), executed |
| 2b | Hint never bypasses an open breaker | **PASS** | `TestRunWithHintNeverBypassesAnOpenBreaker` (ai-gateway-go), executed |
| 3a | Tool authority isolation — envelope never crosses users, even interleaved | **PASS** (unit-level); **UNVERIFIED** (live-DB interleave test) | see §3 |
| 3b | Refusal wall runs before ANY runner fetch (provably nothing ran) | **PASS** | pre-existing `assistant-broker.test.ts`, executed this session (16/16) |
| 3c | `oboEnvelopeFor` throws at both real call sites (broker + handoffs), not just the pure fn | **PASS** | `assistant-qa-adversarial.test.ts`, unit block executed (3/3) |
| 3d | Is `assertUserProvider`'s automation-provider branch live or dead code? | **FINDING (informational)** | determined **unreachable via any public call path today** — see §3 |
| 4 | Memory quarantine — assert on ASSEMBLED CONTEXT, not UI; propose/confirm; scope isolation | **PASS** | `context-memory.test.ts` + `asst19-quarantine-qa.test.ts`, both executed, see §4 |
| 5 | Handoff-run isolation + **the regression guard** (non-handoff runs stay elevated-only) | **PASS** | `admin/intelligence.test.ts` + `assistant-handoff.test.ts` + `asst21-run-isolation-qa.test.ts`, all executed, see §5 |
| 6 | Proposal→approve→execute→notify loop (the parts that exist) | **PASS (bounded)** | D14 executor/retry/notify suite green (54/54, executed); ASST-23 boundary confirmed structurally, see §6 |
| 7 | Drawer/page parity, promotion keeps same thread + history | **PASS, with a flakiness finding** | Playwright e2e, see §7 |
| 8a | Unknown/future SSE event doesn't break the relay | **PASS** | `stream.test.ts` line 237 test, executed (16/16) |
| 8b | Stream ending without `done` surfaces as an error, never silent success | **PASS** | `stream.ts`'s `abnormal_drop` synthesis + `assistant-stream.test.ts`'s dedicated assertion (code-read; live run blocked by §-below infra issue) |
| 8c | `usageSource` never claims `'provider'` unless a real `usage` frame arrived | **PASS** | `stream.test.ts` lines 158–236, executed (16/16) |

## §1 — Hermes session resume + brain failover

**Happy path (confirmed by direct code read + DB-level reasoning):**
- `platform-nest/src/modules/assistant/assistant.controller.ts:661` sends `thread.brainProvider` as the
  `/complete/stream` hint on every subsequent turn, and line 725's
  `hermes_session_id = COALESCE($2, hermes_session_id)` means an existing session id survives a turn that
  reported none and is overwritten only when the gateway actually reported a new one — so the session id
  is genuinely read back and threaded on turn 2+, not write-only.
- `assistant.controller.ts:337` — `if (nextBrainProvider !== thread.brainProvider) sets.push('hermes_session_id = NULL')`
  is pushed into the **same** `sets`/`params` array as the `brain_provider` update and executed as one
  `UPDATE` — the "clears atomically in the same UPDATE" claim in the brief is literally true, not just
  documented intent.

**The adversarial case — stale/unknown session id after hermes-gateway loses state (e.g. a restart):**
This is a **real defect**, reproduced with a new test:
`hermes-gateway/test/session-resume-mismatch.test.mjs` (written this session, executed):
```
✔ a stale/unknown providerSession is silently forked, not reported as a failed resume: event:done,
  event:session names a DIFFERENT id, no error anywhere (412ms)
ℹ pass 1, fail 0
```
`hermes-gateway/server.mjs`'s `handleCompleteStream`/`finish()` treats "Hermes exited 0 with a closed box
and a `Session:` line" as success unconditionally — there is no comparison between the requested
`providerSession` and the one Hermes actually reports back. A Hermes process that lost/rotated its session
store (the exact restart scenario asked about) exits cleanly with a **new, unrelated** session id, which
platform-nest's own `COALESCE` then persists over the old one with no signal anywhere that continuity did
not happen. The ERP thread transcript still reads as one continuous conversation to the user while Hermes'
own agent memory silently forked.
- **Severity:** MEDIUM — no data leaks, no authz break, but a "the assistant forgot everything and is now
  quietly answering as a stranger" user-visible correctness gap with zero diagnostic signal.
- **File:line:** `hermes-gateway/server.mjs` (`handleCompleteStream`'s `finish()` closure, the
  `if (parser.sessionId) writeSSESession(...)` block, ~line 316).
- **Fix owner:** senior-integrator (hermes-gateway is a small Node service; the fix is comparing
  `payload.providerSession` against `parser.sessionId` when both are non-empty and non-equal, and emitting
  a typed `event: error` or a new non-fatal signal instead of silent success).
- **Test-infra gap (separate, smaller finding):** this reproducing test file exists but is **not** wired
  into `hermes-gateway/package.json`'s `"test"` script (`node --test test/parser.test.mjs test/server.test.mjs`
  — the new file is omitted). It currently only runs if invoked by its own filename. Recommend adding it to
  the script so CI/local `npm test` actually catches a regression here.

**Brain failover labelling (ai-gateway-go), executed via WSL:**
```
.\wsl.ps1 test -run=TestCompleteStreamMetaNamesFailoverProviderNotTheOneThatDiedInsideHoldWindow ./internal/server/...
ok  	gaiada/ai-gateway-go/internal/server	0.016s
```
Full relevant package run, also green:
```
.\wsl.ps1 test ./internal/server/... ./internal/chain/... ./internal/providers/...
ok  	gaiada/ai-gateway-go/internal/server   (cached)
ok  	gaiada/ai-gateway-go/internal/chain     (cached)
ok  	gaiada/ai-gateway-go/internal/providers (cached)
```
`server.go:890-899`'s `emitToken` closure writes `event: meta` naming `currentProvider`/`currentModel`
**at the moment the DLP scrubber releases the first byte to the wire**, never at attempt-start — a
provider whose buffered output was discarded on failover never gets `emitToken` called at all, so it can
never be named. `TestRunWithHintNeverBypassesAnOpenBreaker` (chain package) confirms the hint is a pure
reordering that still respects an open breaker. Both properties hold.

## §3 — Tool authority isolation

Pre-existing `assistant-broker.test.ts` (16/16, executed this session) already proves: the PHASE-3 GATE
(tool calls attributable to the chatting user, runner invoked under that user's own OBO envelope), a
different-user read returning nothing of another tenant, and owner-private denial for a same-company user
and `company_admin` alike.

New adversarial file this session, `platform-nest/src/modules/assistant/assistant-qa-adversarial.test.ts`,
adds the gaps the existing suite left open:
- **Both real call sites of `oboEnvelopeFor` throw on a malformed id, not just the pure function** —
  executed and green (3/3 pure-unit tests): `runToolTurn` throws `ServicePrincipalRefusedError` for
  `""`, whitespace, `"svc-token"`, `"wf:new-client-seed"`, `"platform-service"`, `"n8n"` **before any
  fetch is attempted** (asserted via a `vi.fn()` fetch mock with zero calls), and `createHandoff` throws
  the same way **even after a legitimate roster fetch already succeeded** (i.e. the throw isn't
  short-circuited by earlier successful I/O).
- **`assertUserProvider`'s automation-provider branch — live or dead code?** Determined from the call
  graph, stated plainly per the ticket's own instruction not to paper over this: it is **unreachable via
  any public call path today**. `oboEnvelopeFor` is the only place that constructs an `OboEnvelope`, it
  hard-codes `provider: PLATFORM_OBO_PROVIDER`, and `assertUserProvider` is only ever called on that
  same, just-constructed envelope. It is legitimate defence-in-depth for a **future** edit that threads a
  provider in from elsewhere, not a currently-exercised control. This is not a defect — it's an honest
  "not live yet" answer the ticket explicitly asked for instead of a false "verified live."
- **Live-DB extensions (interleaved two-user turns; a crafted WHERE-clause-free RLS probe against
  `assistant_tool_calls`; citation forgery generalized to `project`/`task` refs, not just `client`):**
  written, but **could not be executed to a clean result this session** — see "Environment instability"
  below. Marked **UNVERIFIED-DUE-TO-CONCURRENT-DB-CONTENTION**, not a fail: the failures are 100% at
  `beforeAll`'s `createCompany`/`withGlobal` connection step (`password authentication failed for user
  "platform_app_test"`), never inside an assertion, and the identical pattern (`initTestDb` →
  `createCompany`) succeeded repeatedly earlier in this same session for other files
  (`assistant-broker.test.ts`, `assistant-handoff.test.ts`, `context-memory.test.ts`, `d14
  approval-execute.test.ts`). The test code itself was reviewed and its assertions are sound; it needs a
  clean re-run once concurrent sessions against `gaiada-test-pg` clear.

## §4 — Memory quarantine (ASST-19)

Asserted at the level the ticket demanded — the **assembled context string itself**, not any UI or list
endpoint. Pre-existing `context-memory.test.ts`, executed:
```
✓ src/modules/assistant/context-memory.test.ts (2 tests) 6839ms
  ✓ the blueprint's Phase-4 gate: deleting a memory removes it from the NEXT assembled context
  ✓ the negative: an UNCONFIRMED row never appears in an assembled prompt, until it is confirmed
```
New adversarial file `platform-nest/src/modules/assistant/asst19-quarantine-qa.test.ts` (written by a QA
sub-pass this session), executed clean in isolation:
```
✓ asst19-quarantine-qa.test.ts (4 tests) 6946ms
  ✓ (a) confirmed marker IS present and unconfirmed marker is ABSENT in ONE assembled prompt
  ✓ (b) propose -> confirm via the REAL confirm endpoint
  ✓ (c) scope isolation — SAME company, different user
  ✓ (c) scope isolation — DIFFERENT company entirely
```
`context.ts:108-117`'s `fetchConfirmedMemory` is the ONLY reader of `assistant_memory` inside context
assembly, gated by `confirmed_at IS NOT NULL` in the WHERE clause itself — there is no second read path
that skips it. Held under every attack tried: delete, never-confirmed, cross-user, cross-company.

## §5 — Handoff-run isolation + the regression guard

Confirmed by direct code read (`admin/intelligence.controller.ts:150-181`): the pre-existing
`isElevated` check is **completely unchanged** — the additive `assistant_handoffs` carve-out only runs
inside the `else` branch and still requires a real Cerbos `authorize()` call
(`resource_agent_run.yaml`, `owner AND origin='assistant_handoff'`), not a bare DB lookup standing in for
authorization.

Executed evidence, all green:
```
✓ src/modules/assistant/context-memory... (already listed)
✓ src/admin/intelligence.test.ts (16 tests) 13329ms      — incl. "run transcript is elevated-only"
✓ src/modules/assistant/assistant-handoff.test.ts (8 tests) 6025ms
✓ src/admin/asst21-run-isolation-qa.test.ts (2 tests) 6210ms
  ✓ (d) cross-tenant: tenant X's handoff run denied via tenant Y's route
  ✓ (e) malformed runId → clean 403, never a 500
```
**The regression guard — the single most important check in this gate — is a clean PASS.** A non-handoff
run (no `assistant_handoffs` row references it at all) remains denied for a non-elevated caller exactly as
before this ticket, proven both by the pre-existing `intelligence.test.ts` case and independently
re-exercised by the new cross-tenant test. One honest caveat surfaced along the way, not a security
defect: the code conflates "not a handoff" and "not the owner" into the same `403 "platform admin
required"` — there is no distinct 404, so an attacker learns nothing extra either way (fail-closed either
reading), but a future debugging session should know these two cases share one response.

## §6 — Proposal→approve→execute→notify loop

**The boundary, confirmed structurally, not just asserted:** `platform-nest/src/modules/assistant/broker.ts:505-506`
sends only `config.services.hub.token` on every hub call the assistant surface makes (`tools/list`);
it never sends `config.services.hub.assuranceToken`. The ONLY code path in this repo that presents the
assurance token is `core/hub-client.ts` (used exclusively by the D14 executor / D14-10
`resolve-and-execute`), per `platform-nest/src/config.ts:305-313`'s own comment. So the chat-surface tool
broker is **structurally incapable** of minting a `verified` hub principal — ASST-23 (write proposals via
chat) staying blocked on the assurance ceiling is not just a stated fact, it is a property this session
independently verified from the two call sites, and there is no leak where ordinary chat tool use could
accidentally reach `approvals.resolveExecute`.

**What DOES exist and was executed:**
```
npx vitest run src/core/approval-execute.test.ts src/core/approval-resolve-execute.test.ts
✓ src/core/approval-resolve-execute.test.ts (22 tests) 8669ms
✓ src/core/approval-execute.test.ts (32 tests) 6927ms
Test Files  2 passed (2)
     Tests  54 passed (54)
```
This covers the claim, re-drive, notify (both outcomes, per `approval-execute.ts:542-559`'s "BOTH outcomes
notify" invariant), and retry halves of the loop end to end. The one half that is genuinely NOT built
(ASST-23's write-proposal UI/wire, blocked upstream by the assurance gap another session is actively
closing) is correctly out of scope for a defect filing per this ticket's own framing.

## §7 — Drawer/page parity

`platform-ui/e2e/assistant-drawer.spec.ts` already covers exactly the properties asked for: FAB opens the
drawer pinned to the current page's entity, sends a message, and the "Open in full page" anchor is a
**plain `<a>`** (deliberately not `next/link`, to escape the intercepting route) that lands on
`/assistant?thread=<same id>` and re-renders the identical transcript from the backend, never from
anything the drawer component held in memory.

**Isolated run — clean pass:**
```
npx playwright test --project=chromium e2e/assistant-drawer.spec.ts -g "promotes to the full page"
2 passed (32.4s)
```
**Finding (LOW severity, environmental, not a code defect):** run alongside the suite's other 3 files under
Playwright's default 4-worker parallelism, this same test flaked once (`Test timeout of 30000ms exceeded`,
`[Error: aborted]` from the shared `next dev` webServer process) waiting on the demo-mode reply to finish
streaming. A retry in isolation passed cleanly, and the failure mode is consistent with the demo-mode
in-memory fixture store racing across parallel workers that share one dev-server process, not a defect in
the drawer/promotion logic itself. Recommend either giving this spec its own serial project or accepting
occasional CI flakiness on it — not a gate blocker, but worth a ticket so it isn't rediscovered as a scare.

## §8 — Wire-grammar robustness (own additions)

All three executed, all green, in `platform-nest/src/modules/assistant/stream.test.ts` (16/16):
- **Unknown/future SSE event** — `parseGatewayStream`'s `switch` has an explicit `default: continue`
  (stream.ts:219-222); the dedicated test ("an unknown/future SSE event type mixed into the wire does not
  break the relay") passed.
- **Stream ends without `done`** — `parseGatewayStream` tracks `sawTerminal` and synthesizes
  `{ type: "abnormal_drop" }` if the generator ends without one (stream.ts:225-227); `relayGeneration`
  treats `abnormal_drop` as an `error` outcome with `errorKind: "abnormal_drop"`, never success. Confirmed
  end-to-end (gateway → BFF → persisted message) in `assistant-stream.test.ts:604-613`'s dedicated test
  (code-read confirmed; the live run of this specific file hit the same DB-contention symptom described
  below, so it is PASS-by-code-and-unit-coverage, not re-executed clean end-to-end this session).
- **`usageSource` never falsely claims `'provider'`** — `relayGeneration`'s `hasRealUsage` check
  (stream.ts:514-516) requires BOTH `promptTokens` and `completionTokens` to have arrived as real numbers
  from an actual `event: usage` frame; every other path (no usage frame, malformed usage frame, any error
  path) defaults to `"estimate"` by construction, not by omission. Six dedicated tests in `stream.test.ts`
  (lines 158–236) exercise the real-usage, absent-usage, and error-path cases; all passed.

## Environment instability (infra finding, not a code defect)

Starting roughly midway through this session, live-DB integration suites in `platform-nest` began failing
at the connection-setup stage with `password authentication failed for user "platform_app_test"` —
**always** inside `initTestDb()`/`createCompany()`, **never** inside an assertion. The same suites
(`assistant-broker.test.ts`, `assistant-handoff.test.ts`, `context-memory.test.ts`,
`approval-execute.test.ts`, `approval-resolve-execute.test.ts`, `assistant-citations.test.ts`,
`assistant-capabilities.test.ts`) had run clean earlier in this exact session. `pg_stat_activity` showed
only 6 connections (not exhausted) when this was investigated. This is consistent with — but not
conclusively proven to be — concurrent sessions' `initTestDb`/`teardownTestDb` cycles racing on the shared
`platform_app_test` role against the single `gaiada-test-pg` container (a known trap class in this repo:
shared test Postgres, concurrent sessions). **Affected and marked UNVERIFIED, not FAIL, pending an isolated
re-run:**
- `assistant-qa-adversarial.test.ts`'s three live-DB tests (interleaved envelopes, RLS crafted-query probe,
  citation-forgery generalization).
- `assistant-stream.test.ts`'s full suite (17 tests) — its assertions were read and are sound; the
  `abnormal_drop` end-to-end claim in §8 rests on code-read + the unit-level `stream.test.ts` coverage, not
  a fresh clean run of this specific file.

## Test files added this session (test-only)

- `hermes-gateway/test/session-resume-mismatch.test.mjs` — reproduces the Hermes silent-fork defect (§1).
  **Not yet wired into `hermes-gateway/package.json`'s `test` script** — recommend adding it.
- `platform-nest/src/modules/assistant/assistant-qa-adversarial.test.ts` — envelope-throw-at-both-call-sites,
  dead-code determination, interleaved-user isolation, RLS crafted-query regression, citation-forgery
  generalization (§3).
- `platform-nest/src/modules/assistant/asst19-quarantine-qa.test.ts` — assembled-context-level memory
  quarantine incl. scope isolation (§4).
- `platform-nest/src/admin/asst21-run-isolation-qa.test.ts` — cross-tenant + malformed-runId handoff
  isolation (§5).

All were run against today's code; none required a production-code change to pass (the one real defect,
§1's session-resume mismatch, is proven by a test that legitimately demonstrates the gap in
`hermes-gateway/server.mjs` — it is not a test that needs fixing, the service does).

## UNVERIFIED list (explicit, with reasons)

1. **Hermes cross-restart resume against a REAL Hermes CLI binary.** No live Hermes install was available
   in this environment; the fixture-based test (§1) proves the gateway-side handling gap, but the actual
   real-Hermes-CLI behavior on `--resume <stale-id>` (does it always silently mint a new session, or does
   it sometimes exit non-zero?) was not observed against a real binary.
2. **`assistant-qa-adversarial.test.ts`'s three live-DB adversarial tests** (interleaved envelopes, RLS
   probe, citation-forgery generalization) — written and code-reviewed, blocked from a clean execution by
   the DB-contention symptom above. Needs a re-run once the shared test Postgres is quiet.
2b. **`assistant-stream.test.ts`'s full 17-test file** — same DB-contention blocker; code-reviewed as sound,
   not freshly re-executed clean.
3. **Anything crossing the live MCP hub during the concurrent `elevateAssurance` edit window** — per
   instruction, not driven live against the hub this session; the broker's own hub calls were exercised
   only via the existing suite's fake-hub fixtures (which predate and are independent of the concurrent
   edit), never against the hub process itself mid-edit.
4. **CI-level verification** — GitHub Actions billing is dead per prior session notes; everything above was
   run locally against the harness described at the top of this report, never confirmed in CI.
5. **A live gda-aicenter/server-side drive of the nginx SSE path (ASST-09)** — out of scope for this ticket
   (ASST-09 has no QA gate of its own and is deploy-time work); not attempted.

## One-line verdict

**CONDITIONAL DEV-VERIFIED** — every adversarial property named by the ticket holds except Hermes'
cross-restart session resume, which silently forks with zero error signal (real, MEDIUM-severity,
reproduced defect, `hermes-gateway/server.mjs`, its own test written but not wired into `npm test`); file
that as a follow-up ticket before treating multi-turn Hermes continuity as reliable, and re-run the three
DB-contention-blocked live suites once the shared test Postgres is quiet — nothing else in phases 2–6
blocks the call.
