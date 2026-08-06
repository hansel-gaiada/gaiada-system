# T2b — `ai-agents` runner support for deferred filing (confirm-before-file) — report

**Ticket:** T2b, per `docs/superpowers/plans/2026-08-06-asst-23-unblock-design.md` §7.2.5 (the
runner leg of the confirm-chip mechanism ruled in §7). Scope: `ai-agents/` only. No commit made —
tree left dirty for review, per instructions.

## Summary

Added a per-goal `fileOnSuspend?: boolean` option (default `true`) to `runWriteAgent` and to
`POST /goals`. When explicitly `false`, a suspended `high_write` is captured as a `SuspendedIntent`
(tool, wire-mapped impact, real args) instead of being filed through the hub's `approvals.request`.
The intent is held in a new in-memory, per-process, per-goal TTL map inside `buildRunnerApp`
(default ~15 min, `AGENT_INTENT_TTL_MS`) and merged into `GET /goals/:id` as `suspendedIntent`,
absent once evicted. No agents-DB migration; no schema change; nothing here calls the hub on the
deferred path.

## Files touched

- `ai-agents/src/write-agent.ts` — `WriteAgentOptions` (`fileOnSuspend`), `SuspendedIntent` type, the
  new `filed: null` shape on `WriteAgentResult`'s `"suspended"` status, `runWriteAgent`'s new 7th
  (optional) parameter and its catch-branch fork. Reuses `toWireImpact` (T1's helper) for the
  deferred path's `impact` field rather than duplicating the mapping.
- `ai-agents/src/write-agent.test.ts` — new `describe("T2b — …")` block (7 tests): default/`{}`/
  explicit-`true` byte-identical to pre-T2b; `false` never calls `approvals.request`; the intent's
  `impact` equals `toWireImpact("high_write")`; D13 still gates before the write gate is reached;
  `fileOnSuspend` has no effect on an all-reads `completed` run. Also fixed two pre-existing
  assertions (`res.filed.approvalId` / `res.filed.impact`) that no longer compile now that
  `WriteAgentResult`'s `"suspended"` status has two shapes — see "Compile-time fallout" below.
- `ai-agents/src/runner/service.ts` — `runnerConfig.intentTtlMs` (env `AGENT_INTENT_TTL_MS`, default
  15 min); two new per-app in-memory maps (`goalOptionsById`, `suspendedIntentsById`); `mapWriteResult`
  now explicitly branches on `res.filed === null` instead of assuming `filed` is always present;
  `processGoal`'s write-specialist branch reads+deletes the per-goal option, forwards it to
  `runWriteAgent`, and parks a `filed:null` result's intent into the TTL map; `POST /goals` accepts
  and validates `fileOnSuspend` (400 on non-boolean), stores an entry ONLY when explicitly `false`
  (the default costs zero map memory), and cleans up on the queue-full race path; `GET /goals/:id`
  merges an unexpired `suspendedIntent` in after the tenant-scoped lookup already succeeded (so the
  existing 404-before-probing guarantee covers the intent for free), and lazily evicts an expired
  entry on that same read.
- `ai-agents/src/runner/service.test.ts` — new tests (8) exercising the real HTTP path end to end:
  default byte-identical (no `suspendedIntent` ever appears on the filed path), `fileOnSuspend:false`
  suspends with zero hub calls and a merged `suspendedIntent`, the agents-DB-never-holds-raw-args
  proof (reads the store row directly, greps for a marker string), explicit `true` parity, the
  ≤1-intent-per-message shape (first attempt only, budget/goal ends before a second is possible),
  a 400 on a non-boolean `fileOnSuspend`, TTL expiry (tiny configurable TTL, distinguishable from
  404), and the supervisor-delegation scope boundary (flag has no effect on a delegated sub-run — see
  "Divergence/scope note" below). Also added an `intentTtlMs` passthrough to the test file's `build()`
  helper, careful not to unconditionally spread `intentTtlMs: undefined` into the runner config (that
  would silently zero every non-TTL test's default via `{...runnerConfig, ...deps.config}`).
- `ai-agents/src/orchestrator.ts` — one line: `GoalSuspendedError(name!, res.filed ? res.filed.approvalId : null, blackboard)`
  instead of `res.filed.approvalId` unconditionally. Compile-time fallout only (see below); the
  orchestrator never requests deferred filing, so `res.filed` is non-null here in every real run.
- `ai-agents/src/cli.ts` — same class of fix: the "suspended" output branch now checks `r.filed`
  before dereferencing it, with a defensive fallback message for the (unreachable, from the CLI)
  `null` case.
- `ai-agents/src/approval-resume.test.ts` — one line (`res.filed?.approvalId` instead of
  `res.filed.approvalId`), compile-time fallout only, no behavior change.

### Compile-time fallout (not asked for by name, but required for `tsc --noEmit` clean)

`WriteAgentResult`'s `"suspended"` status now has two shapes (`filed: FiledApproval` vs.
`filed: null; intent: SuspendedIntent`). Every place in `ai-agents/src` that narrowed on
`res.status === "suspended"` alone and then dereferenced `res.filed.X` unconditionally stopped
compiling, because TypeScript correctly widens `res.filed` to `FiledApproval | null` in that branch.
Three call sites outside the four files named in the ticket's file list hit this:
`orchestrator.ts:190`, `cli.ts:34`, `approval-resume.test.ts:112`. All three were fixed with a
one-line null-check/optional-chain and a comment explaining why the null branch is unreachable in
practice for that specific caller (none of them requests deferred filing). This is a mechanical
consequence of the type change, not new functionality, and it is the only way `tsc --noEmit` can be
clean across the whole package with the contract as specified — flagging it explicitly since it
wasn't itemized in the ticket's file list.

## Endpoints changed

`POST /goals` (ai-agents runner, internal service — not a `platform-nest` `/api/:tenantId/*`
endpoint): body gains optional `fileOnSuspend?: boolean` (default `true`); 400 if present and not a
boolean. `GET /goals/:id`: response gains optional `suspendedIntent?: { tool, impact, args }`,
present only while an intent is filed-pending-confirmation and unexpired.

## Test results (real output)

```
$ npx tsc --noEmit
(no output — clean)

$ npx vitest run
 Test Files  16 passed | 6 skipped (22)
      Tests  150 passed | 45 skipped (195)
   Start at  14:41:16
   Duration  15.56s
```

Before this ticket: 135 passed / 45 skipped (per the ticket's stated baseline). This ticket added 15
tests (7 in `write-agent.test.ts` + 8 in `runner/service.test.ts`): 135 + 15 = 150, matching exactly.
`agent-write-guard.test.ts` — unchanged, still 5/5 (this ticket never touches an `AgentDef`'s `tools`
map, so the guard's allowlists are untouched).

## Invariant-by-invariant verdict

1. **`fileOnSuspend` defaults to true; every existing caller byte-identical — PASS.**
   Proven by a test, not asserted in prose: `write-agent.test.ts`'s "default (no 7th arg at all)"
   and "opts:{} (present but empty)" tests both assert the filed (non-null) shape and that
   `approvals.request` was called; `runner/service.test.ts`'s "T2b default (fileOnSuspend omitted)"
   drives the real HTTP path and asserts `suspendedIntent` never appears. Every pre-existing caller
   (`cli.ts`, `orchestrator.ts`'s delegated writes, `approval-resume.test.ts`, the pre-T2b tests in
   `write-agent.test.ts`/`service.test.ts`) passes 6 args or omits the flag and is unmodified in
   behavior — the only edits to those files are the compile-time null-narrowing fixes described
   above, none of which change any assertion's expected value.

2. **The agents DB must never hold raw tool args — PASS.**
   `mapWriteResult`'s new branch (deferred-suspend) constructs an outcome string that names the
   tool and impact but never interpolates `args`. `store.finishGoal`'s `FinishGoalPatch` has no args
   field at all (unchanged shape). The TTL map (`suspendedIntentsById`) lives only inside
   `buildRunnerApp`'s closure — never passed to `store.insertGoal`/`finishGoal`/`insertRun`. Proven
   directly, not inferred: `runner/service.test.ts`'s "agents DB NEVER holds the raw args" test plants
   a marker string in the tool args, asserts `JSON.stringify(store.goals.get(id))` (the actual
   in-memory row `PgGoalStore`/`MemGoalStore` would persist) does NOT contain it, while the same
   marker DOES appear in the `GET /goals/:id` HTTP response body — proving the boundary is exactly
   where the design says it is (the runner may hand real args back to its caller on this one read;
   it must never write them to its own store).

3. **Expiry is explicit and tested; an expired intent must not be confirmable and must fail
   distinguishably from "never existed" — PASS, with a scope note (see below).**
   `runner/service.test.ts`'s TTL test configures a tiny `intentTtlMs`, confirms the intent is present
   immediately, waits past expiry, and confirms: (a) `suspendedIntent` is gone from the SAME goal's
   `GET /goals/:id` response, while (b) the goal's own `status`/`errorKind`/`approvalId` fields are
   unchanged (still `suspended`/`approval_required`/`null`) — proving the eviction is lazy and scoped
   to the intent, not a side effect that corrupts the goal row — and (c) a genuinely nonexistent goal
   id 404s, a structurally different response shape from (a). Within `ai-agents`' scope there is no
   "confirm" endpoint (that is T3b, in `platform-nest`), so "must not be confirmable" is satisfied
   here by construction: once `suspendedIntent` is absent, there is no raw-args payload anywhere in
   this process for any caller to confirm with. See the divergence note below for the exact boundary
   this implies for T3b.

4. **≤1 filing per message; the first `high_write` still ends the goal — PASS, unchanged mechanism.**
   `runAgent`'s write gate (`agent.ts`) is untouched by this ticket — the first `high_write` throws
   `ApprovalRequiredError` and `runWriteAgent`'s catch branch returns immediately (to one of the two
   "suspended" shapes) either way; there was never a loop that could reach a second `high_write`
   within one run once the first suspends. `runner/service.test.ts`'s "an unresolved high_write still
   ends the goal exactly once" test scripts a SECOND model turn that would request a second write and
   proves it is never reached (`deps.calls` stays empty; the captured intent's args are exactly the
   first attempt's). The consult-before-throw ordering (`agent.ts` calling `resolveApproval` before
   the write gate throws) is untouched — a rejected exact re-ask still returns `{match:"rejected"}`
   before this ticket's fork is ever reached, for both `fileOnSuspend` values.

5. **Confirm-filed rows shape-identical to runner-filed rows — PASS by non-involvement.**
   This ticket does not file anything on the deferred path — `fileApproval` (and therefore the
   `approvals.request` call shape T1 fixed) is entirely untouched. `toWireImpact` is reused (not
   duplicated) for the intent's `impact` field specifically so that whatever downstream filer
   consumes `suspendedIntent` receives the exact wire-legal value `fileApproval` would have sent for
   the identical `ApprovalRequiredError` — see the ambiguity note below on why this is a substantive
   design choice, not a formality.

## Ambiguities in §7.2.5 flagged explicitly (per the ticket's instruction, since T3b codes against this concurrently)

1. **Is `SuspendedIntent.impact` the raw agent-side label (`"high_write"`) or the wire label
   (`"high"`)?** §7.2.5's own text says *"the intent row" carries `impact:'high'` and that "T1's
   mapping logic lives in ONE exported helper both `fileApproval` and the broker reuse, not two
   copies"* — but the broker is in `platform-nest`, a separate project that cannot literally import
   `toWireImpact` from `ai-agents`. I resolved this by having `SuspendedIntent.impact` carry the
   **wire** label (`toWireImpact(err.impact)`), computed once inside `ai-agents` at the same call site
   `fileApproval` uses, so that: (a) the ai-agents-internal "one exported helper, reused not
   duplicated" reading is satisfied literally (both `fileApproval` and the deferred branch call
   `toWireImpact`); (b) nothing that crosses the `ai-agents` → `platform-nest` process boundary via
   `GET /goals/:id` ever carries the raw `"high_write"` label — consistent with T1's whole point
   (never let `"high_write"` reach a wire boundary); and (c) `platform-nest`'s side (T3b) then simply
   **persists** the value it receives on `suspendedIntent.impact` onto the `assistant_write_intents`
   row rather than re-deriving it — which is the only way the "not two copies" language can be true
   across a repo boundary that cannot share a function. **If T3b's implementer reads §7.2.5 as
   requiring `platform-nest` to re-run its own agent-Impact→wire mapping from a raw `"high_write"`
   string, that reading is incompatible with what `ai-agents` now sends** — flagging this explicitly
   so the two sides don't diverge. I believe the resolution above is correct and the design text is
   just imprecise about the repo boundary, not wrong in intent.

2. **Scope boundary: supervisor-delegated writes.** §7.2.5's normative flow (§2.5 step 1) has the
   composer sending `agent:'task-filer'` directly — never through `supervisor`. The ticket's file list
   (`write-agent.ts`, `runner/service.ts` + tests) has no path for threading `fileOnSuspend` through
   `orchestrator.ts`'s internal `runWriteAgent` call for a delegated sub-run. I left that call
   unmodified (it always files immediately, exactly as before) and added a test proving the flag is
   silently ignored on a `supervisor`-routed goal rather than causing a compile error or a runtime
   throw. This matches the design's own explicit scope note in §7.2.5 ("a handoff to `task-filer`
   still files WITHOUT the in-thread confirm... If the owner wants confirm-on-handoff too, that is a
   follow-up ticket"), read as covering supervisor-delegation the same way it covers handoffs — both
   are "the runner decided to route a write sub-task on its own," not "the user directly selected a
   write-capable agent." Flagging so this reading is confirmed rather than assumed.

3. **"An expired intent must not be confirmable" — no confirm endpoint exists in `ai-agents`.** As
   noted in invariant 3 above, this ticket cannot literally test "a confirm attempt on an expired
   intent is refused" because there is no confirm action in this repo — that's T3b. What IS built and
   tested here is the precondition T3b's confirm handler will depend on: `GET /goals/:id`'s
   `suspendedIntent` field is reliably absent after TTL expiry and reliably present before it, on the
   exact same (still-200, still-`suspended`) goal. If T3b's confirm handler is designed to call this
   endpoint (directly or via the broker's already-harvested `assistant_write_intents` row) to decide
   confirmability, this ticket's contract gives it exactly what it needs. If T3b instead expects
   `ai-agents` itself to expose a `POST /goals/:id/confirm`-shaped rejection, that would be new scope
   not in this ticket's file list — flagging so it's a decision, not a silent gap.

## Blockers / follow-ups

- None blocking. T2b is self-contained within `ai-agents/`; T3b (platform-nest confirm machinery)
  can proceed against the `suspendedIntent` shape documented above.
- Follow-up for whoever wires T2 (`task-filer` def + eval enrollment): nothing in T2b required
  touching `specialists.ts` or `agent-write-guard.test.ts`'s allowlists — `fileOnSuspend` is
  orthogonal to which tools/agents exist. T2 can land independently once T2b is landed (per the
  design's wave order, T2b → T2 in the same repo, serialized).
