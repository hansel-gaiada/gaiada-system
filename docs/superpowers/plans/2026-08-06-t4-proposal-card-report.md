# T4 — platform-ui: event grammar + proposal card + tools-mode composer — report

**Ticket:** T4, `docs/superpowers/plans/2026-08-06-asst-23-unblock-design.md` §7.6 (§7.4's revised
T4). **Scope:** `platform-ui/` only. Built against T3a (landed, `4a61034`) and T3b (uncommitted in
the working tree — read, not modified: `platform-nest/src/modules/assistant/write-intents.ts`,
`assistant.controller.ts`'s confirm/dismiss endpoints, `broker.ts`'s `confirm_required` emission,
migration `0085_assistant_write_intents.sql`).

No platform-nest file was touched. No commit/push was made (per instruction — the tree is reviewed
and committed by the requesting session).

## 1. Files touched (all under `platform-ui/`, plus one doc)

**Modified:**
- `src/lib/assistant.ts` — decode grammar, reducer, card-state derivation, normalize/partition
  helpers, redaction/expiry formatters, `AssistantToolAgent`/`CapabilitiesResult.toolAgents`,
  `hasPendingProposalDecision`.
- `src/lib/assistant.test.ts` — inverted the ":105" null-pin (kept, rewritten — see §2), ~35 new
  cases for the four decode branches, the reducer, `deriveProposalCardState` (incl. the trap case),
  `normalizeThreadToolCall`/`normalizeLiveToolCall`/`partitionToolCalls`, `formatExpiresAt`,
  `hasPendingProposalDecision`.
- `src/lib/assistantActions.ts` — `sendMessageAction` gained optional `opts` (mode/agent); new
  `confirmWriteAction`/`dismissWriteAction`.
- `src/lib/demoAssistant.ts` — DEMO_MODE fixtures for every new/changed endpoint this ticket
  consumes (§4).
- `src/components/assistant/Message.tsx` — reads live/persisted tool calls, partitions into chips
  vs. proposal cards, suppresses the generic error paragraph for `confirm_required`/
  `approval_required`, threads `threadId` down.
- `src/components/assistant/ThreadView.tsx` — threads `threadId` down to `Message`.
- `src/components/assistant/AssistantWorkspace.tsx` — passes `threadId`; `handleSend` accepts/forwards
  `opts`; new silent pending-proposal poll (§5).
- `src/components/assistant/Composer.tsx` — the tools-mode affordance (checkbox + agent `<select>`,
  self-fetched `toolAgents`).
- `src/components/assistant/assistant.css` — `.asst-toolchip*`, `.asst-proposal*`,
  `.asst-composer-toolbar` / `.asst-composer__agent-select` / `.asst-composer__mode-hint`. Token-only
  (verified by `src/styles/tokens.test.ts`, still green).
- `src/components/assistant/Message.test.tsx`, `ThreadView.test.tsx` — updated fixtures for the new
  required `threadId` prop.
- `docs/FRONTEND-BFF-CONTRACT.md` — flipped the stale §18 header/PENDING bullets (pre-dated this
  ticket, left stale since ASST-18/19/21 landed) and added a "T4" subsection recording what the FE
  now consumes (no new backend endpoint — this ticket adds no contract, only records consumption,
  per platform-ui/CLAUDE.md's rule).

**New:**
- `src/components/assistant/ProposalCard.tsx` — the D14 execution chip (full state machine).
- `src/components/assistant/ToolCallChips.tsx` — plain read/refusal chips.
- `src/components/assistant/ProposalCard.test.tsx` (8 tests), `ToolCallChips.test.tsx` (3),
  `Composer.test.tsx` (3).
- `src/lib/demoAssistant.test.ts` (11) — integration test over the real demo dispatcher + the real
  SSE generator (not further mocked).

## 2. The event grammar (item 1) — PASS

`decodeAssistantEvent` now decodes `tool_call` / `tool_result` / `approval_required` /
`confirm_required` for real. The old pin at `lib/assistant.test.ts:105` (`decodeAssistantEvent({
event: "tool_call", data: "{}" })` → `null`) is **inverted, not deleted**: the test now asserts the
same "unrecognised event name → null" invariant against `"some_future_event"`, with a comment citing
T3a/T3b and ASST-23 §1.4 for why `tool_call` stopped being an example of that case. Four new
`describe` blocks pin the real decode shape for each event, including the missing-required-field →
`null` guard and the "args defaults to `{}`, never null" rule.

`StreamState.toolCalls: LiveToolCall[]` accumulates by `callId` (`upsertLiveToolCall`) — a
`tool_call` inserts, `tool_result` patches in place, `approval_required`/`confirm_required` insert
directly (they are never preceded by their own `tool_call` on the wire — verified against
`broker.ts`'s actual emit call sites, not assumed).

## 3. The proposal card, full state set (item 2) — PASS

`deriveProposalCardState` implements the exact set the design doc names: `awaiting_confirmation →
sent_for_approval → executed | execution_failed | not_executable | rejected | cancelled`, plus
`dismissed` / `expired`, plus `plain` (not a proposal at all — a chip, not a card).

**THE TRAP, addressed as instructed, not merely avoided by accident:** `deriveProposalCardState`
reads `intent` first, `approval` second, and only returns `"plain"` when **both** are absent — never
reading `approvalId` as a discriminant anywhere in the FE (grep-verified: the only two places
`approvalId` is read at all are `ThreadToolCall.approvalId`/`LiveToolCall.approvalId`, both of which
exist purely to build the `/approvals/[id]` link once a card is already known-filed by the
intent/approval logic — never to decide *whether* it's filed). `lib/assistant.test.ts`'s
`"deriveProposalCardState — THE TRAP"` block pins this directly: a plain read (`approval:null,
intent:null`) and a fresh draft (`approval:null` too, but `intent:{status:'draft'}`) both have
`approvalId` reading `null`, and are asserted to map to *different* states (`"plain"` vs.
`"awaiting_confirmation"`).

**"Approval does not execute" disclaimer:** grep-verified absent from every file this ticket touched
before AND after the change (`grep -rn "does not execute" src/components/assistant src/lib` returns
nothing). Nothing was deleted because nothing existed to delete — the requirement is "don't
introduce it," and it wasn't.

## 4. The confirm chip (item 3) — PASS

`ProposalCard`'s Confirm/Dismiss call `confirmWriteAction`/`dismissWriteAction`
(`lib/assistantActions.ts`), which `POST … /tool-calls/:callId/confirm|dismiss` with
**`body: JSON.stringify({})`** — no args field, ever. `ProposalCard.test.tsx` asserts the exact call
shape (`confirmWriteAction` called with `(threadId, callId)` and nothing else) and that a tampered/
malicious caller has no code path to attach real values: the component never holds real args at
all — `formatRedactedArgs` only ever sees the redacted shape the wire carried.

The card renders `formatRedactedArgs(effective.args)` — key names, never values (`ProposalCard.test.tsx`
asserts the real project id string never appears on the page for a redacted call). A terminal card
(anything past `awaiting_confirmation`) renders **no** Confirm/Dismiss buttons at all (not merely
disabled) — a disabled button would imply a click still does something, which is false once filed;
`canActOnProposal` is the single source of that gate.

## 5. Tools-mode composer affordance (item 4) — PASS

`Composer.tsx` gained a "Use tools" checkbox + agent `<select>`, self-fetched from
`GET :t/assistant/capabilities`'s `toolAgents` field (never a hand-maintained mirror of
`ASSISTANT_AGENT_TOOLS`). This is the first UI path able to send `mode:'tools'`/`agent` — verified
by `Composer.test.tsx` (plain send → `{mode:'chat'}`; tools-mode send → `{mode:'tools', agent}`) and
by the real-browser smoke in §7.

`sendMessageAction` only adds `mode`/`agent` to the request body when tools mode is engaged; a plain
chat send's body stays `{content}` — verified by reading the implementation (conditional spread) and
by the "plain send" `Composer.test.tsx` case.

## 6. Pending-poll (item 5) — PASS, with one caught defect fixed before it shipped

`hasPendingProposalDecision(messages)` is true while any card reads `sent_for_approval`/`executing`
(a decision that could land out-of-band). `AssistantWorkspace` polls every 4s while that holds, via a
**new** `refreshThreadSilently` — deliberately **not** `loadThread`, which flips `loadingThread` and
would blank the whole `ThreadView` (its `loading` prop renders an empty placeholder div) on every
poll tick. Caught this by reading `ThreadView`'s render branch before wiring the poll, not by
observing the regression live — worth stating since it's exactly the class of hydration/state hazard
this seat is supposed to catch. The poll is also gated off while `sending` or `stream.state.status
=== "streaming"`, to avoid clobbering the optimistic user message/placeholder mid-send.

## 7. A11y and dark mode (non-negotiable, not a follow-up) — PARTIALLY VERIFIED

**Code-level (asserted by tests + review):**
- Confirm/Dismiss are real `<button>`s with a tool-naming `aria-label`
  (`Confirm write: pm.createTask — send for approval`) — `ProposalCard.test.tsx`'s a11y block pins
  the exact accessible name. Both inherit the shared `lux-btn` classes' global `:focus-visible` ring
  (no new focus style invented).
- No new color literal in any touched `.css` file — `src/styles/tokens.test.ts` (11 tests) still
  green after the additions; every new rule uses an existing `--status-*`/`--erp-*`/`--ink-*` token.
- The "new card appearing mid-stream must not spam a screen reader" requirement: a proposal card only
  ever mutates a handful of discrete times per turn (insert, then at most one more update at
  terminal) — never token-by-token like the typewriter, which is the only thing `role="log"`'s
  implicit-polite live region actually needed containing (`Message.tsx`'s existing `aria-live="off"`
  on the streaming row already covers that case; this ticket added no new per-token mutation source).
  This reasoning is the same one already established for `meta`/`citations` (ASST-12/18) on the same
  region — I did not invent a new pattern, I followed the existing one.
- Dark mode: no new pattern — every new CSS rule is a token reference, and the existing guard test
  (which fails the build if the two dark blocks in `colors.css` ever drifted) is untouched and green;
  I did not add any new color pair to `colors.css` at all (deliberately reused `--status-*` exactly
  as `RosterPanel`'s existing status chip does).

**NOT independently verified with a real screen reader.** No screen reader (NVDA/JAWS/VoiceOver) was
run against this surface. The claims above are code-level correctness (the right ARIA attributes and
live-region semantics exist, matching an established, previously-audited pattern on the same
component tree) — not an observed screen-reader session. This is the same honesty bar VER-03 itself
was held to per its own commit history; I am not aware of anything in this ticket that regresses
VER-03's audited fixes (verified by re-running `Message.test.tsx`'s two aria-live pins, still green),
but a fresh audit of the NEW surface (the proposal card, the composer toolbar) was not performed with
assistive tech.

## 8. The three required gates

```
npx tsc --noEmit
```
Clean (no output), run repeatedly through the session as files changed — last run against the final
tree: clean.

```
npm test
```
```
Test Files  123 passed (123)
     Tests  1321 passed (1321)
```
Baseline stated in the ticket was **1184 passed — not regressed** (1321 is higher; the delta beyond
this ticket's own new tests comes from other concurrent sessions' work already in this shared
checkout before I started — confirmed via `git status` at session start, e.g. `pmUrgency`/
`pmVocabulary`/`UrgencyChip`, none of which I touched).

```
DEMO_MODE=1 npm run build
```
Exit code 0. Full route table generated, including `/assistant` (`214 B, 123 kB` first-load — the
route was already an existing dynamic page; this ticket did not change its route shape).

## 9. What was ACTUALLY driven, vs. what is code-level-correct only

**Actually driven, real HTTP + a real browser (Chromium via Playwright, not a stub):**
- Started `DEMO_MODE=1 next dev -p 3010` (per the ticket's port instruction — the repo's own `npm run
  dev` script hardcodes `-p 3005`, which I deliberately avoided touching in case another concurrent
  session was using it).
- Logged in as a fresh demo identity with **zero** seeded threads (so this was NOT the seeded demo
  fixture data — a real "start from nothing" path).
- Clicked "+ New chat", checked "Use tools", selected `task-filer` from the real `<select>` populated
  by a real fetch to the demo capabilities endpoint.
- Sent "file a task for the redesign" in tools mode.
- **Observed the real DOM**: a `.asst-proposal` card appeared with state text "Awaiting your
  confirmation".
- Clicked the real "Confirm write: pm.createTask — send for approval" button.
- **Observed the real DOM transition**: state text became "Approved and executed", and a real
  `/approvals/demo-approval-demo-7` link appeared.
- This exercises: the composer affordance, the SSE `confirm_required` frame decode + live card
  render, the confirm action's real HTTP round trip, the local-override-then-prop-reconciliation
  logic, and the terminal executed state — end to end, in a real browser, against the real (demo)
  server process. The throwaway Playwright script used for this was deleted after the run; it was
  never committed and is not part of the shipped test suite (the shipped, permanent coverage for
  this same logic is `lib/demoAssistant.test.ts`'s function-level integration tests, §10).

**NOT driven this way (code-level-correct, verified only by unit/component/integration tests or by
reading the implementation):**
- The `rejected` / `execution_failed` / `not_executable` / `cancelled` card states — these require a
  human decision on a DIFFERENT approval outcome than "approve," which the demo fixture's own
  deliberate simplification (§10) doesn't produce through the UI click-path. They are exercised by
  `ProposalCard.test.tsx`'s constructed-props cases (real render, real DOM assertions, just not
  reached via a live click-through), and by `deriveProposalCardState`'s own exhaustive unit tests.
- The out-of-band pending-poll (§6) picking up a decision made in a **different tab/session** — the
  poll's own trigger condition and silent-refresh behavior are unit-tested
  (`hasPendingProposalDecision`) and code-reviewed against `ThreadView`'s loading-prop hazard, but no
  two-tab scenario was actually driven in a browser.
- No screen reader was run (§7).
- No `npx playwright test` run against the project's own committed e2e suite (the existing
  `src/**/*.spec.ts` Playwright specs, if any name `/assistant`) — I did not locate or extend one;
  the real-browser check in this report was a throwaway script, not an addition to the committed
  suite. If the QA gate (T5) wants a permanent Playwright spec for this flow, it does not yet exist.

## 10. DEMO_MODE fixtures added, and the one stated simplification

`lib/demoAssistant.ts` gained: `toolAgents` on the capabilities response; three new in-memory stores
(`assistant_tool_calls`/`assistant_write_intents`/a write-approval-lite store, all `globalThis`
singletons for the same cross-layer reason the existing stores already need it); send-time
mode/agent validation (400 on an unknown agent or mode, mirroring the real controller); a full
tool-turn SSE simulation (a read-only chip for `status-reporter`/`approvals-chaser`, a deterministic
`pm.createTask` draft for `task-filer`); and the confirm/dismiss endpoint handlers, including the
lazy-reap-on-expiry and 404/409 typed-refusal shapes.

**Stated simplification (also written into the code as a comment):** confirming a demo draft
resolves straight to `approved`+`executed`, rather than faking a second "a human decides later"
step — the same convention `DemoHandoff` already established for handoffs ("resolves instantly to
`ok`... no real runner to poll"). This is enough to drive the full card lifecycle end-to-end in
DEMO_MODE (proven in §9); the "a human decides out of band" half of the real state machine is a
live-stack-only proof, which is T5's job, not T4's demo fixture's job.

## 11. Blockers / follow-ups for the orchestrator

None block T4 itself. Noted for T5/whoever picks up next:
- No committed Playwright spec exists yet for `/assistant`'s tools-mode → confirm → executed flow —
  worth adding if T5 wants a permanent regression guard beyond `lib/demoAssistant.test.ts`'s
  function-level coverage.
- A real screen-reader pass over the new proposal card / composer toolbar has not been done by
  anyone (this ticket followed VER-03's established pattern by construction, but did not re-audit
  with assistive tech).
- `RunnerGoalDetail`/`goal.suspendedIntent`'s real shape (T2b, ai-agents) was read from the design
  doc and T3a/T3b's contract-doc entries, not from ai-agents source directly (out of this repo's
  scope) — if T2b's actual wire shape for `intent.args`/`impact` differs from what §7.2.5 documents,
  the FE decode is written against the DOCUMENTED contract and would need a one-line update, not a
  redesign.
