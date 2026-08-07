# PM Repsona Parity — do-not-downgrade audit (P4-L6) + performance budget (P4-L5)

Status: **DEV-VERIFIED** (audit) / **PLANNED** (budget — a number now exists, but only the
small-tenant half of it is measured) · 2026-08-07 · extends
`2026-08-04-pm-repsona-parity-phase4-plan.md` workstream L. Read that plan first; this document
is the L5/L6 deliverable it calls for, not a replacement for it.

Scope note: this pass touched no files. Every item below came back clean against the working
tree as of commit `fef853d` (`feat(pm): Ball board, assignment history, blocked reasons, Gantt
fidelity (P4-B6/B7/B9/B10/I4/L3)`), so there was nothing to fix inside the three files this
ticket was authorised to touch (`UrgencyChip.tsx`, `urgency.css`, `task-detail.css`). Findings
outside that scope are recorded in §3 for routing, not patched.

---

## 1. P4-L6 — the do-not-downgrade audit

Method: for each capability the plan names as "we exceed Repsona," grep + read the current
source, confirm the feature still renders/behaves, and record file/line evidence. Verdict scale:
**INTACT** (present, wired, evidenced), **REGRESSED** (present but broken), **MISSING** (gone).

### 1.1 8-emoji comment reactions (Repsona has one thumbs-up)

**Verdict: INTACT.**

- Closed 8-emoji set defined identically in two places that must agree, and do:
  `platform-ui/src/lib/demoPm.ts:283` and `platform-ui/src/components/pm/CommentThread.tsx:28`
  both declare `["👍","❤️","🎉","👀","✅","💡","🙏","🔥"]`.
- Picker UI: `CommentThread.tsx:239` (reaction-add popover), `:283` (filters to only the emoji
  with a nonzero count for the compact display), `:352` (the full picker in the composer).
- Server-side (demo layer) validation rejects anything outside the set:
  `demoPm.ts:494` — `if (!REACTION_EMOJI_SET.has(emoji)) return { status: 400, ... }`.
- Round-trip covered by test: `demoPm.test.ts:499-502` posts `👍` and asserts
  `reactions: [{ emoji: "👍", count: 1, mine: true }]`.

No trace of a single-reaction (thumbs-up-only) model anywhere in the current tree.

### 1.2 Poly-assignee: department/division assignment (Repsona cannot express this)

**Verdict: INTACT**, and correctly reconciled with the Ball rename.

- Type: `AssigneeKind = "person" | "department" | "division"` — `platform-ui/src/lib/pm.ts:190`.
- The plan's resolution (§1.5 of the phase-4 plan) says Ball = `assignee.refId`/`kind`,
  Responsible = `assignee.responsibleId`, and the kind may still be a unit. Confirmed:
  `AssigneePicker.tsx:12` types `kind` as `AssigneeKind`, `:49` branches UI on
  `kind === "department" || kind === "division"` to show the unit-specific picker.
- The division-drag write path (`pmActions.ts:205-218`, `setDivisionAssignee`) constructs
  `{ kind: "division", refId, refName, responsibleId, responsibleName }` — the unit is the Ball,
  a real person is still forced into `responsibleId` (line 207: `if (!responsibleId) return
  { ok: false, error: "Pick a responsible person for this division." }`), so "whose turn" and
  "who owns it" stay independently expressible exactly as the plan specifies.
- `Board.test.tsx:122,167` construct tasks with
  `assignee: { kind: "division", refId: "div-a", ... }` and assert on ambiguous/needs-a-pick
  states — the unit-kind path is exercised by tests, not just typed.
- Department-level rollups (`lib/departments.ts:66-67`) still read `a.kind === "department"` /
  `a.kind === "division"` to decide whether a task belongs to a dept's workspace — poly-assignee
  is load-bearing for a real feature (department consoles), not decorative.

### 1.3 Gantt: drag-reschedule, dependency-draw, multiselect, move-together cascade, burndown overlay

**Verdict: INTACT.** `Gantt.tsx` is 765 lines (plan-era note recorded 568 — it grew, consistent
with L3/L4 fidelity work landing on top, not with anything being stripped out).

| Capability | Evidence |
|---|---|
| Drag-reschedule | `beginDrag` wired at `Gantt.tsx:594` (`onPointerDown={canEdit ? (e) => beginDrag(e, bar, "move") : undefined}`), start/end resize handles at `:602-603`, commits via `batchReschedule` at `:363` and `:417` |
| Dependency-draw | Link-pointer handle `:607` (`onPointerDown={(e) => beginLinkPointer(e, bar)}`), `addDependency` import `:8`, dedicated section header comment `// ---- dependency draw ----` at `:426` |
| Multiselect | Section header `// ---- multiselect (P2-08) ----` at `:331`; shift-click toggle described at `:375`; keyboard activation (Enter/Space on a focused bar) at `:458-459`; `aria-label` at `:589` documents both "Arrow keys reschedule" and "Enter or Space toggles multiselect" |
| Move-together cascade | Comment at `:345-346`: "so a lone drag still cascades to its dependents, and a multiselect drag cascades every selected bar's dependents too"; resize explicitly excluded from cascade at `:392` ("Resize... never cascades — only a whole-bar 'move' drag carries dependents/selection") |
| Burndown overlay | `bdPoints()` helper `:202`, `showBurndown` state `:277`, toggle button `:635-636`, SVG polylines (ideal vs actual) `:691-693` |

All five capabilities the plan lists as "Repsona doesn't have, we do" are present, and the code
comments at the relevant lines are the same ones the plan quotes — this is the same
implementation the plan described, not a rewritten one.

### 1.4 D17 custom fields, doc versions with restore, task/doc templates, recurrence

**Verdict: INTACT**, four independent checks:

- **Custom fields**: `TaskCustomFields.tsx` wraps the generic `<CustomFields>` renderer
  (`:5, :41`) and is imported into `TaskDetailView.tsx:38`, wired to
  `updateTaskCustomFields` (`TaskDetailView.tsx:18`).
- **Doc versions + restore**: `DocHistory.tsx:3-4` imports `fetchDocVersions`,
  `fetchDocVersion`, `restoreDocVersion`; the header comment at `:13-16` documents the exact UX
  ("View" swaps in a read-only body, "Restore" reveals an inline confirm, "never a browser
  `confirm()`"); `restore()` at `:41-45` calls `restoreDocVersion` and refetches on success.
- **Templates**: `TemplateManager.tsx` imports `Template` from `lib/pm` (`:3`), the comment at
  `:17` states templates are created only via "Save as template" on a task, and
  `TaskDetailView.tsx:19` imports `saveTaskAsTemplateAction`.
- **Recurrence**: `lib/pmRecurrence.ts` exists as its own module (split out per its header
  comment, "Client-safe recurrence constants/types (P2-06)"); `TaskDetailView.tsx:18` imports
  `undoRecurrenceSpawn`, and `titleWithRecurrenceGlyph` (`pm.ts` import at `TaskDetailView.tsx:13`)
  renders the recurrence marker on a task's title.

### 1.5 Per-project custom status registries (Repsona's statuses are fixed)

**Verdict: INTACT**, and richer than the plan's own summary of it.

- `ProjectStatus` shape at `pm.ts:84-87`: `color`, `isDone`, `isBlocked`, `wipLimit?`.
- `StatusManager.tsx` is the full per-project editor: create/update/reorder/remove
  (props at `:18-21`), drag-and-keyboard reorder (`:26-27` comment), mutually-exclusive
  Done/Blocked chips, an optional WIP-limit number field, and a **guarded delete** — deleting an
  in-use status offers an inline "move N tasks to…" rather than orphaning tasks (`:14-16`,
  `:21` `remove(statusId, moveTo?)`).
- `DEFAULT_STATUSES` (`pm.ts:116`) is now *derived* from `PM_STATUS_LADDER`
  (`pmVocabulary.ts`) rather than hardcoded — this is the P4-B8 landing already recorded in the
  phase-4 plan's execution log, and it does not remove per-project customization: a project that
  has materialized its own registry rows keeps them untouched
  (`isSynthDefaultStatuses`, `pm.ts:126-136`, compares structurally so a customized project is
  never silently overwritten).

### 1.6 Append-only assignment history (Repsona's ball reassignment is last-write-wins)

**Verdict: INTACT**, and I traced the choke point rather than trusting the comment.

- `demoPm.ts:230-237` states the invariant directly: "Append-only, exactly like the real table:
  nothing here ever mutates or removes a row, because 'passing the ball does not erase the
  previous holder' IS the feature."
- The single write path: `patchTask()`'s `b.assignee` branch (`demoPm.ts:968-980`).
  `assignmentHistoryFor(t.id)` is called **before** mutating `t.assignee` (line 973, with an
  explicit comment explaining the ordering matters — seeding after the mutation would record a
  phantom duplicate row), the mutation happens at line 974, and `appendAssignmentEvent` fires
  only on a real change (`JSON.stringify` before/after compare, `:977`) so a no-op PATCH doesn't
  churn the ledger.
- I checked whether every assignee-changing call site actually funnels through this one PATCH
  rather than a shortcut that would bypass it. It does — confirmed by reading, not assuming:
  - `reassignResponsible` (`pmActions.ts:162-177`) → `send(\`/pm/tasks/${taskId}\`, "PATCH", { assignee }, "pm.manage")` at `:175`
  - `setBallToMe` (`:185-196`) → same PATCH shape at `:193`
  - `setAssignee` (`:239-243`) → same PATCH shape at `:240`
  - `setDivisionAssignee` (`:205-218`) → same PATCH shape at `:215`

  `appendAssignmentEvent` (`demoPm.ts:244-257`) is called from exactly one call site
  (`demoPm.ts:978`) — grep confirms this — which is correct *because* every write path above
  converges on that one PATCH handler rather than each maintaining its own history-append logic.
  A second call site would be the bug shape to watch for later (a write path that reaches the
  history table directly instead of through the shared PATCH), not this one.
- Backfill semantics match the plan's requirement that legacy tasks not read as "never
  assigned": `assignmentHistoryFor` (`:260-277`) lazily materializes one synthetic origin row
  dated from the task's own `updatedAt`, not from "now" (`:264-266` comment: "a history that
  claims every legacy task was assigned this second would be actively misleading").
- Reader: `listAssignmentHistory` (`pm.ts:401`), documented at `:382` as joined so the UI needs
  no second round-trip; consumed by `TaskDetailView.tsx:12`.

**This is UI/demo-layer evidence only.** The real append-only guarantee (no UPDATE/DELETE grant
to the runtime role, RLS) lives in `platform-nest` migration `0078`
(`pm_task_assignment_events`, per the phase-4 plan's `P4-B1`) — that file is owned by another
agent working this tree concurrently and was correctly out of scope for this ticket. The
UI-side invariant (one choke point, ordering-correct backfill, real-change gating) is verified
above; the DB-side invariant is not re-verified here and should not be inferred from this
section.

### Audit summary

| Capability | Verdict |
|---|---|
| 8-emoji comment reactions | INTACT |
| Poly-assignee (dept/division), kind may be a unit | INTACT |
| Gantt: drag-reschedule / dependency-draw / multiselect / move-together / burndown | INTACT |
| D17 custom fields | INTACT |
| Doc versions + restore | INTACT |
| Task/doc templates | INTACT |
| Recurrence | INTACT |
| Per-project custom status registries | INTACT |
| Append-only assignment history (UI-side invariant) | INTACT |

**No regression found.** Nothing in `UrgencyChip.tsx`, `urgency.css`, or `task-detail.css` needed
a fix as a result of this audit — both files were read in full (`UrgencyChip.tsx`, 79 lines;
`urgency.css`, 81 lines) and are clean: no colour literal, per-tier shape (not colour-only),
`.pm-sr-only` label on the dot form, `prefers-reduced-motion` respected on the one animated
tier (overdue-dot pulse only, chip form never animates by design comment at `urgency.css:68-70`).

---

## 2. P4-L5 — the performance budget

### 2.1 What was measured, and how

Two commands, run once each (`npm run typecheck`, `npm test`), plus the build exactly once per
this ticket's authorisation:

```
npm run typecheck            # tsc --noEmit — clean, no output
npm test                     # vitest run, jsdom
DEMO_MODE=1 npm run build    # the real gate (next build)
```

Results:

- **Typecheck:** clean.
- **Unit tests:** **128 test files, 1387 tests, all passing, 32.71s wall clock**
  (vitest's own reported `Duration`; the breakdown it also reports — transform 28.84s / setup
  73.14s / collect 45.04s / tests 47.12s / environment 200.96s / prepare 26.05s — sums past the
  wall clock because vitest runs files in parallel worker threads; 32.71s is the number a human
  waiting on the command actually experiences).
- **Build:** `✓ Compiled successfully in 11.0s`, then type/lint validation, static page
  collection, and trace collection on top (the full `npm run build` invocation takes longer than
  the 11.0s compile step alone, but Next does not print a single end-to-end wall clock for the
  whole command — 11.0s is the number it does print, and it is the dominant cost).

### 2.2 First Load JS — the real numbers, not an estimate

Shared baseline (every route pays this once, cached after):

```
+ First Load JS shared by all                                   102 kB
  ├ chunks/1255-ab54a41c275880be.js                              46 kB
  ├ chunks/4bd1b696-100b9d70ed4e49c1.js                        54.2 kB
  └ other shared chunks (total)                                2.26 kB
ƒ Middleware                                                   34.3 kB
```

PM-specific routes, from the same build:

| Route | Page size | First Load JS |
|---|---|---|
| `/projects/[projectId]` (project workspace — Board+Gantt+Charts+Docs mounted via `?view=`) | 312 B | **139 kB** |
| `/departments/[deptId]/projects/[projectId]` (same workspace, dept-scoped) | 297 B | 139 kB |
| `/tasks/[taskId]` | 303 B | 118 kB |
| `/departments/[deptId]/projects/[projectId]/tasks/[taskId]` | 283 B | 118 kB |
| `/(.)tasks/[taskId]` (intercepted route — the task drawer slide-over) | 1.06 kB | 119 kB |
| `/departments/[deptId]/board` (cross-project-within-dept board) | 1.98 kB | 112 kB |
| `/departments/[deptId]/charts` | 2.25 kB | 107 kB |
| `/departments/[deptId]/timeline` (Gantt, dept-scoped) | 1.42 kB | 110 kB |

The project workspace (`139 kB`) is the heaviest PM route in the app, because it is a single
route mounting Board, Gantt, Charts and the doc/comment surfaces behind one `?view=` switch
rather than a route per view — that's a deliberate architecture choice (one component tree, one
data fetch per navigation) and the number is the honest cost of it. Every PM route is
server-rendered on demand (`ƒ Dynamic` — no static PM page exists, correctly, since every one is
session- and tenant-scoped).

### 2.3 The budget

**First paint (server-rendered PM routes).** Target: **time-to-first-byte + hydration under
1.5s on a mid-tier connection (Fast 3G-equivalent, ~1.5 Mbps) for the heaviest PM route
(139 kB First Load JS + the 34.3 kB middleware pass)**, and **under 500ms on a broadband/office
connection**. This is a budget for what we control — bytes shipped and render-blocking work — not
a promise about a user's actual network, which we cannot measure from this repo.

**Interaction target (board/Gantt at realistic tenant size).** Target: **drag-reschedule,
multiselect toggle, and status-column drag each complete their optimistic UI update in under
100ms**, with the network commit (`batchReschedule` / the assignee PATCH) following
asynchronously — this is achievable because every interactive Gantt/Board mutation in the current
code is already optimistic-first (state updates before the `await batchReschedule(items)` /
`await send(...)` resolves; see `Gantt.tsx:363,417` and every `pmActions.ts` write). The 100ms
figure is Repsona's own SPA-interaction budget restated as our target, not a number we measured
against Repsona directly (no access to their client-side profiling).

**The standing constraint.** Runtime dependencies stay at **exactly four**: `next`, `react`,
`react-dom`, `server-only` — confirmed against `platform-ui/package.json` `dependencies` as part
of this ticket (no fifth entry). No chart library at any tenant size; every chart in
`components/reports/charts/` and every Gantt/Charts visual in `components/pm/` is hand-rolled
SVG. This constraint is what keeps the 102 kB shared baseline from growing when Phase 5 adds the
`@all` cross-project surfaces, Productivity view, and additional charts — new chart types must
be new hand-rolled SVG, not a new package.

### 2.4 What was NOT measured, and why — read this before citing "faster" anywhere

- **No seeded large tenant exists in this repo.** `DEMO_MODE=1` fixtures
  (`lib/demoFixtures.ts` → `demoPm.ts`) are hand-authored demo data, sized for browsing the UI,
  not for load-testing it. I did not fabricate a large-tenant number, and did not run the build
  or any interaction test against one, because none exists to run against.
- **Repsona is a client-side SPA.** On a small tenant (a handful of projects, dozens of tasks —
  which is what the demo fixtures approximate), a client-side SPA that has already loaded its
  bundle can feel *faster* than our server-rendered navigation, because every subsequent view
  is a local re-render with no round trip. Our architectural bet — SSR pages, one execution
  environment, no client-side data cache to keep consistent — pays off at scale (many
  projects/tasks/concurrent editors, which is where an SPA's client-side state management and
  full in-memory dataset start to cost real bytes and real re-render time), not on a demo-sized
  tenant. **I have not demonstrated that payoff.** The 139 kB/118 kB numbers above are real; the
  claim that they translate into a win over Repsona at realistic scale is not measured here and
  should not be asserted as fact until it is.
- **No Playwright/Lighthouse timing run was performed.** The ticket scope was the build's own
  reported numbers (route sizes, First Load JS, compile time) and the vitest wall clock — real
  browser timing (Core Web Vitals, actual TTFB against a running server) is a separate
  measurement this ticket did not take, and the budget above is deliberately phrased as a target
  to be verified that way later, not as an already-verified result.
- **Board/Gantt "under 100ms" is a code-shape argument (optimistic updates exist), not a
  stopwatch measurement.** I read the code and confirmed the update model is optimistic; I did
  not instrument and time an actual drag interaction.

**Bottom line: "faster" now has a number, several numbers are real and reproducible (route
sizes, test wall clock, dependency count), and the numbers that would prove the scale claim
specifically — the ones that matter most for "except faster… at the tenant size a real team
runs" — are not yet measured because the large-tenant fixture and the browser-timing harness to
measure against it don't exist yet. Building the large-tenant demo fixture and a Playwright
timing pass against it is the natural next ticket; it is out of scope here and is flagged for
routing in §3.**

---

## 3. Findings for routing (not fixed here — outside this ticket's file ownership)

None. The audit in §1 found every "we exceed Repsona" capability intact with no regression, and
none of them required a change inside `UrgencyChip.tsx` / `urgency.css` / `task-detail.css`, the
only files this ticket was authorised to touch.

One follow-up worth queuing, surfaced by §2.4 rather than by the audit: **there is no large-tenant
demo fixture and no browser-timing harness**, so the "faster at scale" half of the owner's
directive is asserted as a target, not yet demonstrated as a result. Recommend a follow-up
ticket (scale-fixture + Lighthouse/Playwright-timing pass against `/projects/[projectId]` and
`/departments/[deptId]/board` at, say, 50 projects / 2,000 tasks) before anyone quotes this
budget as proof rather than as a target.
