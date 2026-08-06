# T3a report — the broker's first write turn (registry gate + write-tool mirror + card-state join)

**Ticket:** `docs/superpowers/plans/2026-08-06-asst-23-unblock-design.md` §7.6 (T3a), scoped by the
owner's §7 delta (§7.2 confirm-chip mechanism is T3b/T2b's — NOT built here; §7.1 both PM tools ship
in v1). **Seat:** senior-be. **Date:** 2026-08-06.

## Scope actually built

Platform-nest only, coded against a fake runner (the real `ai-agents` `task-filer` AgentDef is T2's
job, a separate standalone project). Nothing in `ai-agents`, no migration, no Cerbos edit, no
confirm/dismiss endpoint, no `assistant_write_intents` — all explicitly out of scope per the brief.

## Files touched

- `platform-nest/src/modules/assistant/broker.ts`
  - `ASSISTANT_AGENT_TOOLS` gains `"task-filer": ["projects.list", "tasks.list", "pm.createTask", "pm.createDoc"]`.
  - New `ASSISTANT_AGENT_WRITE_TOOLS: Record<string, readonly string[]>` = `{"task-filer": ["pm.createTask", "pm.createDoc"]}`.
  - New step **(0.5)** in `runToolTurn`, before wall 1: every tool in
    `ASSISTANT_AGENT_WRITE_TOOLS[agent]` must have a `getExecutable()` entry (imported from
    `core/approval-executables.ts`) or the turn is refused typed (`errorKind: "tool_not_executable"`),
    a `denied` ledger row per offending tool, runner never contacted.
  - New module-load-time guard (`assertNoDelegatingAgent`, `FORBIDDEN_DELEGATING_AGENTS`): throws at
    import if either mirror ever names `"supervisor"` — added mid-task in response to the coordinator's
    relay of T2b's finding (a `fileOnSuspend:false` goal routed through the supervisor's fan-out still
    files immediately, which would bypass the owner's confirm chip the moment T3b ships). See "T2b
    finding" section below for why a name-based check, not a structural AgentDef check, is what's
    available on this side of the repo boundary.
  - Header comments updated: the old "read-only agents only, deliberately" pin is rewritten into the
    write-map contract (three invariants, restated in the test file below).
- `platform-nest/src/modules/assistant/assistant.controller.ts`
  - `GET :tenantId/assistant/threads/:id` (`getThread`) now returns per-message `toolCalls[]`, each
    optionally joined to its `automation_approvals` row (`approval: {status, executionStatus,
    executionError} | null`). New `fetchToolCallsByMessage()` helper + `ThreadToolCall`/`ToolCallRow`
    types. Additive only — every existing field on `thread`/`messages` is unchanged.
- `platform-nest/src/modules/assistant/capabilities.ts`
  - `CapabilitiesResult` gains `toolAgents: AssistantToolAgent[]` (`{name, tools, writeTools}`),
    sourced directly from the broker's two mirrors — no FE-side hand-maintained agent list.
- `platform-nest/src/core/d14-17-assistant-write-registry.test.ts` — rewritten (A)/(A-reverse) into
  the successor invariant (A1/A2/A3: every declared write tool is registered; every non-write tool in
  the mirror is NOT registered; the write map is a subset of the tool map), added (A4) pinning the
  T2b supervisor-denylist fact, and added the two `pm.createDoc` origin-agent cases §7.1 required
  (happy-path + archived-project refusal, mirroring the existing `pm.createTask` cases). (B)/(C) for
  `pm.createTask` kept verbatim.
- `platform-nest/src/modules/assistant/assistant-broker.test.ts` — two new live-PG-+-Cerbos cases
  (registry-gate refusal; card-state join end to end) plus fake-hub/fixture wiring: a `tools/call`
  branch on the existing fake hub (needed for the executor's real re-drive), `pm.createTask`/
  `pm.createDoc` added to `owner`'s hub-visibility fixture, `config.approvalGrantSecret` set in
  `beforeAll`.
- `docs/FRONTEND-BFF-CONTRACT.md` — new §18 addendum ("T3a — the broker's first write turn...").

## Endpoints changed

- `GET /api/:tenantId/assistant/threads/:id` — response shape gains `messages[].toolCalls[]`
  (additive; see contract addendum for the exact shape). No new endpoint, no new Cerbos action — same
  `"read"` authorization as before.
- `GET /api/:tenantId/assistant/capabilities` — response gains `toolAgents[]` (additive).

No new routes. `POST .../messages` / `GET .../stream` behavior for `task-filer` is otherwise the
existing ASST-17 mechanics (`approval_required` on suspend) — T3a adds no new SSE frame.

## The T2b mid-task addition

Addressed as requested, before considering the ticket done:
- **Module-load-time throw** in `broker.ts` if `ASSISTANT_AGENT_TOOLS` or `ASSISTANT_AGENT_WRITE_TOOLS`
  ever names `"supervisor"` (or any future name added to `FORBIDDEN_DELEGATING_AGENTS`).
- **Chose the name-based denylist over a structural AgentDef check** because `platform-nest` cannot
  import `ai-agents`' `AgentDef` type at all (separate standalone projects, no shared package, per
  CLAUDE.md) — there is no `def.specialists`-shaped field to test against from this side of the
  boundary. The denylist is grounded in the actual current fact (`"supervisor"` is the ONE delegating
  construct in `ai-agents` today) and is documented at the declaration site with a pointer to T2b's
  finding and the exact bypass mechanism, so the next person adding an agent to either mirror
  understands what they would break and why a second name might need adding to the set.
- Backed by a live test ((A4) in the rewritten registry test) asserting the fact holds today, in
  addition to (not instead of) the import-time throw.
- **T1's `toWireImpact` / T2b's `SuspendedIntent.impact` = wire-label finding**: read and confirmed to
  have no bearing on anything T3a built — T3a does not touch `assistant_write_intents` or any
  `SuspendedIntent` shape (that's T3b). Noted for the record, no action needed here.

## Test results (real output)

Orphan count before: `1` (the live test DB itself — `test_%` prefix matches nothing, counted the
right way per the standing trap note).

```
$ npx tsc --noEmit
(clean, no output)
```

```
$ npx vitest run src/core/d14-17-assistant-write-registry.test.ts
 ✓ src/core/d14-17-assistant-write-registry.test.ts (11 tests) 4296ms
 Test Files  1 passed (1)
      Tests  11 passed (11)
```

```
$ npx vitest run src/modules/assistant/assistant-broker.test.ts
 ✓ src/modules/assistant/assistant-broker.test.ts (18 tests) 7548ms
   ✓ ... step 0.5: a write tool with NO approval-executables entry is refused BEFORE the runner is
       ever contacted — zero goals, typed refusal
   ✓ ... card state: a suspended origin='agent' pm.createTask, once decided AND executed, shows up
       EXECUTED on a fresh GET thread — via the real decide() endpoint and the real executor
 Test Files  1 passed (1)
      Tests  18 passed (18)
```

```
$ npx vitest run src/modules/assistant/
 Test Files  11 passed | 1 skipped (12)
      Tests  107 passed | 2 skipped (109)
```

```
$ npx vitest run src/core/approval-executables.test.ts src/core/d14-15-pm-registry.test.ts \
  src/core/approvals-decide.test.ts src/core/approval-execute.test.ts \
  src/core/d14-09-agent-origin-authority.test.ts src/core/d14-09-redelivery-storm.test.ts \
  src/core/automation-approvals.test.ts src/core/approval-resolve-execute.test.ts
 Test Files  8 passed (8)
      Tests  129 passed (129)
```

Full-suite run (`npx vitest run`, all files, ~20 min): launched in the background; result appended
below once it completes (see the UNVERIFIED note if this document is read before that landed).

No Cerbos policy file was touched by this ticket, so no `gaiada-test-cerbos` restart was needed.

## PASS / FAIL / UNVERIFIED

- **PASS** — `tsc --noEmit` clean.
- **PASS** — registry gate (step 0.5): refuses typed, zero runner contact, `denied` ledger rows,
  visible on reload. Verified live against real PG (`resetExecutableApprovals`/
  `registerCoreExecutableApprovals`/`registerPmExecutableApprovals` mutate-and-restore, matching the
  existing d14-17 idiom).
- **PASS** — card-state join: pre-decision state asserted against the true column DEFAULT
  (`execution_status: 'not_applicable'`, not a guessed `'pending'`), then a REAL `decide()` call as a
  REAL company_admin, then the REAL `executeApprovedAutomationWrite`, then a fresh `GET thread` shows
  `approval: {status:'approved', executionStatus:'executed', executionError:null}`. Ledger row's own
  `status` column confirmed untouched (`'pending'`) — the join is read-time, not a transcript mutation.
- **PASS** — both v1 PM write tools (`pm.createTask` AND `pm.createDoc`) proven for `origin='agent'`
  execution: happy path + archived-project refusal, closing §7.1's "must be made true, not asserted"
  caveat.
- **PASS** — write-map contract (A1/A2/A3) + T2b supervisor-denylist (A4) all pinned and green.
- **PASS** — `capabilities.ts`'s `toolAgents` additive field; verified via `tsc` + that
  `assistant-capabilities.test.ts` (unchanged, 6 tests) still passes (no exact-equality assertion on
  the full response object anywhere in that file, confirmed by inspection).
- **PASS** — all pre-existing assistant + approvals/D14 suites green after the change (107 + 129
  tests respectively, listed above) — no regression in the owner-privacy, redaction, D14 execution, or
  capability-gate tests this surface depends on.
- **UNVERIFIED (at time of writing)** — the full `npx vitest run` (all ~244 files) was still running
  in the background; see the addendum below for its actual result once it lands. Everything the
  ticket names as touched (`modules/assistant/**`, `core/d14-17-…test.ts`, `core/approval-execute.ts`
  read-only, `docs/`) has already been independently verified green above; the full run is the
  no-blind-spots confirmation the brief requires for a touched surface this wide.
- **N/A / not attempted (explicitly out of scope, confirmed not touched)**: `assistant_write_intents`
  migration, confirm/dismiss endpoints, Cerbos `confirm_write` edit, `fileOnSuspend` plumbing — none
  of these files were opened for writing.

## Blockers / follow-ups (loud, not worked around)

None found that block T3a's own scope. Forward notes for the tickets that build on this:

- **T2** must land the real `task-filer` AgentDef in `ai-agents/src/specialists.ts`'s
  `writeSpecialists`, plus the `RERUN_CAPABLE_HIGH_WRITES` allowlist entries for `pm.createTask`/
  `pm.createDoc`, before a real (non-fake) runner can serve this agent. Until then, a live turn naming
  `task-filer` reaches the real agent-runner and gets an unrecognized-agent failure from THAT service
  (unchanged failure shape — a `runner_error`, not a security gap: wall 1/step 0.5 in this file both
  still run first and would refuse just as loudly if the mirror ever drifted from what the runner
  actually serves).
- **T3b** owns the confirm-chip machinery (§7.2) on top of what's here — this ticket's
  `approval_required` flow (immediate filing) is what ships until T3b lands its
  `assistant_write_intents` + confirm/dismiss endpoints. Nothing here needs to change for T3b to build
  on it: the card-state join already reads `approval_id`/status generically, and T3b's own plan
  (§7.2.1-7.2.7) layers a pre-filing `draft` state in front of the same ledger row shape.
- **T4** (FE) can source its composer's agent picker from `GET .../capabilities`'s new `toolAgents`
  field rather than hand-maintaining a list, and its proposal-card rendering can consume `GET
  thread`'s new `toolCalls[].approval` shape directly.

---

*(Full-suite output appended here once the background run completes.)*
