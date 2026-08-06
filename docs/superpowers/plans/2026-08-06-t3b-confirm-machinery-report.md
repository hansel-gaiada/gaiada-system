# T3b report — the confirm-before-file machinery (ASST-23 §7.2)

**Ticket:** `docs/superpowers/plans/2026-08-06-asst-23-unblock-design.md` §7.6 (T3b), §7.2 is the
ruled state machine. **Seat:** senior-be. **Date:** 2026-08-06. **Depends on:** T3a (landed,
`c46b249`/`4a61034` lineage) — this ticket builds on the write-map contract, step-0.5 registry gate,
and card-state join T3a shipped; T2b (landed, `82d3643`) — the runner's `fileOnSuspend`/
`suspendedIntent` contract this ticket's broker changes consume.

## Scope built

Everything §7.6/T3b names: the `assistant_write_intents` migration, the confirm/dismiss endpoints,
the filing extraction (`fileAutomationApproval` → shared core), the Cerbos `confirm_write` edit, and
the broker rewiring that makes the runner's `fileOnSuspend:false` contract this ticket's ONLY
suspended-write path. No `ai-agents` files touched (T2b already shipped the runner-side contract this
ticket consumes as a fait accompli).

## §7.2 read against the code — one place the design's literal SQL does not work as written

§7.2.3 gives the claim as a single UPDATE that both nulls `tool_args` and `RETURNING`s it:

```sql
UPDATE assistant_write_intents SET status='filed', approval_id=$new, tool_args=NULL
 WHERE id=$1 AND status='draft' AND expires_at > now() RETURNING tool_args
```

Taken literally this returns **NULL**, not the real args — Postgres's `RETURNING` reflects the
row's post-`SET` state, so a column set to `NULL` in the same statement returns `NULL`. I did not
diverge silently: I split this into three statements on the SAME connection/transaction — (1) claim
+ mark `filed`, `RETURNING tool_args` (NOT yet nulled), (2) `insertAutomationApprovalRow` with those
real args, (3) a second `UPDATE … SET tool_args = NULL`. All three are still one Postgres transaction
(the `withTenants` callback the endpoint runs inside), so the atomicity guarantee §7.2.3 actually
cares about — claim/file/scrub commit or roll back together — holds exactly as specified; only the
literal single-statement shape was infeasible as quoted. Flagging this per the "say so loudly" the
brief the ticket asked for.

## A real bug the test suite caught (worth naming, not just fixing quietly)

First implementation had `resolveLostClaim` (the double-click / already-filed / dismissed / expired
resolver) **throw** `ConflictException` from inside the confirm/dismiss transaction on a conflict
outcome. That is wrong: NestJS's `HttpException` thrown inside a `withTenants` callback propagates
out through the `catch → ROLLBACK` in `db/index.ts`'s `withTenants` — which rolls back **the very
reap-on-expiry UPDATE** the same function had just run, undoing the "flip to expired + scrub
`tool_args`" side effect the design requires to actually persist. My own "expiry (confirm claim)"
test caught this immediately (DB still showed `status:'draft'` with the real args intact,
post-refusal). Fixed by making `confirmWriteIntent`/`dismissWriteIntent`/`resolveLostClaim` return a
discriminated `ConfirmOrDismissOutcome` (`ok | not_found | conflict`) and NEVER throw; the controller,
strictly AFTER `withTenants(...)` has committed, is the only place that turns `not_found`/`conflict`
into the actual HTTP exception. This is the general lesson: **any DB write inside a transaction that
is meant to survive a "this request is being refused" outcome must not share that transaction with
the throw that reports the refusal.**

A second smaller thing the same test pass caught: this codebase's global `HttpErrorFilter`
(`http-error.filter.ts`) reshapes every `HttpException` body down to `{error, field?}`, reading only
`response.message`. Passing a structured object (`{error, status}`) to `ConflictException` without a
`message` key silently loses the payload to Nest's own default `exception.message` ("Conflict
Exception") — so the row's actual status must be named IN the message text, asserted by callers via
substring match, not a structured field. Documented at the throw site so the next edit doesn't
reintroduce it.

## Files touched

- `platform-nest/migrations/0085_assistant_write_intents.sql` (NEW) — re-verified the ledger head at
  authoring time (`ls migrations | sort | tail` → `0084_assistant_handoffs.sql`, confirmed again
  immediately before the full-suite run, no collision either time). Brand-new table, zero DML,
  composite tenant-scoped FK to `assistant_tool_calls` (`ON DELETE CASCADE`), `UNIQUE (tool_call_id)`
  on a NOT-NULL column (checked against the "NULL defeats UNIQUE" trap explicitly — does not apply),
  the standard two-sided `tenant_isolation` RLS policy (mod=`'assistant'`).
- `platform-nest/src/core/approval-filing.ts` (NEW) — `insertAutomationApprovalRow(c, id, input)`
  (the bare INSERT, caller-supplied client + id, for composing into someone else's transaction),
  `notifyApprovalFiled(id, input)` (the activity-log + decider-notification half, split out so a
  caller whose INSERT ran on a different connection/transaction can still run it, as a separate
  best-effort step, strictly AFTER that transaction commits), `fileAutomationApproval(input)` (the
  pre-extraction shape: INSERT + notify, its own transaction — what `create()` now calls).
- `platform-nest/src/core/automation-approvals.controller.ts` — `create()` is now a thin wrapper over
  `fileAutomationApproval`; added one guard (`if (!req.principal.userId) throw
  BadRequestException(...)`, matching the codebase's own idiom elsewhere) since `FileApprovalInput
  .requestedBy` is typed `string`, not `string | null`. Everything else in this file (detail/list/
  decide/retry/resolve-and-execute) untouched.
- `platform-nest/src/modules/assistant/write-intents.ts` (NEW) — `confirmWriteIntent`,
  `dismissWriteIntent`, `reapExpiredIntents` (thread-wide lazy reap for `GET thread`), `intentTtlMs()`
  (reads `config.assistantIntentTtlMs`), the `ConfirmOrDismissOutcome` discriminated result type.
- `platform-nest/src/modules/assistant/broker.ts`
  - `POST /goals` body now ALWAYS sends `fileOnSuspend: false` (harmless for read-only agents, which
    never suspend; the handoff path — `handoffs.ts` — is a separate goal-submission call, untouched).
  - `RunnerGoalDetail` gains `suspendedIntent?: {tool, impact, args} | null` (T2b's contract);
    `approvalId` is now documented as legacy/defensive (kept, not deleted — see below).
  - `BrokerEmit` gains `confirmRequired`; `ToolTurnResult` gains `intent?: SuspendedIntentResult`
    (REAL, unredacted args + a pre-generated `id`/`toolCallId` pair, mirroring how `BrokerToolCallRecord
    .id` is already pre-generated so the SSE frame and the eventual DB rows agree on ids without a
    second round trip).
  - The suspended branch of `runToolTurn` now branches on `goal.suspendedIntent` FIRST (this broker's
    real, only-mode-today path: redact, emit `confirm_required`, return `intent` for the caller to
    persist) and falls back to the legacy `goal.approvalId` shape only if a runner ever ignores the
    flag — kept as a defensive branch, not deleted, with a third fallback (`errorKind:"intent_lost"`)
    for the (currently unreachable, in-repo-untestable) case where the runner reports `suspended` with
    neither shape (the "sub-second worst case" §7.2.4 names — a runner restart between `finishGoal`
    and the broker's poll evicting the in-memory intent).
- `platform-nest/src/modules/assistant/assistant.controller.ts`
  - `stream()`: wires `emit.confirmRequired`; the tool-turn persist transaction now also INSERTs
    `assistant_write_intents` (status `'draft'`) when `turn.intent` is present, AFTER
    `persistToolCalls` in the SAME transaction (so the composite FK to the just-inserted tool_call row
    resolves).
  - `getThread()`: calls `reapExpiredIntents(c, id)` before the message/tool-call SELECT, same
    transaction. `fetchToolCallsByMessage` extended to LEFT JOIN `assistant_write_intents` by
    `tool_call_id`; `ThreadToolCall.intent: {status, expiresAt} | null`, null once `approvalId` is
    set (the approval join "takes over", per §7.2.1). The effective `approvalId` for a row is
    `COALESCE(tc.approval_id, wi.approval_id)` — the confirm-chip path never writes `tc.approval_id`
    at turn time (nothing was filed yet), so the intent row's OWN `approval_id` is where a confirmed
    call's approval id actually comes from.
  - NEW `POST :tenantId/assistant/threads/:id/tool-calls/:callId/confirm` and `.../dismiss` — owner-only
    (Cerbos `confirm_write`), no request body consumed at all (§7.2.4: a confirm cannot carry args).
- `platform-nest/cerbos/policies/resource_assistant_thread.yaml` — `confirm_write` added to the ONE
  existing owner rule's action list (same file, same condition, no new rule, no admin path).
  **`gaiada-test-cerbos` restarted** (verified necessary — the FIRST test run before the restart
  denied every confirm/dismiss call, including the owner's own, with a flat 403 across the board; the
  exact silent-DENY-on-an-unlisted-action signature the standing note warns about. Post-restart, an
  owner-ALLOW and non-owner-DENY smoke check both passed live, folded into the real test suite rather
  than a separate throwaway probe).
- `platform-nest/src/modules/assistant/stream.ts` — `AssistantSseEvent` gains `"confirm_required"`.
- `platform-nest/src/modules/assistant/assistant-qa-adversarial.test.ts` — `noopEmit()` fixture
  updated (`BrokerEmit` gained a required field; one-line fix, unrelated test logic untouched).
- `platform-nest/src/config.ts` — `assistantIntentTtlMs` (env `ASSISTANT_INTENT_TTL_MS`, default 1h).
- `platform-nest/src/db/module-assistant-write-intents-rls.test.ts` (NEW) — FORCE RLS + one policy,
  module-wall probe, cross-tenant probe, `UNIQUE (tool_call_id)` probe, cascade-through-messages/
  tool_calls probe, status CHECK probe. Mirrors `module-assistant-rls.test.ts`'s established pattern.
- `platform-nest/src/modules/assistant/assistant-write-intents.test.ts` (NEW) — the confirm-machinery
  suite; see below.
- `platform-nest/migrations/README.md` — numbering log entry for `0085` (re-verification note).
- `docs/FRONTEND-BFF-CONTRACT.md` — new "T3b" addendum under §18.

## Endpoints added / changed

- **NEW** `POST /api/:tenantId/assistant/threads/:id/tool-calls/:callId/confirm` — owner-only, no
  body. `200 {intentId, status:'filed'|'<idempotent current status>', approvalId, approval}`;
  `409 {error}` (message names the row's actual status) if the row is terminal in the OTHER direction
  or expired; `404` if no draft exists for that `callId`.
- **NEW** `POST /api/:tenantId/assistant/threads/:id/tool-calls/:callId/dismiss` — same shape, opposite
  target status, no filing ever.
- **CHANGED (additive)** `GET /api/:tenantId/assistant/threads/:id` — `messages[].toolCalls[].intent:
  {status, expiresAt} | null`.
- **CHANGED (additive)** `GET .../stream` — new non-terminal SSE frame `confirm_required`; terminal
  frame for this path is `error` + `errorKind:'confirm_required'`.
- **UNCHANGED** `POST /api/:tenantId/automation-approvals` (`create()`) — byte-identical behaviour
  (verified: `automation-approvals.test.ts`, 15/15 green, unmodified file).

## Test results (real output)

Orphan count before this session's work: `2` non-template databases (`select count(*) from
pg_database where datistemplate=false and datname<>'postgres'`). Checked again mid-run (`1`) — the
per-file `teardownTestDb()` is dropping its DB promptly, no accumulation observed at any snapshot
taken during this session's several dozen `vitest run` invocations.

```
$ npx tsc --noEmit
(clean, no output)
```

```
$ npm run lint:migration-rls
[lint-migration-rls] OK -- scanned 84 migrations (53 baselined, 31 enforced); no unguarded FORCE-RLS
backfills found.
```

```
$ npx vitest run src/db/module-assistant-write-intents-rls.test.ts
 ✓ src/db/module-assistant-write-intents-rls.test.ts (6 tests) 2427ms
 Test Files  1 passed (1)
      Tests  6 passed (6)
```

```
$ npx vitest run src/db/module-assistant-rls.test.ts src/core/automation-approvals.test.ts \
  src/core/d14-17-assistant-write-registry.test.ts
 ✓ src/core/automation-approvals.test.ts (15 tests)
 ✓ src/core/d14-17-assistant-write-registry.test.ts (11 tests)
 ✓ src/db/module-assistant-rls.test.ts (10 tests)
 Test Files  3 passed (3)
      Tests  36 passed (36)
```

```
$ npx vitest run src/modules/assistant/assistant-broker.test.ts
 ✓ src/modules/assistant/assistant-broker.test.ts (18 tests) 5575ms
 Test Files  1 passed (1)
      Tests  18 passed (18)
```
(Every pre-existing test in this file — incl. the LEGACY `approvalId`-filed-at-turn-time "suspended
write" and "card state" cases — stayed green, unmodified, exercising broker.ts's kept-not-deleted
fallback branch. This is what proves the fallback branch is real code, not dead code nobody checked.)

```
$ npx vitest run src/modules/assistant/
 ✓ 11 files passed | 1 skipped (12)
      Tests  107 passed | 2 skipped (109)
```
(Full pre-existing assistant module suite, run again after ALL of this ticket's changes — same 107
passing as T3a's own report recorded, zero regressions.)

```
$ npx vitest run src/modules/assistant/assistant-write-intents.test.ts
 ✓ src/modules/assistant/assistant-write-intents.test.ts (14 tests) 5459ms
 Test Files  1 passed (1)
      Tests  14 passed (14)
```

The 14 T3b-specific cases, by name:
1. a suspended write drafts an `assistant_write_intents` row and surfaces `confirm_required` — no
   approval filed, no decider notified, real title never on the wire, DB-level redaction check on
   BOTH the intent row (real) and the ledger row (redacted).
2. confirm files an `origin='agent'` approval attributed to the OWNER, scrubs the intent's real args,
   notifies the decider (notification count delta = +1, checked against `notifications`).
3. a confirmed intent flows through the EXISTING `decide()`/`executeApprovedAutomationWrite()` chain
   unchanged, card shows executed, **and** `executed_by = owner` while `decided_by = admin` at the DB
   — the anti-privilege-amplification invariant, checked directly, not inferred.
4. a confirmed intent against an ARCHIVED project still fails closed at execution
   (`precondition_failed:project_archived`, hub never called) — through the NEW confirm path
   specifically, proving §2's WD-29 precondition re-check is unaffected by where the filing came from.
5. **8 concurrent confirm requests against the SAME draft, via real parallel `app.inject` calls
   (`Promise.all`, not sequential)** — every response 200, every response reports the identical
   `approvalId`, and the `automation_approvals` row count for the tenant increased by EXACTLY 1, not
   8. This is the genuine-concurrency test the brief asked for, using this codebase's own established
   idiom for the same class of claim (mirrors `pm-short-codes.test.ts`'s "GENUINE CONCURRENCY — real
   parallel HTTP requests" framing and `client-invites.test.ts`'s 8-way race).
6. dismiss discards the draft, files nothing, notifies nobody, scrubs `tool_args`.
7. dismissing an already-dismissed draft is idempotent (200), not a 409.
8. confirm after dismiss is refused typed (409), zero new filing.
9. dismiss after confirm is refused typed (409).
10. expiry via the confirm claim itself: refused typed (409), and the claim's OWN refusal reaps the row
    (status→`expired`, `tool_args`→NULL) — this is the test that caught the rollback bug above.
11. expiry via `GET thread`'s lazy reap: a stale draft is still `'draft'` in the DB until something
    reads the thread, then flips to `expired` + scrubs, with no background job anywhere.
12. confirm/dismiss are owner-only: a different same-company user AND a real `company_admin` are BOTH
    denied 403 on both endpoints (the VER-02 pattern, applied to `confirm_write`) — then the real owner
    still confirms successfully afterward, proving the intruders' attempts left the row untouched.
13. confirming/dismissing a `callId` with no draft at all is a 404.
14. the §7.2.5 scope note, driven LIVE: a real `POST …/handoff` call's own goal submission (unchanged
    `handoffs.ts`) never sends `fileOnSuspend` at all — a suspended handoff would still file
    immediately, exactly as before this ticket.

```
$ npx vitest run
 (full suite — 244 files / ~3367 tests; launched in the background, ~15+ min runtime historically)
```
**UNVERIFIED at time of writing** — running in the background when this section was drafted; the
addendum at the end of this document reports its actual, real result once it lands (per the "a 200 is
not a pass" / "paste real output" instruction — this report will not claim a full-suite pass it has
not yet observed).

## PASS / FAIL / UNVERIFIED

- **PASS** — `tsc --noEmit` clean.
- **PASS** — `lint:migration-rls` clean (no unguarded FORCE-RLS backfill; migration 0085 has zero DML
  by construction).
- **PASS** — migration 0085's RLS shape: FORCE RLS + one policy, module-wall two-sided handshake,
  cross-tenant isolation, `UNIQUE (tool_call_id)` (checked NOT-NULL, so the "NULL defeats UNIQUE" trap
  does not silently disable it), cascade-through-messages/tool_calls, status CHECK — all live-verified
  against real Postgres under the NOBYPASSRLS app role.
- **PASS** — single-winner claim under GENUINE concurrency (8-way real parallel HTTP race, not a
  sequential re-call): exactly one filing, every response consistent.
- **PASS** — the args custody chain: real args exist ONLY in `assistant_write_intents.tool_args`
  between draft and confirm, NULL in every terminal direction (filed/dismissed/expired), never
  re-derived at confirm time (read from the claim's own `RETURNING`), never on the wire (redacted SSE
  frame + redacted ledger row), byte-identical between the intent's real copy and the filed
  `automation_approvals.tool_args`.
- **PASS** — authority: `requested_by` on the filed row is always the CHATTING USER (never the
  approver), verified at the DB alongside `decided_by`/`executed_by` in the same test — the anti-
  privilege-amplification invariant checked directly rather than assumed from D14's own (unmodified)
  correctness.
- **PASS** — filing extraction: `fileAutomationApproval`/`insertAutomationApprovalRow` shared between
  `create()` (n8n path, unmodified behaviour, 15/15 automation-approvals tests green) and the confirm
  machinery; a confirmed row is shape-identical (proven by driving it through the SAME
  `decide()`/`executeApprovedAutomationWrite()` D14 chain T3a's own card-state test used, unmodified).
- **PASS** — expiry: TTL config-driven, lazily reaped both at the claim boundary (structural refusal)
  and at `GET thread` (opportunistic sweep), no background job, both paths tested directly including
  the DB-level NULL assertion on `tool_args`.
- **PASS** — endpoints are owner-only: a non-owner AND a real `company_admin` both 403 on confirm AND
  dismiss (VER-02's pattern, extended to the new action).
- **PASS** — zero-notification pre-confirm: no decider bell/mail exists until `notifyApprovalFiled`
  runs, which only happens once (`justFiled` gate), after the filing transaction commits, never on an
  idempotent replay.
- **PASS** — Cerbos: `confirm_write` added to the existing owner rule; `gaiada-test-cerbos` restarted
  (verified NECESSARY — pre-restart run denied everything, including the owner, a live demonstration
  of the silent-DENY trap); owner-ALLOW + non-owner-DENY both verified post-restart.
- **PASS** — regression: `automation-approvals.test.ts` (n8n/`create()` path) and the full
  `src/modules/assistant/` suite (107 tests) both green, unmodified, after every change in this ticket.
- **PASS** — a design defect found and fixed, not routed around: §7.2.3's literal single-UPDATE claim
  SQL cannot both null `tool_args` and `RETURNING` its pre-null value in one statement (see the section
  above) — resolved with an equivalent three-statement, one-transaction claim; and the
  throw-inside-the-transaction rollback bug the test suite caught (see above).
- **UNVERIFIED (at time of writing)** — the full `npx vitest run` (~244 files, all suites). Every file
  this ticket touched, plus its nearest neighbours (the full assistant module, the automation-approvals
  surface, D14-17's registry test, the new RLS test), has already been independently run green above;
  the full run is the no-blind-spots confirmation, not the first evidence of correctness. **Addendum
  below reports the real result once observed** — this document will be updated in place, not
  represented as passing before that happens.
- **N/A** — no `ai-agents` files were opened; T2b's runner-side contract was consumed as-is, read but
  not modified.

## Blockers / follow-ups

None load-bearing for T3b's own acceptance. Named for T4 (FE) and T5 (QA) to pick up:
- T4 needs the exact `confirm_required` SSE shape (`{callId, toolName, intentId, args, impact,
  expiresAt}`) and the `toolCalls[].intent` GET-thread shape — both in the contract addendum.
- T5's adversarial pass should still independently re-drive the concurrency test at a larger N if it
  wants a second data point beyond this ticket's 8-way race, and should verify the mail/notification
  tap (MAIL-05) actually delivers for `notifyApprovalFiled`'s post-commit call, not just that
  `notifications` rows appear (this ticket verified the row, not the outbound tap — MAIL-05 is a
  separate, already-tested surface this ticket did not re-verify).
- The design's §7.2.3 literal SQL divergence (see above) should be folded back into the design doc's
  own text if that document is revised again, so a future reader does not re-discover the same
  RETURNING-sees-post-SET-state fact.

## Addendum — full-suite result

*(to be filled in once the background `npx vitest run` completes)*
