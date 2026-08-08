# PM — Repsona Parity Phase 4: cross-project scope, the Ball axis, and a real dataviz layer

Status: **COMPLETE — 2026-08-08.** Phase 4 and Phase 5's PM scope are on `main`, CI green.
Shipped across 7 agent waves; see §0.1 for the execution log. Still open: `B0` (a design note the
work itself overtook), `F2` (task-level like — owner decision), `K4` (the employee-portal contract,
another session's surface), the 4 owner decisions in §5, and the 8 `PMA-*` tickets raised by the
agentic-native audit (`2026-08-08-pm-agentic-native-audit.md`).
Planned 2026-08-04 · supersedes nothing; extends
`2026-07-23-pm-repsona-parity-and-console-redesign.md` (P1–P3, DEV-VERIFIED 2026-07-24/25) and its
UX spec `2026-07-23-pm-console-ux-design-spec.md`.

Trigger: side-by-side review of the live Repsona instance (`gda.repsona.com`, 6 screenshots of the
`@all` cross-project scope: Home · Gantt · Responsible · Ball · Charts · Productivity) against our
PM module.

---

## 0. The honest read

P1–P3 went **deep on one project**: tags, custom fields, custom statuses, recurrence, burndown,
swimlanes, templates, duplication, followers, reactions, doc versions. That work is real and in
several places exceeds Repsona.

What the screenshots expose is a different axis. Repsona's entire IA is a **scope switcher** —
one dropdown flips *every* view between one project and `@all`. We have three scopes
(tenant dashboard → department console → project workspace) but **no cross-project PM scope at
all**, and two of Repsona's six cross-project views have no equivalent anywhere in our app.

So this is not "more project features". Workstreams A–D came out of the parity review; E–K are the
owner's amendments of 2026-08-04, and they are what push this past one phase (see §4.0):

| # | Workstream | Why |
|---|---|---|
| **A** | Cross-project (`@all`) scope + scope switcher | The missing axis; makes every existing view reusable at tenant grain |
| **B** | The **Ball** axis | A genuine capability gap we previously mis-scored as "we exceed" (see §2) |
| **C** | Gantt chrome (zoom · window · filter facets · today line · undo/export) | The most visible fidelity gap |
| **D** | A tokenised dataviz colour ramp | The prerequisite for "colourful bars/charts/kanban" that does not break the build |
| **E** | Productivity view | Second missing cross-project view; ingredients all exist |
| **F** | Task-modal parity | Small, cheap, independent |
| **G** | **Urgency: overdue · almost late · in time** | Owner request; the "glance many projects" affordance, and it doesn't exist at any grain today |
| **H** | **Project time range** | Owner request; `PmProject` has `dueDate` but no start — nothing to track against |
| **I** | **Chained tasks (enforced)** | Owner request; `dependsOn` exists but is advisory only. This is what gives the status ladder teeth |
| **J** | **WA bot + AI agent access, RBAC-gated** | Owner request; MCP foundation exists. D14 **cleared** 2026-08-05/06 — the real gate is impact classification (§4.2) |
| **K** | **Progress → client portal + employee surfaces** | Owner request; portal timeline exists, employee portal is another session's |
| **L** | **Repsona fidelity: UI + vocabulary** | Owner directive 2026-08-06 — "exactly the same as Repsona, faster and better". Overrides §2(a); PM becomes a deliberate visual island |

Order matters: **D unblocks the visual half of A/B/C/G**, and **A's data layer unblocks B, C's
filter facets and G's server-side "about to slip" query**. Do D and A's data layer first.

---

## 0.1 Execution log

**2026-08-06 — first foundation slice, DEV-VERIFIED.** Deliberately the pure, client-safe helpers
that everything else consumes, because these are precisely where drift starts if six surfaces each
roll their own.

| ticket | what landed | verification |
|---|---|---|
| `P4-G1` `P4-G2` | `src/lib/pmUrgency.ts` — `taskUrgency` / `projectUrgency` / `rollUpUrgency` / `dayDiff`, tiers `overdue · due-soon · on-track · undated · done`, dates-only with a 3-day default window, per-project override. Re-exported from `lib/pm.ts` | 27 new unit tests |
| `P4-L2` | `src/lib/pmVocabulary.ts` — `PM_TERMS`, `PM_STATUS_LADDER` (the 5 statuses), `PM_RENAMES` | 12 new unit tests |

**2026-08-06 — second slice: the palette, the chip, and the status ladder.**

| ticket | what landed | verification |
|---|---|---|
| `P4-L1` `P4-G4` | `src/styles/tokens/pm.css` — PM-scoped Repsona palette: chrome, `--pm-radius*`, urgency graphic/text tiers, the 5 status hues, an 8-tone categorical ramp. Imported by `globals.css` | 6 new guard tests in `tokens.test.ts` |
| `P4-G3` | `components/pm/UrgencyChip.tsx` + `urgency.css` — dot and chip forms, per-tier **shape** as well as hue, roll-up counts | 9 new tests |
| `P4-B8` | `DEFAULT_STATUSES` now DERIVES from `PM_STATUS_LADDER`; ladder = `Backlog · ToDo · Doing · Blocked · Done`, hues from the PM palette. New `intakeStatusId()` / `readyStatusId()` helpers | 8 new/updated tests |

Gate (both slices): `tsc` clean · **1242 unit tests pass** (117 files) · `DEMO_MODE=1 npm run build`
green.

Palette notes: the hues are **reconstructed from the screenshots**, not sampled from Repsona's CSS —
they land on the Material ramp, which is evidently what Repsona uses. Every ratio was computed with
the WCAG formula: urgency text tiers are 4.91–5.59:1 on light and 5.50–7.89:1 on dark; the tone ramp
uses **one** text colour (ink) on every chip in both themes, 4.94:1 (purple, the floor) to 11.63:1
(lime), which works because ink-on-fill is surface-independent — so there is no per-tone/per-theme
text matrix to keep honest. The chip is never colour-only: overdue is the one pointed shape, due-soon
a clock, on-track a check, and a dot carries a real `.pm-sr-only` label because `title` is not
reliably announced.

### 0.2 Two real bugs the ladder change surfaced (both fixed)

Adding one status at position 0 broke two things that had nothing to do with naming. Both failed
**silently** — no throw, no type error — which is why they are worth recording as a class.

1. **`suggestFromTask` stopped suggesting Doing.** The rule was "if you are at `flow[0]` and have
   progress, step to `flow[1]`". `Backlog` took position 0, so `todo` was no longer `flow[0]` and a
   task with real subtask progress simply stopped being advanced. Generalised to "from anything
   before the ACTIVE-WORK step, jump to it", where the active step is `in_progress` when the registry
   has it and otherwise the second spine entry (which reproduces the old behaviour exactly for a
   custom registry). Bounded on purpose: a task already at or past the active step is left alone, so
   progress can never push work forward into a review/approval status.
2. **A fired recurrence would have been parked in Backlog.** The spawn used "first non-done status",
   which became `Backlog` — invisible in ToDo, so the recurrence looks broken while every test that
   only asserted "a child was spawned" still passes. Root cause: three call sites reached for "the
   first status" while meaning **two different things**. Both are now named —
   `intakeStatusId()` (fresh uncommitted work: a duplicate → Backlog) and `readyStatusId()`
   (work ready to pick up now: a fired recurrence, or workstream `I`'s auto-promotion → ToDo). A
   bare `statuses[0]` in PM code is now a smell. Regression guards added for both.

### 0.3 `P4-B8b` — backend ladder + the intake/ready split — **LANDED 2026-08-06**

`platform-nest` now carries the same 5-status ladder (`src/modules/pm/pm.controller.ts`), with the
PM-palette hex mirroring `styles/tokens/pm.css`, plus `intakeStatus()` / `readyStatus()` applied to
all four defaulting sites: new task → **ready**, recurrence spawn → **ready**, task duplicate →
**intake**, project duplicate → **intake**. `tsc` clean; **83 PM tests pass** (was 82 — one added).

**No migration, deliberately.** Statuses are synth-on-read: a project with zero
`pm_project_statuses` rows — everything that never opened the editor — picks up the ladder on the
next read. A project that *has* materialized rows customized its workflow on purpose, and inserting a
status at position 0 would silently reorder someone's board, so those keep exactly what they have.
This also sidesteps the backfill-under-RLS trap entirely, because there is no backfill.

**The backend suite caught a defect in my own `readyStatus`.** There is an existing test that builds a
project where the literal `todo` status is flagged `isDone` — written precisely to stop a
literal-id fallback. `readyStatus` prefers the canonical `todo` **by id**, so on that project it
would have dropped every new task and every fired recurrence into a **done** column: born complete,
progress coerced to 100. The id preference is now re-checked against the flags in *both* layers, with
guard tests either side. Two lessons worth keeping:

- an id-based preference in a registry whose flags are user-editable must always be flag-checked;
- the older test's *setup* silently depended on create defaulting to "first status by position". That
  default is now `readyStatus`, which skips a done-flagged status on purpose — so the setup was made
  explicit rather than the assertion weakened. A test whose premise erodes is worth more than a test
  whose expectation is loosened.

One wart recorded, pre-existing and out of scope: the backend's default colours are literal hex, so a
**materialized** status carries a fixed colour that cannot adapt to dark mode, while a synthesized one
renders through `var(--pm-status-*)` and does. The values match, so the two agree in light mode.

Historic note — what this ticket was opened to fix: `platform-ui`'s `DEFAULT_STATUSES` is only the fallback
for when the backend returns no registry rows; `platform-nest` carries its **own** independent
default list at `src/modules/pm/pm.controller.ts:105-106` (still `To do · In progress · Blocked ·
Done`, house-palette hex). So as of this slice a project created through the backend gets four
statuses while the UI's fallback synthesizes five. This is precisely the frontend-first drift the
repo warns about, and it is *my* change that opened it.

It had to, in one go:

- point the backend's default list at the same 5-status ladder (and decide whether existing
  `pm_project_statuses` rows get a Backlog row backfilled — see the RLS backfill trap),
- mirror the intake-vs-ready split at the **three** sites that currently share the
  `firstNonDone?.id ?? "todo"` idiom — recurrence spawn (`:1115`), task duplicate (`:1262`), project
  duplicate (`:1414`) — all three of which would park work in Backlog,
- decide the **new-task default** (`:826` takes "first status by position", which becomes Backlog).
  A task created from the New Task form arriving in Backlog rather than ToDo is a visible product
  decision, not an implementation detail.

Two design choices in that slice worth knowing before building on it:

- **`today` is a required parameter, never read from the clock inside the helper.** Server and
  client straddle midnight differently and locale/timezone divergence is a known hydration trap
  here; the server resolves "today" once per render and passes it down, so every consumer of one
  page agrees by construction. `dayDiff` parses at UTC midnight, so DST cannot make a calendar day
  23 or 25 hours long and round to the wrong integer (pinned by tests).
- **`taskUrgency` takes a precomputed `isDone`**, because done-ness comes from the task's own
  project's status registry and this module has to stay client-safe. Same precedent as `taskTags`.

**Next up, and why they aren't done yet:** `P4-G3`/`P4-G4` (the `UrgencyChip` primitive) need the
Repsona palette from `P4-L1` first — exact colour values plus light/dark contrast validation, which
is a design decision, not a mechanical one. `P4-B8` (pointing `DEFAULT_STATUSES` at
`PM_STATUS_LADDER`) is held deliberately: see §3.1.

### 3.1 `P4-B8` has a visible consequence — flagging before doing it

Adding `backlog` to the synthesized default set is not a pure rename. `isSynthDefaultStatuses()`
exists to keep never-customized projects **pixel-identical** (no status-colour dots on column heads
until a project actually customizes), and it compares the set structurally — length included. So
landing the 5-status ladder means:

- every project still on synthesized defaults **gains a Backlog column** on its board, and
- `isSynthDefaultStatuses` must be updated, which by definition changes that "pixel-identical"
  behaviour for those projects.

That is a visible change to live boards, so it wants an explicit call rather than arriving as a
side-effect of a naming ticket: do projects on defaults get Backlog automatically (recommended —
otherwise the ladder the owner specified doesn't actually exist for most projects), and do
already-customized projects get it offered or left alone?

## 1. Gap register — screenshot by screenshot

### 1.1 Scope switcher + `@all` (Home screenshot, top-left "Cross project ▾")

| Repsona | Ours | Verdict |
|---|---|---|
| Project dropdown switches scope for all 6 views | 3 hardcoded scopes, no switcher, no tenant-wide PM scope | **MISSING** |
| 6 counter badges in the top bar (time · responsible · ball · reactions · ? · info) | bell + global search only | **MISSING** |

Routes today: `/projects/[id]?view=…` (project), `/departments/[deptId]/{board,timeline,charts}`
(department, via `lib/departments.ts` derived from org structure + poly-assignee), `/` (My Work).
There is no route that says "all PM work in this tenant".

### 1.2 Home (status dashboard, 4 columns)

Repsona: `Today's Todo` · `Completed Tasks` · `Tasks with Activity` (explicit 7-day window
`7/28 – 8/4`, grouped by status, **with comment excerpts and @-mentions inline**) ·
`Upcoming Schedule` (next 7 days, grouped by status). Every card shows avatar · project name ·
parent-task breadcrumb · status pill · due date · overdue glyph.

Ours: `/` My Work + per-department Home. Neither is cross-project-PM-shaped, and **no view
anywhere renders comment excerpts against a task card** — that's the column that makes Repsona's
Home feel alive.

### 1.3 Gantt

| Feature | Repsona | Ours (`components/pm/Gantt.tsx`, 568 lines) |
|---|---|---|
| Day / Week / Month zoom | ✅ 3 buttons | ❌ single auto-fit scale |
| Explicit date window (`2026-07-04 – 2026-11-04`, clearable) | ✅ | ❌ window is derived from task min/max (`computeTimeline`) |
| Day columns w/ weekday headers | ✅ | ❌ axis is two labels: start + end |
| Today marker line | ✅ red vertical | ❌ |
| Filter facets: Keywords · Tags · Status · Responsible · Ball · Priority · Milestones · Due date | ✅ 8 | 🟡 **tags only** |
| Toggles: Sub-task · Overdue only · Show closed | ✅ 3 | ❌ |
| Undo / redo | ✅ | ❌ (drag-reschedule is immediate + irreversible) |
| Export (download icon) | ✅ | ❌ |
| Project group rows w/ inline "Add a task" | ✅ | 🟡 groups yes (`GanttGroup`), inline add no |
| Drag-reschedule · dependency draw · multiselect · move-together · burndown overlay | ❌ | ✅ **we exceed** |

So our Gantt has the *harder* half (interaction, dependency graph, cascade) and is missing the
*cheap* half (chrome). That's a good position to be in.

### 1.4 Responsible board

Per-person columns with avatar headers, `no user` column first. We have this as
`?swimlane=assignee` inside one project (`assigneeColumns()` in `lib/departments.ts`) — needs
promotion to a first-class view at `@all` scope. Mostly free once A lands.

### 1.5 Ball — **the real capability gap, and we are deliberately going past Repsona**

The Repsona `Responsible` and `Ball` boards show **different tasks for the same people**
(Edward: 1 responsible task vs 4 ball tasks; Gusde: 5 vs 6). The task modal settles the data model:
`Responsible`, `Ball`, `Due date` and `Status` are **four independent fields**, Ball is a single
person with a `Set to me` shortcut, and Repsona's ball is *last-write-wins* — reassigning
overwrites, and the previous holder is gone.

The P1–P3 plan scored this `🏆` for us on the grounds that poly-assignee (person/division/
department) + `contributors` beats "single Responsible + single Ball". **That was a category
error** — poly-assignee is a richer *ownership* model; Ball is a second, orthogonal axis meaning
*"whose turn is it right now"*. `grep -ri "\bball\b" src/lib/` returns nothing.

**RESOLVED 2026-08-06 — Ball is our existing assignee, renamed.** The owner's call: *"Ball is
exactly assignee, but a rename, as the current team is already familiar with how Repsona names
things."* This collapses most of workstream B, because our `Assignee` type **already carries two
independent people**:

| Repsona field | Our field | Notes |
|---|---|---|
| **Ball** | `assignee.refId` + `kind` | The assignment itself. `kind:"person"` renders as a person, exactly like Repsona; `kind:"division"/"department"` is our superset, which Repsona cannot express |
| **Responsible** | `assignee.responsibleId` | Already literally named "responsible", always a real person, and **independently settable** (`reassignResponsible` patches it while leaving `refId`/`kind` alone) |

So there is **no new axis, no second assignment concept, and no new column for the current
holder** — the two side-by-side pickers in the Repsona modal map onto fields we already have. What
survives from the original amendment is the **history** requirement, and only that:

> Passing the ball does not remove the previous holder — we keep the full record and history.

**Original amendment (2026-08-04), retained for the history requirement only:**

> Ball assigns the job to a person **and** sets the job status (`Backlog · ToDo · Doing · Done`).
> The current assignee is **whoever holds the latest ball**. Passing the ball does **not** remove
> the previous holder — we keep the full record and history of the task.

So the ledger is now a **history table beside the existing field**, not a replacement for it. The
current ball stays where it already lives (`pm_tasks.assignee`); each change appends
`(refId, kind, responsibleId, status, when, by whom, why)`. Consequences:

- **No denormalisation to maintain** — this was the main risk in the old shape and it's gone. The
  current holder is the existing field; the ledger is append-only history read on demand. Nothing
  can drift out of sync because there is only one source of truth for "now".
- **Append-only means never `UPDATE`/`DELETE`** on the history table. A mistaken pass is corrected
  by passing again, which is also what makes the record trustworthy.
- **The ledger overlaps three records we already keep**: who worked on this (`contributors`, TR-02),
  status over time (`pm_progress_snapshots`, 0040), and the activity feed (`work_activity`, §11).
  Ball history should **feed** those, not become a fourth parallel record — see decision 7.
- Every pass is a **notification event** ("the ball is yours"), so it goes through the outbox.

(Note: `pm-gantt__ball` in the Gantt CSS is the dependency-draw handle. Unrelated — rename it
during C now that "ball" means something specific.)

**The status ladder — RESOLVED 2026-08-06: `Backlog · ToDo · Doing · Blocked · Done`, one status
field, registry kept.** `Blocked` stays (the earlier 4-item list dropped it); only `Backlog` is
genuinely new, and `In progress` renames to `Doing`. Per-project registries still let a project add
`Ready to check` / `Client Review` as the owner's live instance does.

**One consequence needs a call (decision 17): is `Blocked` set by the system or by a human?** With
chain enforcement (`I`) the system knows a task has open blockers, so `Blocked` can be derived. But
Repsona teams also use Blocked for *external* waits ("waiting on the client"), which no dependency
graph can infer. Recommend **both, distinguishably**: system-set when an open dependency exists
(with the blocker named, and cleared automatically when it closes), manually settable for external
blocks (with a required reason). A single undifferentiated `Blocked` where nobody can tell whether
the system or a person set it — and therefore whether it will clear itself — is the failure mode.

Historic context for the above (kept because it explains why the registry survives):

- `DEFAULT_STATUSES` (`lib/pm.ts`) = `To do · In progress · Blocked · Done` — **no Backlog**, and
  `Blocked` has no place in the new ladder.
- A full **per-project custom status registry** (P2-04, migration 0038) with colours, `isDone`,
  `isBlocked`, `wipLimit`, ordering — projects define their own sets, and `backlog` already appears
  as a status id in `pm.test.ts`, so the ladder is expressible today without new columns.
- The owner's own live Repsona uses **five** statuses (`ToDo · Doing · Ready to check ·
  Client Review · Done`) — i.e. more than the 4 in the amendment, which is exactly what a
  per-project registry is for.

Settled: **one status field, registry kept**, default ladder becomes the five above, and each ball
event records the status at the moment of handoff.

### 1.6 Charts

| Repsona | Ours (`components/pm/Charts.tsx`) |
|---|---|
| Cumulative flow, stacked colour bands + legend | ✅ built, coloured from the status registry |
| **Tag distribution donut** | 🟡 ranked horizontal bars (deliberate — dataviz guidance) |
| Burndown when milestones set | ✅ built |
| — | ✅ we add: KPI tiles, crosshair tooltips, `<details>` data tables |

Only real gap is scope (per-project only) + the donut. `Donut` already exists in
`components/reports/charts/` — reuse, don't rebuild. Note Repsona's chart is visually louder
mostly because of **saturation**, not chart type: that's workstream D, not a chart rewrite.

### 1.7 Productivity — **second real gap**

Per-person: a big contribution score (430 / 218), a GitHub-style **year calendar heatmap**, and an
8-series activity area chart (completed tasks · assigned-completed · involved-completed · tasks
accepted · reactions · reactions received · contribution to notes · comments · total).

We have every ingredient and zero assembly: `CalendarHeatmap` + `TrendLine`/`StackedBars` in the
reports chart kit, the `work_activity` table (§11 of the BFF contract), reactions/followers
(P3-08), `rollup_metrics`, and `/reports/person`. What's missing is (a) a **scoring formula
decision** and (b) a series endpoint. The tracker program (`tracker-reporting-foundation.md`)
already owns this ground — Phase 4 should **consume** it, not fork it.

---

## 2. Design-system decision — read before writing any CSS

> **SUPERSEDED 2026-08-06 by workstream `L`.** The owner chose full Repsona fidelity, which is
> option (b) below (a scoped PM skin), not the recommended (a). `L1` keeps the guard test intact by
> putting the Repsona palette in a **PM-scoped token file** rather than exempting PM components —
> read `L` for the mechanism. The analysis below stands as the reasoning for *why* a scoped token
> file is the only safe way to do (b).

`src/styles/tokens.test.ts` fails the build on:

- **any** colour literal (hex / `rgb()` / `rgba()`) in `src/components/**/*.css` — the only
  exemptions are `creative/creative.css` and the token layer itself,
- any `border-radius` or `box-shadow` in `globals.css` (shadows only via `--elev-overlay`),
- drift between the two dark blocks in `colors.css`.

The live palette is the Syrowatka luxury family — muted bronze/champagne/olive, hairline borders,
zero radius, opacity-only hovers. Repsona is saturated (pink/azure/amber/lime) and rounded.

**"Colourful bars for timeline and charts, kanban" therefore cannot be done by pasting Repsona's
hexes into component CSS — the guard test will fail the build, correctly.**

Two ways forward:

- **(a) Recommended — a tokenised dataviz ramp.** Add `--viz-1…--viz-8` (+ `--viz-N-fill`,
  `--viz-N-fg`) to `styles/tokens/colors.css` (the one place literals are legal), with validated
  light/dark pairs, and point status colours, tag colours, Gantt bars, kanban accents and chart
  series at it. Keeps one identity, satisfies the guard test, gives real saturation where data
  lives. The 8-slug `lib/tagColors.ts` palette is the seam — it already ships onLight/onDark pairs
  with documented WCAG ratios; extend that method with a **bolder, higher-chroma ramp** rather
  than inventing a parallel system.
- **(b) A scoped "app-like" PM skin** (rounded, saturated, its own CSS island). Faster to make
  look exactly like the screenshot; fragments the design system, needs a guard-test exemption per
  folder, and puts PM permanently out of step with HR/Reports/Creative.

Recommendation: **(a)**. Follow the `dataviz` skill for the ramp (form heuristic, colour formula,
the runnable contrast validator) and extend `tokens.test.ts` to assert the ramp's light/dark
parity so the next person can't half-add a colour.

Open question for you either way: **how far do we push saturation?** Repsona-loud, or
"luxury-loud" (the same ramp at ~70% chroma so it still reads as our product)?

---

## 3. Workstreams and tickets

Ticket ids continue the PM series (`P4-*`). Tier tags follow the agent-army standard.

### D — dataviz token layer (do first; blocks the visual half of everything else)

| id | scope | tier |
|---|---|---|
| `P4-D1` | `--viz-1…8` ramp + `-fill`/`-fg` tiers in `tokens/colors.css`, light + dark, WCAG-validated via a throwaway contrast script (document the ratios inline, same as `tagColors.ts` does) | senior-uiux |
| `P4-D2` | Extend `tokens.test.ts`: ramp exists, both dark blocks identical, every `--viz-N` has all three tiers | junior |
| `P4-D3` | Repoint consumers: `TAG_COLOR_HEX`, `STATUS_COLORS`/`statusColor`, `pm-gantt__bar--*`, board column accents, `Charts` series | senior-fe |

### A — cross-project scope (the spine)

| id | scope | tier |
|---|---|---|
| `P4-A1` | **BE:** `GET /api/:t/pm/tasks` grows server-side facets — `status[]`, `tag[]`, `priority[]`, `responsible[]`, `ball[]`, `milestone[]`, `due{From,To}`, `q`, `overdueOnly`, `includeClosed`, `includeSubtasks` — + cursor pagination. Client-side filtering over a whole tenant will not scale, and the existing `?assignee=me` is the only tenant-wide read today | senior-be |
| `P4-A2` | **BE:** cross-project aggregates — `GET /api/:t/pm/flow` and `/pm/burndown` at tenant grain (both are per-project today) | senior-be |
| `P4-A3` | `lib/pm.ts` scope layer: one `PmScope = {kind: "all"\|"department"\|"project", id?}` threaded through the readers, so the same view components serve all three scopes. **Do not fork a fourth set of components** | senior-fe |
| `P4-A4` | `ScopeSwitcher` in the PM surface header (Repsona's dropdown), persisted like the company switcher | senior-uiux |
| `P4-A5` | Route group for `@all` — new top-level PM surface (see §5 open decisions) mounting Home · Board · Responsible · Ball · Gantt · Charts · Productivity | medior |
| `P4-A6` | `Responsible` promoted to a first-class view at every scope (reuse `assigneeColumns`) | junior |
| `P4-A7` | Cross-project Charts (reuse `Charts.tsx` unchanged, feed it A2's aggregates) + add the tag **donut** alongside the ranked bars, reusing `reports/charts/Donut` | medior |
| `P4-A8` | `@all` **Home**: 4 columns incl. `Tasks with Activity` with comment excerpts — needs a joined comments-on-tasks read (`work_activity` §11 is the likely source) | medior |
| `P4-A9` | Top-bar counter badges (mine-scoped: responsible · ball · reactions · overdue) — one counts endpoint, not six list calls | medior |

### B — Ball (= assignee, renamed) + assignment history

**Much smaller than originally planned** — Ball maps onto the existing `assignee` field (§1.5), so
this is a rename plus a history table, not a new axis. Decisions 3–5 are resolved; 7 and 17 remain.

| id | scope | tier |
|---|---|---|
| `P4-B0` | Design note: history-table shape, and how it relates to `contributors` / `pm_progress_snapshots` / `work_activity` so we don't ship a fourth "who touched this" record (decision 7) | architect |
| `P4-B1` | **DB:** migration `0078` (head is **0077** `mail_core` — re-verify the ledger before writing) — `pm_task_assignment_events (id, company_id, task_id, ref_id, ref_kind, responsible_id, status_id, note, changed_by, created_at)`, append-only (**no UPDATE/DELETE grant to the runtime role**), composite tenant-scoped FKs, index on `(company_id, task_id, created_at DESC)` and `(company_id, ref_id)`. **No denormalised current-holder column** — `pm_tasks.assignee` already is it. RLS + the `app_module_allowed` two-sided handshake apply | senior-db |
| `P4-B2` | **DB:** seed one history row per task that already has an assignee, so existing tasks don't read as "never assigned". Read `migration-backfill-rls-trap` first: an owner role without BYPASSRLS and an unset tenant GUC makes a backfill affect **zero rows and report success** | senior-db |
| `P4-B3` | **BE:** every write that changes `assignee` (`PATCH …/tasks/:id`, `reassignResponsible`, the division/board drags) appends a history row **in the same transaction**. This is the whole ticket — a write path that forgets to append silently loses history, and nothing surfaces it | senior-be |
| `P4-B4` | **BE:** `GET /api/:t/pm/tasks/:id/assignment-history` → the full chain; `?ball=me` / `?ball[]=` facets on the list endpoint (feeds `P4-A1`, filtering on the existing `assignee`) | senior-be |
| `P4-B5` | **BE:** invariant tests — a reassignment never deletes a prior row; a correction appends rather than mutates; **every** assignee write path appends (enumerate them, one test each); RLS blocks cross-tenant reads of the chain | qa |
| `P4-B6` | `Ball` board view — per-person columns off `assignee.refId`, drag = reassign. Largely `assigneeColumns()` promoted to a view (overlaps `P4-A6`) | medior |
| `P4-B7` | Task-detail: `Responsible` (`responsibleId`) + `Ball` (`refId`) side by side with `Set to me`, per the modal, plus the **assignment-history timeline** | medior |
| `P4-B8` | Default status ladder → `Backlog · ToDo · Doing · Blocked · Done` (`DEFAULT_STATUSES`, `isSynthDefaultStatuses`, and every project still on the synthesized set) | senior-fe |
| `P4-B9` | Ball + Responsible as filter facets and List columns | junior |
| `P4-B10` | Rename `pm-gantt__ball*` → `pm-gantt__link*` — now mandatory, not hygiene: "ball" is about to mean the assignee everywhere else | junior |
| ~~`P4-B11`~~ | Dropped — anyone may pass the ball (decision 4), so no new Cerbos policy. Pin it with a test that a `pm.write` holder succeeds and a read-only/client principal is denied | junior |

### L — Repsona fidelity: UI + vocabulary (owner directive, 2026-08-06)

> "Ensure the UI is fully mimicking Repsona, also the naming — the team wants exactly the same as
> Repsona, except faster and better."

**This overrides the §2 recommendation (a) and needs stating plainly: PM will look different from
the rest of the ERP.** Repsona is dark-first, rounded, saturated; the Syrowatka system is hairline,
zero-radius, muted bronze/champagne, and `tokens.test.ts` enforces it app-wide. Both cannot be true
on one surface. HR, Reports, Creative, Admin and the client portal all follow the house style, so a
Repsona-faithful PM is a deliberate visual island. That is an acceptable trade — the team uses PM all
day and familiarity beats consistency here — but it should be a decision on record, not a surprise.

**How to do it without punching a hole in the guard test.** Do **not** exempt `components/pm/**`
from the colour-literal rule; that exemption never comes back. Instead put the Repsona palette in a
**PM-scoped token file** (`styles/tokens/pm.css`) — literals are legal in the token layer — and have
PM components consume only `var(--pm-*)`. Same mechanism as `creative.css` solves its own problem,
no new precedent, and the guard test keeps protecting every other surface. Radius and shadow are
the same story: `--pm-radius`, and `--elev-overlay` for floating layers.

| id | scope | tier |
|---|---|---|
| `P4-L1` | `styles/tokens/pm.css`: Repsona-faithful palette (status hues, tag chips, board/card surfaces, dark-first) + `--pm-radius`. Light **and** dark, contrast-validated. Extend `tokens.test.ts` to assert PM components reference only `var(--pm-*)`/existing tokens — never a literal | senior-uiux |
| `P4-L2` | **The vocabulary map is a single source of truth** — one exported constant, not strings scattered across 30 components. Ball · Responsible · Cross project · Sub-task · Ready to check · Milestones · Notes · Productivity · Charts · Set to me · Follow. Half-renaming is worse than not renaming: two names for one thing in the same product | senior-fe |
| `P4-L3` | Component-level fidelity pass against the screenshots: card anatomy (avatar · project · parent breadcrumb · tag chips · status pill · due + overdue glyph), column headers with avatars, the filter-bar layout, the task modal | senior-uiux |
| `P4-L4` | Dark theme for PM — closes the known gap from P1–P3 (`pm-console-repsona-redesign`) and is table stakes since every screenshot is dark | medior |
| `P4-L5` | **"Faster and better" needs a number.** Budget: server-rendered first paint, no chart library (4 runtime deps stays), board/Gantt interaction under ~100ms at realistic tenant size. Measure `@all` with a seeded large tenant before claiming it — Repsona is a client-side SPA and will feel fast on small data; our win has to be real at scale | senior-fe |
| `P4-L6` | Where we deliberately **exceed** Repsona, keep our version and don't downgrade for fidelity: 8-emoji comment reactions, poly-assignee (dept/division), dependency-draw + drag-cascade Gantt, custom fields, doc versions, templates. "Exactly the same" means the parts the team knows, not removing what we do better | senior-uiux |

### F — task modal parity (from the two modal screenshots)

We are ahead on reactions (8-emoji set on comments vs Repsona's single thumbs-up), followers,
dependencies, custom fields, time logs, templates. Real gaps:

| id | scope | tier |
|---|---|---|
| `P4-F1` | Comment composer: `@`-mention picker · emoji · markdown · **Preview** (we have a plain textarea + attach) | medior |
| `P4-F2` | Task-level like/vote count (distinct from per-comment reactions) — **decide whether we want it** or whether comment reactions already cover it | junior |
| `P4-F3` | `Today` quick-schedule dropdown on the task, due-date **range** display + the overdue glyph | junior |
| `P4-F4` | `Set to me` one-click on Responsible and Ball | junior |

### C — Gantt chrome

| id | scope | tier |
|---|---|---|
| `P4-C1` | Zoom (Day/Week/Month) + explicit clearable date window; `computeTimeline` gains an override window instead of always deriving from task min/max | senior-fe |
| P4-C2 | Day/week column headers + **today line** + weekend banding | medior |
| `P4-C3` | Full filter bar (the 8 facets + 3 toggles) as a bookmarkable GET form, driving A1's server-side params — same shape as the existing tag filter, not a new pattern | medior |
| `P4-C4` | Undo/redo for reschedules + dependency edits (a client-side action stack over `batchReschedule`; safe because every op is already a batch) | senior-fe |
| `P4-C5` | Export (CSV from the existing `<details>` data pattern; PNG only if you want it) | junior |
| `P4-C6` | Inline "Add a task" per group row | junior |

### G — urgency indicator: **overdue · almost late · in time** (owner request, 2026-08-04)

> "We need a clear indicator to let us know if it's overdue, almost late, and still in time — so
> this is rich for glancing many projects and tasks."

Today the only signal is Repsona's overdue skull and our `blockedIds` outline; "almost late" does
not exist anywhere, and nothing rolls up to the **project** grain, which is what "glancing many
projects" actually needs.

This is a **one-helper, many-render-sites** feature, and that's the trap: if each surface derives
urgency itself, they will disagree, and a board card will contradict the row above it. So the
pure function lands once in `lib/pm.ts` (client-safe half) with tests, and every surface consumes
it. It must not be colour-only — a colour-blind or greyscale reader has to get the same reading,
which means a glyph/shape tier alongside the colour (the design system already does this with
`statusColor` + `statusGraphic`).

| id | scope | tier |
|---|---|---|
| `P4-G1` | `taskUrgency(task, now)` → `overdue \| due-soon \| on-track \| undated \| done` — pure, client-safe, tested, **one** definition. Pin `now` as a parameter (never `Date.now()` inside), or SSR and the client will disagree at midnight and hydration will diverge | senior-fe |
| `P4-G2` | `projectUrgency(tasks)` roll-up — the worst-case tier plus counts, so a project row/card can be glanced without opening it. This is the half that makes it "rich for many projects" | senior-fe |
| `P4-G3` | `UrgencyDot` / `UrgencyChip` primitive in `components/ui.tsx`: colour **+** distinct glyph **+** accessible label. Three tiers only — a fourth reads as noise at a glance | senior-uiux |
| `P4-G4` | Urgency tokens on the `--viz` ramp (`P4-D1`): overdue / due-soon / on-track in light **and** dark, contrast-validated. Do **not** reuse `--status-critical` blindly — status and urgency are different axes and a task can be `Doing` *and* overdue | senior-uiux |
| `P4-G5` | Apply at every render site, one ticket so they can't drift: board card, List row, Gantt bar + label, `@all` Home columns, Ball/Responsible boards, project cards, dept `MyWorkRail`, milestone rows | medior |
| `P4-G6` | `Overdue only` toggle (`P4-C3`) + a `due-soon` facet, filtered **server-side** in `P4-A1` — a tenant-wide "what's about to slip" query must not be a client-side filter over every task | senior-be |

**Needs your call (decision 8).** What is "almost late"?

- **(a) Fixed window** — due within N days (Repsona-ish simplicity; N=2 or 3). Predictable, but a
  6-month task and a 1-day task get the same warning window.
- **(b) Proportional** — the last X% of the task's own start→due span. Scales to task size; means
  nothing for a task with no start date (a large share of them).
- **(c) Risk-aware** — date proximity **weighted by `progress`**: due in 2 days at 10% is at risk;
  due in 2 days at 90% is fine. Most useful, most explaining to do, and the only variant that can
  say something is at risk *before* it is nearly due.

My recommendation: **(a) as the shipped default with the threshold configurable per project**, and
**(c) modelled but held** — a risk score is a genuinely better signal, but it's also the kind of
number people argue with, so it wants its own decision rather than riding in on this one. Also
decide whether `Done` outranks `overdue` (a task finished late: does it still glow red?) — I'd say
done-and-late shows a muted "was late" marker in history views and nothing on the boards.

### E — Productivity (consume the tracker program)

| id | scope | tier |
|---|---|---|
| `P4-E1` | **Decide the score.** Repsona's 430/218 is opaque; ours must be documented and explainable, or it becomes a performance-management weapon nobody trusts | you + architect |
| `P4-E2` | **BE:** per-person daily activity series + score, from `work_activity` + `rollup_metrics` | senior-be |
| `P4-E3` | `Productivity` view: score + `CalendarHeatmap` (year grid) + multi-series area chart. Reuse the reports chart kit; do not add a chart library (4 runtime deps is a standing constraint) | medior |
| `P4-E4` | Reconcile with `/reports/person` so we don't ship two different "how productive is X" numbers | senior-fe |

---

### H — project time range (owner request)

> "There should be a time range of a project. So we can track it."

`PmProject` carries **`dueDate` only** — no start. The base `projects` row *does* have
`start_date`, so half the data exists and simply isn't surfaced. Without a range there is no
project bar to put on a Gantt, no project-grain urgency (`P4-G2` needs it), and nothing for the
client portal timeline to plot against.

| id | scope | tier |
|---|---|---|
| `P4-H1` | **BE:** expose `startDate` on `PmProject` (already on the base row) + add a target/end date; `PATCH` both. Decide whether the range is **authored** or **derived from tasks** — see decision 12 | senior-be |
| `P4-H2` | Project bars as the top row of each Gantt group (a project's own range above its tasks), plus plan-vs-actual: authored range vs the task-derived envelope. This is what makes slippage visible at a glance | senior-fe |
| `P4-H3` | Project range + `projectUrgency` (`P4-G2`) on project cards, the `@all` Home, and dept project lists | medior |

### I — chained tasks: enforced dependencies (owner request)

> "A feature of chained tasks. So the next cannot be started if the previous is not done. This will
> make the status rich — backlog, to do, doing, done — will have real function and meaning."

**Most of this is already built and merely advisory.** `dependsOn` (task ids), `openDependencies()`,
`blockedIds`, the Gantt cycle guard, conflict edges, transitive-dependents cascade — all shipped. A
blocked task today gets a visual outline and nothing stops anyone starting it.

So the ask is **enforcement**, not a new dependency model. Recommendation: enforce on the existing
`dependsOn` DAG rather than introducing a separate "chain" entity — a chain is the linear case of
the graph we already have, and a second overlapping model would need its own cycle guard, its own
reschedule cascade, and its own bugs.

The genuinely interesting part is the owner's second sentence: with enforcement, **`Backlog` vs
`ToDo` stops being a matter of opinion**. `Backlog` = has open blockers; `ToDo` = blockers clear,
ready to pick up. That's a computable distinction, and it's why this ties back to decision 6.

| id | scope | tier |
|---|---|---|
| `P4-I1` | **BE:** the enforcement gate — reject a transition into `Doing` (or any non-`isDone`, non-backlog status configured as "started") while `openDependencies()` is non-empty. Server-side is the only place this can live; the client check is a courtesy | senior-be |
| `P4-I2` | **Decide + implement readiness semantics** (decision 13): auto-promote `Backlog → ToDo` when the last blocker closes, or keep status manual and surface a computed `ready`/`blocked` flag? Auto-promotion is the thing that makes the ladder feel alive; it's also a write triggered by someone else's action, so it needs an event and an audit trail | senior-be |
| `P4-I3` | **Per-project mode: hard-block vs warn** (decision 14). A hard block *will* bite on real work — a stale dependency nobody cleaned up becomes "I can't do my job". Recommend hard-block as the default with an explicit, audited override rather than a silent warn-only mode | senior-be |
| `P4-I4` | UI: blocked tasks state *what* blocks them and link to it; the status control disables unreachable transitions with the reason (never a dead control with no explanation); "ready to start" as a first-class filter facet | medior |
| `P4-I5` | Ball + chain interaction: passing the ball on a blocked task — allowed (you may hand over a blocked task) but it cannot enter `Doing`. Pin this in tests, it's the case that will be got wrong | qa |
| `P4-I6` | Notify the ball holder + followers when the last blocker clears ("this is now startable") | junior |

### J — WhatsApp bot + AI agent access, RBAC-gated (owner request)

> "Integrate WA bot to read, modify and write if the requesting user has the RBAC to do that,
> otherwise read only. The AI agents also capable of full access if the RBAC is enough."

**Foundation exists and is better than expected.** The MCP hub already ships `pm.createTask` and
`pm.createDoc` as LOW-impact writes behind Cerbos + an OBO principal envelope (callers cannot
assert roles), plus a per-workflow allowlist (`AUTOMATION_ALLOWLIST` — `wf:report` is currently the
only scope with PM writes) and the WS4 impact gate. The bot's `/projects` skill already closes the
D4 identity loop. So this is **extending a working surface**, not building one.

Three things make it harder than it sounds, and all three are known:

1. **D14 has no resume path.** Approving a suspended automation write **executes nothing** —
   verified, and a deliberate spec deferral. Every bot/agent PM *write* that trips the impact gate
   lands in exactly this hole. This is a **hard prerequisite**, not a footnote: ship reads first,
   and do not ship gated writes until D14 has a resume path.
2. **Agent identity is a four-table handshake.** `users` + `identity_links` + `user_roles` +
   **`company_memberships`** — miss the last one and Cerbos denies with no obvious cause. Bot/
   automation principals are deliberately `users` rows (Cerbos authorises principals);
   `company_memberships.kind=service` is the interim marker.
3. **"Otherwise read-only" must be a Cerbos outcome, never a bot-side branch.** The bot must not
   decide what a user may do — it presents the OBO envelope and the hub/Cerbos answers. A read-only
   fallback implemented in bot code is a security bug wearing a feature's clothes.

| id | scope | tier |
|---|---|---|
| `P4-J1` | PM **read** tools on the hub: `pm.listTasks` (with the `P4-A1` facets), `pm.getTask`, `pm.listProjects`, `pm.taskBallHistory` — Cerbos-gated, no impact gate needed | senior-integrator |
| `P4-J2` | PM **write** tools: `pm.setStatus`, `pm.passBall`, `pm.setDueDate`, `pm.comment`. **Unblocked** (D14 landed) — the work is now the impact classification (decision 16) and, for anything not `low`, its own `approval-executables.ts` entry + precondition re-check. See §4.2 | senior-integrator |
| `P4-J2b` | If any PM write lands `medium`/`high`: the precondition re-check must re-validate the **chain constraint** (`P4-I1`) at execution time — an approval filed while a blocker was closed can execute after it reopened | senior-be |
| `P4-J3` | Cerbos policy for the new `pm_tool` actions + the principal-kind matrix (human / bot-on-behalf-of / autonomous agent). A **new** policy file is not hot-reloaded over the bind mount — unlisted kind = silent DENY; restart Cerbos | senior-be |
| `P4-J4` | Bot skill: natural-language task read/update in WhatsApp, rendering the *denial reason* when Cerbos says no rather than a generic failure | senior-integrator |
| `P4-J5` | Agent tool wiring (WS8 supervisor) + per-goal budget, reusing the existing approvals-suspension path | senior-integrator |
| `P4-J6` | **Agentic-native audit** — run PM Phase 4 against the 7-criterion bar in `2026-08-03-agentic-native-erp-plan.md` (still OPEN, must close before staging). Build to the bar now; retrofitting it costs more | architect |
| `P4-J7` | Adversarial authz tests: a client-tier principal, a staff principal without `pm.write`, and a bot with a stale role must each get read-only or denied — driven end-to-end through the bot, not just unit-tested | qa |

### K — progress propagation: client portal + employee surfaces (owner request)

> "The progress of a project will also update the timeline in the client side (portal) and employee
> tasks (dashboard and employee portal)."

Status of each destination — they are **not** equally ready:

- **Client portal — largely built.** `/api/:t/portal/timeline`, `/portal/milestones`,
  `progressPercent` per project and an `upcoming`/`history` split already exist, behind 4-layer
  isolation (`portal-scope.ts`) with SSE that **deliberately carries no data** (it signals; the
  client refetches). Progress propagation is mostly *making sure the existing projection stays
  truthful* once ball/chain/urgency change what "progress" means.
- **Employee dashboard (My Work) — exists**, needs the new signals (ball, urgency, readiness).
- **Employee portal — does not exist.** Per `hr-self-service-scoped-out`, there is an HR ops
  console and seven scattered self-service routes, no staff portal. This request either scopes to
  the existing dashboard or opens a new surface — decision 15.

The non-obvious risk is **disclosure**. Ball history names staff and records who dropped what;
internal statuses like `Client Review` and internal task titles are not client-safe. Piping richer
progress into the portal without an explicit client-safe projection is how internal detail leaks to
a paying client.

| id | scope | tier |
|---|---|---|
| `P4-K1` | **Define the client-safe projection** — exactly which PM fields cross into the portal (recommend: project range, progress %, milestone state, urgency tier; **never** ball history, internal statuses, staff names, or task titles unless explicitly marked client-visible) | architect |
| `P4-K2` | Portal timeline consumes the project range (`P4-H1`) + urgency tier; the existing SSE signal fires on progress change | medior |
| `P4-K3` | My Work: ball-holder queue ("the ball is with you"), readiness, urgency tiers | medior |
| `P4-K4` | **Contract only** (decision 15): publish the employee-facing PM reads — "my tasks", "the ball is with me", urgency tier, readiness, my project ranges — as a §-numbered contract in `docs/FRONTEND-BFF-CONTRACT.md` for the employee-portal session to consume. Ship the endpoints + `lib/pm.ts` helpers; **do not build the portal surface**. My Work (`K3`) is the reference consumer that proves the contract is real | senior-be |
| `P4-K5` | Portal isolation tests extended: a client principal must not be able to read ball history or internal statuses through **any** portal route | qa |

## 4. Sequencing

### 4.0 This is now too big for one phase — split it

The owner's own read is correct: with Ball-as-ledger, project ranges, enforced chains, bot/agent
access and portal propagation, this is no longer "Phase 4". Shipping it as one undifferentiated
program is how a 10-workstream plan turns into six months of half-landed surfaces. Split on a
hard boundary — **does it change the data model, or does it consume it?**

| | Phase 4 — *the model* | Phase 5 — *the surfaces* |
|---|---|---|
| Workstreams | **D** colour · **L1/L2** PM tokens + vocabulary · **G** urgency · **H** project range · **B** ball rename + history · **I** chain enforcement · **A1–A3** the scope data layer | **A4–A9** `@all` views · **C** Gantt chrome · **L3–L6** fidelity pass · **E** productivity · **F** modal parity · **J** bot/agent · **K** propagation |
| Why here | Every one of these changes what a task *is*. They must be settled before six surfaces read them | All of these *render or transport* the model. Cheap once the model is stable, expensive if the model moves underneath them |
| Gate to exit | Model is frozen: ball ledger invariants pass, urgency has one definition, chain enforcement is on, project ranges exist | — |

Prerequisites for Phase 5:

- ~~**`J` write half is blocked on D14**~~ — **CLEARED 2026-08-05/06.** The D14 resume path landed on
  main (`e2d65f8`, CI green) and the agent half is wired too (`ai-agents/src/deps.ts` implements
  `resolveApproval` → hub `approvals.resolveExecute` → platform-nest
  `POST :t/automation-approvals/resolve-and-execute`). **But it clears `J2` for a different reason
  than we assumed — see §4.2; the real question turned out to be impact classification, not the
  resume path.**
- **`K` needs the client-safe projection decided first** (`K1`), or internal ball/status detail
  leaks to clients through a route that already works.

### 4.2 What D14 actually means for `J2` (checked, not assumed)

The plan said "hold `J2` until D14 has a resume path". That framing was wrong, and the correction
matters more than the unblocking:

**The D14 gate suspends on impact tier only** — `tool.write && tool.impact !== "low"`
(`mcp-hub/src/policy.ts`). The two PM tools that exist today (`pm.createTask`, `pm.createDoc`) are
`impact: "low"`, so they **never suspended in the first place**. The schema agrees:
`automation_approvals.impact` is `CHECK (impact IN ('medium','high','unclassified'))` — a low-impact
write cannot even be *filed* as an approval. A registry entry in
`platform-nest/src/core/approval-executables.ts` does **not** mean a tool was ever blocked; for the
PM tools those entries serve the *agent re-run* path only.

So the real gate on `J2` is a decision we hadn't identified: **what impact tier do the new PM write
tools get?** (decision 16)

- Classified **`low`** → never suspends, no approval flow, no registry entry, ships immediately —
  and an agent can change task status and pass balls **unattended**.
- Classified **`medium`/`high`** → suspends on the gate, and each tool needs its **own** entry plus
  a server-side precondition re-check. The executor is *registry*-scoped, not origin-scoped: every
  program needs its own entry, by decision.

The ledger cuts in favour of `low` for `pm.passBall` — a pass is cheap, attributable, and corrected
by appending rather than mutating. `pm.setStatus` is the one to think about, because with
workstream `I` a status write can now violate a chain constraint; if it were ever gated, the
precondition re-check is exactly where that must be re-validated at execution time, not at filing
time.

Recommended: run Phase 4, stop, review against real data, then plan Phase 5 properly. `E`, `F` and
`J1` are independent enough to run opportunistically in either phase.

### 4.1 Within-phase order

```
decisions 13 · 17 · 1 · 2* ───────────────── still gate parts of phase 4
        (*2 superseded by L — see §2 note)
L1 → L2 ────────────────────────────────── vocabulary before any renaming lands

B0 (design note)                        ← settles ledger + status fields
D1 → D2 → D3                            (colour layer; unblocks all visuals)
        └─ G4 → G3                      (urgency tokens ride the same ramp)
G1 ∥ G2 → G3 → G5                       (urgency: helpers before render sites)
A1 ∥ A2 ∥ B1 → B2                       (backend + DB, parallel)
A3 → A4 → A5                            (scope spine)
        ├─ A6 ∥ A7 ∥ A8 ∥ A9
        ├─ B3 → B4 → B5 → B6 ∥ B7 ∥ B9 ∥ B10 ∥ B11
        │       B8 (default ladder) ∥ after B0
        └─ C1 → C2 → C3 → C4 ∥ C5 ∥ C6
                   └─ G6 (facets need C3's filter bar + A1)
H1 → H2 ∥ H3                            (project range; G2 depends on it)
B* → I1 → I2 → I3 → I4 ∥ I6             (chain enforcement needs ball settled)
                    └─ I5 (qa)
E1 (decision) → E2 → E3 → E4            (independent; can run last)
F1 ∥ F3 ∥ F4  (F2 pending decision)     (independent; cheap)
K1 (decision) → K2 ∥ K3 ∥ K4 → K5       (phase 5; K1 gates all of K)
J1 → J3 → J4 ∥ J6 → J7                  (phase 5 reads)
decision 16 → J2 → J2b                  (phase 5 writes; D14 CLEARED, see §4.2)
```

Two things must not be parallelised: **G1/G2 before G5** (or surfaces derive urgency themselves and
disagree), and **B1/B2 before any B write path** (an append-only table with a mutable write path
already in flight is how the history gets silently lost).

Gates: `npm run typecheck` + `npm test` + **`DEMO_MODE=1 npm run build`** (the real gate — tsc and
vitest have both passed while the build broke on a `server-only` leak) + `npx playwright test
--project=smoke`. Every new endpoint needs a `lib/demoFixtures.ts` fixture or the build gate and
e2e run blind. QA gate before merge on B (new column + policy) and A1 (new query surface).

Docs to update as we go: `docs/FRONTEND-BFF-CONTRACT.md` §5 (and §11 for the activity reads),
`docs/modules/MODULES.md` + `CHANGELOG.md` (`platform-ui` + `platform-nest` version bumps).

---

## 5. Open decisions — I need your calls on these

1. **Where does `@all` live?** New top-level nav entry (`/work` or `/pm`) with a scope switcher,
   *or* fold it into the existing `/` dashboard as a scope of My Work? Repsona's answer is a
   dedicated surface. I'd go `/pm` with the switcher, and keep `/` as the personal landing.
2. **Saturation ceiling** (§2): Repsona-loud, or the same ramp dialled to ~70% chroma so PM still
   reads as our product? Rounded corners on cards/bars — yes or stay at zero radius?
3. **Ball scope.** Single user only (Repsona, and it matches "whose turn is it"), or may the ball
   sit on a department/division like our poly-assignee? Recommend **single user** — a department
   can't take a turn, and poly reintroduces the ambiguity Repsona avoided.
4. ~~**Who may pass the ball**~~ — **DECIDED 2026-08-04: anyone may pass the ball.** No
   holder/responsible gate; `pm.write` in the project's company is the floor (a read-only or client
   principal still cannot). The ledger is what makes this safe — every pass is attributable, so
   openness costs nothing that history doesn't recover. `P4-B11` shrinks to "no special policy,
   pinned by a test".
5. ~~**Does the ball replace `assignee`?**~~ — **DECIDED 2026-08-06: Ball *is* `assignee`, renamed**
   (team already fluent in Repsona's vocabulary). `Ball` = `assignee.refId`/`kind`, `Responsible` =
   `assignee.responsibleId` (already independently settable). No new axis, no new current-holder
   column — only the history table survives. Workstream `B` shrinks accordingly.
6. ~~**One status field or two?**~~ — **DECIDED 2026-08-06: one field, registry kept, ladder =
   `Backlog · ToDo · Doing · Blocked · Done`.** `Blocked` stays; `In progress` → `Doing`; `Backlog`
   is the only genuinely new state. Per-project registries still add `Ready to check` /
   `Client Review`.
7. **Ball history vs the three records we already keep** — should a ball pass auto-add the holder to
   `contributors`, write a `work_activity` row, and/or supersede `pm_progress_snapshots` for status
   history? (Recommend: contributors **yes**, `work_activity` **yes**, snapshots left alone.)
8. **"Almost late"** — **PARTLY DECIDED 2026-08-04: the system computes it, purely objectively.**
   No manual "at risk" flag, no per-task override, no human judgement in the tier — it is a
   function of stored facts only. That kills option (b)'s soft edges and any editorial input.
   **Still open: which facts.** Both remaining candidates are objective:
   - dates only (due within N days), or
   - dates **weighted by `progress`** — due in 2 days at 10% vs at 90%.

   Both are deterministic and reproducible; "objective" doesn't pick between them. I recommend
   **dates-only at N=3 as the shipped tier** (one number, trivially explainable when someone asks
   why their task turned amber) with the progress-weighted variant computed alongside as a
   separate, clearly-labelled *risk* signal. Reason: the moment a single amber badge silently mixes
   "the date is close" with "you haven't done enough", people stop trusting it — and objectivity
   without explainability is not much use for glancing. **Unless you say otherwise I will build
   dates-only, N=3, configurable per project.** Also confirm: does a task completed late keep a
   marker? (Recommend: in history views yes, on boards no.)
9. **The productivity score formula** (E1) — and whether it's visible to peers, managers only, or
   self-only. A people decision, not an engineering one.
10. **Task-level like/vote** (`P4-F2`) — do we want it, given we already have 8-emoji reactions on
    comments?
11. **Sub-task toggle**: Repsona's Gantt hides sub-tasks by default. Our `Subtasks` are a
    lightweight checklist on a task, not first-class tasks — promote them, or drop the toggle?
    (Recommend: drop it rather than fake it.)
12. ~~**Project range — authored or derived?**~~ — **DECIDED 2026-08-06: authored, with the
    task-derived envelope drawn alongside.** The gap between them is the slippage signal.
13. **Readiness semantics** (`P4-I2`) — when the last blocker closes, does the task auto-promote
    `Backlog → ToDo`, or does status stay manual with a computed `ready` flag beside it?
    Auto-promotion makes the ladder feel alive but means someone else's action writes to your task;
    that needs an event + audit row, not a silent update. **Now interacts with decision 17** — if the
    system clears `Blocked` automatically, it should probably promote `Backlog → ToDo` too, or the
    two behave inconsistently for the same underlying event.
14. ~~**Chain enforcement: hard-block or warn?**~~ — **DECIDED 2026-08-06: hard-block with an audited
    override, per-project.**
15. ~~**Employee portal**~~ — **DECIDED 2026-08-04: out of scope here.** A separate session owns the
    employee-portal surface. This program's job is to be **integration-ready**: expose the
    employee-facing PM reads as a documented contract the other session consumes, and do not build
    (or half-build) the surface itself. See §6.1 for the seam and the collision risk.

16. **Impact tier for the PM write tools** (§4.2, gates `J2`) — `pm.passBall`, `pm.setStatus`,
    `pm.setDueDate`, `pm.comment`. `low` = ships immediately, no approval flow, **agents write
    unattended**. `medium`/`high` = each needs its own registry entry + precondition re-check, and a
    human approves every agent status change. Recommend **`low` for `passBall`/`comment`** (cheap,
    attributable, corrected by appending) and **a deliberate call on `setStatus`** — it is the one
    that can violate a chain constraint, and "an agent moved my task to Done" is the write people
    will actually object to. Note the existing PM tools are already `low`, so `low` is the
    consistent default rather than a new precedent.
17. **Is `Blocked` system-set or human-set?** (§1.5, gates `I2`) Recommend **both, visibly
    distinguished**: system-set from an open dependency (blocker named, auto-clears), human-set for
    external waits (reason required). If nobody can tell which kind they're looking at, nobody knows
    whether it will clear itself.
18. **Design divergence on record** (`L`) — confirm you accept that PM will look unlike HR, Reports,
    Creative, Admin and the client portal, all of which follow the house style. I think it's the
    right trade for a surface the team lives in; it should just be explicit.

## 6. Coordination with the employee-portal session

### 6.1 The seam, and the collision risk

The employee portal is owned elsewhere (decision 15). Two sessions building against one repo is a
known hazard here: there is **one working tree**, and another session's `git checkout` moves HEAD
underneath you so your files look reverted. Rules that apply to this program specifically:

- **The seam is a document, not a shared file.** Publish the employee-facing PM reads as a numbered
  section of `docs/FRONTEND-BFF-CONTRACT.md` and let the other session build against it. Frontend-
  first drift is the recurring bug class in `platform-ui` — a console reading fields the backend
  never sends renders a confident wrong answer that `tsc` cannot see and demo fixtures hide. A
  written contract is the only thing that stops two sessions inventing two shapes.
- **Likely contention points** — flag these before touching them: `lib/rbac.ts` (an employee portal
  will want new capabilities), `components/shell/nav.ts`, `lib/portal*.ts` and `portal-scope.ts`
  (the *client* portal — an employee portal must not be bolted onto client isolation), and the My
  Work dashboard, which `K3` edits and an employee portal will want to reuse.
- **Mechanics:** commit early, never `git add -A`, re-check before push, and verify with reflog if
  files look reverted. Releases race — another session's deploy can move the tag under you.
- **`K3` is the reference consumer.** Building My Work against the same contract proves it works
  before the other session depends on it, rather than shipping an untested interface and finding out
  during their integration.

## 7. Explicitly out of scope

Repsona's wiki/notes surface beyond our existing Docs; time-tracking rework (we already exceed
with `TimeLog` + estimates); mobile-native views; the `?`/`i` help drawers; anything that would add
a runtime dependency; **the employee-portal surface itself** (§6.1 — contract only). ~~A D14 resume
path~~ — landed 2026-08-05/06 outside this program (§4.2).
