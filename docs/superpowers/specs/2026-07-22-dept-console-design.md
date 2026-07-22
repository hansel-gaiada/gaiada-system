# Department Console Design — Command Center + Persistent Rail

**Status:** DESIGN COMPLETE (P1-02) · **Date:** 2026-07-22 · **Owner:** senior-uiux
**Ticket:** P1-02 in `docs/superpowers/plans/web-dev-phase1-tickets.md` — blocks P1-06/07/09/10.
**Extends:** `platform-ui/src/components/ui.css` (luxury primitives) +
`platform-ui/src/styles/globals.css` (tokens). Adds console-scoped tokens + components in
`platform-ui/src/components/departments/`.

This spec is the contract the console-shell ticket (P1-06) and the data-wiring ticket (P1-07)
build against. It does not touch `[deptId]/layout.tsx`, `page.tsx`, or `lib/deptToolkits.ts` —
those are P1-06's job. It ships the CSS those tickets need and the five reusable components,
with their prop APIs locked.

---

## 1. Problem & direction

The department console today is a header + tab strip + whatever the active tab renders — no
persistent "what do I do next" surface, no visual read of project health (numbers only), and a
"Build Tools" tab that's really just bookmarks. The brief: turn it into a **hybrid command
center** — calm, light, professional, and *visual* — without adding new tabs, new chrome, or
new interaction patterns. Every department (Web Dev today, any future department tomorrow) gets
the same shell; only the data differs.

**Guiding rules, in order of priority:**
1. **Reduce, don't add.** Build Tools folds into Home. No new page chrome. The rail is one
   surface, not a stack of widgets.
2. **Visual over numeric.** Every KPI that can be a bar or a ring, is. Numbers are still there
   (precision matters for an ERP) but they're never the *only* representation.
3. **Colour is signal, never decoration.** One risk colour (`#B5622F`, the system's existing
   "at risk / blocked / overdue" rust) is the only colour that means "look at this." Everything
   else stays neutral ink. A calm console is one where colour is rare enough to trust.
4. **Props only.** Every component in `components/departments/` is a pure view. Zero `fetch`,
   zero server-only imports, zero department-name branching. The Web Dev toolkit and the generic
   fallback toolkit render the exact same components — that's the proof this is a template, not
   a Web-Dev-shaped page with other departments squeezed in later.

---

## 2. Information architecture (decision #10 — locked, not re-derived)

Tabs, in order: **Home · Projects · Board · Timeline · Activity · PRD Studio · Repositories ·
Deliverables · Connections.**

- **Home** replaces today's Overview *and* absorbs Build Tools (as a `LauncherRow` at the
  bottom of Home, not its own tab). `/departments/[deptId]/tools` becomes a redirect to Home
  (P1-06).
- **Projects** is the owned-project list (table/grid); **Board** is the kanban working view —
  today's single "Projects & Workflow" tab splits into these two so a health-ring glance (Home)
  and a full backlog manipulation view (Board) don't compete for the same screen.
- **Activity** is the F2 (`work_activity`) feed at full width/filterable; the `ActivityFeed`
  component built here is what Home shows as a *compact* preview and what the Activity tab shows
  at full length — same component, different item-count prop, no fork.
- **PRD Studio** is untouched (WS11 edge — do not orphan, per decision #10).
- **Repositories / Deliverables / Connections** are new tabs (P1-09) that lean on the same
  `TeachState` empty-state pattern defined here (§5) before a department has connected anything.
- **The rail renders once, in `[deptId]/layout.tsx`, outside the tab `children`** — every one of
  the nine tabs sees the same "My work today / Waiting on me" panel without re-rendering it.

Icon note for P1-06 (not this ticket's file to edit): `shell/icons.tsx`'s `IconName` set has no
dedicated glyphs for Board/Timeline/Activity/Repositories/Deliverables/Connections yet. Suggested
reuse of the existing set so P1-06 doesn't need new SVG paths: Home→`home`, Projects→`projects`,
Board→`box`, Timeline→`clock`, Activity→`pulse`, PRD Studio→`pulse` (already used), Repositories→
`gateway`, Deliverables→`box`, Connections→`hub`. If that reuse reads as ambiguous once tabs are
side by side, adding 2–3 purpose-built glyphs to `icons.tsx` is a fast, low-risk follow-up — flag
to the architect rather than improvising bespoke SVG inside a component file.

---

## 3. Layout — 2-column shell with persistent rail

```
Desktop (≥1180px)                          Narrow (<1180px)
┌─────────────────────────────┬─────────┐  ┌───────────────────────────┐
│ PageHeader (existing)                  │  │ PageHeader (existing)     │
├─────────────────────────────┴─────────┤  ├───────────────────────────┤
│ SectionTabs (existing)                 │  │ SectionTabs (existing)    │
├─────────────────────────────┬─────────┤  ├───────────────────────────┤
│                             │  RAIL   │  │  MAIN (tab content)       │
│  MAIN (tab content)         │ sticky  │  │  — KpiStrip               │
│  — KpiStrip                 │ ┌─────┐ │  │  — dept-ring-grid         │
│  — dept-ring-grid           │ │My   │ │  │  — ActivityFeed preview   │
│  — ActivityFeed (preview)   │ │work │ │  │  — LauncherRow            │
│  — LauncherRow              │ │today│ │  ├───────────────────────────┤
│                             │ ├─────┤ │  │  RAIL (falls in normal    │
│                             │ │Wait │ │  │  flow, not sticky)        │
│                             │ │ing  │ │  │  — My work today          │
│                             │ │on me│ │  │  — Waiting on me          │
│                             │ └─────┘ │  └───────────────────────────┘
└─────────────────────────────┴─────────┘
```

- Markup: `.dept-shell > .dept-shell__main + .dept-shell__rail`. **DOM order is always
  main-then-rail** — the grid puts the rail on the right at desktop width; below the 1180px
  breakpoint the grid simply collapses to one column and the rail falls into normal flow
  *below* the main content. No JS, no reordering, no collapsible/accordion state to build or
  test. Main content stays first for mobile scroll order and screen-reader order, which also
  means "what do I do next" (the rail) is never the *only* thing above the fold on a phone —
  the tab's own content is.
- The rail is visually one panel (`.dept-rail`, a single hairline-bordered surface) with two
  internal sections, not two separate cards — reads as one system, and it's the thing that's
  the same across all nine tabs so it should look distinct from tab content that changes.
- `position: sticky` on the rail only applies ≥1180px, where there's enough width for it not to
  compete with main-content horizontal space.

This shell CSS (`.dept-shell`, `.dept-shell__main`, `.dept-shell__rail`) is delivered in this
ticket's CSS but **not yet wired into `layout.tsx`** — P1-06 places `<MyWorkRail .../>` inside
`.dept-shell__rail` and each tab's `children` inside `.dept-shell__main`.

---

## 4. The one signature visual: the health ring

`ui.css` already has a rule the whole system quietly obeys: *"the [status badge] dot is the
system's one sanctioned circle."* Everywhere else is hairlines and right angles — zero border-
radius, no shadows. Introducing progress **rings** is the one deliberate exception this redesign
takes, and it earns that exception by being reserved for the single highest-value number a
department owner checks: a project's health. It is not decoration — an SVG ring is a stroke
(hairline, same visual language as everything else), it's just bent into a circle, and its
sweep *is* the data (progress %), not an illustration of it.

- Ring stroke is the brand accent (bronze) at rest. It is **at-risk red only when the project
  is actually at risk** (`overdue > 0 OR blocked > 0`, decision #12) — the sole place colour
  signals urgency in this whole shell.
- Every ring is paired with the same two supporting facts every time: **open count** and
  **next milestone due** — no ring appears without its numeric backup, so the visual is a
  faster read of the same truth, not a prettier but vaguer one.
- KPI strip's Progress tile gets the same treatment in miniature: a 3px hairline bar under the
  percentage. That's the strip's only non-numeric element, on purpose — the other three KPIs
  (Active/Due soon/Blocked) are genuinely discrete counts and forcing a bar under them would be
  visual noise with no information gain.

---

## 5. The "Connect X" teach empty-state pattern

Distinct from the existing `systems/EmptyNote` (a single quiet caption for "the system is wired
up, there's just nothing here yet" — e.g. no agent goals). The **teach state** is for "this
department hasn't connected anything yet, and there's a concrete next step" — first-run
Repositories/Deliverables/Connections/Activity/Launcher-row-with-no-tools. Shape:

```
[glyph]
Title (one line, plain: "No activity yet", not "Error: no data")
Body (one line, ≤44ch, explains what will appear and why it's empty)
[optional ghost-button CTA → usually the Connections tab]
```

Implemented once as `TeachState` (`components/departments/TeachState.tsx`) and composed inside
`ActivityFeed` and `LauncherRow` here; P1-09 reuses the exact same component (imported, not
copied) inside the new Repositories/Deliverables tabs so first-run departments read identically
everywhere. `TeachState` is intentionally not one of the five named deliverables but is exported
for reuse — it has no data dependency of its own, only the copy/CTA passed to it.

---

## 6. Colour & tone rules (recap, binding for P1-06/07/09)

| Signal | Colour | Where it appears |
|---|---|---|
| At risk / blocked / overdue | `var(--dept-risk)` = `#B5622F` (matches `ui.tsx` `STATUS_COLORS` "at risk"/"blocked"/"overdue" — same colour, same meaning system-wide) | Blocked KPI value (only when >0), ring stroke + badge on at-risk projects, "Overdue" due-badge in the rail, the rail's left accent bar on "Waiting on me" rows, unmapped-seat caption in the launcher row |
| Positive / neutral progress | `var(--dept-positive)` = `var(--erp-accent)` (brand bronze) | Ring stroke at rest, KPI progress bar fill |
| Everything else | ink (`--text-primary` / `--erp-ink-50` / `--erp-ink-60`) | Labels, counts that aren't in trouble, captions, timestamps |

No new hue is introduced. Console tokens live scoped inside `departments.css` (`--dept-risk`,
`--dept-positive`, `--dept-ring-track`) rather than in `styles/tokens/colors.css` — they're
aliases for this surface, not new brand primitives.

---

## 7. Component inventory & prop contracts

All five live in `platform-ui/src/components/departments/`, are plain functions (no `"use
client"`, no hooks, no fetch), and render fully from props. Full TypeScript source is the
canonical contract; summarized here for the next FE seat:

### `KpiStrip` (`KpiStrip.tsx`)
```ts
interface KpiStripProps {
  active: number;              // todo + in_progress
  dueSoon: number;              // due ≤7d, not done
  blocked: number;
  progressPct: number;          // 0–100, avg across owned projects
  totalTasksFoot?: string;      // e.g. "of 24 total"
  totalProjectsFoot?: string;   // e.g. "across 6 projects"
}
```
Fixed 4-metric shape (not a generic array) because decision #12 fixes the semantics — every
department computes the same four numbers from tasks/projects it owns, so a typed contract here
removes ambiguity for P1-07 rather than reinventing a schema per caller.

### `HealthRingCard` (`HealthRingCard.tsx`) — one instance per owned project
```ts
interface HealthRingCardProps {
  projectName: string;
  href?: string;
  progressPct: number;          // 0–100, drives the ring
  openCount: number;
  nextMilestone?: { label: string; dueDate: string /* ISO */ } | null;
  atRisk: boolean;               // overdue>0 || blocked>0, computed by caller
  atRiskReason?: string;         // e.g. "2 overdue · 1 blocked"
}
```
Callers render N of these inside a `<div className="dept-ring-grid">` wrapper (CSS provided,
not a separate component — a grid of cards needs no logic of its own).

### `ActivityFeed` (`ActivityFeed.tsx`)
```ts
type ActivitySource = "pm" | "pipeline" | "github" | "google_drive" | "claude" | "manual" | "system";
interface ActivityItem {
  id: string;
  actor?: string | null;
  verb: string;                  // pre-humanized by the caller, e.g. "shipped"
  objectLabel: string;           // e.g. "Task: Fix login redirect"
  href?: string;
  occurredAt: string;            // ISO
  source?: ActivitySource;
}
interface ActivityFeedProps {
  items: ActivityItem[];         // caller sorts newest-first; component groups by day only
  emptyTitle?: string; emptyBody?: string; emptyCtaLabel?: string; emptyCtaHref?: string;
}
```
`source` is the fixed F2 enum from decision #3 — nothing Web-Dev-specific. Day-grouping
("Today"/"Yesterday"/date) is pure display math on `occurredAt`, not a fetch.

### `MyWorkRail` (`MyWorkRail.tsx`) — rendered once, in the layout
```ts
type RailPriority = "low" | "medium" | "high" | "critical";
interface RailTaskItem {
  id: string; title: string; href?: string;
  dueDate?: string | null; priority?: RailPriority; projectName?: string;
}
interface RailWaitingItem {
  id: string; title: string; href?: string;
  kind: "approval" | "blocked_task"; waitingOn?: string;
}
interface MyWorkRailProps {
  today: RailTaskItem[];         // caller sorts by (due, priority) per decision #12
  waiting: RailWaitingItem[];    // pending approvals + my blocked tasks, per decision #12
  todayEmptyText?: string; waitingEmptyText?: string;
}
```
The component does not sort — sort order is data-wiring logic (P1-07's job), keeping this a
pure view. Due badges (`Overdue` / `Due today` / `Due <date>`) are computed here since that's
pure display math on `dueDate`, same reasoning as `ActivityFeed`'s day grouping.

### `LauncherRow` (`LauncherRow.tsx`) — Build Tools merged into Home
```ts
interface LauncherItem {
  key: string; label: string; desc?: string; href: string;
  glyph?: string;                 // e.g. "⌘", "⎇", "△"
  external?: boolean;             // default true
  seatStatus?: "mapped" | "unmapped";   // C1 forward-compat, omit if no seat concept
  seatLabel?: string;             // shown when mapped, e.g. "opens as hansel@gaiada.com"
}
interface LauncherRowProps {
  items: LauncherItem[];
  emptyTitle?: string; emptyBody?: string; emptyCtaLabel?: string; emptyCtaHref?: string;
}
```
`seatStatus`/`seatLabel` are optional so P1-10 (C1 seat registry) can light up "opens as …" /
"Map your seat" without this component needing a Claude-specific prop or a second variant.

---

## 8. What's out of scope here (explicitly deferred to the tickets that own it)

- Wiring `[deptId]/layout.tsx` to place `MyWorkRail` in `.dept-shell__rail` and tab content in
  `.dept-shell__main`, the new tab routes, and the `/tools` → Home redirect — **P1-06**.
- All real data: KPI math, owned-project queries, `/api/:t/work-activity` reads, approvals reads,
  the (due, priority) sort — **P1-07**.
- Repositories/Deliverables/Connections tab bodies and their `TeachState` copy — **P1-09**.
- Seat-mapping admin UI and `seatStatus` wiring — **P1-10**.

---

## 9. Verification performed for this ticket

- `npx tsc --noEmit` — clean.
- `npx vitest run` — 151 tests / 31 files green, including 10 new tests across the 5 components
  (empty-state rendering, risk-colour-only-when-nonzero, badge/seat states) using mock props —
  no fetching, no backend, matches the "static skeleton, DEMO_MODE scratch render" acceptance bar.
