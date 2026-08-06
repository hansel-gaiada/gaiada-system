# T1 — impact-vocabulary mismatch at the approval-filing boundary — report

**Scope:** `ai-agents/` only. No changes to `platform-nest/` or `mcp-hub/` source (as instructed). Tree
left dirty for review; nothing committed or pushed.

## The bug (confirmed by reading the code)

`ai-agents/src/write-agent.ts`'s `fileApproval()` forwarded `err.impact` to the hub's
`approvals.request` tool verbatim. For a suspended `high_write` (`ai-agents/src/agent.ts`'s write
gate: `if (impact === "high_write") throw new ApprovalRequiredError(tool, impact, args, steps)`) that
value is the literal string `"high_write"`.

Both downstream consumers only ever accepted `medium | high | unclassified`:

- `mcp-hub/src/platform-write-tools.ts` — the `approvals.request` JSON-schema `impact` property:
  `enum: ["medium", "high", "unclassified"]`.
- `platform-nest/src/core/automation-approvals.controller.ts:22` —
  `const IMPACTS = new Set(["medium", "high", "unclassified"]);`, checked at `create()`:
  `if (!IMPACTS.has(impact)) throw new BadRequestException(...)`. Backed by migration 0014's CHECK
  constraint on `automation_approvals.impact`.

So the first genuine `high_write` suspension in the platform's history would 400 at the hub, and the
agent goal would fail with **no approval proposal ever recorded** — the exact failure mode this
program cannot afford, since a suspension with no durable trace is worse than no suspension at all
(a human never even learns a write was blocked).

It survived because every agent-side test scripted `callTool` as a permissive mock that accepts any
args (see the pre-existing `deps()` helper in `write-agent.test.ts`), so the real hub schema was never
exercised, and the D14-17 approval tests inserted rows via raw SQL with `impact='high'` directly,
bypassing the filing path entirely.

## The fix

Added `toWireImpact()` in `ai-agents/src/write-agent.ts`, called from `fileApproval()` before the
`approvals.request` call. It is an **exhaustive** switch over `Impact | "unclassified"` (the exact
type `ApprovalRequiredError.impact` carries), with a `_exhaustive: never` default branch — a future
variant added to `agent.ts`'s `Impact` union is now a **compile error** in `write-agent.ts`, not a
runtime 400 at the hub.

### The full set of labels handled

`Impact = "read" | "low_write" | "high_write"`, plus `ApprovalRequiredError`'s own widened parameter
type `Impact | "unclassified"` — so four values, all four handled:

| agent-side label | wire label | reasoning |
|---|---|---|
| `"high_write"` | `"high"` | The obvious mapping, and I checked it's the *right* one, not just the obvious one. `agent.ts`'s own D14-12 header already establishes that the hub treats `"medium" \| "high" \| undefined` (unclassified-but-write) as equally confirm-required — stricter wins in both directions. `"high"` is the one wire label that keeps a filed `high_write` at least as strict as that existing equivalence. It is also the exact severity `approvals.resolveExecute` (the D14-14 rerun-capable transport, `mcp-hub/src/platform-write-tools.ts`) is itself registered at (`impact:"high"`), so a rerun-capable high_write carries one consistent severity from suspension through to execution — no re-classification happens mid-flight. |
| `"unclassified"` | `"unclassified"` | Identical spelling both sides; a straight pass-through. Kept as an explicit case (not folded into a default) so it is visibly covered by the exhaustiveness check. This branch is not reachable through today's `agent.ts` write gate (only `"high_write"` is ever thrown there) — it exists because the error class's declared type is wider than what the gate actually produces, and a defensive mapping should cover the type, not just today's call site. |
| `"low_write"` | **throws** | Checked whether this can reach the call site: no. `agent.ts`'s write gate only throws `ApprovalRequiredError` when the *effective* impact (`effectiveImpact()`, D14-12) is exactly `"high_write"` — a `low_write` runs unattended by design; that's what makes it low. There is also no wire tier for "safe to auto-execute" — the wire only has `medium\|high\|unclassified`, because a filed suspension is by definition at least medium-severity. Mapping it to `"medium"` would fabricate a severity nobody assessed. I chose to fail loud at the boundary (throw, with a message naming the contract it violated) rather than either invent a severity or let the hub reject a nonsensical filing downstream with a 400. |
| `"read"` | **throws** | Same reasoning as `low_write`: a read tool has no write-impact opinion at all, so there is nothing truthful to file. Also unreachable through today's gate. |

I also checked whether any *other* label besides `high_write` could realistically reach `fileApproval`
in production: no. `runAgent`'s write gate (`agent.ts:345`) throws `ApprovalRequiredError` in exactly
one place, guarded by `if (impact === "high_write")`, where `impact` is the post-`effectiveImpact()`
reconciled value (`Impact`, never widened). So `"low_write"` and `"read"` are only reachable if some
future or test code constructs `ApprovalRequiredError` directly with a mismatched label — which is
exactly why I made `toWireImpact` throw for them rather than silently coerce, and why the report calls
this out explicitly rather than leaving it implicit.

### Where the fix lives

`ai-agents/src/write-agent.ts`:
- `export type WireImpact = "medium" | "high" | "unclassified"` — restated wire vocabulary.
- `export const WIRE_IMPACTS: readonly WireImpact[]` — the full accepted set, for tests to assert
  against.
- `export function toWireImpact(impact: Impact | "unclassified"): WireImpact` — the exhaustive mapping,
  documented inline with the same reasoning as the table above.
- `fileApproval()` now calls `toWireImpact(err.impact)` and sends that (`wireImpact`) as the `impact`
  arg to `approvals.request`, and returns it (not the raw agent-side label) in `FiledApproval.impact` —
  so the durable record and any caller-facing message (`cli.ts`, `runner/service.ts`) both report the
  value that was actually filed.

**Not imported from `platform-nest`**, per the ticket's constraint (`ai-agents` and `platform-nest` are
separate standalone projects, not a monorepo — CLAUDE.md). `WIRE_IMPACTS` is a second restated copy of
the same list `agent-write-guard.test.ts`'s header describes as unavoidable in this situation; each
restatement carries a comment pointing at the authoritative source
(`platform-nest/src/core/automation-approvals.controller.ts`'s `IMPACTS` set, mirrored by
`mcp-hub/src/platform-write-tools.ts`'s `approvals.request` schema enum) so the two sides can be kept
in sync by inspection, and a test (below) pins the restated copy against a literal transcription of
that same set so a future divergence fails a test rather than production.

## Tests added (`ai-agents/src/write-agent.test.ts`)

New `describe("T1 — the agent-side Impact label is translated to the wire vocabulary before filing")`
block, four tests:

1. **`WIRE_IMPACTS matches the real platform controller's accepted set exactly`** — asserts
   `write-agent.ts`'s restated set equals a second, independently-transcribed literal
   (`new Set(["medium", "high", "unclassified"])`) in the test file, commented with the controller
   source. This is the tripwire for either side drifting.
2. **`THE BUG THIS CATCHES: a suspended high_write files a wire-legal impact, never the raw agent-side
   label`** — this is the test that would have caught the original defect. It calls `fileApproval`
   directly with a real `ApprovalRequiredError("tasks.update", "high_write", ...)`, then asserts the
   actual `impact` **value** handed to the mocked `approvals.request` call is a member of the real
   accepted set, and specifically `"high"`. Before the fix this would have asserted `"high_write"` —
   not a member of the set — failing exactly the way the real hub schema/controller would have 400'd.
   The previous suite (`write-agent.test.ts`'s existing suspension test) only asserted `toMatchObject`
   on `toolName`/`toolArgs`/`origin`/`agentName` and never inspected `impact`'s value, which is why it
   passed both before and after this fix — it wasn't exercising the schema boundary at all.
3. **`toWireImpact maps every value onto the real accepted set, or throws — never silently passes an
   illegal value through`** — direct unit coverage of all four `Impact | "unclassified"` values against
   `toWireImpact`, checking both the happy-path outputs are members of `WIRE_IMPACTS` and that the two
   unreachable-in-practice inputs throw with a message naming the contract violated.
4. **`runWriteAgent's suspended path files the SAME wire-legal impact end to end`** — re-runs the
   existing `highWriteAgent` suspension scenario through the full `runWriteAgent` → `fileApproval` path
   (not just the pure function) and asserts both the args handed to the mocked `callTool` and the
   `FiledApproval.impact` returned to the caller are wire-legal.

None of these weaken `agent-write-guard.test.ts` — it is untouched, still 5/5 green (see verification
below).

## Verification (real command output)

```
$ npx tsc --noEmit
(clean — no output, exit 0)

$ npx vitest run
 ✓ src/runner/service.test.ts (19 tests) 285ms
 ✓ src/approval-resume.test.ts (17 tests) 9ms
 ✓ src/agent-write-guard.test.ts (5 tests) 7ms
 ✓ src/impact-reconciliation.test.ts (18 tests) 8ms
 ✓ src/deps.test.ts (14 tests) 83ms
 ↓ src/knowledge/store.test.ts (13 tests | 13 skipped)
 ✓ src/orchestrator.test.ts (8 tests) 7ms
 ↓ src/knowledge/service.test.ts (10 tests | 10 skipped)
 ✓ src/write-agent.test.ts (8 tests) 12ms
 ↓ src/runner/store.test.ts (5 tests | 5 skipped)
 ↓ src/knowledge/graph.test.ts (8 tests | 8 skipped)
 ✓ src/evals/harness.test.ts (8 tests) 5ms
 ✓ src/trainer/trainer.test.ts (7 tests) 10ms
 ✓ src/models/registry.test.ts (7 tests) 3ms
 ↓ src/memory/episodic-pg.test.ts (5 tests | 5 skipped)
 ✓ src/memory/episodic.test.ts (6 tests) 9ms
 ✓ src/agent.test.ts (6 tests) 6ms
 ✓ src/obs/collector.test.ts (4 tests) 6ms
 ↓ src/models/registry-pg.test.ts (4 tests | 4 skipped)
 ✓ src/obs/otel-bridge.test.ts (1 test) 18ms
 ✓ src/knowledge/graph-ingest.test.ts (4 tests) 7ms
 ✓ src/runner/queue.test.ts (3 tests) 15ms

 Test Files  16 passed | 6 skipped (22)
      Tests  135 passed | 45 skipped (180)
```

(`write-agent.test.ts` went from 4 tests before this ticket to 8 after — the 4 new T1 tests — all
green. `agent-write-guard.test.ts` unchanged at 5/5, CI-enforced guard not weakened.)

## What I found but deliberately left alone

- **`platform-nest`'s `IMPACTS` set and the CHECK constraint are correct as-is** — I did not widen them
  to accept `"high_write"`, per the ticket's explicit instruction. They are the shared wire contract
  with n8n automation and should not know about an internal agent-side label.
- **`ApprovalRequiredError.impact`'s declared type (`Impact | "unclassified"`) is wider than what
  `agent.ts`'s write gate can actually produce today** (only `"high_write"` is ever thrown). I left the
  error class's type alone rather than narrowing it to `"high_write"` only, because narrowing it would
  be an API change to `agent.ts` outside this ticket's stated scope (translate at the boundary, not
  redesign the error type), and the wider type is arguably intentional headroom for a future caller.
  Instead I made `toWireImpact` exhaustive over the type as declared, so the wider type costs nothing
  in safety — an unreachable-today value still gets a defined (throwing) behavior rather than an
  unchecked `string`.
- **No other call site sends `impact` to `approvals.request`** — grepped `ai-agents/src` for
  `ApprovalRequiredError(` and `approvals.request`; `write-agent.ts`'s `fileApproval` is the only
  producer of that tool call in this project. Nothing else needed the same fix.
- **`WireImpact`/`WIRE_IMPACTS`/`toWireImpact` are all exported** (rather than kept module-private) so
  the guard test can assert against them directly, matching this codebase's existing pattern of
  exporting pure boundary functions for direct unit testing (e.g. `effectiveImpact` in `agent.ts`,
  exported for the same reason per its own doc comment).
