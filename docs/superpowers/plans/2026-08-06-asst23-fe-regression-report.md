# ASST-23 proposal card — FE verification gap closure report

**Session:** senior-fe, 2026-08-06. **Scope:** `platform-ui/` only, per the two gaps disclosed in
`2026-08-06-t4-proposal-card-report.md` §9/§11 and `2026-08-06-asst-23-unblock-design.md` §7. No
`platform-nest`/`ai-agents`/`mcp-hub` file touched. No commit/push made — tree left for review.

---

## 0. The two gaps, and their disposition

1. **No committed browser regression spec for propose → confirm → executed.** T4 drove this once
   with a throwaway script (deleted, never committed). **CLOSED** — `e2e/assistant-proposal-card.spec.ts`
   (new, 6 tests) is now in the committed suite, runs in the `chromium` project.
2. **`rejected` / `execution_failed` / `cancelled` never met a backend.** Proven only by
   `ProposalCard.test.tsx`'s constructed-props cases because DEMO_MODE's confirm handler always
   resolved to `approved`+`executed`. **CLOSED** — `lib/demoAssistant.ts` now derives the terminal
   outcome from a keyword in the drafting message (mirroring the existing `ERROR_TEST`/`STALL_TEST`
   convention), so each state is reachable through a real propose→confirm click, not just asserted
   against constructed props. Covered at two layers: `demoAssistant.test.ts` (function-level,
   5 new cases) and the new Playwright spec (3 dedicated browser tests).

Two **real, previously-latent bugs** were found and fixed while building the regression spec (not
manufactured to justify the ticket — see §3). Both are small, in-scope, and load-bearing for the
spec's own reliability.

---

## 1. Files touched

**New:**
- `platform-ui/e2e/assistant-proposal-card.spec.ts` — the committed regression spec (6 tests):
  propose→confirm→executed end to end (composer affordance, `confirm_required` SSE decode, the
  confirm action's real HTTP round trip, terminal render, approvals link); a keyboard-only
  confirm/dismiss a11y test; three tests driving `REJECT_TEST`/`CANCEL_TEST`/`FAIL_TEST` through a
  real click to `rejected`/`cancelled`/`execution_failed`.

**Modified:**
- `platform-ui/src/lib/demoAssistant.ts` — `DemoWriteOutcome` type + `pickDemoWriteOutcome` (keyword
  scan on the drafting message, same convention as `ERROR_TEST`/`STALL_TEST`) + `demoApprovalOutcomeFor`
  (the one place the outcome→approval-row-shape mapping lives); `DemoWriteIntent` gained a
  `demoOutcome` field (demo-only, never on any wire/persisted shape); the confirm handler now branches
  on it instead of hardcoding `approved`+`executed`. Comments updated to state the mechanism and why
  it doesn't touch the intent-then-approval discriminant order (the documented trap).
- `platform-ui/src/lib/demoAssistant.test.ts` — 5 new cases proving `REJECT_TEST`/`CANCEL_TEST`/
  `FAIL_TEST` reach their terminal shapes through the real dispatcher (not constructed props), that
  the outcome round-trips through the reload-joined GET (not just the confirm response), and that the
  default (no-keyword) path is unchanged.
- `platform-ui/src/components/assistant/AssistantWorkspace.tsx` — **bug fix**: `loadThread` gained a
  staleness guard (`activeThreadIdRef`, synchronously updated everywhere `activeThreadId` changes,
  via a new `setActive` helper). See §3.1.
- `platform-ui/playwright.config.ts` — one line: `PORT` now reads `process.env.E2E_PORT` before
  falling back to `3005`, so a session can run e2e on a dedicated port without touching the shared
  default or a sibling session's server. Nothing else in the file changed.

**Contract additions:** none. No new backend endpoint, no `FRONTEND-BFF-CONTRACT.md` change — this
ticket only extends demo fixtures and adds a test.

---

## 2. PASS — verified, with how

```
npx tsc --noEmit
```
Clean (no output). Run repeatedly through the session as files changed.

```
npm test
```
```
Test Files  123 passed (123)
     Tests  1326 passed (1326)
```
Baseline stated for this ticket was **1321 passed** (T4's own number) — not regressed; +5 is exactly
this ticket's new `demoAssistant.test.ts` cases. Re-run clean at the end of the session against the
final tree.

```
DEMO_MODE=1 npm run build
```
Exit code 0, full route table generated, no errors — re-run at the end of the session against the
final tree (this matters here specifically because `AssistantWorkspace.tsx`, a client component, was
edited).

```
npx playwright test --project=chromium e2e/assistant-proposal-card.spec.ts
```
**Run in isolation, 4 consecutive times** (across fresh-server and warm-server conditions), **6/6
green every time**, ~24–32s each run. Uses `E2E_PORT=3010` per this session's port assignment. The
`chromium` project is the right one: it's the only project with a stored, authenticated session
(`.auth/user.json`, logged in as `hansel@gaiada.com`, which `lib/demoIdentity.ts` maps to the
`demo-hansel` identity — the same owner the seeded/created demo assistant threads use); `anon`,
`smoke`, and `portal` all authenticate as someone else or not at all, so this spec cannot run there.

Both new terminal-state demo mechanisms (§0.2) were verified at two independent layers, not just one:
- `npx vitest run src/lib/demoAssistant.test.ts` — 16/16 green, including the 5 new cases driving the
  real dispatcher functions (`assistantDemo`, `demoAssistantStreamBody`) exactly as the Next.js route
  handlers call them.
- The 3 dedicated Playwright tests, driving the SAME states through an actual composer→confirm click
  in a real Chromium browser.

---

## 3. Two real bugs found and fixed while building the spec

Both surfaced from the SAME root symptom while iterating on the spec: sequential tests within the
file appeared to bleed into each other's threads (a card from test N-1 rendering alongside test N's
own card). I did not assume either was environmental noise and move on — both were isolated to a
specific, reproducible mechanism, fixed, and the fix verified against a clean run before being
accepted.

### 3.1 App bug: `loadThread` had no staleness guard (fixed in `AssistantWorkspace.tsx`)

`loadThread(id)` is async. Nothing previously checked whether `id` was **still** the active thread by
the time its `GET thread` resolved. Switching threads twice in quick succession — exactly the
"land on `/assistant`, then immediately click + New chat" pattern this spec's own helper does —
could let an earlier, slower `loadThread` call (for the thread you just navigated away from, kicked
off by the page's own mount effect) resolve **after** a newer switch had already set `messages` to
something else (a fresh empty array from `handleNew`), silently overwriting the new thread's messages
with the old thread's.

**Fix:** `activeThreadIdRef`, a ref kept synchronously in sync with `activeThreadId` via a new
`setActive(id)` helper (replacing every raw `setActiveThreadId` call). `loadThread` now compares its
own request's `id` against `activeThreadIdRef.current` at resolve time and skips applying
`messages`/`threads` if a newer switch happened meanwhile — the busy flag is still always cleared, so
nothing gets stuck disabled waiting on a request that will never apply.

This is a genuine, if narrow, latent correctness issue independent of this ticket's scope, but it sits
squarely inside the file this ticket already touches (per T4's own list) and is exactly what would
make the new committed spec unreliable if left unfixed — so it was in scope to fix, not just report.

### 3.2 Test-design issue: a scripted click can land before hydration (fixed in the new spec, not the app)

Separately, a scripted `.click()` on "+ New chat" (and later, on the "Use tools" checkbox) could land
on the SSR-rendered element **before** React finished hydrating and attached its handler — the click
is then silently dropped. This is not an app bug; it's the standard SSR-hydration race, and it is
measurably worse on this shared box while several other sessions' Node processes are also running
(observed directly: over the course of this debugging, one run that would normally take ~10s took
1.6 hours purely from resource contention with sibling processes on the same machine).

**Fix, in the test:** `retryUntilVerified(act, verify, label)` — perform the interaction, then check a
condition that can **only** become true once the interaction actually took effect (a NEW thread id in
the URL for "+ New chat" — not "the conversation log is empty", which is ambiguous with a loading
placeholder of the OLD non-empty thread; `toBeChecked()` for the checkbox), retrying the interaction
itself, not just re-waiting, if verification times out. This is the standard mitigation for this class
of race, not a workaround for a defect.

---

## 4. UNVERIFIED / explicitly not claimed

- **No real screen reader was run.** NVDA/JAWS/VoiceOver were not driven against the proposal card,
  the composer toolbar, or the keyboard-only confirm/dismiss flow in this session, matching T4's own
  disclosed gap. The keyboard-operability test (`confirm is keyboard-operable with an accessible
  name...`) proves focus can reach the button via `Tab`-equivalent programmatic focus and that
  `Enter` activates it, and that the shared `lux-btn` global `:focus-visible` ring is the only focus
  style in play (no new one was added) — this is real keyboard-operability evidence, but it is **not**
  a screen-reader pass, and I am not implying it is one. This gap remains open for whoever picks up a
  real assistive-tech audit.
- **Full-suite-under-heavy-concurrent-load stability.** In isolation, the new spec passed 6/6 on
  every one of 4 runs. When deliberately co-run with `e2e/assistant-drawer.spec.ts` at higher worker
  counts on this SAME shared, multi-agent-loaded box, both files showed flakiness (timeouts,
  including on the drawer spec's own pre-existing, untouched test) — consistent with environmental
  resource contention rather than a defect in either spec (the drawer spec's failures were on tests
  this ticket never touched). I did not chase this further once the pattern was clearly load-shaped
  rather than logic-shaped; running the suite on a quieter box, or with a lower worker count locally,
  is the practical mitigation. Flagged rather than quietly implied fixed.
- **`not_executable`, the 7th proposal card state**, was not in this ticket's required scope (the
  ticket named exactly `rejected`/`execution_failed`/`cancelled`) and was not added — `demoAssistant.ts`'s
  `DemoWriteOutcome` type does include a `not_executable` branch already wired through
  `demoApprovalOutcomeFor` (cost was near-zero once the other three existed), but no keyword trigger,
  fixture test, or Playwright test exercises it. Noted as a cheap follow-up, not claimed as done.

---

## 5. Blockers / follow-ups for the orchestrator

None block this ticket. For whoever picks up next:
- A real assistive-tech (screen reader) audit of the proposal card + composer toolbar has still never
  been done by anyone, across this ticket and T4's.
- `not_executable` could be wired through the same keyword mechanism (`NOTEXEC_TEST`) for
  completeness — the type already supports it; only the trigger + tests are missing.
- If this suite is added to CI or a shared local-dev routine, prefer a dedicated/quiet runner or a
  lower `--workers` count for the `chromium` project — this session observed real, reproducible
  slowdowns (not correctness failures) purely from sharing the box with other concurrent sessions.

## 6. Non-negotiables checked

- No new runtime dependency added (Playwright is an existing devDependency; no other import added).
- No colour literal introduced — no `.css` file was touched at all in this ticket.
- `DEMO_MODE=1` fixtures are the mechanism used for both gaps; no new consumed endpoint was added, so
  no `FRONTEND-BFF-CONTRACT.md` change was needed.
- VER-03's a11y fixes: `Message.test.tsx`'s aria-live pins were not touched and remain green (part of
  the 1326); no new `role="log"`/`aria-live` pattern was introduced anywhere in this ticket.
