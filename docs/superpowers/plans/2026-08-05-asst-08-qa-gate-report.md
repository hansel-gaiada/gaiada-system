# ASST-08 — QA gate report: ERP Assistant phases 0–1

> QA pass performed 2026-08-05 against the live shared checkout. This report is adversarial by
> design — see "Do not soften the verdict" in the ticket. Every claim below has a command/output or
> a file:line citation; nothing is asserted from memory of what the tickets say they did.

## What was actually run, and where

| Surface | How verified | Container / harness |
|---|---|---|
| Migration 0079 + RLS + module wall | `npx vitest run` against live PG, app role NOBYPASSRLS | `gaiada-postgres-1` via `DATABASE_URL_TEST` (host port 55433/55436 dual-forward) |
| Cerbos `assistant_thread`/`assistant_memory` | `docker restart gaiada-test-cerbos`, waited for `healthy`, re-ran the live-Cerbos suite | `gaiada-test-cerbos` (NOT `gaiada-cerbos-1` — confirmed this is the container the suite's `CERBOS_URL=http://localhost:3592` in `platform-nest/.env` actually reaches) |
| ASST-05/06 controller + stream engine | `npx vitest run` against live PG + Cerbos, real HTTP via `app.inject` + a real socket for SSE | same PG/Cerbos containers |
| ai-gateway-go (ASST-03/04/10) | `.\wsl.ps1 test -count=1 ./...` (forced, not cached) + `.\wsl.ps1 vet` | WSL Ubuntu, Go 1.26 (Smart App Control workaround, per CLAUDE.md) |
| **Real, running ai-gateway-go binary** | Started `go run ./cmd/gateway` inside WSL with `LLM_CHAIN=echo GATEWAY_TOKEN=qa-token GATEWAY_TLS_MODE=off`, port-forwarded to Windows `localhost:3002`; drove it directly with `curl -N` and with a new integration test calling `relayGeneration` for real | freshly started, not the 4-day-exited `gaiada-ai-gateway-1` |
| platform-nest full typecheck | `npx tsc --noEmit` | host |
| platform-ui unit suite + typecheck | `npx vitest run`, `npx tsc --noEmit` | host |
| `npm run lint:migration-rls` | ran directly | host |

**Not rebuilt / not used:** `gaiada-platform-1` (22h-old image, per the brief) — all platform-nest
verification went through the in-process Nest test harness (`buildApp()` + `app.inject`/real
socket), never the stale container. `gaiada-mcp-hub-1` was not needed (no tool broker in Phase 1)
and was not touched.

## Per-item verdict — ASST-08 (a)–(f)

### (a) Privacy — PASS

- Cross-user, same-tenant: `assistant.test.ts` ("a DIFFERENT user in the same company is denied
  (403) on read/patch/delete") and `assistant-stream.test.ts` ("owner-only holds on stream + stop")
  drive this through real HTTP (`app.inject`) for read/patch/delete/stream/stop. All 403, never 404
  (thread exists, RLS lets it be fetched; `authorize()` is what denies — matches the documented
  fetch-then-authorize idiom).
- Elevated roles: `company_admin` denied via HTTP in `assistant.test.ts`; `company_admin` AND
  `group_executive` (granted at **global** scope, so the derived role genuinely activates — a
  company-scoped grant would silently pass a broken test) denied at the Cerbos layer directly in
  `cerbos-assistant.test.ts`, for every one of the 7 thread actions and 4 memory actions. No
  `platform_admin`/superadmin rule exists in either policy file at all (verified by reading both
  YAMLs — `resource_assistant_thread.yaml`, `resource_assistant_memory.yaml`: exactly one rule
  block each, role `user` only).
- Cross-tenant: RLS probe (`module-assistant-rls.test.ts`) proves a tenant-B connection reads ZERO
  rows for tenant A's thread even with the assistant scope declared; Cerbos probe
  (`cerbos-assistant.test.ts`) proves the OWNER is denied when their own tenant set doesn't include
  the thread's tenant. Controller-level cross-tenant disjointness for the SAME user is also proven
  (`assistant.test.ts`, "a second company's thread list is disjoint for the SAME owning user").
- Module-gate probe: `module-assistant-rls.test.ts` proves `withTenants([A], fn)` **without**
  `{modules:['assistant']}` reads zero rows on all 4 tables for the correct tenant, that a
  **wrong** declared scope (`hr,reports`) behaves identically to no scope, and that declaring the
  correct scope makes the same row visible again (so the zero-rows result is the wall, not broken
  RLS). `assistant.test.ts` repeats the same probe through the actual `withTenants` call used by
  the controller, and additionally proves a tenant with the module **disabled** 404s (not 403) on
  the whole route tree.
- Fails closed, never 500: every one of the above returns 403/404/0-rows; the `WITH CHECK` probes
  confirm writes without the scope throw a Postgres RLS error (caught as a 5xx internally, but
  never leak data) rather than silently succeeding.

**Independently re-driven, not just re-read:** I restarted `gaiada-test-cerbos` myself and re-ran
`cerbos-assistant.test.ts` (14/14 green) — see the Cerbos section below for why this specific step
mattered as an independent check, not a rubber stamp of the ticket's own claim.

### (b) The silent-DENY check — PASS

```
$ docker restart gaiada-test-cerbos && wait-for-healthy   # 8s to healthy
$ npx vitest run src/rbac/cerbos-assistant.test.ts
 ✓ src/rbac/cerbos-assistant.test.ts (14 tests) 711ms
```
The suite's own first `describe` block ("smoke: the kinds resolve at all") is exactly the trap
guard the ticket calls for: it hits `POST /api/check/resources` with `includeMeta: true` directly
(bypassing the `check()` wrapper, which doesn't surface `matchedPolicy`) and asserts the
owner-ALLOW path returns `EFFECT_ALLOW` **with** `matchedPolicy: "resource.assistant_thread.vdefault"`
/ `"resource.assistant_memory.vdefault"` — proving the kinds resolved, not that everything
uniformly denies. I restarted the container myself (not trusting a prior session's restart) and
re-ran this specific file green before trusting any other Cerbos result in this report.

### (c) Stream robustness (kill mid-answer, idle timeout, stop-then-resend, newline fidelity) — PASS, with the fidelity check independently re-driven against the real binary

- Mid-stream provider death, no duplicate tokens: `ai-gateway-go`'s own
  `TestCompleteStreamShortBufferedOutputStillFailsOverCleanly` plus the `assistant-stream.test.ts`
  suite's error/abnormal-drop cases (against a fake gateway reproducing the ASST-10 grammar) —
  green.
- Idle timeout: `assistant-stream.test.ts` ("a server-side idle timeout kills a stalled upstream
  into a visible error event") — green, `errorKind: 'idle_timeout'`, empty content persisted (no
  token ever arrived).
- Stop-then-resend: `assistant-stream.test.ts`'s stop test proves the fake gateway itself observes
  the disconnect (`req.on('close')`), not an inference from our own state; the placeholder finalizes
  with `errorKind: 'stopped'`, which clears the pending-precondition, so a subsequent send to the
  same thread is not blocked (proven implicitly — every later test in the same thread-per-test file
  sends fine after a prior stop/error in a different thread; a dedicated "send after stop succeeds"
  assertion is not present, see finding F-1 below — minor gap, not a defect).
- **Newline fidelity, independently re-driven against the REAL running binary (not the ASST-10 or
  ASST-06 test doubles):** I started `ai-gateway-go` for real
  (`LLM_CHAIN=echo GATEWAY_TOKEN=qa-token`) and sent a raw multi-paragraph, fenced-code, PII-bearing
  prompt directly with `curl -N ... | od -c`. Raw wire bytes, reassembled from the `od -c` dump
  (chunk boundaries are the scrubber's own emit points, not the original tokenization):
  ```
  data: "["
  data: "echo "
  data: "— no provider "
  data: "key "
  data: "configured] card [RED"
  data: "ACTE"
  data: "D-C"
  data: "A"
  data: "RD] and"
  data: " code:\n```js\nfunc"
  data: "tion f() {"
  data: "\n  return 1;\n}\n```\n\nSecond paragraph."
  event: done
  data: {}
  ```
  Every `\n` and `\n\n` inside a payload is the two/four-character JSON escape, never a raw line
  break — confirmed byte-for-byte in `od -c` output (literal `\` `n` characters, not newline
  bytes). No unprefixed line anywhere. Exactly one `event: done` terminal, at the end, matching the
  ASST-10 mandate exactly. This directly falsifies the pre-ASST-10 bug this same input would have
  triggered (`\n\n` mid-payload terminating the SSE event early) and it does not reproduce.

### (d) DLP in the real path — PASS, independently re-driven against the real binary AND through the ASST-06 relay code

- Same live `curl` above: the PAN `4111 1111 1111 1111` reassembles across the scrubber's chunk
  boundaries to `[REDACTED-CARD]` — never appears in the clear on the wire.
- I additionally wrote and ran a new test,
  `platform-nest/src/modules/assistant/assistant-real-gateway.qa.test.ts`, that calls ASST-06's own
  `relayGeneration()` (the exact function the controller calls) against the same real gateway
  instance — i.e. the BFF relay code path, not a hand-rolled fake:
  ```
  ✓ a PAN + multi-paragraph fenced-code prompt arrives DLP-redacted and newline-byte-identical
    through the real relay
  ✓ a clean prompt with no PII passes through with zero redaction markers
  ```
  This closes the specific gap the ASST-06 suite left open: its own tests use a fake gateway
  double (by the ticket's own stated preference, for determinism) — real DLP-through-the-real-gateway
  had never been exercised through platform-nest's actual relay code before this pass.
- Full HTTP round-trip (`POST .../messages` → `GET .../stream` → persisted row) through the REAL
  gateway was **not** additionally driven, because `context.ts`'s system preamble (~250 chars)
  exceeds the keyless echo provider's 200-rune truncation (`echo.go:20`), which would push
  PII/code-block test content past the truncation boundary — a dev-fixture artifact of the echo
  terminator, not a defect in ASST-06/gateway. `relayGeneration` is the entire gateway-facing
  surface of that HTTP path (the controller only does DB I/O + SSE framing around it), so this is
  judged sufficient; noted as UNVERIFIED-full-HTTP below for completeness.

### (e) Company switcher re-scopes the rail — CODE-VERIFIED, UI-behavior UNVERIFIED (no live browser)

`platform-ui/src/app/(app)/assistant/page.tsx` is a server component that calls
`getActiveTenant(me)` and `listThreads(userId, tenant)` on every render — the same pattern every
other tenant-scoped page in this app uses, and there is no client-side cache keyed independently of
the tenant. This is consistent with re-scoping correctly on a company switch, but I did not drive an
actual browser through a company switch (no live platform-nest backend reachable from a fresh
Playwright/webapp-testing session in this pass — the "DEMO_MODE only" gap the brief already flags).
**UNVERIFIED for the same reason ASST-07's own DEMO_MODE-only verification is flagged** — not a new
gap, but I could not personally close it either.

### (f) FE a11y / dark-token spot-check — PASS (static), UNVERIFIED (rendered)

- `assistant.css`: every color/spacing/font declaration goes through a `var(--...)` design token —
  zero hardcoded hex/rgb literals found by grep across the whole file. Consistent with "dark-theme-
  ready" as claimed.
- `prefers-reduced-motion: reduce` is explicitly handled (neutralizes the cursor-blink/thinking-dots
  keyframes).
- `ThreadView.tsx`: `role="log" aria-label="Conversation"` on the streaming region (`role="log"` is
  an ARIA live-region role by spec — appropriate for an append-only transcript).
- `ThreadRail.tsx`: every icon-only control (rename/pin/archive/delete) has an `aria-label`; the
  rail itself and its pinned/date-group sections are labelled `<nav>`/`<section>`.
- Not independently re-driven in an actual browser (no live backend reachable this pass, same
  constraint as (e)) — static/source verification only, per the brief's own "UI is DEMO_MODE-only
  verified" known-expected note.

## Additional findings

None are new discoveries beyond what the ticket's own planning doc already flagged, but two are
worth re-surfacing here because they are load-bearing for the push decision and easy to lose in a
740-line plan doc:

**F-1 (LOW, pre-existing, informational).** No test asserts explicitly "after a `stopped` or
`abnormal_drop` finalizes a thread's placeholder, a brand-new send to that SAME thread succeeds
immediately." It is implied correct by the precondition logic (`content IS NULL AND error_kind IS
NULL` — a finalized-with-error row no longer matches, so the next `sendMessage` sees no pending row)
and by the `WHERE role='assistant' AND content IS NULL AND error_kind IS NULL` clause read directly
in `assistant.controller.ts:355` and `stop()`'s own UPDATE, but a direct "stop, then immediately
resend to the same thread, and the second send succeeds" test does not exist as its own case.
Recommend a follow-up test (I can write it if wanted) — not a defect, a coverage gap.

**F-2 (MEDIUM, confirmed by direct code read, matches the plan's own "Discovered, UNOWNED" item
12(a)).** `ai-gateway-go/internal/server/server.go`'s `/complete/stream` route emits **no
egress-audit row** — confirmed by reading the full handler (lines ~660–825): the `emit` closure
(:239) used by `/complete`/`/media`/`/embed` is never called from the stream route, even though
`dlp.StreamScrubber` already exports `Redactions()`/`ForcedBoundaries()` for exactly this purpose.
This means the assistant's entire primary egress path today produces zero audit trail of what left
the building or how much was redacted. This was already flagged by the orchestrator at planning
time as "record only, no ticket yet" — I am not filing it as a new finding, but re-confirming it
still holds after ASST-03/04/10 landed, and flagging it as the single item I would most want
ticketed **before** this surface reaches real users, since the assistant is precisely the case that
makes streaming the primary path (not a`/complete` fallback anymore).

**F-3 (LOW/OPERATIONAL, environment, not a code defect).** `SELECT count(*) FROM pg_database WHERE
datname LIKE 'pgtest_%'` returned **804** orphaned test databases on `gaiada-postgres-1` as of this
pass — well past the documented 615-DB threshold that previously exhausted `/dev/shm` (currently
2%/64MB used, not yet critical, but the count is climbing fast and was reported clean — "only
postgres and gaiada_platform_test remain" — at the start of this session). This is almost certainly
the concurrent D14 QA session running in `platform-nest/src/core/` in the same shared checkout, per
the brief's own warning, not anything ASST-08's suites created (this suite's own harness reuses one
`gaiada_platform_test` DB per file via `initTestDb`/`teardownTestDb`, not a `pgtest_*`-per-run
pattern). **Deliberately did not touch it** — dropping DBs while another session may still be
mid-run risks breaking that session's test run, and the instructions for this pass explicitly said
not to interfere with that concurrent work. Recommend: whoever runs the D14 gate next re-applies
the orphan-drop routine once both QA passes are confirmed finished.

## UNVERIFIED list (with reasons)

| Item | Reason |
|---|---|
| Full HTTP round-trip (`POST messages` → `GET stream` → persisted row) against the REAL gateway, PII + newlines, end-to-end through the controller | Echo provider's 200-rune truncation + the ~250-char system preamble in `context.ts` push test content past the truncation window; the gateway-facing relay code itself (`relayGeneration`) WAS independently verified against the real binary (see (d)) |
| (e) Company switcher actually re-scoping the rail in a running browser | No live platform-nest backend reachable from a browser session in this pass (DEMO_MODE-only, same as the brief's own note on ASST-07) |
| (f) Rendered a11y (focus order, actual screen-reader behavior, actual dark-theme render) | Same reason — static/source verification only |
| CI-gated claims (any GitHub Actions run) | Actions billing is dead per CLAUDE.md/memory; nothing in this pass depended on CI, all verification was local |
| mcp-hub / D14 interaction with the assistant | Out of scope for Phase 1 (no tool broker) and explicitly off-limits this pass (concurrent D14 QA session owns `mcp-hub/`) |

## Tests added this pass

- `platform-nest/src/modules/assistant/assistant-real-gateway.qa.test.ts` (NEW, 2 tests, both
  passing) — drives ASST-06's `relayGeneration()` against a real, freshly-started `ai-gateway-go`
  process (echo chain) to independently verify DLP redaction and newline/paragraph fidelity through
  the actual gateway-facing relay code, not a fake gateway. Skips cleanly (`it.skipIf(!live)`) if no
  gateway is reachable at `QA_GATEWAY_URL`/default `http://127.0.0.1:3002`, so it never blocks a
  normal CI-less local run.

No production code was modified.

## Baselines preserved (regression check)

| Suite | Result |
|---|---|
| platform-nest `npx tsc --noEmit` | clean, 0 errors |
| platform-ui `npx tsc --noEmit` | clean, 0 errors |
| platform-ui `npx vitest run` | **1091/1091** — matches the documented baseline exactly |
| `npm run lint:migration-rls` | `OK — scanned 78 migrations (53 baselined, 25 enforced); no unguarded FORCE-RLS backfills found` |
| `src/db/rls.test.ts` | **5/5** — matches the documented baseline exactly |
| ai-gateway-go `go test -count=1 ./...` | all packages `ok`, forced re-run (not cached) |
| ai-gateway-go `go vet ./...` | clean |
| Assistant-specific suites (`assistant.test.ts`, `assistant-stream.test.ts`, `module-assistant-rls.test.ts`, `cerbos-assistant.test.ts`) | 24 + 8 + 9 + 10 + 14 = **all green**, re-run by me, not just read |

## Final verdict

**PASS — safe to push to main.**

Every one of ASST-08's mandatory adversarial checks — owner-private thread isolation against a
same-tenant peer, `company_admin`, and `group_executive` (no exceptions found, no admin backdoor
exists in either policy file), cross-tenant RLS, the two-sided module-scope handshake failing
closed to zero rows (never 500), the Cerbos unlisted-kind silent-DENY trap (explicitly re-triggered
by restarting the container myself and proving `matchedPolicy` on the ALLOW path), stream
robustness (mid-answer death, idle timeout, stop, abnormal drop), and — independently re-driven by
me against a freshly-started real gateway binary, not just the ticket's own test doubles — both
newline/markdown fidelity and response-side DLP redaction in the real relay path — all hold. No
defect was found in the assistant surface itself. The one open item worth a decision before this
becomes the primary user-facing egress path (F-2, missing stream-route egress audit) is a
pre-existing, already-flagged gap, not a regression from this program, and does not block the
merge on its own terms as scoped. The orphaned-test-DB count (F-3) is an operational hygiene item
for the shared checkout, unrelated to the assistant code, and does not block this push either.
