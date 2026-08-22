# UI Redesign — Layout, Information Architecture & Migration Mechanics

Status: PLANNED (spec). Scope: `platform-ui/`. This document does not specify colour, type,
elevation or density token *values* — that is the parallel visual-design-language spec. It
specifies where things sit, what they are made of, and how we get there without breaking the
build gate.

All counts below were taken directly from the repository on 2026-08-22 (`platform-ui/src`),
not estimated.

---

## 0. Real-number baseline

| Metric | Count | How counted |
|---|---|---|
| `page.tsx` route files | 157 | `find src/app -name page.tsx` |
| — under `(app)` (staff shell) | 138 | same, filtered |
| — under `(portal)` (client shell) | 15 | same, filtered |
| — standalone (`login`, `step-up`, `invite`, `print`) | 4 | same, filtered |
| Route handlers (`src/app/api/**/route.ts`) | 19 | `find src/app/api -name route.ts` |
| CSS files | 44 | `find src -name "*.css"` |
| Vitest test files (`*.test.ts(x)`) | 154 | `find src -name "*.test.ts*"` — CLAUDE.md's "~98" figure is stale; this is the current count |
| Playwright spec files (`e2e/*.spec.ts`) | 12 | plus 2 non-spec support files (`auth.setup.ts`, `personas.ts`) |
| Playwright projects | 6 | `setup, chromium, anon, portal, personas, pm-unified, smoke` (7 listed; `setup` is a dependency, not a test-bearing project) |
| Shell component files | 22 | `src/components/shell/*.{tsx,ts,css}` |
| `ui.tsx` primitives | 7 | `Eyebrow, Card, Button, StatusBadge, KpiTile, HairlineTable, Toast` (+3 pure helpers: `statusColor`, `statusGraphic`, `humanizeStatus`) |
| Top-level `components/` subdirectories | 26 | domain-scoped component folders |
| Department bespoke toolkits | 4 | `WEB_DEV, CREATIVES, SEO, SOCIAL_MEDIA` in `lib/deptToolkits.ts`; every other department gets the generic Home-only shell |
| Sidebar nav groups (member role) | 9 | `Me, Workspace, Organization, Departments, Business, Reports, Appraisals, Intelligence, Systems` (pinned via `nav.test.ts`) |

---

## 1. Current-state IA audit

### 1.1 The nav tree (`components/shell/nav.ts`)

`navFor(me, tenantId, departments)` returns a flat list of `NavGroup`, each with `NavItem[]`.
For the modal `platform_admin` role there are 10 groups (adds an unlabelled `Settings` group);
for a plain `member` there are 9. Structure, current as of `nav.test.ts`:

```
Me            (ungated)          — Overview, Inbox, Leave, Loans                     [4]
Workspace     (pinned, ungated)  — Dashboard, Project Management, Calendar, Approvals [4]
Organization  (mixed gate)       — Overview [+ Positions, Access if people.directory] [1-3]
Departments   (ungated)          — {business depts...}, HR, IT                        [2+N]
Business      (mixed gate)       — Project Mgmt, Clients, Deliverables, Timesheets,
                                    [Billing], Agency, Meetings, Monitoring, [Rollups] [7-9]
Reports       (mixed gate)       — My/Project/Department [+ Company]                  [3-4]
Appraisals    (mixed gate)       — My Appraisals [+ Team, + Cycles]                    [1-3]
Intelligence  (ungated)          — Assistant, Knowledge, AI Agents                     [3]
Systems       (ungated)          — Bot, Gateway, Hub, Automation, Observability        [5]
Settings      (admin.access)     — single row → /admin (which fans into 8 in-page tabs)
```

**Depth.** Two levels in the sidebar itself (group → item), but four real levels of navigation
exist once you follow a link: sidebar group → sidebar item → in-page `SectionTabs` (e.g.
`/admin`'s 8 tabs, `/reports`'s layout) → in-page sub-tabs or drawers (e.g. a department's
`DeptTabs` secondary strip, a task's `@drawer` slide-over). A user can be four clicks from the
sidebar before reaching a leaf, and the sidebar's own two levels don't reveal that the third and
fourth exist.

**Breadth.** The `Departments` group is the widest and the least stable: N business departments
(from org structure, unbounded) plus the two permanently-pinned functional entries HR and IT.
There is no cap or overflow treatment — a company with 12 departments gets 14 flat rows in one
group. `Business` is the second-widest static group at 7-9 items and is where **the owner's own
2026-08-10 directive already had to intervene once** (collapsing Projects+Tasks into one
`Project Management` entry) because it was outgrowing a flat list.

**Orphans and dead ends.**
- `(app)/[...placeholder]/page.tsx` is a deliberate, honest catch-all ("Not yet furnished") for
  any nav route that resolves but has no page — this is not a bug, it is the escape valve that
  lets nav be built ahead of pages. It should stay in the target IA (§2) but its trigger surface
  should shrink as Phase 4/5 land.
- `/project-management` and `/pm` are two different pages serving overlapping intent
  (company-wide PM tabs vs. the cross-project `@all` scope surface) — both intentional per
  inline comments, but a new user has no way to know which one is "the" PM page without reading
  the sidebar labels closely; they render under different route segments with different data
  scopes.
- `/organization/access` and `/organization/positions` are nav-gated on `people.directory ||
  isElevated`, which means the two rows can vanish for a department head whose authority comes
  from a *position*, not a role capability — the page itself is built to handle a refusal
  gracefully, but the row disappearing (rather than appearing and 403-degrading) is an
  inconsistency with the rest of this codebase's own "never a blank/hidden surface, always a
  visible refusal" doctrine (see rbac.ts's own IAM-02a-FIX commentary).
- `/hr/*` and `/it/*` are simultaneously **standalone top-level route segments** and **entries
  inside `Departments`** — HR and IT are "always-present functional departments" per nav.ts, so
  they are reachable two ways with two different code paths (`(app)/hr/layout.tsx` +
  `SectionTabs` vs. the generic `[deptId]/layout.tsx` + `DeptTabs`), which is the seam most
  likely to visually diverge under a redesign if the two aren't unified (see §2.3).

**Where the two-level department-console pattern (group strip + sub-tab strip) works.** SEO is
the design's stress case and its best validation: 4 primary groups (Home, Project Management,
Accounts, Optimize, Campaigns), the widest — Optimize — carrying 6 sub-tabs. The pattern holds
because (a) a group with exactly one tab collapses to a direct link with no secondary strip
(`DeptTabs.tsx`'s own logic), so Home and Connections never show a redundant one-item sub-strip,
and (b) `deptSlug()` keys the toolkit off the department's *name*, so the console survives
whatever id the org structure assigns.

**Where it doesn't work.** The generic (non-bespoke) toolkit is Home-only — a single group, no
sub-strip, which is fine — but it means most departments in a growing holding (anything without
one of the 4 bespoke toolkits) get a workspace that is visually a "console" (header, tab strip,
persistent `MyWorkRail`) around content that doesn't exist yet. That's an honest placeholder, not
a broken pattern, but it means **the two-level pattern's "it doesn't work" case isn't the pattern
failing — it's the content being thin**, which the target IA (§2.3) should call out explicitly so
Phase 5 doesn't get read as "fixing the IA" when it is actually "populating toolkits."

The second real failure mode: `Business`'s `Project Management` row and `Workspace`'s
`Project Management` row and every department console's `Project Management` group **share an
identical label** (`PM_TERMS.projectManagement`) by deliberate design ("the surface reads
identically everywhere it appears") but point at three different scopes (`/project-management`,
`/pm` with `@all` scope, `/departments/[id]/projects|board|ball|...`). Consistent labelling of
inconsistently-scoped destinations is a legitimate UX bet (recognition over precision) but it is
exactly the kind of decision a redesign can silently undo by treating "same label" as "same
component" — flagged for the target IA to preserve on purpose, not by accident.

### 1.2 Route inventory by shape

Grouping the 138 `(app)` pages by what they render (eyeballed against the archetypes defined in
§5, not a mechanical count):

- ~40 are **list/index** pages over a single resource (`/clients`, `/tasks`, `/projects`,
  `/people`, `/companies`, `/it/devices`, `/it/accounts`, most `/departments/[deptId]/<tab>`
  leaves).
- ~25 are **record detail** pages (`/projects/[id]`, `/tasks/[id]`, `/clients/[id]`,
  `/companies/[id]`, `/people/[id]`, `/billing/[id]`, `/appraisals/[id]`, `/meetings/[id]`,
  `/monitoring/[id]`, `/pipeline/[id]`).
- ~15 are **form/wizard** pages, mostly `.../new` and `.../edit` routes plus `/companies/[id]/org`.
- ~10 are **dashboard/overview** pages (`/`, `/hr`, `/it`, `/organization`,
  `/departments/[deptId]` Home, `/agents`, `/systems/observability`).
- ~10 are **report** pages (`/reports/*`, `/reports/[deptId]` console tabs, `/print/reports/*`).
- 8 are **settings** pages, all children of the single `/admin` `SectionTabs` shell.
- The PM cluster (`/pm`, `/project-management`, department `board`/`timeline`/`charts`/`ball`
  tabs) is its own **board** archetype family, ~12 routes.
- The remainder (`/knowledge`, `/assistant`, `/search`, `/calendar`, `/notifications`,
  `/account`) are one-off surfaces that map loosely onto dashboard or list but each carry a
  bespoke interaction model.

This is the shape the closed archetype set in §5 has to actually cover — it is not a green
field, it is a reclassification of what already exists.

---

## 2. Target IA

### 2.1 Model: three concentric scopes, not three separate navs

The holding OS has exactly three scopes a screen can be in, and every route belongs to exactly
one:

1. **Global** — spans every company the user can reach. Today: `Rollups`, `Reports → Company`,
   the `Me` group, `Intelligence`, `Systems`, and the special-access banner
   (`SpecialAccessBanner.tsx`) that already exists for this. Global scope is the *default* for
   `platform_admin`/`group_executive` and otherwise only reachable where a capability explicitly
   grants cross-company reach (`rollups.view`, a `serviceScopes` service assignment).
2. **Company-scoped** — everything gated by the active `tenantId` cookie
   (`gaiada_tenant`/`lib/tenant.ts`). This is the *default* scope for everyone else and for most
   of the sidebar today: `Organization`, `Business`, per-company `Reports`/`Appraisals` rows.
3. **Department console** — a company-scoped sub-scope with its own persistent chrome
   (`DeptTabs` + `MyWorkRail`), already built as `[deptId]/layout.tsx`.

The target IA keeps this three-scope model **explicit** rather than implicit. Today a user
cannot tell, by looking at the sidebar, whether the row they're about to click is global or
scoped to the company shown in the switcher — `Rollups` and `Reports → Company` sit in the same
visual list as `/organization`, with no differentiator besides which capability happened to gate
them. The redesign's shell (§3) makes this visible with a **scope indicator that travels with the
content region**, not just a static company name in the sidebar: a global page (Rollups,
Systems, an Intelligence surface) shows a "Group-wide" chip in the page header area; a
company-scoped page inherits the sidebar's live company name; a department console page inherits
both (company name + department name) in its own header, which `[deptId]/layout.tsx` already
half does via `PageHeader`'s breadcrumb trail.

### 2.2 Where the company switcher lives, and how the active company is unmistakable

Keep it in the sidebar (`CompanyContext.tsx`) — this is a deliberate CLAUDE.md decision
("Company scope lives in the sidebar; everything below is that company") and it is right: a
top-bar switcher competes with search and notifications for the same 64px strip and gets lost.
The gap is not placement, it's **persistence of the signal once the user has scrolled or drilled
in**. Two additions, both buildable with existing primitives:

- The active company name becomes part of the **document title** (`<title>{company} · {page} ·
  Gaiada</title>`), set once in `(app)/layout.tsx`, so a user with 6 browser tabs open to 6
  companies can tell them apart without switching to any of them — this is a real, reported
  failure mode of multi-tenant switchers and costs nothing (no new component, a `generateMetadata`
  export).
- Every page inside a `[deptId]` or company-scoped record-detail route repeats the company name
  in its `Breadcrumbs` trail (many already do — `[deptId]/layout.tsx`'s `PageHeader` breadcrumb
  is `Organization / Departments / {dept}`; it should be `{Company} / Departments / {dept}`
  instead so scope survives a deep link shared between colleagues in different companies).

`SpecialAccessBanner` (shown when `canViewAllCompanies`) stays as the loud, sticky, exec-only
signal that "you are looking across the whole holding" — it should NOT be generalized to a
per-page badge for ordinary company scope; that would dilute the one case it exists to flag.

### 2.3 "My work" cutting across companies

Already half-built and correctly scoped: `lib/queue.ts::getMyWorkQueue` is described as "ONE
ranked queue" feeding both `CommandCenterHome` (manager tier) and `QueueAgendaHome` (everyone
else), and it already fans out per-company (`projectQueueForCompany`). The target IA keeps `/`
(Dashboard) as the cross-company My Work landing and does **not** duplicate that surface per
company — a user with work in 4 companies should see one ranked list, envelope-wrapped (§2.5) if
any company leg fails, not 4 separate dashboards. This is already the architecture; the redesign
task is visual (KpiTile/queue card re-skin under Phase 4), not structural.

The one structural gap: `MyWorkRail` (department console) and the Home queue are **two
independently-computed "what do I do next" surfaces** with a documented, deliberate shape
difference (dept rail = this-department-only tasks + a department-scoped approval projection;
Home = the full cross-company queue). This is correct architecture (a department console should
not show cross-company noise) but the target IA should state the rule explicitly so Phase 4/5
work doesn't accidentally try to unify them: **department scope narrows the queue; it never
computes a second one.**

### 2.4 HR and IT: resolve the double path

Per §1.1, HR/IT are reachable both as dedicated route segments (`(app)/hr`, `(app)/it`, each
with their own `layout.tsx` + `SectionTabs`) and as `Departments` entries pointing at
`/departments/[deptId]`. The target IA picks **one**: HR and IT become ordinary department
consoles with bespoke `deptToolkits.ts` entries (following the SEO/WEB_DEV/CREATIVES/SOCIAL_MEDIA
precedent), and the standalone `(app)/hr/*`, `(app)/it/*` route trees are retired with redirects.
This is explicitly **out of scope for this spec to execute** (it is a route-consolidation change
with real data-wiring implications — `lib/hr.ts`'s own `HrEnvelope` predates the shared
`envelope.ts` on purpose) but the target IA must record the decision so Phase 5 doesn't build two
more bespoke HR/IT toolkits on top of the existing standalone pages, doubling the problem. Flag
for the architect: this is a candidate ticket, not something to fold silently into the visual
redesign.

### 2.5 The envelope's presence in the target IA

Any nav destination whose data can legitimately span companies (`Rollups`, `Reports → Company`,
the Home queue, a future cross-company People directory) must render `EnvelopeBanner` when its
`Envelope<T>` has exclusions — this is already built (`lib/envelope.ts`,
`components/scope/EnvelopeBanner.tsx`) and the redesign's job is purely to re-skin the banner
(currently a `<details>`-based disclosure using `sys-empty-note`/`scope-envelope` classes) onto
the new visual language, never to change *when* it fires. No list-page archetype in §5 should be
approved for Phase 4/5 migration without confirming it either doesn't span companies or renders
this banner.

### 2.6 The external client: portal-only, cleanly separated

Already correctly isolated: `isClientOnly()` (never `isClient && !isElevated`, per rbac.ts's own
scar tissue) drives a hard redirect to `/portal` in `(app)/layout.tsx`, and `(portal)/portal/*`
is its own route group with its own `layout.tsx`, replacing the entire `(app)` shell rather than
reusing it with a filtered nav. The target IA changes nothing here structurally. The one visual
constraint for Phase 2/5: **the portal shell (`portal.css`) is a separate CSS surface from
`shell.css`** and must be re-skinned as its own line item — treating "the shell" as one artifact
during migration would either forget the portal or accidentally leak staff-only chrome
(command palette, department nav) into a surface that must never show it. See §8's Phase 2 file
list.

### 2.7 PM keeps Repsona's layout; the rest converges

Per the owner's fixed decision: PM's information architecture (board, gantt, list, task drawer,
status ladder, tags) is retained verbatim. Concretely, in IA terms, this means the target nav
model above (three concentric scopes) applies to *how you get to* PM (`/pm`, `/project-management`,
department Project-Management groups), never to *what's inside* it once you're there. The PM
surface already has its own token island (`styles/tokens/pm.css`, guarded by
`tokens.test.ts`'s five PM-specific assertions) — the target visual work (Phase 3) re-skins those
tokens to the house palette without touching `Board.tsx`, `TaskDrawer.tsx`, or any PM layout
component's structure. This is a **visual convergence, not a layout migration** — call it out
explicitly in the Phase 3 entry/exit criteria (§8) so QA knows the acceptance bar is "same
interactions, house colours" and not "redesigned board."

---

## 3. Shell layout spec

### 3.1 Sidebar

Current grid: `.erp-app { grid-template-columns: 248px 1fr; }`, collapsing to a 64px icon rail
(`--rail: 64px`) via `html[data-sidebar="collapsed"]`, and to an off-canvas drawer below 760px
(`min(var(--drawer-width), 86vw)`). Three states total, not two:

| State | Width | Trigger | Breakpoint |
|---|---|---|---|
| Expanded | 248px | default / explicit toggle | ≥761px |
| Rail (collapsed) | 64px | `SidebarToggle` + `gaiada_sidebar` cookie | ≥761px only — `sidebarState.tsx`'s `rail = collapsed && wide` |
| Off-canvas drawer | min(drawer-width, 86vw) | `NavToggle` burger | ≤760px, always off-canvas regardless of the collapse cookie |

Target spec keeps this three-state model unchanged — it already correctly treats touch/narrow
viewports as pointer-gated, not just width-gated (the whole reason the drawer breakpoint exists
instead of degrading further to the icon rail: "a 64px rail... dropped every label, which left
five identically-drawn department icons stacked with nothing to tell them apart," per the file's
own comment). The redesign's job is a **new width scale under the token layer's radius/elevation
change** (the visual-design spec owns the actual pixel values) plus one structural addition:

- **Grouping**: keep the current collapsible-group model (`NavGroupSection`, multi-open, the
  group holding the current route opens by default) but cap `Departments` at a visible max (e.g.
  6 rows) with an inline "All departments →" link to `/organization` beyond that — this is the
  direct fix for §1.1's breadth problem and needs no new component, just a slice in `Sidebar.tsx`.
- **Iconography**: `shell/icons.tsx` is a hand-rolled stroke-icon set (36 glyphs, single 1.6px
  stroke, one file, zero dependency) — keep this exact mechanism. Any new nav destination in
  Phase 2+ gets a new `PATHS` entry, never an icon library. `nav.test.ts` already pins "every
  collapsible group needs a rail glyph" and "no two groups share a glyph" — extend, don't replace,
  that guard as new groups appear.
- **Rail flyout** (`RailCategory.tsx`): keep the hover-with-delay + click-primary + keyboard
  (arrow keys, Escape, focus-trap-free single-panel) model verbatim — it is already accessible
  and dependency-free; the redesign only changes its surface colours/elevation.

### 3.2 Top bar

Current `erp-top` (`shell.css`) holds, left to right: nav toggle (mobile only) → module label +
date → global search form (`action="/search" method="get"`, a real GET, not client JS) → `+ New`
menu → notification bell. This is the right inventory and the target spec keeps it, with one
addition and one clarification:

- **Addition**: the command palette trigger (§4) — a visible affordance (icon + "⌘K" hint) sits
  where the search form is today; the palette *subsumes* the plain-text `/search` form rather
  than sitting beside it (two search entry points in one 64px bar is redundant chrome). The bare
  `<form action="/search">` remains functional as the palette's zero-JS fallback and for the
  `?q=` deep-link case.
- **What does NOT belong in the top bar**: page-specific actions (those belong in `PageHeader`'s
  `actions` slot, already correctly separated), breadcrumbs (they belong under the page title,
  already correct), and the company switcher (stays in the sidebar per §2.2 — do not let a
  visual pass "simplify" by moving it up, that reopens a decision already made).

### 3.3 Breadcrumbs + PageHeader

`PageHeader.tsx` was already simplified once (the header comment documents removing eyebrow +
subtitle rendering to cut ~292px of vertical chrome that mostly repeated the sidebar). The target
spec keeps this discipline and extends it: breadcrumbs render only past two segments (`Home /
X` is suppressed; `Home / Departments / Web Dev / Projects` renders in full) — already
implemented (`trail.length > 2`), no change needed structurally, only visual re-skin.

One real gap: `Breadcrumbs.tsx` and `PageHeader.tsx` both use **inline `style` props** rather than
CSS classes for their entire layout (font sizes, colors, flex layout all inline). This is fine
today because there is no per-breakpoint or per-theme variation needed, but the redesign's
elevation/radius/spacing-scale change (fixed decision #3) cannot be applied to inline styles by a
find-and-replace across `tokens/*.css` — every inline `style={{...}}` in these two files (and any
other component following the same idiom — grep shows this is common, e.g. `KpiTile`,
`Toast`) needs a manual pass to move onto classes before the token layer can re-skin them
"for free." This is a Phase 1 worklist item (§8), not a cosmetic nice-to-have — it is the
mechanical precondition for token-driven re-skinning to actually reach these components.

### 3.4 Right-hand rail / drawer

Two distinct existing mechanisms, both kept, neither merged:

- **`@drawer` parallel route** (`(app)/@drawer/(.)assistant`, `(app)/@drawer/(.)tasks/[taskId]`):
  a true Next.js intercepting route + parallel slot, rendered outside `<Shell>`'s scroll
  container so it positions against the viewport. `AssistantDrawer.tsx` and (implicitly)
  `TaskDrawer.tsx` both close via `router.back()`, both trap focus, both restore focus to a named
  trigger element on close. This is the load-bearing accessible-drawer pattern for the whole app
  — the target component inventory (§6) generalizes it into a reusable `Drawer` primitive (see
  NEW: `Drawer`) rather than a third copy-paste when the next slide-over is needed.
- **`MyWorkRail`** (department console): a persistent, non-dismissible content rail rendered
  once by `[deptId]/layout.tsx`, not a drawer at all — it's a permanent second column. Keep this
  distinction sharp in the redesign vocabulary: "rail" = permanent layout column; "drawer" =
  transient overlay reached by intercepting navigation. Do not let Phase 3/4 rename or visually
  conflate the two; they have different a11y contracts (a rail is part of the page's normal tab
  order; a drawer is a modal dialog with a trap).

### 3.5 Responsive behaviour, by breakpoint

| Breakpoint | Sidebar | Top bar | Content |
|---|---|---|---|
| ≥1025px | expanded/rail per cookie | full (search, meta, actions) | `max-width: 1180px` (or `none` under `data-width="wide"`, the current default) |
| 761–1024px | expanded/rail per cookie, narrower (208px) | tighter gaps, search capped 300px | padding reduced |
| ≤760px | off-canvas drawer, burger toggle | date/meta hidden, search stays | padding reduced further |
| ≤520px | off-canvas drawer | search goes full-width | padding minimal |
| `pointer: coarse` (any width) | — | 44px minimum targets on every interactive control (already comprehensively covered in `shell.css`'s last block) | same |

This table is a restatement of what `shell.css` already implements correctly — the redesign's
obligation is to preserve every one of these rules through the token change, and the guard test
(§9) should gain an explicit assertion that the 44px touch-target rule and the 760px drawer
breakpoint survive the CSS rewrite (today nothing pins them beyond visual QA).

---

## 4. Command palette (Cmd/Ctrl-K)

There is no command palette today (`grep` across `components/` and `shell/` for
"palette"/"cmdk"/"kbar" returns nothing) — this is new, and it is the single largest genuinely
new surface in this spec. Hand-rolled, per the hard constraint (no `cmdk`, no headless-UI).

### 4.1 What it searches

Three tiers, each already backed by data the app already has server-side — no new backend
endpoint is required for tier 1 and 2:

1. **Static nav destinations** — every `NavItem` from `navFor()`, flattened, already RBAC-filtered
   because `navFor()` already takes `me`/`tenantId`. Zero network cost: this list can be computed
   server-side in the same request that renders `Shell` and passed down as a prop, exactly like
   `Sidebar` already receives it.
2. **Department + toolkit destinations** — every `DeptTab` across every department the active
   company has, resolved via `toolkitFor()` the same way `DeptTabs` does today. Also static per
   request.
3. **Live records** (a client name, a project, a task, a person) — this is the one tier that
   needs a network round-trip, and it must go through the single-egress rule: a new
   `src/app/api/search/palette/route.ts` handler (browser-reachable, per the existing precedent
   of `src/app/api/search/*`) that calls `platformFetch` server-side and returns a small,
   already-RBAC-narrowed result set. This is new BFF surface — record it in
   `docs/FRONTEND-BFF-CONTRACT.md` before Phase 4 wiring, not invented here (architect's call
   whether it fans out to existing list endpoints or gets a dedicated search endpoint — flagged
   as a contract addition, not decided in this spec).

### 4.2 How it stays inside the single-egress rule

The palette component (`CommandPalette.tsx`, client) never calls `platformFetch` itself — it
debounces keystrokes and calls the `/api/search/palette` route handler exactly like
`OriginFilterBar`/`FacetFilters`-style client components already call server actions for
filtered data. Tiers 1 and 2 need no fetch at all (computed at `Shell` render time, same request
as the sidebar). This mirrors the existing precedent of `TopBar`'s server-computed `newItems`
array — RBAC-gate server-side, hand the client a plain array.

### 4.3 Keyboard model

- `Cmd/Ctrl-K` opens from anywhere (a single `keydown` listener mounted once in `Shell`, same
  scope as `AssistantFab`).
- `Escape` closes, focus returns to whatever triggered it (keyboard shortcut → whatever had
  focus before; the visible trigger button → that button) — same restore-focus discipline
  `AssistantDrawer`/`TaskDrawer` already established; reuse their pattern (`useRef` + effect
  cleanup), don't reinvent it.
- Arrow Up/Down move a virtual "active" index; Enter navigates; typing filters live, no separate
  submit step.
- The palette is itself a `Drawer`-family overlay (§3.4/§6) — same scrim, same focus trap.

### 4.4 Accessibility — the ARIA combobox pattern

`role="combobox"` on the text input (`aria-expanded`, `aria-controls` pointing at the listbox),
`role="listbox"` on the results container, `role="option"` + `aria-selected` per row,
`aria-activedescendant` on the input tracking the highlighted option id — this is the exact
pattern already half-demonstrated in this codebase by `RailCategory.tsx`'s own arrow-key
navigation (though that one is a plain button list, not a combobox) and is standard enough to
implement in plain React with no dependency: a `<ul role="listbox">` of `<li role="option"
id={...}>`, an `aria-activedescendant` state variable, and `scrollIntoView({block: "nearest"})`
on the active option when it changes.

### 4.5 RBAC filtering

Tiers 1–2 are pre-filtered server-side by construction (they're literally `navFor()`'s output).
Tier 3 (live records) must apply the *same* narrowing the record's own list page would apply —
e.g. a palette hit on a project must not appear for a user who couldn't open `/projects/[id]`
directly. The safest implementation is **not** a separate palette-specific authorization check
but reusing each domain's own `-data.ts` reader (`listClients`, `listProjects`, etc.) filtered by
a short query param, so the palette can never leak more than the list page already would — one
authorization surface, not two to keep in sync. This is exactly the trap the codebase's own
"frontend-first drift" pattern (CLAUDE.md's own named bug class) would create if the palette grew
its own read path.

---

## 5. Page archetypes

A closed set of eight. Every one of the 138 `(app)` routes and 15 `(portal)` routes maps onto
exactly one (a route may combine two visually — e.g. a detail page with an embedded mini-list —
but has one *primary* archetype).

### 5.1 List / Index

Wireframe: `PageHeader` (title + primary action, e.g. "+ New Project") → optional `EnvelopeBanner`
if cross-company → filter bar (search + facet chips) → `DataTable` or `HairlineTable` → pagination
footer. Optional bulk-action bar appears above the table only when ≥1 row is selected.

Maps: `/clients`, `/projects`, `/tasks`, `/people`, `/companies`, `/it/devices`, `/it/accounts`,
`/deliverables`, `/meetings`, `/monitoring`, `/knowledge`, `/notifications`, `/pipeline`, most
`departments/[deptId]/<tab>` leaf pages (engagements, keywords, rankings, repositories, ...),
`/organization/access`, `/organization/positions`, `/admin/users`, `/admin/audit`.

### 5.2 Record Detail

Wireframe: `PageHeader` (title = record name, breadcrumb trail to its list) → a summary strip
(KPI tiles or a `DescriptionList`) → tabbed or stacked content sections (activity, related
records, attachments) → a persistent action rail or inline action buttons for state transitions.

Maps: `/projects/[id]`, `/tasks/[id]`, `/clients/[id]`, `/companies/[id]`, `/people/[id]`,
`/billing/[id]`, `/appraisals/[id]`, `/meetings/[id]`, `/monitoring/[id]`, `/pipeline/[id]`,
`/it/devices/[id]`, `/approvals/[id]`.

### 5.3 Dashboard / Overview

Wireframe: greeting/date line → KPI tile row → 2-3 column grid of cards (queue, agenda, activity
feed, chart) → no table as the primary element (tables are secondary, inside a card).

Maps: `/` (Home, role-differentiated `CommandCenterHome`/`QueueAgendaHome`), `/hr`, `/it`,
`/organization`, department console Home tabs (all of them, bespoke or generic), `/agents`,
`/systems/observability`, `/portal` (client landing).

### 5.4 Board

Wireframe: primary group strip → optional sub-tab strip → column-based kanban with drag/keyboard
move, a persistent filter/facet strip above the columns, a right-side task drawer on card click
(never a full navigation away from the board).

Maps: `/pm`, `/project-management`, `departments/[deptId]/board`, `departments/[deptId]/ball`,
`departments/[deptId]/timeline` (Gantt variant of the same family), `departments/[deptId]/charts`
(chart variant). **This entire archetype is Phase-3, Repsona-layout, visual-only re-skin per
§2.7 — its wireframe above describes what already exists, not a change.**

### 5.5 Form / Wizard

Wireframe: `PageHeader` (title = "New X" / "Edit X") → single-column field stack
(`Field.tsx`-style: label, control, hint, error) grouped into labelled sections for long forms →
sticky or end-of-page primary/secondary action pair (Save/Cancel).

Maps: every `.../new` and `.../edit` route (`~15` per §1.2), `/companies/[id]/org` (structural
editor, same archetype with a heavier canvas), `/account`.

### 5.6 Settings

Wireframe: a single top-level `SectionTabs` strip (already the exact `/admin` pattern) → each tab
renders its own list/detail/form content using the *other* archetypes internally. Settings is a
meta-archetype — a tab container — not a fifth visual pattern.

Maps: `/admin/*` (8 tabs), and — recommended, not required by this spec — `/account` could adopt
the same tab shell if it grows past its current single form.

### 5.7 Report

Wireframe: a range/scope selector bar → KPI tile row → one or more chart-kit components
(`TrendLine`, `StackedBars`, `Donut`, etc. — already hand-rolled SVG, kept as-is) → a
`ReportTableView` fallback for the same data → optional print/export action.

Maps: `/reports/{person,project,department,company}`, department console `reports`/`charts`
tabs, `/print/reports/[jobToken]` (the print-sidecar rendering of the same document — see §5.8's
note on why print is architecturally excluded from shell concerns).

### 5.8 Empty / Pending

Wireframe: a centred icon/glyph + one-sentence explanation + (when applicable) the owning
ticket/contract reference. Not a variant of List with zero rows — a distinct, deliberately
sparse archetype so "nothing here yet" never gets confused with "no data matched your filter."

Maps: `(app)/[...placeholder]`, `BackendPending`-rendered states inside any other archetype,
`ConnectionState`/`EmptyNote` renders, `ReportAccessDenied`/`ReportRangeError`, the 403 branch
inside `/admin/users` (a Record-Detail-shaped page degrading to this archetype under refusal),
`not-found.tsx`.

**Note on `/print/*`**: it is not assigned an archetype "container" the way the other seven are,
because it is rendered by a cookie-less Playwright sidecar outside the normal shell entirely
(§9's risk register covers this). Its *content* reuses the Report archetype's visual language
(same chart kit) but its *chrome* is print-specific CSS (`app/print/print.css`) and must never
import anything from `shell.css` or depend on client-side JS (the sidecar has no interaction
model, only a render-and-capture pass).

---

## 6. Component inventory

`ui.tsx` today: `Eyebrow, Card, Button, StatusBadge, KpiTile, HairlineTable, Toast` (7), plus
three pure colour/label helpers. Everything else data-heavy has been built ad hoc, once, per
consuming surface (`DataTable` for generic lists, `SearchableTable`/`Paginator` for the systems
console, `FacetFilters`/`OriginFilterBar`/`FilterChips` for three different filter needs,
`AssistantDrawer`/`TaskDrawer` for two different drawers with no shared base).

| Component | Status | Notes |
|---|---|---|
| `Card` | EXISTS | re-skin only (radius/elevation tokens) |
| `Button` | EXISTS | needs a 3rd variant? evaluate in Phase 1; today only `solid`/`ghost` |
| `StatusBadge` | EXISTS | logic (`statusColor`/`statusGraphic`) is sound; visual only |
| `KpiTile` | EXTEND | move inline `style` props to classes (§3.3) before re-skin is possible |
| `HairlineTable` | EXTEND | fine for small static tables; needs a documented boundary vs. `DataTable` so authors stop guessing which to reach for |
| `Toast` | EXTEND | currently one at a time, no stacking/queue — Phase 4 data-mutation UX (§7) needs a toast queue |
| `Eyebrow` | EXISTS | the signature type treatment; keep verbatim, only token values change |
| `DataTable` | EXTEND | has search+sort+client pagination+CSV already; needs sticky header, column visibility control, and a "saved view" concept (persist filter+sort+visible-columns to `gaiada_prefs` or a new per-view cookie) — none of that exists today |
| `SearchableTable` (systems) | EXTEND or MERGE | near-duplicate of `DataTable`'s job, built for the systems console specifically — Phase 1/2 worklist should evaluate collapsing these two rather than carrying both forward |
| Filter bar | NEW (unify) | `OriginFilterBar`, `FilterChips`, `FacetFilters` are three bespoke, non-shared implementations of the same idea — target: one `FilterBar` primitive (chips + optional facet dropdowns), server-friendly (renders from a plain array of `{key,label,count}` the caller computes, same contract `FilterChipDef` already uses) |
| Bulk-action bar | NEW | nothing today selects multiple rows across any list; needs row-selection state (client component wrapping `DataTable`) + a floating action bar. Client component; server actions underneath per row already exist for most single-row operations, so this is orchestration, not new writes |
| `Tabs` (generic) | EXTEND (unify) | `SectionTabs`, `DeptTabs`, `PortalTabs`, `BotTabs` are four independent implementations of "a tab strip with active-prefix-match resolution." Target: one `Tabs` primitive parameterized by `{key,label,href,icon}[]` + an optional two-level variant for `DeptTabs`'s group/sub-tab case, so a fifth console doesn't get a fifth copy |
| `Drawer` (generic) | NEW | generalizes `AssistantDrawer`/`TaskDrawer`'s shared, already-correct pattern (intercepting route, `router.back()` close, focus trap, named-trigger refocus) into one component both — and the command palette (§4) — mount. Client component; API: `<Drawer onClose={...} labelledBy={...}>{children}</Drawer>`, trigger id passed as a prop for refocus |
| `Modal` | NEW | there is no true modal (blocking, centred, non-drawer) anywhere today — confirmation dialogs are currently ad hoc (`window.confirm` in places, or inline "are you sure" state). Client component, same focus-trap machinery as `Drawer` but centred/sized rather than edge-anchored; the two should share a `useFocusTrap` hook rather than duplicate the trap logic a third time |
| `Popover` / `Menu` | NEW (unify) | `UserMenu`, `NewMenu`, `RailCategory`'s flyout are three independent outside-click + Escape + `role="menu"` implementations. Target: one `Menu` primitive (trigger + positioned panel + outside-click/Escape close), each current call site becomes a thin wrapper supplying its own items |
| `Pagination` | EXTEND (unify) | `Paginator.tsx` (systems) vs. `DataTable`'s inline pager are two implementations; target one shared control |
| Avatar / presence | NEW | `UserMenu`'s initials-circle (`erp-side__avatar`) is the only avatar treatment today, inline in one component; no shared `Avatar` component and no presence/online-state concept exists anywhere in the codebase (confirmed: no such data model in `lib/platform.ts`'s `Me`). Flagging presence as **NEW, and out of scope for this redesign** unless the backend gains a presence signal — do not build UI for data that doesn't exist |
| Timeline | EXISTS (PM-scoped) | the Gantt view under PM stays exactly as-is per §2.7; not generalized into a shared primitive by this spec |
| Kanban primitives | EXISTS (PM-scoped) | `Board.tsx`'s column/card/drag model stays PM-only per the owner's fixed decision; **do not** extract a generic `Kanban` primitive as part of this redesign — that would be new scope, not a re-skin |
| Command palette | NEW | see §4 in full; client component (`"use client"`), reads server-computed nav/dept data as props, calls one new route handler for tier-3 live search |
| `EnvelopeBanner` | EXISTS | visual re-skin only; logic untouched (§2.5) |
| `BackendPending` / `EmptyNote` / `ConnectionState` | EXISTS | visual re-skin only |
| `Field` (form) | EXISTS | already carries label/hint/error/required correctly; re-skin only |
| Chart kit (10 components) | EXISTS | hand-rolled SVG, explicitly out of scope for new dependency risk; re-skin (colour tokens) only, owned by the visual-language spec, not this one |

**Totals**: 7 EXISTS-as-is (pure re-skin), 8 EXTEND (existing component, structural addition
needed), 8 NEW (`FilterBar` unification, bulk-action bar, `Tabs` unification, `Drawer`, `Modal`,
`Menu` unification, `Pagination` unification, Command palette). Avatar/presence is called out as
NEW-but-deferred (no backing data).

---

## 7. Interaction + state model

### 7.1 Loading

Two-tier policy, matching what the codebase already does ad hoc and making it a rule:
**skeleton** for anything rendering inside an already-mounted shell where the layout shape is
known in advance (a list page's table, a dashboard's KPI row) — reserves the exact space so
nothing jumps. **Spinner** (small, inline) only for actions with no predictable layout (a button
mid-submit, the command palette's live-search tier). Never a full-page spinner once the shell has
painted — `(app)/loading.tsx` (Next's route-level loading UI) already exists and should render a
shell-shaped skeleton, not a blank screen, for the initial navigation case.

### 7.2 Optimistic writes

Server actions already follow one shape everywhere (`ctx()` → capability gate → `{ok, error?,
field?, id?}`, per CLAUDE.md). The redesign's UI-side contract: any action invoked from a List or
Board archetype (status change, ball pass, task move) updates the client-visible state
immediately (React `useOptimistic` or local state flip) and rolls back with a `Toast` error on a
non-`ok` result — `Board.tsx`'s existing `move`/`movePick` plumbing already does exactly this
(the `pick` ambiguity-popover result is itself evidence of optimistic-with-recovery already being
the working pattern). Phase 4/5 should extend this same contract to `DataTable`-hosted inline
edits and the new bulk-action bar, not invent a second pattern.

### 7.3 Error surfaces

`PlatformError(status, message, field?)` is the one error shape. Field-level errors bind to
`Field`'s existing `error` prop (already wired: `aria-describedby` + `aria-invalid`). Page-level
errors (a 403, a 500) use the `StateScreen`/`Feedback.tsx` pattern already established by
`(app)/error.tsx` — the redesign re-skins `StateScreen`, doesn't replace it. A `PlatformError`
with `status === 403` inside a page body (not a route-level throw) should render the Empty/Pending
archetype's refusal variant (§5.8) — already the pattern `/admin/users` demonstrates — rather
than a route-level error boundary, because a 403 is an expected, navigable outcome, not a bug.

### 7.4 Toasts

Current `Toast` is single-instance, rendered inline by whatever page mounts it (no global queue).
Phase 4's bulk-action bar and optimistic-write rollback (§7.2) both need **more than one toast
able to appear in sequence without clobbering each other** — this is the one place §6's "EXTEND"
marking on `Toast` becomes load-bearing: it needs a queue (a `ToastProvider` context + a fixed
portal region, client-only, no new dependency) before Phase 4 ships, not after.

### 7.5 Empty states

Follow the existing, correct distinction: `DataTable`'s own `empty` prop (a string, "Nothing
here yet") for "the list has no rows because there's nothing to show," versus `BackendPending`
for "this list is real but its backend doesn't exist yet." A redesign PR that reaches for
`BackendPending` where the correct state is a genuinely empty list (or vice versa) is a
regression this spec explicitly flags — memory note "an empty list is a claim" documents exactly
this failure mode already occurring in this codebase.

### 7.6 The envelope's excluded-companies affordance

Covered in §2.5 — restated here for completeness of the interaction model: `EnvelopeBanner`
renders nothing when fully included, a one-line summary plus a native `<details>` disclosure
otherwise. No JS required for the disclosure (native `<details>`), which the redesign should
preserve — do not "componentize" this into a JS-driven accordion just because the rest of the
palette/menu work is going client-heavy; this one's simplicity is a feature.

### 7.7 Keyboard navigation across the shell

Already real and specific, not aspirational: `:focus-visible` ring (globals.css), skip link
(`Shell.tsx`'s `#main-content`), `RailCategory`'s arrow-key + Escape handling, `TaskDrawer`/
`AssistantDrawer`'s focus trap + restore. The command palette (§4.3/4.4) and the new `Menu`/
`Modal` primitives (§6) must match this existing bar, not set a new lower one — concretely: every
new interactive overlay gets Escape-to-close, a focus trap while open, and a named-trigger
refocus on close, using the *same* `useFocusTrap` hook (§6's `Modal` entry) rather than a fourth
bespoke implementation.

---

## 8. Migration mechanics

### 8.1 Phase plan — entry/exit criteria

**Phase 1 — Token layer + primitives.**
*Entry*: visual-design spec's token values exist as a reviewed diff to
`src/styles/tokens/{colors,fonts,typography,spacing}.css` plus a new elevation/radius scale.
*Exit*: `DEMO_MODE=1 npm run build` green, `npm test` green (all 154 files), `tokens.test.ts`
updated (not deleted — see §9) to assert the *new* rules (radius/elevation now legal, still
zero color-literal-outside-tokens), all 7 `ui.tsx` primitives visually re-skinned with no API
change, the inline-`style`-to-class migration for `PageHeader`/`Breadcrumbs`/`KpiTile` (§3.3)
done so later phases can theme them.

**Phase 2 — Shell.**
*Entry*: Phase 1 merged. *Exit*: `Shell.tsx`, `Sidebar.tsx`, `TopBar.tsx`, `shell.css`,
`portal.css` (separately — §2.6), and every shell sub-component in §3 re-skinned; command
palette (§4) ships behind no flag (it's additive, nothing depends on its absence); build gate +
full Playwright suite (`setup → chromium`, `anon`, `portal`, `personas`, `smoke`) green;
`nav.test.ts` unchanged in assertions (it tests structure, not class names, so it should not need
touching — if it does, that is a signal the refactor leaked structural change into a "visual"
phase).

**Phase 3 — PM re-skin.**
*Entry*: Phase 2 merged. *Exit*: `tokens/pm.css` re-skinned to reference the house palette
(still guarded by its own 5 assertions in `tokens.test.ts`, which must keep passing unmodified in
*logic*, only in *values*); `Board.tsx`, `TaskDrawer.tsx`, Gantt/Timeline, `pm-*.css` files (6 of
them) visually converged; zero changes to `Board.tsx`'s props, drag/keyboard interaction, or
`page-helpers.ts`/`ball-gate.test.ts` logic — those two test files passing unmodified is the
acceptance bar for "this was a re-skin."

**Phase 4 — Data surfaces.**
*Entry*: Phase 2 merged (Phase 3 may run in parallel, different files). *Exit*: `DataTable`
extended (sticky header, column control, saved views), `FilterBar`/`Menu`/`Pagination`
unifications land, bulk-action bar ships on at least one real list page as the reference
implementation, `Toast` gains its queue, every List/Detail/Report archetype page re-skinned.

**Phase 5 — Department sweeps.**
*Entry*: Phase 2 and 4 merged. *Exit*: all 4 bespoke `deptToolkits.ts` consoles + the generic
Home-only shell re-skinned; HR/IT double-path decision (§2.4) resolved *if* the architect has
ticketed it by this point — otherwise Phase 5 re-skins the standalone HR/IT trees as they exist
today rather than blocking on an unscheduled consolidation.

Each phase's exit criteria is independently a shippable, demo-able state — per the fixed
decision. No phase depends on a later phase's component work (Phase 4's `Drawer`/`Menu`
primitives are additive; Phase 2's palette doesn't require them to exist first — it can ship with
its own inline overlay markup and be refactored onto the shared `Drawer` once Phase 4 lands it,
rather than blocking Phase 2 on Phase 4's primitive work).

### 8.2 Build gate discipline through all five phases

`next build` (via `DEMO_MODE=1 npm run build`) is the gate, not `tsc`/vitest alone — CLAUDE.md is
explicit that both have passed while a `server-only` import reaching a client component broke
the actual build. Every phase's PR(s) must run the full sequence locally before merge:
`npm run typecheck` → `npm test` → `DEMO_MODE=1 npm run build` → `npx playwright test --project
smoke`. No phase gets an exception. Because CSS-only changes (most of Phase 1/3) cannot break a
server/client boundary, the highest-risk phases for this specific trap are **Phase 2** (new
command-palette client component reading server-computed props — a misplaced `server-only`
import here is exactly the historical failure mode) and **Phase 4** (`Drawer`/`Modal` as new
client components consumed from currently-server pages).

### 8.3 What happens to the ~154 vitest files

The large majority (component logic tests: `nav.test.ts`, `page-helpers.test.ts`,
`ball-gate.test.ts`, every `*Actions.test.ts`, every `lib/*.test.ts`) assert **behavior and data
shape**, not DOM class names or pixel layout — these should need zero changes across all five
phases, and a phase whose diff touches a large number of them is a signal the "visual-only"
boundary was violated somewhere. The minority that *do* touch rendered output
(`Board.test.tsx`, the `systems/*.test.tsx` component tests using React Testing Library) query by
role/label/text (`getByRole`, `getByText`) per this codebase's existing convention, not by class
name — so a token-value or class-rename change should not break them either, *provided* the
redesign does not also rename ARIA roles or visible text while re-skinning. That constraint
should be an explicit code-review rule for Phases 1-5: **a PR that changes both a component's
visual class names and its accessible name/role in the same diff is two changes, not one — split
it.**

### 8.4 What happens to the Playwright projects

- `setup` / `chromium`: unaffected by CSS changes; affected only if a re-skin changes an
  `aria-label`, visible text, or `data-testid`-equivalent selector any spec depends on (a grep of
  `e2e/*.spec.ts` for the selectors used should be step one of Phase 2, before merging shell
  changes).
- `anon`, `portal`, `personas`: same rule — these are identity/flow tests, not visual tests; they
  should be untouched by a well-scoped re-skin.
- `pm-unified`: Phase 3's acceptance test. This project should be run explicitly (not just left
  to CI's default) before and after every Phase 3 PR as a manual gate, since it is the one
  project purpose-built to catch a PM interaction regression.
- `smoke`: the CI build-gate check — runs against the *built* app, which is exactly why it is
  the one Playwright project that would have caught the historical `server-only`-in-client-
  component class of bug `tsc`/vitest both missed. Every phase's CI run must include it, not just
  Phase 2's.

### 8.5 Visual regression snapshots — yes, and how

**Recommendation: yes, introduce them, using Playwright's built-in `toHaveScreenshot()` — no new
dependency, since Playwright is already a runtime dependency of the test toolchain (not a
`platform-ui` runtime dep, a devDependency, so it doesn't touch the "four runtime deps" rule at
all).** Given a five-phase visual migration touching 44 CSS files, the single highest-leverage,
lowest-cost regression net is: for each of the 8 page archetypes (§5), pick one representative
route already covered by an existing `chromium`-project spec, add a `toHaveScreenshot()`
assertion in `DEMO_MODE` (deterministic fixture data, no network flake), and commit the baseline
*at the end of Phase 1* (post-token-layer, pre-shell-change) so Phase 2 onward has something real
to diff against. Do **not** add snapshot coverage before Phase 1 lands — a baseline taken against
the pre-redesign zero-radius/no-shadow surface would immediately and correctly fail on Phase 1's
very first PR, which is noise, not signal. Keep the snapshot set small (8-12 routes, one per
archetype plus PM's board and the portal shell) — a large, unmaintained snapshot suite rots
faster than it protects; this is meant as a migration seatbelt for five specific phases, not a
permanent visual-QA program the team commits to forever.

### 8.6 Ordered file-by-file worklist — Phase 1

1. `src/styles/tokens/colors.css` — add radius/elevation scale tokens (`--radius-sm/md/lg`,
   `--elev-1/2/overlay` if not already fully specified by the visual-design spec's own deliverable
   — coordinate, don't duplicate).
2. `src/styles/tokens/spacing.css`, `typography.css`, `fonts.css` — apply the visual spec's values.
3. `src/styles/tokens/pm.css` — touched last within Phase 1, only enough to keep
   `tokens.test.ts`'s 5 PM assertions passing; full PM re-skin is Phase 3, not Phase 1.
4. `src/styles/globals.css` — remove the hard "zero border-radius, no box-shadow" rule
   (`tokens.test.ts`'s own assertions #2 must be rewritten in the same PR, never left red — see
   §9's guard-test risk).
5. `src/styles/tokens.test.ts` — rewritten alongside step 4 (not after) to assert the *new*
   invariants: radius is now legal (drop the negative assertion), `--elev-overlay` usage rule
   loosens to "elevation tokens only, no raw `box-shadow` outside `tokens/*.css`" (same
   discipline, wider legal surface), color-literal ban unchanged.
6. `src/components/ui.tsx` + `ui.css` — re-skin all 7 primitives.
7. `src/components/PageHeader.tsx`, `src/components/Breadcrumbs.tsx` — move inline `style` props
   to classes (§3.3) in the same PR as their visual re-skin, since the class extraction has no
   independent value until there's a token to apply through it.
8. `src/components/ui.test.tsx` — extend if the class-name refactor changes what's queryable
   (should not, if role/text-based queries are kept per §8.3's rule).
9. Add the Phase-1-end visual regression baseline (§8.5) — last step, once steps 1-8 are stable.

### 8.7 Ordered file-by-file worklist — Phase 2

1. `src/components/shell/shell.css` — the single largest file in this phase; re-skin in place,
   width/breakpoint values unchanged (§3.5's table is the acceptance spec).
2. `src/components/shell/icons.tsx` — no change needed unless the visual spec's stroke-width
   token differs from the current hardcoded `1.6`; if so, parameterize via a CSS custom property
   rather than hardcoding a new literal.
3. `src/components/shell/Sidebar.tsx` — add the `Departments` group cap + "All departments →"
   link (§3.1).
4. `src/components/shell/NavGroupSection.tsx`, `RailCategory.tsx`, `NavLink.tsx`,
   `SectionTabs.tsx`, `DeptTabs.tsx` — visual re-skin only, no logic change.
5. `src/components/shell/TenantSwitcher.tsx`, `CompanyContext.tsx` — visual re-skin; add the
   `<title>` scope signal (§2.2) in `(app)/layout.tsx`'s `generateMetadata`, not in these files.
6. `src/components/shell/UserMenu.tsx`, `NewMenu.tsx` — candidates to be rebuilt on the new
   shared `Menu` primitive (§6) rather than purely re-skinned in place, since Phase 2 is when
   that primitive should first land (the palette needs the same overlay/outside-click plumbing).
7. New: `src/components/shell/CommandPalette.tsx` (client) + `src/app/api/search/palette/route.ts`
   (server route handler) — built per §4, wired into `Shell.tsx` alongside `AssistantFab`.
8. `src/components/portal/portal.css`, `(portal)/portal/layout.tsx` — re-skinned as its own line
   item (§2.6), verified against the `portal` Playwright project specifically.
9. Full-suite run: `npm run typecheck && npm test && DEMO_MODE=1 npm run build && npx playwright
   test` (all projects, not just `smoke`) before Phase 2 is declared exit-criteria-met.

---

## 9. Risk register (ranked)

1. **Server-only/client-component boundary trap.** The codebase's own named worst-case (`tsc`
   and vitest both pass, `next build` breaks a route). Highest risk in Phase 2 (new
   `CommandPalette` client component) and Phase 4 (`Drawer`/`Modal` as new client primitives
   consumed by currently-pure-server pages). *Mitigation*: `DEMO_MODE=1 npm run build` +
   `smoke` project run on every PR touching a new or newly-client-ified component, no exceptions;
   new client components import only from other client-safe modules (`X.ts`, never `X-data.ts`).

2. **Concurrent agent sessions share this repo; main moves under you.** Per the user's own
   standing operational note — a 5-phase, 44-CSS-file migration run by multiple sessions/agents
   over time is exactly the shape of change most exposed to this. *Mitigation*: each phase is one
   or a small number of PRs merged promptly (not left open across sessions), `git status`/diff
   checked against base before any `git add` of a broad path (per the "`git add <file>` takes the
   whole file" trap), and the Phase exit criteria (full test+build+e2e green) re-verified
   immediately before merge, not just when the branch was cut.

3. **The guard test (`tokens.test.ts`) rewrite.** This file is *the* mechanism enforcing the old
   design law (zero radius, no shadow) and will actively fight Phase 1 unless rewritten in the
   same PR that changes `globals.css` (§8.6 step 4-5). A phase that "temporarily" disables or
   skips this test to unblock a build is the single most likely way this program regresses
   silently — a disabled guard test is worse than no test, because its presence in the file tree
   signals protection that no longer exists. *Mitigation*: no PR may skip/disable an assertion in
   this file; every change to it is a same-PR replacement of one invariant with its Phase-1
   successor, reviewed as carefully as the CSS change itself.

4. **RBAC-gated rendering regressions.** `nav.ts`, `nav.test.ts`'s six assertions, and every
   `can()`/`isElevated`/`isClientOnly` call site in shell components are logic the redesign must
   not touch, only re-skin around. *Mitigation*: `nav.test.ts` passing unmodified is a Phase 2
   exit gate (§8.1); any PR that needs to modify an assertion in it gets flagged for extra review
   as a structural (not visual) change — see §8.3's "two changes, not one" rule.

5. **Hydration divergence from locale/timezone formatting.** Named directly in CLAUDE.md's own
   trap list (`toLocaleString`/`toLocaleDateString` depending on runtime ICU). `TopBar.tsx`'s
   `dateLine` (`new Date().toLocaleDateString("en-GB", ...)`) is a live example already in the
   shell surface this spec touches in Phase 2. *Mitigation*: no phase introduces a new
   un-pinned locale/timezone call; any new date formatting in the command palette or new
   components goes through the existing pinned pattern (`charts/chartHover.ts::fmtDate`'s
   precedent), not a fresh `toLocaleDateString()` call.

6. **The print sidecar.** `/print/*` is rendered cookie-less by a separate Playwright process and
   must not gain a dependency on anything the shell redesign introduces (the command palette, the
   new `Drawer`/`Modal` primitives, any client-side theme-detection JS). *Mitigation*: `print.css`
   stays its own file, imports nothing from `shell.css` or the new primitives; the Report
   archetype's chart-kit re-skin (owned by the visual-language spec) is the only thing Phase 3/4
   should let leak into print's visual output, and only through shared *token* values, never
   shared *components*.

7. **Visual/accessible-name coupling in the same diff (§8.3).** A re-skin that quietly renames a
   button's visible text or an `aria-label` while also changing its class breaks both the vitest
   RTL tests and any Playwright spec selecting by that text, and is hard to distinguish from a
   deliberate content change in review. *Mitigation*: the "two changes, not one" review rule
   stated in §8.3, enforced by CI diff review, not tooling (there is no automated way to catch
   this without a dependency this project has decided against).

8. **`DataTable`/`SearchableTable` divergence hardening instead of resolving.** If Phase 4 re-skins
   both independently rather than resolving the EXTEND-or-MERGE question in §6, the redesign
   permanently doubles the maintenance surface it had a chance to halve. *Mitigation*: make the
   merge-vs-extend call explicitly at the start of Phase 4, not implicitly by re-skinning
   whichever file a PR happens to touch first.

9. **The `[...placeholder]` catch-all masking real gaps during Phase 5.** Because it renders a
   calm, on-brand "not yet furnished" message, a Phase 5 department sweep could re-skin the
   placeholder itself and declare a department "done" without the toolkit actually existing.
   *Mitigation*: Phase 5 exit criteria is measured by `hasBespokeToolkit()` returning true for
   the department count claimed complete, not by "the placeholder page looks nice now."

---

## 10. Effort estimate

Assumptions: one senior FE engineer as the primary implementer per phase, with a second
engineer (medior-level) available for parallel file-list work within a phase once the pattern is
established; a design review checkpoint at the start of each phase (visual spec already in hand,
no design exploration time included); QA pass included in each phase's own total, not additive;
"day" = a focused implementation day, not calendar elapsed time (agents/engineers may parallelize
across sessions per this repo's own concurrent-agent reality — elapsed time could compress below
the sum if two phases with no file overlap run concurrently, e.g. Phase 3 alongside Phase 4).

| Phase | Scope | Estimate | Basis |
|---|---|---|---|
| 1 | Token layer + 7 primitives + guard-test rewrite + inline-style extraction on 2 files | **4-5 days** | Small, well-bounded file count (≤10 files) but the guard-test rewrite and inline-style extraction are fiddly, not mechanical |
| 2 | Full shell (22 shell files + portal.css) + new command palette + new route handler | **8-10 days** | Largest single-surface phase; command palette is genuinely new (not a re-skin) — §4's four sub-specs (search tiers, keyboard, a11y, RBAC) are a real feature, budgeted ~3 of the 8-10 days alone |
| 3 | PM re-skin (6 pm-*.css files + Board/TaskDrawer/Gantt visual pass), zero logic change | **5-6 days** | File count is small but the "verify zero interaction regression" bar (pm-unified Playwright project, ball-gate/page-helpers tests unmodified) requires careful, slow verification, not fast painting |
| 4 | DataTable extension (sticky header, column control, saved views), FilterBar/Menu/Pagination unification, bulk-action bar, Toast queue, ~40 list + ~25 detail + ~10 report pages re-skinned | **12-15 days** | The largest page count and the most new component surface (§6's 8 NEW/EXTEND items land here); the DataTable/SearchableTable merge decision alone is a half-day design conversation before any code |
| 5 | 4 bespoke + N generic department consoles re-skinned; HR/IT decision either resolved or deferred per §2.4 | **6-8 days**, **+3-5 days if HR/IT consolidation is pulled into scope** | Scales with department count more than route count — each bespoke toolkit's craft group is genuinely distinct UI, not a template stamp |
| **Total** | | **35-44 days** (base), **38-49 days** if HR/IT consolidation is folded in | Excludes the parallel visual-design-language work (token *values*) and any new backend endpoint the command palette's tier-3 search requires (architect's call, §4.1) |

This is a single-engineer-equivalent estimate; the program's own standing practice of running
several agent sessions concurrently on non-overlapping file sets (Phase 3 vs. Phase 4, or a
junior/medior engineer taking Phase 5's department-by-department sweep once Phase 2's shell
primitives are stable) can compress elapsed calendar time meaningfully below this sum without
changing the total effort.
