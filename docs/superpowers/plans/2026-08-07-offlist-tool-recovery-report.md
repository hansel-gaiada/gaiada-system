# Off-list tool recovery report — a hallucinated tool name no longer kills the turn

**Ticket:** live bug, filed 2026-08-07 (owner drove `task-filer` with "try to do 1 open task to proof
that this feature work"; the UI showed `tool not on the agent's allow-list: mcp__gaiada__pm_listTasks`
/ `Something went wrong`).
**Seat:** senior-be. **Date:** 2026-08-07.
**Scope:** `ai-agents/` only. No `platform-nest` file was touched — see "Why broker.ts needed no
change" below.

## Verdict

**PASS.** Root cause confirmed as diagnosed by the ticket (not re-derived, only verified). Fix (a)
implemented in `ai-agents/src/agent.ts`. Fix (b) implemented in `ai-agents/src/specialists.ts`. Fix (c)
confirmed structurally and by a direct test — no code change was needed for the sibling agents.
`npx tsc --noEmit` clean. Full `ai-agents` suite green: **158 passed / 45 skipped** (up from 155/45 —
+3 net new tests, all in `agent.test.ts`, exercising the fix itself). `agent-write-guard.test.ts`
untouched, still 6/6 passing.

## What I verified before changing anything

- `mcp-hub`'s PM-ish tool surface is exactly `pm.createDoc`, `pm.createTask`, `projects.create`,
  `projects.get`, `projects.list`, `tasks.create`, `tasks.get`, `tasks.list`, `tasks.update` — the
  ticket's list matches what the runner's own contract expects (`ai-agents/src/specialists.ts`'s
  `writeSpecialists.taskFiler.tools` and `agent-write-guard.test.ts`'s `RERUN_CAPABLE_HIGH_WRITES`
  reference the same two namespaces). `pm.listTasks` does not exist in either namespace — confirmed by
  reading `specialists.ts` directly, not by re-querying the hub.
- `ai-agents/src/agent.ts:333-339` (pre-fix) threw `ToolNotAllowedError` unconditionally the instant
  `def.tools[tool] === undefined`, ending the whole `runAgent` loop — confirmed by reading the code and
  by the pre-fix behaviour of `agent.test.ts`'s "refuses tools outside the allow-list" test (a single
  scripted off-list response was already enough to fail the run before this ticket).
- `task-filer`'s `tools` map (`projects.list`, `tasks.list`, `pm.createTask`, `pm.createDoc`) mixes two
  naming namespaces for one PM domain — reads under `projects.`/`tasks.`, creates under `pm.` — exactly
  the shape that invites a model to guess a `pm.` sibling for a read it can already see a `pm.` create
  for. This is a real design smell, and the ticket is right that it is the most likely proximate cause
  (a model reasoning "there's `pm.createTask`, so there must be a `pm.listTasks`" is a completely
  ordinary LLM analogy-completion failure, not a bizarre one).

## (a) Off-list tool call is now recoverable, bounded — `ai-agents/src/agent.ts`

**Decision: implemented as specified.** I do not think a hard fail is safer here, for the reason the
ticket already gives and that I re-verified by reading the code path end to end: the tool is refused
identically either way (`deps.callTool` is never reached for an off-list name, recoverable attempt or
terminal one), and the only thing that changes is whether the MODEL gets to try again with a name it
can already see in its own prompt. There is no new capability, no new authority, and no new tool
becomes callable — only the number of chances to *name a real one* changes. The security posture that
actually matters (agent can never act with more authority than the human it serves; a genuine write
still suspends) is untouched, and I re-ran the D14 approval-suspension test
(`agent.test.ts`'s "high-impact writes suspend for human approval") to confirm it still passes unchanged.

**What changed**, `ai-agents/src/agent.ts`:
- Added `export const MAX_OFF_LIST_ATTEMPTS = 2` (a named, exported constant — not a magic number —
  so a test or a future caller can reference the exact cap rather than re-deriving it).
- `runAgent`'s loop gained a per-run `offListAttempts` counter (independent of `protocolRetries`, the
  existing malformed-JSON counter — different failure shape: a well-formed action naming a tool that
  doesn't exist, vs. invalid JSON).
- The allow-list check (`declaredImpact === undefined`) now, on the first `MAX_OFF_LIST_ATTEMPTS`
  occurrences, pushes a `SYSTEM`-style refusal into the transcript (naming the tool that was refused
  and the exact list of allow-listed tools, `Object.keys(def.tools)`) and `continue`s the loop — the
  same "nudge and retry" idiom the existing malformed-JSON path already used, reused rather than
  duplicated in spirit. On the `(MAX_OFF_LIST_ATTEMPTS + 1)`th off-list call it throws
  `ToolNotAllowedError` exactly as before this ticket — byte-identical typed error, same `.steps`
  payload shape, same downstream mapping in `runner/service.ts` and `evals/trace.ts`.
- `deps.callTool` is **never** invoked on this branch, on any attempt, recoverable or terminal — I kept
  this as the one non-negotiable and it is structurally true by reading the diff: the new branch only
  ever does `transcript.push(...)` + `continue`, or falls through to the existing `throw`. There is no
  path from "off-list" to "dispatched."
- Docstring block added above `MAX_OFF_LIST_ATTEMPTS` (and inline at the call site) recording the live
  incident, the fix, and the two invariants that don't change, so a future reader doesn't have to
  reconstruct the reasoning from a commit message.

**Why the cap is a flat count, not per-tool-name or reset-on-success:** the ticket asked for "2 off-list
attempts, then fail as today" without qualification, and a flat per-run counter is the simplest
reading that still bounds worst-case cost (at most 2 wasted model calls before either recovery or the
pre-ticket failure) regardless of whether the model repeats the same wrong name or tries several
different wrong names. I did not add per-name tracking or a reset-on-real-tool-call — that would be a
second design decision the ticket didn't ask for, and the simple flat cap is sufficient to fix the
reported bug (one wrong guess, one correct retry).

## (b) Reduced the invitation to hallucinate — `ai-agents/src/specialists.ts`

**Decision: named the exact tools verbatim in `task-filer`'s `systemPrompt`; did NOT rename any hub
tool; did NOT add `projects.get`/`tasks.get`.**

The `systemPrompt` now states, in prose: *"Your ONLY callable tools are exactly these four — there is
no pm.listTasks, tasks.read, or any other name, and calling anything else will be refused:
projects.list (read all projects), tasks.list (read all tasks), pm.createTask (file a task),
pm.createDoc (file a project document). Reads live under the projects./tasks. names; creates live
under the pm. name — do NOT guess a tool name by analogy across those two (e.g. there is no
pm.listTasks: to read tasks, call tasks.list)."*

Two things worth stating plainly about why this is additive, not the actual fix:

1. **The tool list was already in every prompt.** `buildPrompt` (`agent.ts`) already appends an
   `Available tools:` section listing every entry of `def.tools` verbatim, every turn — the model that
   hallucinated `pm.listTasks` had already been shown `projects.list (read)`, `tasks.list (read)`,
   `pm.createTask (high_write)`, `pm.createDoc (high_write)` and invented a fifth name anyway. So
   naming the tools again in the systemPrompt is a *second*, prose-form anchor — plausibly a
   reinforcement (raising the salience of the exact names, and explicitly pre-empting the specific
   analogy that failed live), not a structural guarantee. (a) is the structural fix; (b) is the
   mitigation the ticket asked me to also do.
2. **The naming inconsistency itself is left as-is, on purpose**, per the ticket's explicit instruction
   not to rename existing hub tools. I documented why in a new comment block in `specialists.ts`:
   `pm.createTask`/`pm.createDoc` are load-bearing across `agent-write-guard.test.ts`'s
   `RERUN_CAPABLE_HIGH_WRITES`, the hub registry (`mcp-hub/src/pm-tools.ts`), `wf:report`'s automation
   allowlist, and the Cerbos policy list — renaming either namespace to match the other would touch all
   four surfaces for a naming-hygiene reason alone, and that is out of this ticket's scope.

**On `projects.get`/`tasks.get`:** considered and explicitly **not added**. Adding either would:
- Require widening `platform-nest/src/modules/assistant/broker.ts`'s `ASSISTANT_AGENT_TOOLS["task-filer"]`
  mirror to match (the broker's comment on that map states plainly that a stale/narrow mirror is safe —
  "over-strict refusal, never an under-strict allow" — but a *correct* widening still needs to happen
  on both sides or the new tool is unreachable from the assistant surface anyway).
- Require confirming Cerbos's `mcp_tool` policy already makes `projects.get`/`tasks.get` visible to an
  ordinary chatting user's OBO principal (wall 1 in `broker.ts`, `visibleToolsFor(principal)`) — I did
  not check this, and getting it wrong in either direction is exactly the kind of contract-surface
  question the ticket instructs me to stop on rather than improvise.

This is a genuine "consider it, defer it" outcome, not an oversight: the live bug is fixed by (a)
regardless of whether `task-filer` ever gets single-resource reads, and adding them is a scope decision
for whoever owns the assistant's tool-surface contract next, not a naming-hygiene fix.

## (c) Sibling case — `status-reporter` / `approvals-chaser`

**Confirmed covered, structurally and by a direct test — no code changed for either agent.**

Both specialists are plain `AgentDef`s run through `runAgent` (via `traceRun` from
`runner/service.ts`'s read-specialist branch) — the exact same loop `task-filer`'s write path runs
through (via `runWriteAgent` → `runAgent`). The fix lives entirely inside `runAgent` itself, so there is
no per-agent wiring to duplicate or forget. I did not take that on faith: `agent.test.ts` gained
`"the recoverable nudge is shared runAgent behaviour — it covers every specialist (e.g. status-reporter,
approvals-chaser), not just task-filer"`, which drives the REAL `statusReporter` `AgentDef` (imported
from `./specialists`, not a re-declared fixture) through a hallucinated tool name
(`projects.getSingle`) followed by a correct retry (`projects.list`), and asserts the hallucinated name
was never dispatched to `callTool` while the run still finishes. Green.

## Test evidence added

All in `ai-agents/src/agent.test.ts` unless noted:

1. **Reproduces the live failure directly** — `"an off-list tool guess is a RECOVERABLE nudge: the
   hallucinated tool is never called, and the model finishes on retry with a valid name"`: a
   `task-filer`-shaped `AgentDef` (`tasks.list` read + `pm.createTask` high_write) is driven with a
   scripted model that calls `pm.listTasks` first (refused, never dispatched), then `tasks.list` (the
   real retry), then finishes. Asserts `toolCalls` (the actually-dispatched tool names) equals exactly
   `["tasks.list"]` — the hallucinated name never reaches `deps.callTool`.
2. **Proves the hard cap is real and still fails closed** — `"caps off-list recovery at
   MAX_OFF_LIST_ATTEMPTS, then refuses outright exactly as before — the tool is NEVER dispatched on any
   attempt"`: a model that always returns the same off-list call is given a `callTool` that throws if
   ever invoked (a trap, not just an assertion after the fact). Confirms `ToolNotAllowedError` is still
   thrown, and that it takes exactly `MAX_OFF_LIST_ATTEMPTS + 1` model calls to get there (2 recoverable
   + 1 terminal) — pins the exact cap, not just "eventually fails."
3. **Proves the fix is shared, not task-filer-specific** — the `statusReporter` test described in (c)
   above.
4. Existing test `"refuses tools outside the allow-list (typed, run stops)"` renamed to `"... once
   recovery is exhausted"` (behaviour unchanged: a single scripted off-list response, repeated by the
   test's own `scripted()` helper on every subsequent call, now takes 3 model calls instead of 1 to
   reach the same `ToolNotAllowedError` — still asserted, unchanged assertion).

One pre-existing fixture needed a budget bump to keep passing under the new semantics (not a behaviour
change, a test-fixture capacity fix): `ai-agents/src/runner/service.test.ts`'s `reader` AgentDef had
`maxSteps: 2`, which is enough for the OLD immediate-throw behaviour but not enough room for 2
recoverable retries + 1 terminal attempt (3 model calls) under the new one. Bumped to `maxSteps: 4`
with a comment explaining why; the affected test ("failed: a tool off the allow-list...") is otherwise
unchanged and still asserts the same terminal `status: "failed"` / `errorKind: "tool_not_allowed"`.
Renamed with a clarifying suffix ("...repeated past the recoverable cap...") so the intent is legible
without reading agent.ts.

## Why `platform-nest/src/modules/assistant/broker.ts` needed no change

I read the whole file before concluding this, per the ticket's own "in scope if the broker must relay
a recoverable refusal differently" carve-out. It does not need to:

- The broker never sees the recovery happening. It submits one goal (`POST /goals`) and polls
  `GET /goals/:id` to a **terminal** status (`TERMINAL_GOAL_STATUSES`). The recoverable-retry loop this
  ticket adds happens entirely *inside* `runAgent`, before the goal ever reaches a terminal status — so
  from the broker's perspective, a goal that recovers just... completes normally (`status: "ok"`),
  exactly like a goal that never hit an off-list call at all. A goal that exhausts the cap still ends up
  `status: "failed"`, `errorKind: "tool_not_allowed"` — the exact same terminal shape the broker already
  handled before this ticket (its generic `errorKind: goal.errorKind ?? goal.status ?? "runner_error"`
  fallback in the terminal-mapping `if (goal.status === "ok") ... return { outcome: "error", ... }`
  branch).
- No new field, no new SSE frame, no new `BrokerToolCallRecord` status is needed: the runner's step
  transcript already only records `"<tool> ok"` / `"<tool> failed"` for tools that were actually
  dispatched (`runner/service.ts`'s `traceFromRun`) — an off-list attempt, recoverable or terminal, was
  never dispatched, so it was never going to show up as a per-tool-call ledger row either before or
  after this fix. That is consistent with the existing "the runner's step transcript carries no
  arguments at all" design note in `broker.ts`'s own header (redaction section) — this fix doesn't touch
  that boundary.

I confirmed there is no direct code coupling between the two projects (`ai-agents` and `platform-nest`
are separate standalone projects per `CLAUDE.md` — not a monorepo): `grep -rn "ai-agents"
platform-nest/src/modules/assistant/*.ts` returns only comments/mirrors (`ASSISTANT_AGENT_TOOLS` and
its write-tool counterpart), never an import. Since I made zero changes to any file whose shape those
mirrors describe (`task-filer`'s `tools` map is unchanged; only its `systemPrompt` string changed),
the mirrors stay accurate and no `platform-nest` test needed to be run or touched.

## Test results (real output)

```
$ npx tsc --noEmit
(clean — no output)

$ npx vitest run
 Test Files  16 passed | 6 skipped (22)
      Tests  158 passed | 45 skipped (203)
   Duration  ~10s
```

`agent-write-guard.test.ts` specifically: 6/6 passing, file untouched (confirmed by not appearing in
the diff of files edited this session).

## Files touched

- `ai-agents/src/agent.ts` — the off-list recoverable-retry fix (§a), `MAX_OFF_LIST_ATTEMPTS` export,
  header + inline documentation of the live incident and the fix.
- `ai-agents/src/specialists.ts` — `task-filer`'s `systemPrompt` now names its four callable tools
  verbatim and warns against cross-namespace analogy guessing (§b); new comment block documenting the
  naming-inconsistency wart and the considered-but-deferred `projects.get`/`tasks.get` addition.
- `ai-agents/src/agent.test.ts` — 3 new tests (live-bug reproduction, hard-cap proof, cross-specialist
  proof) + one renamed existing test; imports `MAX_OFF_LIST_ATTEMPTS` and `statusReporter`.
- `ai-agents/src/runner/service.test.ts` — `reader` fixture's `maxSteps` bumped 2→4 (capacity fix, not a
  behaviour change) with an explanatory comment; the one affected test renamed with a clarifying
  suffix, assertions unchanged.

## Blockers / follow-ups

None for this ticket. Two out-of-scope items surfaced during the work, recorded here rather than acted
on:

1. Whether `task-filer` should gain `projects.get`/`tasks.get` — needs an owner/architect call on
   widening the assistant's tool-surface contract (`broker.ts`'s `ASSISTANT_AGENT_TOOLS` mirror +
   Cerbos `mcp_tool` policy visibility), not a naming fix. See §b above.
2. The `pm.` vs `projects.`/`tasks.` naming split is a real, acknowledged design wart across four
   surfaces (D14 test allowlist, hub registry, `wf:report`'s automation allowlist, Cerbos policy list).
   Unifying it is a cross-cutting rename, not something to do inside a bug-fix ticket — flagged, not
   fixed, exactly as instructed.
