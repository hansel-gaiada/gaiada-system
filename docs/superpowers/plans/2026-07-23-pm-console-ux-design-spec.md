# PM Department Console — UX/Interaction Design Spec

**Date:** 2026-07-23
**Status:** Design spec — build-ready, awaiting approval to implement
**Companion docs:** `2026-07-23-pm-repsona-parity-and-console-redesign.md` (audit + plan),
`2026-07-23-dept-console-ia-redesign.md` (the two-level IA this builds on).

> Bar: match Repsona's UX/flow at full polish, on our own "luxury minimalist" design
> system (0 radius, no shadow, hairline 0.5px borders, opacity-fade hovers, Cormorant
> display / Inter body, accent #B5622F). Every surface names the exact files/classes to
> extend. No half-botched UI.

---

## 0. Contract/schema dependencies (flag for architect)

Most of this builds on the existing `/api/:t/pm/*` contract with NO backend change. Five
additions need new model/contract work — each designed in full below so it's build-ready
the moment the contract lands:

| Addition | Section | Extend this existing pattern |
|---|---|---|
| `PmTask.tags: string[]` + per-project `Tag{id,label,color}` registry | §6 | new (analog: `lib/org.ts` unit registry) |
| Per-project configurable statuses `{id,label,color,isDone,isBlocked,wipLimit}` | §7, §8 | `TASK_STATUSES`/`STATUS_LABEL` in `lib/pm.ts` become project-scoped data |
| `PmTask.customFields` | §5, §8 | **low-lift** — reuse live D17 framework (`components/forms/CustomFields.tsx`, `entities.ts`, `FieldDefManager.tsx`); add `entity_type:"pm_task"` |
| `PmTask.recurrence` | §8 | new — small enum + next-occurrence spawn |
| Gantt burndown daily snapshot | §4 | **architect decision** — nightly snapshot table vs. derive from `outbox_events`; not buildable from current data |

Everything else (board fixes, in-console project workspace, dept Gantt aggregation +
drag-reschedule + dependency-draw, task-detail nesting) is buildable today.

---

## 1. Console shell — contextual rail
Rail (`MyWorkRail`) shows on **Home only**. Board/Timeline/Projects/Project-Workspace are
**full-bleed** (independent of the user's global width pref — these are structurally wide).
- Add `fullBleed?: boolean` to `DeptTab`/`DeptGroup` (`deptToolkits.ts`); set on projects/board/timeline.
- New `components/departments/DeptShellFrame.tsx` (client): same deepest-prefix active-tab
  resolution as `DeptTabs.tsx` + a manual match for `/departments/{deptId}/projects/{…}`;
  full-bleed tab → `<div class="dept-shell dept-shell--full">` (no rail mounted), else the
  existing 2-col grid with rail.
- CSS: `.dept-shell--full{display:block}` + `.erp-main__inner:has(.dept-shell--full){max-width:none}`
  (pure CSS seam, no prop drilling across the layout boundary).

## 2. Board (kanban) — fix clipping + multi-axis drag
- **Clipping fix:** replace `.pm-board` grid with a fixed-width flex row inside a horizontal
  scroller (`.pm-board-scroll.erp-scroll` + `.pm-board{display:flex;gap:14px}` +
  `.pm-col{flex:0 0 280px}`). Uniform columns at ANY count (critical once §7 custom statuses
  ship). Drop the squeeze `@media` rules. Sticky `.pm-col__head`.
- **Unify axes:** delete `BoardLanes`; every grouping renders through `Board` with an
  axis-appropriate `move`:
  | Axis | Column | Drag sets | Drag? |
  |---|---|---|---|
  | Status (default) | status | `task.status` | yes (existing) |
  | Assignee | responsibleId | `assignee.responsibleId` | new, yes |
  | Priority | priority | `task.priority` | new, yes |
  | Division | division | `assignee={division…}` + resolve responsible | new, yes (inline popover on ambiguity) |
  Division drop: if current responsible already in target division → commit; else a small
  anchored popover (filtered responsible `<select>`, `.erp-usermenu__pop` style) — Esc cancels.
- **Card anatomy:** add tags row (§6), subtask count `n/m`, blocked badge (`.pm-blocked-chip`
  reused, needs a `byId` map the page already has), due-date pill (reuse rail's
  `--risk/--soon/--quiet` colors), optional 20px initials tile.
- **Drag affordances:** `.pm-card--dragging` (opacity .4), existing `.pm-col__body--drop`;
  commit via existing `startTransition`+`router.refresh()`.
- **WIP display (extra):** over-limit column head → `--dept-risk` border + count color;
  never blocks the drop, shows a one-line toast.
- **Error state gap:** `Board.tsx` currently ignores `move()`'s `{ok:false}` — add the inline
  toast pattern from `Dependencies.tsx`/`TimeLog.tsx`.

## 3. Project workspace IN the console
Extract `projects/[projectId]/page.tsx` body → `components/pm/ProjectWorkspaceView.tsx`
(`projectId` + `backHref`/`backLabel`). Mount twice:
- Standalone `projects/[projectId]` = thin wrapper (back → Projects) for search/notifications/rollups.
- New `departments/[deptId]/projects/[projectId]/page.tsx` (nested, full-bleed, DeptTabs shows
  Projects active; back → dept name).
- Rewrite in-console "open project" links (Projects tab table + Home health rings) to the nested path.
- View-switcher → components unchanged (Board/List/Gantt/Milestones/Docs); add the `?swimlane=`
  group-by control to the project Board view (currently missing).

## 4. Timeline tab — real department-level Gantt
Replace the skeleton. Aggregate owned projects' tasks+milestones (reuse Home's
`computeProjectHealth` calls) onto one shared axis. `Gantt.tsx` gains
`groupBy: flat|project|milestone|assignee` (default `project` at dept level) with sticky
collapsible group headers (`?collapsed=` in URL). Milestone diamonds + dashed guidelines (phase-1).
**Phase-1 interactions (endpoints already exist):** drag-to-reschedule (edge=resize, middle=move,
new `rescheduleTask` action), dependency-draw via hover end-balls (`.pm-gantt__ball`, reuses
`addDependency`+`wouldCreateCycle`; inconsistent schedule → `--dept-risk` line), in-bar progress
fill. **Phase-2:** move-together + shift-multiselect; burndown overlay (needs the §0 data decision).

## 5. Task detail — nest in console
Extract `tasks/[taskId]/page.tsx` body → `components/pm/TaskDetailView.tsx`. Mount twice
(standalone for search/notifications; new `departments/[deptId]/projects/[projectId]/tasks/[taskId]`).
**Link rule:** links to a task from inside `/departments/[deptId]/…` use the nested path; from
outside (search/notifications/`/tasks`/rollups) use `/tasks/[taskId]`. Make `Board`/`Gantt` task
links a `taskHref(id)` prop supplied by the caller. Add tags row + a Custom-fields card
(reuse `CustomFields.tsx` verbatim once `pm_task` field defs exist).

## 6. Tags/labels (contract addition)
`Tag{id,label,color}` per-project registry (architect: per-project vs per-tenant); `PmTask.tags`.
`TagColor` = closed set of **8 muted system-consistent tones** (extend accent family, same
desaturation as `STATUS_COLORS`). Appears on: board card, list column, task detail, filter bar
(multi-select chips). New `components/pm/TagChip.tsx` (one class + per-instance CSS var).
Inline tag manager (AssigneeEditor-style reveal, shared `ColorSwatchPicker`, in-use delete guard).
Picker = toggleable chips, instant-commit (like `Subtasks` checkboxes).

## 7. Custom statuses/workflow (contract addition)
Per-project ordered `ProjectStatus{id,label,color,isDone,isBlocked,wipLimit?}` replaces the
`TaskStatus` union. `isDone`/`isBlocked` flags feed existing KPI/health/AI-tracker math.
Editor: "⚙ Edit statuses" (gated `pm.manage`), inline-reveal, drag-reorder rows (vertical native
DnD), label input, shared `ColorSwatchPicker`, Done/Blocked toggle chips, WIP number, guarded
delete (inline "move N tasks to →"). Default projects seed today's 4 statuses (no visible change).
`groupByStatus` becomes project-data-driven → board renders N uniform scrolling columns.

## 8. Extras (beyond Repsona)
- **WIP limits** — display §2, set §7. No new surface.
- **Swimlanes (true 2-axis grid)** — phase-2. Rows=Division/Assignee, cols=Status; sticky left
  label column; between-row drag reuses §2's responsible-person popover.
- **Recurring (contract addition):** `PmTask.recurrence{freq,until?}`. `NewTaskForm` "Repeats"
  select (conditional-reveal "Ends"). `↻` glyph before title everywhere. Final-occurrence-done
  spawns next server-side + undo toast.
- **Custom fields on tasks (contract addition, low-lift):** reuse `CustomFields.tsx`/`FieldDefManager.tsx`;
  add `pm_task` to `entity_type`.

## 9. Cross-cutting
- **Filters:** keep the `.lux-filters` GET-form pattern for every new filter (tags, custom-status,
  Gantt group-by) — bookmarkable/back-safe, no client filter store.
- **Saved views:** natural follow-up = named saved query strings; note the seam, not built now.
- **Empty states:** keep the `EmptyNote` (connected-but-empty) vs `TeachState` (first-run) split;
  new empties use `EmptyNote`.
- **Responsive:** board/Gantt scroll at every width; workspace/detail grids already reflow.
- **A11y (required, not optional):** keyboard alternative for EVERY drag — board card "⇅ Move"
  popover; Gantt arrow-nudge + link-mode; status/tag reorder buttons w/ `aria-live`. Focus
  moves into inline panels + returns on close. `role=list/listitem` on columns/cards. 8-swatch
  palette must pass AA on light AND dark cards.
- **Motion:** new transitions ride existing tokens; add new selectors to the existing
  `prefers-reduced-motion` block.

## Net-new / changed files
- `components/departments/DeptShellFrame.tsx` (new), `departments/[deptId]/layout.tsx` (use it)
- `components/pm/ProjectWorkspaceView.tsx` (extract), `components/pm/TaskDetailView.tsx` (extract)
- `departments/[deptId]/projects/[projectId]/page.tsx` (new), `.../tasks/[taskId]/page.tsx` (new)
- `components/pm/TagChip.tsx`, `components/pm/ColorSwatchPicker.tsx` (new)
- `departments/[deptId]/timeline/page.tsx` (rewrite), `Board.tsx` (unify, delete `BoardLanes`)
- `lib/pm.ts` / `demoPm.ts` + platform-nest migrations for the §0 contract additions
