# PM System — Repsona Parity Audit + Department-Console PM Redesign

**Date:** 2026-07-23
**Status:** Plan — awaiting approval
**Context:** Follows the dept-console IA redesign (2026-07-23-dept-console-ia-redesign.md).
User feedback on the Web Dev → Work → Board view: layout is messy, boxes not uniform,
and "I don't think this is a proper project tracking & management system yet." User
asked for (a) an explanation of each sub-tab, (b) a full Repsona feature comparison,
(c) contextual rail (Home only), (d) full PM depth brought into the console, and (e)
close the parity gaps (tags, custom statuses, WIP+swimlanes, recurring).

---

## 1. The layout bug (root cause)

Two concrete defects produce the "messy / clipped / non-uniform" board:

1. **The persistent My-Work rail steals width from wide views.** `.dept-shell` is a
   fixed 2-col grid `minmax(0,1fr) 320px` applied to *every* tab
   (`components/departments/departments.css:26`). Correct for Home; wrong for the Board
   (a 4-column kanban) which needs the full canvas.
2. **The board clips instead of scrolling.** `.pm-board` is
   `grid-template-columns: repeat(4, minmax(220px,1fr))` with **no overflow wrapper**
   (`components/pm/pm.css:17`). 4×220px+gaps ≈ 920px; the rail-squeezed area gives
   ~700px, so columns hold their min and the 4th (DONE) overflows off-screen. Filter
   card (full width) next to cramped columns reads as "non-uniform."

**Fix (WS-1):** rail becomes contextual (Home only); Board/Timeline/Projects/Activity
get full width; board columns live in an `overflow-x:auto` scroller with uniform
fixed-width columns; unify filter-bar/column/header spacing.

## 2. Sub-tab purpose + current state

| Sub-tab | Purpose | State |
|---|---|---|
| Work › Projects | Projects this dept owns + task/done counts | ✅ Real |
| Work › Board | Kanban of tasks routed to dept/divisions/people; focus + group-by; drag | ✅ Real (richest) |
| Work › Timeline | Milestone/schedule across owned projects | ⚠️ Stub |
| Work › Activity | Cross-source work-activity feed, filterable | ✅ Real |
| Build › PRD Studio | Briefing → PRD via WS11 pipeline; lists runs | ✅ Real |
| Build › Repositories | Linked code repos (needs GitHub connection) | ⚠️ Stub |
| Build › Deliverables | Files/docs the dept produced | ⚠️ Stub |

Key insight: our **PM engine is deep, but the depth lives on `/projects/[id]` and
`/tasks/[id]`, not in the console.** The console surfaces only a thin slice → it *feels*
incomplete. WS-2 fixes that.

## 3. Repsona feature comparison

Legend: ✅ have · 🟡 partial · ❌ missing · 🏆 we exceed Repsona · ⭐ not in Repsona (beyond-parity)

### Where we MATCH or EXCEED Repsona
| Area | Repsona | Us | Verdict |
|---|---|---|---|
| Assignees | single Responsible + single Ball | poly-assignee (person/dept/division) + responsible | 🏆 |
| Dependencies | visual/scheduling only (red line) | hard `dependsOn` + cycle guard + blocked banner | 🏆 |
| Time tracking | planned/actual hours only | estimate + logged + **billable** + per-entry log | 🏆 |
| Automation / "flows" | none (Slack + API only) | WS4 n8n automation, event bridge, approvals | 🏆 |
| AI | none | AI Tracker + AI agents + gateway | 🏆 |
| Progress rollup | manual per-task | auto from subtasks → task → project | 🏆 |
| Global search | tasks + notes | cross-record global search (`/search`) | ✅ |
| Calendar | none | Calendar surface exists | ✅ |
| Roles/permissions | coarse role-based | Cerbos + RLS + company scope + org structure | 🏆 |
| Comments | threaded + mentions + reactions | threaded + AI badge | 🟡 (no reactions) |

### Where Repsona is genuinely AHEAD (real gaps to close)
| Area | Repsona | Us | Gap |
|---|---|---|---|
| Custom statuses/workflow | per-project custom names/order/colors | fixed todo/in_progress/blocked/done | ❌ |
| Tags / labels | on tasks + notes, colored | none | ❌ |
| Kanban grouping axes (draggable) | Status/Assignee/Ball/Priority all drag | Status drags; division/person read-only lanes | 🟡 |
| Gantt richness | drag-to-reschedule, dep-draw, move-together, burndown overlay | view Gantt on project page; dept Timeline stub | 🟡 |
| Milestone burndown + carry-forward | burndown chart + carry unfinished forward | model only, no burndown/carry | 🟡 |
| Notes/wiki depth | version history + rollback, templates, realtime, infinite hierarchy | ProjectDoc (title/body), simple editor | 🟡 |
| Task/note/project templates + duplication | yes | none | ❌ |
| Charts | cumulative-flow, burndown, tag-breakdown | project/exec rollups only | 🟡 |
| Productivity / activity score + heatmap | yes | activity feed only | ❌ |
| Followers/watchers | follow task (heart) | none | ❌ |
| "Set as Today" / stand-up flag | yes | My Work rail (different model) | 🟡 |
| Task duplicate | yes | none | ❌ |
| Import/export | CSV/XLSX/PDF/JSON in+out | CSV export (tasks) | 🟡 |
| Kaizen (KPT retro) | yes | none | ⭐ (Repsona-specific) |

### Requested items that are NOT Repsona features (beyond-parity — decide deliberately)
| Requested | In Repsona? | Note |
|---|---|---|
| WIP limits | ❌ No | ClickUp/Jira feature; we can add, but it's beyond "match Repsona" |
| Swimlanes (true horizontal) | ❌ No | Repsona only has group-by columns; beyond-parity |
| Recurring tasks | ❌ No | Not in Repsona docs; beyond-parity |
| Custom fields on tasks | ❌ No | Repsona lacks it; we have D17 on projects only |

## 4. Redesign — phased plan

### WS-1 — Console shell + Board layout (small; do first)
- Rail contextual: render My-Work rail only on Home (move it out of the shared
  `[deptId]/layout.tsx` into the Home page). All other tabs render full-width single
  column.
- Board: `overflow-x:auto` scroller; uniform columns (`grid-auto-flow:column;
  grid-auto-columns:minmax(260px,1fr)` or equal flex-basis); board can go full-bleed to
  the content width. Unify filter-bar + column card rhythm.
- Acceptance: 4 columns uniform + never clipped at 1360px; board scrolls if narrow;
  Home unchanged.

### WS-2 — Bring full PM into the console (medium)
- Projects tab: a project row opens the **full project workspace** (list · board ·
  Gantt · milestones · docs) inside the console (reuse the existing `/projects/[id]`
  views under `/departments/[deptId]/projects/[projectId]`, or frame the existing route
  in-console).
- Timeline tab: wire to the real **Gantt** — a dept-level reader aggregating milestones
  + timeline bars across owned projects (engine `computeTimeline` already exists).
- Task cards continue to open task detail (subtasks/deps/time/AI-tracker/comments).
- Acceptance: a Web Dev user can plan+track a project end-to-end without leaving the
  console; Timeline shows a real Gantt.

### WS-3 — Close the real Repsona gaps (larger; phased, prioritized)
Priority order (parity value ÷ cost):
1. **Tags/labels** — add to `PmTask` (+ migration), board/list filter, task detail,
   colored chips. High value, moderate cost.
2. **Draggable kanban grouping** — make division/person lanes reflect drag where it maps
   to a real reassignment (not just status). Medium.
3. **Milestone burndown + carry-forward** — reuse milestone model; add burndown chart +
   "carry unfinished to next milestone." Medium.
4. **Custom statuses/workflow (per project)** — configurable columns replacing the fixed
   4. Big (model + migration + board + move logic); do as its own phase.
5. **Templates + task duplication** — task/project templates, duplicate task. Medium.
6. **Charts** — cumulative-flow + burndown + tag-breakdown on a dept/project Charts view.
   Medium.
7. **Followers/watchers + reactions** — follow a task; emoji reactions on comments. Small–medium.

### WS-4 — Beyond-Repsona extras (optional; only if wanted)
- WIP limits, true swimlanes, recurring tasks, custom fields on tasks. Each is net-new
  (not parity). Build only on explicit go.

## 5. Recommended sequencing
WS-1 (now, quick win — fixes the visible mess) → WS-2 (makes the console a real PM home)
→ WS-3 phased by the priority list → WS-4 only if desired. WS-1+WS-2 alone convert the
console from "shallow" to "a proper PM workspace" using entirely existing engine code.

## 6. Open decisions
- WS-2 embedding: new in-console routes vs. framing existing `/projects/[id]` — decide at
  build time (lean: in-console routes reusing the view components).
- WS-3 scope/order: confirm the priority list or re-rank.
- WS-4: in or out.
