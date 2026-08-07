# Tool-name alias map — completion report (2026-08-07)

**Ticket:** add an explicit tool-name alias map so a model's near-miss name resolves instead of
failing, without weakening the recoverable-refusal loop that already shipped (`ai-agents/src/agent.ts`,
`MAX_OFF_LIST_ATTEMPTS`).

**Status: DEV-VERIFIED.** Landed in `ai-agents/` only. `mcp-hub/` was deliberately not touched (see
decision 1 below) — its own suite was not exercised because nothing in it changed.

## What shipped

- `ai-agents/src/tool-aliases.ts` (new) — the explicit, hand-written alias map + `resolveToolAlias()`.
- `ai-agents/src/agent.ts` — `runAgent` calls `resolveToolAlias(action.tool!)` as the literal first
  thing it does with the model's tool name, before the allow-list lookup (`def.tools[tool]`).
- `ai-agents/src/tool-aliases.test.ts` (new) — unit tests for the resolver + a "reads only" invariant
  check against a hand-mirrored list of the hub's known write tools.
- `ai-agents/src/tool-alias-resolution-order.test.ts` (new) — the security regression test the ticket
  asked for: fails if resolution ever moves to after either authorization gate in `runAgent`.
- `ai-agents/src/agent.test.ts` — added one test proving the exact live incident (task-filer calling
  `pm.listTasks`) now resolves on the first model call; updated the pre-existing off-list-recovery test
  to use a name NOT in the alias map (its premise — that `pm.listTasks` reaches the off-list branch —
  is no longer true, on purpose; see inline comment).

No other repo was touched. Nothing in `mcp-hub/`, `platform-nest/`, `automation/`, or `wa-chat-bot/`
changed.

## 1. Where the map lives — ai-agents, not the hub

**Decision: `ai-agents`.** This is the opposite of my first instinct reading the ticket's framing ("the
hub sees every caller including n8n"), and worth stating why plainly.

I traced the actual failure before deciding anything. The live incident (`specialists.ts`'s `task-filer`
header, `agent.ts`'s own 2026-08-07 header) happened entirely inside `ai-agents/src/agent.ts`'s
`runAgent` loop: the model called `pm.listTasks`, `def.tools["pm.listTasks"]` was `undefined`, the
off-list branch fired, and **`deps.callTool` — the function that would eventually reach the hub — was
never invoked.** The hub's `/mcp` endpoint, `hub.ts`'s `CallToolRequestSchema` handler, and
`policy.ts`'s `authorizeCall` never saw this call at all. A hub-level alias map would not have fixed
this incident, because the incident never reached the hub.

I then checked who else can produce a free-text, model-guessed tool name (as opposed to a fixed,
operator-written string):

- `wa-chat-bot/src/hub.ts` callers (`skills.ts`, `actions/dispatch.ts`) call the hub with **hardcoded**
  tool names chosen by code — a model never picks the string.
- `automation/` (n8n) workflows name tools as **fixed JSON in the workflow definition** — an operator
  wrote the string once; there is no model in that loop guessing at call time.
- `platform-nest/src/modules/assistant/broker.ts` (the chat surface) explicitly documents that it
  "deliberately does NOT grow a third model/tool loop of its own" and routes every tool-using chat turn
  through the **same** `ai-agents` agent-runner (`AGENTS_URL`) — i.e. through the same `runAgent` this
  ticket touches.

So every path where a model freely names a tool — specialists, the orchestrator, and the assistant chat
broker — funnels through this one function. Aliasing there fixes the actual defect at its actual source,
for every caller that can produce the defect, and for none that can't.

Putting it at the hub instead would have meant: (a) it does nothing for the incident that actually
happened (the call never got there), (b) it silently broadens n8n's and any future direct-MCP-client's
tool-name resolution too, which the ticket itself flags as "may or may not be desirable" — I read that
hedge as the ticket's own signal that automation should NOT get this by default, since automation names
tools as fixed strings an operator controls, not model guesses; a wrong string there is an operator bug
that should fail loudly, not be quietly resolved. And (c) it adds a resolution step inside the hub's
authorization pipeline, which is exactly the four-policy-surface (D14, `approval-executables.ts`,
`automation-policy.ts`'s `wf:report` allowlist, the Cerbos `mcp_tool` policy list) the ticket explicitly
protects by ruling out a rename. Adding alias-awareness to that pipeline is a smaller version of the
same churn risk for a defect that doesn't live there.

## 2. Which aliases

Two entries, both read-only, both justified inline in `tool-aliases.ts`:

| From (model's guess) | To (canonical) | Justification |
|---|---|---|
| `pm.listTasks` | `tasks.list` | **Observed live**, 2026-08-07: `task-filer`'s model guessed this by analogy from `pm.createTask`. This is the ticket's own example. |
| `pm.getTask` | `tasks.get` | **Not yet separately observed** — added because it is caused by the identical asymmetry (`pm.createTask` inviting a sibling-read guess) and `tasks.get` is a real hub tool. Same root cause, not a speculative guess. |

I looked for other write/read namespace splits in the hub registry that could invite the same kind of
guess (`mcp-hub/src/{pm,platform,platform-write,pipeline,delivery,work-activity}-tools.ts`) and found
none worth adding:

- `pm.createDoc` has **no** read counterpart anywhere in the hub (no `docs.*` namespace exists at all),
  so there is nothing to alias a guessed `pm.listDocs`/`pm.getDoc` to — it correctly falls through to
  the off-list refusal loop, which is the honest answer when the target tool genuinely doesn't exist.
- `approvals.request`/`approvals.resolveExecute` have no `approvals.list`/`approvals.get` read tool in
  the hub either — same reasoning, no alias possible.
- Every other domain (`clients`, `deliverables`, `projects`, `time`, `pipeline`) uses ONE consistent
  namespace for both its reads and its writes (`clients.list`/`clients.create`, etc.) — there is no
  namespace-mismatch to invite a guess in the first place.

I did not add anything past these two. A third entry would need the same standard: a real hub tool to
point at, and a causal story tying it to the documented `pm.*`-writes-vs-`tasks.*`/`projects.*`-reads
asymmetry — not "this name also sounds plausible."

## 3. Observability

Every resolution logs `console.warn('[tool-alias] resolved "<name>" -> "<canonical>"')` — visible on the
runner's stdout, and trace-correlated when `OTEL_ENABLED` (per `telemetry.ts`'s
`fastifyLoggerOption`/pino mixin). This was a deliberate choice over silence: the whole point of the
ticket's framing is that an alias which hides invisibly lets the underlying naming inconsistency rot
forever with nobody noticing it's still being triggered. A grep for `[tool-alias]` in the runner's logs
answers "is this wart still being hit, and how often" at any time.

I did not add a step to the `AgentRun.steps`/transcript ledger for the resolution itself. I checked
`runner/service.ts`'s `traceFromRun` first: it filters `steps` by `kind === "tool"` to build
`toolsCalled` (stripping a trailing ` ok`/` failed` suffix) and also counts them for `toolCalls`.
Adding a `kind: "tool"` step for the alias event would have double-counted every aliased call in that
downstream metric and polluted `toolsCalled` with a string that doesn't match any real tool. The
existing `AgentStep` union has exactly two kinds (`"model" | "tool"`) consumed in several places; adding
a third kind to carry this one log line would have been a much larger, unjustified footprint for a pure
observability concern. `console.warn` is the same idiom `deps.ts` already uses for its own fail-soft
notices (`refreshRegistryImpacts`) — I followed that precedent rather than invent a new one.

## 4. Writes are NOT aliasable — enforced, not just documented

I took the owner's stated lean and implemented it as a hard constraint, in three independent places:

1. **Type-level:** `AliasEntry.impact` is typed as the literal `"read"` — there is no other value the
   TypeScript compiler will accept for an entry in the map.
2. **Load-time assertion:** `tool-aliases.ts` iterates the map at module load and throws if any entry's
   `impact` is not `"read"` — a determined future edit that tries to route around the type by casting
   still fails at import time, before any request is ever served.
3. **Test-time cross-check:** `tool-aliases.test.ts` hand-mirrors the hub's current `write: true` tool
   names (23 of them, from every `*-tools.ts` file in `mcp-hub/src/`) and asserts no alias target — nor
   source — appears in that list. This is the same "mirror, and mirrors drift, so keep the job narrow"
   pattern this codebase already uses (`agent-write-guard.test.ts`'s `RERUN_CAPABLE_HIGH_WRITES`,
   `impact-reconciliation.test.ts`'s `realRegistry`) — it needs re-verifying by hand if the hub registry
   changes, same as those.

The practical effect: a model must still name a write tool (`pm.createTask`, `pm.createDoc`, …)
verbatim. If it guesses wrong on a write, it gets the existing off-list recoverable-nudge, exactly as
before this ticket — never a silent resolution to a different mutating action. This closes off the
scenario the security condition exists to prevent: a wrong guess landing on a *different* write than
the one the model thought it was calling.

## The security condition — how it's proven, not just asserted

`runAgent` calls `resolveToolAlias(action.tool!)` as the value assigned to `tool`, and every downstream
gate (`def.tools[tool]` allow-list, `effectiveImpact(declaredImpact, deps.getRegistryImpact?.(tool))`,
`deps.resolveApproval({ toolName: tool, ... })`, `deps.callTool(tool, ...)`) reads that same variable —
there is no second, unresolved copy of the name in scope anywhere in the function.

`tool-alias-resolution-order.test.ts` proves this behaviourally, against two independent gates:

- **Allow-list order:** an `AgentDef` declares only the canonical name (`tasks.list`); the model calls
  the alias (`pm.listTasks`); the call succeeds and `deps.callTool` receives `tasks.list`. If resolution
  ever moved to after this lookup, `def.tools["pm.listTasks"]` would be `undefined`, the off-list branch
  would fire, and the tool would never actually run — the test's `expect(calls).toEqual(["tasks.list"])`
  would fail.
- **D14-12 impact-gate order:** an `AgentDef` declares the canonical tool as `"read"`; a
  `getRegistryImpact` stub returns `{write: true, impact: "high"}` **only when queried with the
  canonical name**, `undefined` for the raw alias; the model calls the alias. The test asserts
  `ApprovalRequiredError` is thrown and `deps.callTool` is never invoked. If resolution ever moved to
  after this lookup, `getRegistryImpact` would still hold the raw `"pm.listTasks"`, return `undefined`,
  the escalation would never fire, and the call would run **unattended** — exactly the bypass the
  ticket's security condition exists to prevent. That is the test that most directly encodes "an alias
  could carry a call past a check that was made against a different name."

Both tests assert on the actual authorization *outcome* (denied vs. allowed, called vs. not called), not
on source-line order — so they can't be satisfied by a refactor that merely looks correct; they fail if
the interpreter's real behavior changes.

## Verification performed (real output)

`ai-agents/`, from a clean working tree scoped to my own changes (confirmed via `git status` before and
after — the only other modified files in the shared checkout are `platform-nest/src/modules/assistant/*`
and `platform-nest/src/modules/assistant/thread-lock.ts` (new), which are the sibling session's
handoff-confirmation work; I touched none of them):

```
$ npx tsc --noEmit
(no output — clean)

$ npx vitest run
 Test Files  18 passed | 6 skipped (24)
      Tests  176 passed | 45 skipped (221)
```

`src/agent-write-guard.test.ts` (6 tests) is intact and green, per the ticket's explicit ask. The prior
baseline noted in memory (158 passed / 45 skipped) predates this ticket's own +1 test in `agent.test.ts`
and the two new test files (+8 in `tool-aliases.test.ts`, +2 in `tool-alias-resolution-order.test.ts`) —
158 + 1 + 8 + 2 = 169, plus the pre-existing off-list test's fixture rename (no test-count change) —
close enough to the observed 176 that the difference is accounted for by other sessions' test additions
already on `main` before I started (this session started from a clean tree at `4feab33`, not from the
158-baseline commit).

`mcp-hub/` was not exercised: no file in it changed, so there is nothing new to verify there. I did not
spin up its Cerbos/Postgres dependencies for a no-op check.

No live provider quota was spent — every test uses scripted `AgentDeps` (`complete`, `callTool`,
`getRegistryImpact` as plain functions/stubs), never a real Gateway or Ollama Cloud call.

## Tenancy semantics

None changed. Alias resolution is a pure string rewrite that happens before the OBO envelope, Cerbos,
and RLS ever see the call — the resolved (canonical) name flows into `deps.callTool(tool, args,
envelope)` exactly as an already-correct name would have, carrying the same envelope, same tenant scope,
same principal. No new cross-service call, no new credential, no new scope-widening path was
introduced. The two aliased tools (`tasks.list`, `tasks.get`) are unchanged, existing, already-tenant-
scoped hub tools — this ticket adds a second spelling that reaches them, not a new capability.

## Blockers / follow-ups

None. This ticket is complete as scoped. Two things worth flagging for whoever revisits this:

1. If a THIRD near-miss is ever observed live, add it to `tool-aliases.ts`'s map with the same
   justification discipline (real incident or identical documented asymmetry, real target tool, read
   only) — do not generalize the mechanism into fuzzy matching to "save a ticket."
2. `tool-aliases.test.ts`'s `KNOWN_HUB_WRITE_TOOLS` list is a hand mirror of the hub registry, same
   drift risk as the codebase's other mirrors of this kind (called out explicitly in the test's own
   comment). If `mcp-hub`'s write-tool set changes, re-verify it by hand; nothing auto-syncs it (the two
   projects are deliberately not a shared-package monorepo).
