# Closing the confirm-chip bypass on handoffs — implementation report

**Ticket:** close the ASST-21/§7.2.5 scope note ("the handoff click is itself the explicit consent")
per the owner's 2026-08-07 ruling. Consumes: `docs/superpowers/plans/2026-08-06-asst-23-unblock-design.md`
§7 (T3b's confirm-chip mechanism, authoritative), `docs/superpowers/plans/2026-08-06-ver-asst23-cross-process-report.md`
(what was already proven cross-process). **platform-nest only** — no `ai-agents`/`platform-ui` file
touched (both explicitly off-limits per the dispatch: a sibling session owns `ai-agents`, and the PM
Phase 4 session has uncommitted work in `platform-ui`/`platform-nest/src/modules/pm/`, neither touched
here).

Status vocabulary per `docs/modules/MODULES.md`: this work is **DEV-VERIFIED** against the live test
stack (real PG + Cerbos), not yet deployed.

---

## 1. The gap, restated precisely

`broker.ts`'s chat-path tool turn (`runToolTurn`) sends `fileOnSuspend: false` unconditionally to the
agent-runner's `POST /goals` — a `high_write` suspends as an unfiled DRAFT the owner must confirm
in-thread (T3b). `handoffs.ts`'s `createHandoff` (the ASST-21 "hand off to a specialist" path) did
**not** send this flag at all, so it inherited the runner's own default (`fileOnSuspend` defaults to
`true` in `ai-agents/src/write-agent.ts`) — a `high_write` proposed by a handoff-driven specialist was
filed into `automation_approvals` and notified to every decider **the instant the goal suspended**,
with no owner confirmation step at all. This was a **known, explicit, DOCUMENTED design choice**
(§7.2.5 of the unblock design: "a handoff still files directly, because the handoff click itself is
the explicit consent" — restated in `docs/FRONTEND-BFF-CONTRACT.md`'s ASST-21/T3b sections and pinned
by a regression test in `assistant-write-intents.test.ts`), not an oversight — but the owner ruled it
should be closed, with this reasoning:

> Clicking "hand off to task-filer" is consent to RUN AN AGENT. It is not consent to THIS SPECIFIC
> WRITE with THESE SPECIFIC ARGUMENTS — which is exactly what the chip shows (redacted args) before
> anything is filed. A modal at handoff time would be consent to a blank cheque.

And the directive: **the same in-thread confirm chip, not a second modal, not an auto-file.**

## 2. The fix — reuse, not a second mechanism

### 2.1 `createHandoff` now defers filing too

`platform-nest/src/modules/assistant/handoffs.ts` — the `POST /goals` body `createHandoff` sends now
includes `fileOnSuspend: false`, byte-identical to `broker.ts`'s own chat-path request otherwise. A
read-only handoff (or one that never proposes a write) is unaffected — the flag is only ever consulted
on the runner's write-gate throw.

### 2.2 Harvesting a suspended handoff into the SAME confirm-chip tables

When `refreshHandoff` (called from every `GET :t/assistant/threads/:id/handoffs` poll — the run-watch
view's one read, already lazily re-synced from the runner on each call) observes
`goal.status === 'suspended' && goal.suspendedIntent`, a new function `harvestSuspendedIntent` writes,
in one transaction:

1. **One new `assistant_messages` row** — the in-thread confirm chip's home (a handoff never wrote a
   message into the thread before; this is the first one it ever produces, and only when it has
   something the owner needs to act on).
2. **One new `assistant_tool_calls` row** — `tool_name`/redacted `args` exactly as `broker.ts`'s own
   chat-path harvest writes them (same `redactToolArgs` function, imported, not reimplemented).
3. **One new `assistant_write_intents` DRAFT row** — the real (unredacted) args, `impact` (already the
   wire label, e.g. `"high"`, never re-derived), `status: 'draft'`, `expires_at` from the SAME
   `intentTtlMs()` config both paths share.

This is deliberately **not a second mechanism**. It is the identical three tables T3b already built,
written from a second call site. Consequences, all free:

- The existing `POST :t/assistant/threads/:id/tool-calls/:callId/confirm` / `.../dismiss` endpoints
  handle a harvested handoff intent with **zero code changes** — they key on `(tool_call_id,
  thread_id)`, and a harvested row's shape is indistinguishable from a chat-drafted one.
- The existing `GET :t/assistant/threads/:id` card-state join (T3a/T3b) surfaces it with **zero code
  changes** — same `assistant_tool_calls` ⨝ `assistant_write_intents` ⨝ `automation_approvals` query.
- `platform-ui`'s existing `ProposalCard` renders it with **zero FE code changes** (verified by
  reading `lib/assistant.ts`/`AssistantWorkspace.tsx`/`RosterPanel.tsx` — see §5's one caveat).
- Confirming a harvested intent files through the SAME `insertAutomationApprovalRow` the chat path and
  the n8n path use, attributed to `requestedBy = req.principal.userId` (the route's authenticated
  principal — the owner who is reading their own thread and clicking Confirm), **never** any
  handoff/agent identity, **never** a body field, **never** the row itself. This is what keeps the D14
  executor's re-drive principal and `resolve-and-execute`'s `requested_by` gate intact, unchanged.

### 2.3 Idempotency without a new migration

The synthesized `assistant_tool_calls.id` is the handoff's **own** `assistant_handoffs.id` — a
different table's primary-key space, so reusing the *value* has zero collision risk. A goal can
suspend **at most once ever** (`ai-agents/src/agent.ts` ends the goal at the first unresolved
`high_write` — the same invariant T2b's report already proved: "≤1 intent per message… the first
unresolved high_write throws and ends the goal"), so "does an `assistant_tool_calls` row with this id
already exist" is an exact, race-safe "have I already harvested this handoff's one-and-only
suspension" check. `refreshHandoff` calls the harvest on **every** poll while the goal is suspended;
after the first successful harvest every subsequent poll is one cheap `SELECT` that no-ops. No new
column, no new table, no migration — the migration ledger head (`0086_assistant_thread_title_backfill.sql`)
is unchanged by this ticket, verified with `ls migrations | sort | tail` before and after.

### 2.4 Locking

The harvest takes the same per-thread advisory lock `sendMessage` already uses before allocating a new
`seq` (so a concurrent chat turn on the same thread can never collide with a handoff harvest on
`assistant_messages`' `UNIQUE (thread_id, seq)`). That lock/namespace was previously private to
`assistant.controller.ts`; it is now extracted into a new, tiny shared module
`modules/assistant/thread-lock.ts` (`ASSISTANT_THREAD_LOCK_NS` / `lockAssistantThread`, byte-identical
semantics) so `handoffs.ts` can take it without creating a `handoffs.ts` ↔ `assistant.controller.ts`
import cycle (the controller already imports several functions FROM `handoffs.ts`).

## 3. Invariants re-verified for this path specifically

All six of the ticket's stated invariants hold, via the identical mechanism T3b already proved them
for on the chat path — restated here because this is a SECOND call site, not assumed to inherit them
for free:

1. **Authority** — `requestedBy` at confirm time is `req.principal.userId` (the route's authenticated
   principal), exactly as for a chat-drafted intent; `confirmWriteIntent` does not know or care whether
   the intent it is confirming came from a chat turn or a handoff harvest. Verified live: the filed
   `automation_approvals.requested_by` equals the owner who clicked Confirm, never the handoff's
   `agent` name.
2. **Owner-privacy** — confirm/dismiss are gated by the SAME `resource_assistant_thread.yaml`
   `confirm_write` rule, unconditionally on thread ownership; no new Cerbos rule, no new endpoint, so
   no new authz surface exists for this path to regress. (Not re-proven with a fresh non-owner/
   company_admin probe in this ticket's own tests — VER-02 already proved both directions generically
   against the SAME endpoints; a harvested intent enters those endpoints through the identical
   `WHERE tool_call_id = $1 AND thread_id = $2` lookup, so there is no code path by which the origin of
   the intent could change who is allowed to confirm it.)
3. **The args** — real args live ONLY in `assistant_write_intents.tool_args` between harvest and
   confirm (verified by direct SQL SELECT in the new test); the harvested `assistant_tool_calls.args`
   and every HTTP response (`GET …/handoffs`, `GET …/threads/:id`) carry only `redactToolArgs`'d shapes
   — verified by asserting the planted secret string is absent from every response body.
4. **Single-winner claim** — unchanged; a harvested intent is confirmed through the exact same
   `confirmWriteIntent` claim UPDATE (`WHERE … AND status='draft' AND expires_at > now()`) that already
   has an 8-way genuine-concurrency proof (`assistant-write-intents.test.ts`'s existing case) and a
   separate mixed confirm/dismiss race proof (`assistant-write-intents-t5-qa.test.ts`). Not re-driven
   against a harvested row specifically in this ticket (the claim SQL has no branch on provenance —
   there is nothing about a harvested row that could behave differently), but flagged here rather than
   silently assumed.
5. **Unconfirmed intents notify nobody** — verified live: `automation_approvals` row count and
   `notifications` row count (for the tenant's `company_admin` decider) are both asserted UNCHANGED
   immediately after the harvest (including after a second, idempotent poll), and only increase after
   the owner's own confirm call.
6. **Shape-identical rows** — the confirmed row is inserted via `insertAutomationApprovalRow`, the
   exact function the chat path and the n8n path both call; verified live by reading back
   `requested_by`/`origin`/`workflow_id`/`tool_name`/`tool_args` on the filed row.

## 4. Files touched (all absolute paths)

- `c:/Users/Hansel/Documents/Hansel/Projects/gaiada-system/gaiada-system/platform-nest/src/modules/assistant/handoffs.ts`
  — `createHandoff` sends `fileOnSuspend:false`; new `RunnerSuspendedIntent`/`suspendedIntent` on
  `RunnerGoalDetail`; new `harvestSuspendedIntent`; `refreshHandoff` calls it when applicable.
- `c:/Users/Hansel/Documents/Hansel/Projects/gaiada-system/gaiada-system/platform-nest/src/modules/assistant/thread-lock.ts`
  (NEW) — `ASSISTANT_THREAD_LOCK_NS`/`lockAssistantThread`, extracted verbatim from
  `assistant.controller.ts` so both files can share it without an import cycle.
- `c:/Users/Hansel/Documents/Hansel/Projects/gaiada-system/gaiada-system/platform-nest/src/modules/assistant/assistant.controller.ts`
  — imports the extracted lock helper instead of defining it privately; no behavioral change.
- `c:/Users/Hansel/Documents/Hansel/Projects/gaiada-system/gaiada-system/platform-nest/src/modules/assistant/broker.ts`
  — comment-only update: the stale claim that the handoff path is "deliberately NOT touched" is
  corrected to point at the new harvest.
- `c:/Users/Hansel/Documents/Hansel/Projects/gaiada-system/gaiada-system/platform-nest/src/modules/assistant/assistant-write-intents.test.ts`
  — the old "handoff files directly, no confirm gate" regression pin is REWRITTEN (not deleted) into
  its successor: a new `describe` block with 3 cases (fileOnSuspend now sent; the full harvest→confirm
  happy path with the notify/redaction/idempotency assertions above; a non-suspending handoff harvests
  nothing).
- `c:/Users/Hansel/Documents/Hansel/Projects/gaiada-system/gaiada-system/docs/FRONTEND-BFF-CONTRACT.md`
  — ASST-21's "deferred" bullet marked CLOSED; the T3a/T3b sections' now-stale "handoff still files
  directly" claims annotated SUPERSEDED (not silently rewritten — the original text is kept, dated); a
  new dated addendum section "Closing the handoff confirm-chip bypass (2026-08-07)" added.

**Endpoints added/changed:** none. No new route. `POST :t/assistant/threads/:id/handoff`'s outbound
call to the runner gained one field (`fileOnSuspend:false`); every existing endpoint's request/response
shape is unchanged.

**Migrations:** none. Ledger head verified unchanged (`0086_assistant_thread_title_backfill.sql`).

**Cerbos:** unchanged. No new resource, no new action, no policy edit — the harvested intent flows
through the existing `confirm_write` rule on `assistant_thread`.

## 5. The one FE finding — reported, not fixed (out of `senior-be` scope)

`platform-ui/src/components/assistant/RosterPanel.tsx`'s run-watch poll (`hasActiveHandoff`) refreshes
only `GET …/handoffs`; `AssistantWorkspace.tsx`'s own silent thread-refresh poll only engages once
`hasPendingProposalDecision(messages)` is already true, i.e. once the harvested message is already
present in the fetched `messages` array. Net effect: a harvested handoff intent is correctly filed-only
-on-confirm and fully reachable/confirmable (the security property this ticket exists to fix), but if
the user is sitting on an already-open thread when the handoff suspends, the new confirm-chip message
may not appear until they reload the thread or navigate away and back — a UX-latency gap, not a safety
regression. No `platform-ui` file was read-write touched to fix this (out of scope for this ticket and
this seat); recommended minimal follow-up: have `RosterPanel`'s poll also trigger
`AssistantWorkspace`'s silent thread refresh once any handoff's status is `'suspended'`.

This is the one “genuinely cannot reach the chip” caveat the dispatch asked to be reported instead of
worked around with an invented mechanism — except the harvest DOES reach the chip; the gap is purely in
how promptly the FE notices it, which does not change who can confirm it or what confirming requires.

## 6. Test results (actual output)

### `npx tsc --noEmit -p tsconfig.json`
```
EXIT:0
```
Clean.

### `npm run lint:withtenants`
```
[lint-withtenants] OK — scanned 277 files; all withTenants() calls are single-tenant, or an explicitly
reasoned allowlist entry.
```
PASS.

### `npm run lint:migration-rls`
```
[lint-migration-rls] OK -- scanned 85 migrations (53 baselined, 32 enforced); no unguarded FORCE-RLS
backfills found.
```
PASS (no migration in this ticket, so no new lines were scanned — expected, confirms nothing was
added).

### `npm run test:mail-corpus`
```
Test Files  24 passed (24)
     Tests  195 passed (195)
```
PASS. (Unaffected area — run per the gate requirement.)

### Targeted assistant suites (`assistant-write-intents.test.ts`, `assistant-handoff.test.ts`,
`assistant-broker.test.ts`, `assistant-stream.test.ts`, `assistant-qa-adversarial.test.ts`,
`assistant.test.ts`, `assistant-capabilities.test.ts`, `assistant-citations.test.ts`,
`assistant-memory.test.ts`, `assistant-thread-title.test.ts`, `assistant-write-intents-t5-qa.test.ts`,
`asst19-quarantine-qa.test.ts`, `context-memory.test.ts`, `db/module-assistant-rls.test.ts`,
`admin/intelligence.test.ts`, `rbac/cerbos-agent-run.test.ts`):
```
Test Files  17 passed | 1 skipped (18)
     Tests  170 passed | 2 skipped (172)
```
PASS. Includes the new "handoff-initiated writes now reach the confirm chip" block (3/3 new cases
green) and the full pre-existing ASST-21/T3a/T3b/D14-agent-origin/owner-privacy suites, all still
green — no regression.

### `npm test` (full suite, gate 5)

[[FULL-SUITE-RESULT-PLACEHOLDER — see §7 for the live run status at time of writing this section;
updated below once the background run completes.]]

## 7. Orphan test-DB count

Before this session's work: `SELECT count(*) FROM pg_database WHERE datistemplate=false AND
datname<>'postgres'` → **1** (`gaiada_platform_test`, the persistent shared test DB every suite in
this repo reuses — not itself an orphan; `teardownTestDb()` never drops it, per the standing memory).

After: [[to be re-checked after the full suite completes]].
