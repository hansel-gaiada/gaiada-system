# Department workspaces: every employee works from their own department (DW-*)

**Status: PLANNED; every decision ruled (2026-10-13).** Nothing in this document is built. This is revision 2, written on 2026-10-13
after the owner reviewed revision 1 and its drafts.

**Owner ask (2026-10-13):**
- Make each department its own dashboard. An employee only goes to their own department, so this is
  the part of the ERP they use to work every day.
- The interface must be as clean as possible, with little clutter and distraction and a clear goal.
- Re-arrange menus and tabs so people work efficiently and correctly.
- Simplify the sidebar so an employee can stay in their own dashboard and still have everything they
  need there.
- Leave room to add features later.

**Owner review of revision 1 (2026-10-13).** These are now rulings DW-D9 to DW-D16:
- The AI Assistant gets a row in the sidebar.
- The menus that mattered in the old sidebar are needed inside the department too:
  - **reports** in daily, weekly, monthly, quarterly, semester and yearly periods;
  - **appraisals** for the department and the individual;
  - **learning** for the individual, where heads of department (HODs) can add new material;
  - **analytics**.
- The **Overview page is the most important page**. It is the individual's dashboard: an all-seeing
  eye that is clean, professional and not confusing.
- **Campaigns are multi-department.** Social Media and SEO also run their own campaigns.
- **Creatives supplies the assets.** Web Dev handles anything that needs a software engineer.
- **Each department has its own set of tools and connections**, for example Figma, Claude Code and
  VS Code.
- **The AI Assistant page is today's assistant made better and usable now.** Its routing and model
  usage are planned in a separate plan, so they do not bloat this one.
- The owner also asked what "Intelligence" is for. The answer is in §6.

**Builds on:**
- The Employee perspective of the Three Perspectives plan
  ([`2026-10-10-three-perspectives.md`](2026-10-10-three-perspectives.md) §4.1).
- The department consoles that exist today (`platform-ui/src/lib/deptToolkits.ts`).

**Evidence base:**
- `origin/main` at `d574d099`, read from clean worktrees on 2026-10-13. The shared checkout was 625
  commits behind and was not used.
- Three read-only surveys: a route inventory, departments and prior rulings, and a chrome clutter
  audit. The checks made for revision 2 are cited where they are used.
- `UI` = `platform-ui/src/`, `PN` = `platform-nest/src/`.

**Visual:** draft screens for each department: https://claude.ai/artifact/BeKqZixVQq8R2AuywQBEN9

---

## 0. Summary

**The one idea.** The department becomes the employee's whole working surface. The sidebar is that
department's menu, not a map of the entire ERP.

**What an employee sees:**
- When they open the ERP, they land on their department's **Overview**. It is one clean page:
  - what needs them now;
  - their own numbers for the period;
  - their department's numbers;
  - their work;
  - their growth.
- The sidebar has four short blocks:
  1. **Overview** and **AI Assistant**.
  2. **Work**: the department's own tools, requests, campaigns, clients, and its **Tools &
     connections**.
  3. **Performance**: Reports, Analytics, Appraisals and Learning. Each has a "Mine" view, plus "Team"
     and "Department" views for heads.
  4. **You**: My tasks, Inbox, Calendar and Me. Below it sits one door to the rest of the company.
- **Sidebar size.**
  - A Web Dev employee goes from **38 sidebar rows to 19**, and every one of the 19 is about their
    department or themselves.
  - A root owner goes from **52 to 19**.
- **Inside a section** there is one tab strip, no breadcrumb, and the full page width.
- **Departments work together** through **shared campaigns** and **requests**. Creatives receives
  asset requests, and Web Dev receives engineering requests.

**What does not change:**
- **Who may see what.** The server (Cerbos, RLS) stays the authority. The one access change is the
  HODs' learning and department-report rights, decision DW-D15.
- **The client portal.**
- **URLs.** Every existing page keeps its URL, and ⌘K still finds every page a person may open.

---

## 1. Where we are

| Measure | Today |
|---|---|
| Sidebar groups, plain employee | 9: Me, Workspace, Organization, Departments, Business, Reports, Appraisals, Learning, Intelligence |
| Sidebar rows, plain employee (Gaiada: 5 departments plus HR, IT, Finance) | **38** |
| Sidebar rows, root owner who is also `platform_admin` | **52**, in 12 groups |
| Navigation levels on a department tool page | sidebar group → row → group strip → sub-tab strip |
| Navigation and attention targets on a department Home | about 55–65 |
| Staff pages | 226 `page.tsx`; 10 pure redirects; about 9 orphans |

**What makes it cluttered:**

1. **The sidebar maps the whole ERP and ignores the person's department.** The only exception is a
   small "My department →" button on the Dashboard.
2. **Duplicates.**
   - Project Management appears in 3 places.
   - Leave and Loans appear in 4 places.
   - Learning appears twice.
   - My report, timesheets and appraisals are reachable from 3 places each.
3. **Four layers sit above a department's content:** a breadcrumb, the H1, a group strip and a
   sub-tab strip.
4. **The 320px My-work rail is on almost every tab**, and the Dashboard repeats the same queue.
5. **Department Home has 5–6 stacked cards.** Two of them link to tabs that already exist.
6. **The top bar is crowded.** It has two search boxes, a fixed label, the date and a theme toggle,
   and a floating Assistant button covers content on every page.
7. **Functional departments use flat strips:** HR has 14 tabs, Finance 15, and IT 6 plus 4.

**Facts revision 2 rests on** (checked on `d574d099`):

| Fact | Where | Consequence |
|---|---|---|
| Report periods are `day`, `week`, `month` and `custom`. The GM review has `week` and `month` | `UI/lib/reports.ts:29`, `PN/modules/reports/document-builder.ts:88`, `UI/lib/gm.ts:124` | Quarter, semester and year are **new backend work** (DW-4a) |
| Appraisal subjects are individuals only | `PN/modules/reports/appraisal-engine.ts` | A **department scorecard** is new (DW-4e, DW-Q4) |
| `org_unit_lead` holds `lms.authoring`, `lms.publish`, `lms.assign`, `lms.grade`, `lms.progress.view`, `appraisal.read` and `reports.department.view`, scoped to the head's own unit. It deliberately has no `lms.waive` | `UI/lib/rbac.ts:721` | The right role for HODs already exists |
| Real heads are seeded with `manager` (`MANAGER_LEVELS = gm, head, manager`). That role has `appraisal.score` but **no learning rights and no department-report right** | `PN/seed/roster-access.ts:96`, `UI/lib/rbac.ts:527` | **Today an HOD cannot add learning material** (DW-D15) |
| The sidebar asks `can(me, "lms.authoring", tenant)` at company scope. Unit-scoped grants are refused for company-wide questions | `UI/components/shell/nav.ts`, `rbac.ts::scopeCovers` | Even with `org_unit_lead`, an HOD would not see Authoring. The UI needs a unit-aware check (DW-4g) |
| An agency campaign has `name`, `status`, `project_id` and `budget`, but no departments | `UI/lib/entities.ts:77`, `PN/modules/agency` | Multi-department campaigns need **department parts** (DW-5a) |
| Social Media has a campaigns API (`GET/POST campaigns`) but no screen for it | `UI/lib/social.ts:27` | The Social campaigns screen is new, on an existing backend |
| SEO has campaigns: Planner, Ads Studio, Search Terms and Pacing | `UI/lib/searchMarketing.ts:35` | SEO's own campaigns already exist |
| Web Dev has a request intake (client maintenance, MI-05). Creatives has none | `[deptId]/requests`, `deptToolkits.ts` | Creatives' asset requests are new. Web Dev's intake gains internal requests |
| Each bespoke department already has `launchers` (its tools) and a Connections page (GitHub, Google Drive, Claude seats; SEO also has Google accounts) | `deptToolkits.ts`, `[deptId]/connections`, `lib/claudeSeats.ts` | **Tools & connections** is a regrouping of what exists, plus sets for the departments that lack one |

---

## 2. The model

### 2.1 One home per employee: their workspace

A **workspace** is a department's console, extended to hold everything its people need day to day.

| Person | Home workspace | How it is found |
|---|---|---|
| Placed employee | Their department | `myPlacement` (the org tree's primary unit) |
| HR, Finance or IT staff | HR, Finance or IT | The same, once those departments are in the org tree (DW-D6) |
| Head of department | Their department, plus the Team views | Placement plus `org_unit_lead` on that unit (DW-D15). The server narrows every read |
| Owner or executive with no placement | The **Office of the GM** | No placement, and GM access that is full or narrowed (`lib/gm.ts`) |
| Anyone else with no placement | A Company Overview | Fallback |

- **HR, Finance and IT keep their route trees** (`/hr`, `/finance`, `/it`). They become workspaces by
  being listed in the same registry, not by moving. This replaces the idea in the 2026-08-22 IA doc
  §2.4 of retiring `/hr` and `/it`.
- **Someone with several positions** has their primary placement as home. Their other positions and
  lead units add workspaces to the switcher.

### 2.2 The sidebar

```
┌────────────────────────────┐
│ ◉ Syrowatka                │
│ ┌────────────────────────┐ │
│ │ Web Dev             ▾  │ │  switcher: your workspace(s), every department,
│ │ Gaiada                 │ │  switch company
│ └────────────────────────┘ │
│  Overview                  │  ← the all-seeing dashboard (§3)
│  AI Assistant              │  ← opens the assistant (§6)
│  WORK                      │
│  Project Management        │
│  Build                     │  ┐
│  Run                       │  │ this department's own sections
│  Website                   │  ┘
│  Requests             4    │  ← work other departments and clients ask of us (§7)
│  Campaigns                 │  ← shared + our own campaigns (§7)
│  Clients                   │
│  Tools & connections       │  ← this department's tools and accounts (§4.1)
│  PERFORMANCE               │
│  Reports                   │  ← daily · weekly · monthly · quarterly · semester · yearly
│  Analytics                 │
│  Appraisals                │  ← mine · team · department
│  Learning                  │  ← mine · department courses · add material (heads)
│  YOU                       │
│  My tasks             5    │
│  Inbox                3    │
│  Calendar                  │
│  Me                        │
│ ────────────────────────── │
│  Company                   │
│  [ + New ]                 │
└────────────────────────────┘
```

**Every workspace has the same skeleton.** Only the department's own sections and its tool set
differ, so someone who moves department finds Reports, Appraisals, Learning and their tools in the
same place.

**The switcher replaces the company switcher and the Departments group.**
- It lists your workspace(s) first.
- Then it lists every department of the active company, ungated as today.
- Then it offers "Switch company" when you have more than one.
- The org chart stays complete. That keeps GM-01's point that hiding a department would lie about
  the org chart.

**The group labels (Work, Performance, You) are quiet and short.** Row badges only count things that
need you.

**Footer:**
- **Company** (§9.2).
- **Admin**: Settings, Group and Platform, for those gated in.
- **+ New**, with the workspace's own create action first.

**The collapsed rail and the phone drawer** show the same rows: flat icons with tooltips, no
fly-outs.

### 2.3 Areas, visiting and record pages

Every route belongs to exactly one area: a workspace, the company area, the personal area or an admin
area. A single `areaFor(path)` decides which. A test generated from the page files fails when a page
has no area, or two.

- **Visiting another department** shows its rows under "Visiting SEO", with a one-click "Back to Web
  Dev".
- **Personal pages** (My tasks, Inbox, Calendar, Me) keep your workspace's sidebar.
- **Record pages** keep the area you came from. These are `/tasks/[id]`, `/projects/[id]`,
  `/clients/[id]/*` and `/people/[id]`.
- **The Company and Admin areas** show their own rows, with "Back to Web Dev".

### 2.4 Inside a section

- **One tab strip.** The sidebar row picks the group, and the strip shows its tools. The shell draws
  the strip from the registry, so `/monitoring` or `/finance/*` can sit in a workspace group without
  moving.
- **No breadcrumb inside a workspace.** Deep record pages keep theirs.
- **No My-work rail on tool pages.** "Needs you" lives on the Overview, and its count sits on My
  tasks.

### 2.5 The top bar

```
[☰ phone]  [ Search pages, people, records…  ⌘K ]                 [🔔 3] [RV]
```

- **Search.** One field opens the palette, and Enter goes to `/search`.
- **The floating Assistant button retires**, because the Assistant is a sidebar row now (DW-D9). The
  row opens it as a drawer over the current page, the way the button did.
- **Bell.** It opens a pop-over with "Open inbox".
- **Avatar menu.** Theme, Account, Client view and Sign out.
- **Removed:**
  - the fixed "My Workspace" label;
  - the date;
  - the full-width "Unrestricted access" strip, which becomes a small chip.

### 2.6 Rules that keep this safe

1. **Nothing is removed.** Every page has exactly one home (§10), and a test proves it.
2. **URLs do not change.** Only true duplicates redirect.
3. **⌘K finds everything a person may open.** It is built from the full registry.
4. **Permissions are unchanged, except DW-D15.** Every row keeps its gate, and the server still
   refuses.
5. **Every company type works.**
   - Generic-pack companies get the generic workspace.
   - Agency-only rows stay pack-gated (PV-D15, PV-D17).
   - No company names go in code (PV-D13).
6. **One work queue.** "Needs you" is a projection of `getMyWorkQueue` (WS-UX R-1).

---

## 3. The Overview: the all-seeing dashboard

The Overview is the most important page in the ERP (DW-D12). It answers five questions, in one screen
and in a fixed order:

1. What needs me now?
2. How am I doing?
3. How is my department doing?
4. Where is our work?
5. How am I growing?

Every block answers one of them. A block shows at most 4 numbers or 6 rows, and opens the full page in
one click. It stays clean because the order never changes and nothing appears twice.

### 3.1 Layout

```
Good morning, Reva                   [Today|Week|MONTH|Quarter|Semester|Year]  [New briefing] [Triage · 4]
Web Dev · Gaiada · Tuesday 13 October

NOW ───────────────────────────────────────────────────────────────────────────────────────────────
┌ Needs you · 5 ─────────────────────────────────────────┐ ┌ Today ───────────────────────────┐
│ approval  Approve staging for Villa Asri       2d      │ │ 10:00 Client briefing · Tirta Spa │
│ overdue   Fix contact form on Kopi Lima        1d late │ │ 14:30 Sprint review               │
│ ball      Hero section for Tirta Spa           today   │ │ Check-in opens 16:00              │
│ …                                  See all in My tasks │ │ Your tools: Claude Code GitHub …  │
└────────────────────────────────────────────────────────┘ └───────────────────────────────────┘
YOU · OCTOBER ─────────────────────────────────────────────────────────────── Open my report →
[ 23 tasks done ▲4 ] [ 87% on time ▲3 ] [ 142 h logged of 168 ] [ 9 of 10 check-ins ]
WEB DEV · OCTOBER ────────────────────────────────────────────────── Open the department report →
[ 4 requests waiting ] [ 1 site with a problem ] [ 2 runs waiting approval ] [ 3 due this week ]
┌ Projects ──────────────────────┐ ┌ Campaigns ──────────────────┐ ┌ Requests ────────────────┐
│ Kopi Lima rebuild    ● on track │ │ Tirta Spa launch  our part  │ │ 4 in · 1 sent            │
│ Villa Asri booking   ● at risk  │ │ Kopi Lima promo   our part  │ │ oldest waiting 2d        │
└────────────────────────────────┘ └─────────────────────────────┘ └──────────────────────────┘
GROWTH ─────────────────────────────────────────────────────────────────────────────────────────────
┌ Learning ──────────────────────┐ ┌ Appraisal ──────────────────┐
│ 2 assigned · 1 due Friday      │ │ Q4 cycle · self-review due  │
│ Next: Accessibility basics     │ │ 31 Oct · last result 3.8/5  │
└────────────────────────────────┘ └─────────────────────────────┘
```

### 3.2 The period selector

- One control at the top sets the period for every number on the page: Today, Week, Month, Quarter,
  Semester or Year.
- The same periods drive Reports (§5.1), so the Overview and the report always agree.
- Until quarter, semester and year exist in the backend (DW-4a), those three are shown but disabled.
  The page never fakes a number.

### 3.3 The blocks

| Band | Block | Contents | Source (all exist unless marked) |
|---|---|---|---|
| Now | **Needs you** | One ranked list, max 6: approvals and gates, the ball with me, overdue and due today, mentions, requests assigned to me | `getMyWorkQueue`, which already ranks PM tasks (`fromPmTask`); ball tasks arrive through the PM leg's `assignee=me` (ball-or-responsible on the backend), so no department task read is added |
| Now | **Today** | Agenda, check-in state, my pinned tools | calendar, check-ins, the department's tool set |
| You | **Your numbers** | Tasks done, on-time %, hours logged, check-ins; each against the previous period | person-grain report facts, timesheets, check-ins |
| Department | **Pulse** | 4 department tiles (§4) | per-tile reads |
| Department | **Projects** | Top 4 by risk, with health and next due date | PM rollups |
| Department | **Campaigns** | Shared campaigns we have a part in, plus our own, with our part's status | campaign parts (DW-5a); the SEO and Social campaigns APIs |
| Department | **Requests** | Counts in and sent; the oldest waiting | requests (DW-5c) |
| Growth | **Learning** | Assigned, due, next course | LMS (the `/me/learning` reads) |
| Growth | **Appraisal** | Current cycle stage, my next step, my last result | appraisals (the `/appraisals/mine` reads) |

**Tiles never fake a number:**
- A tile with no backend yet is **hidden**.
- A tile whose read fails says **"unavailable"**, never 0.

### 3.4 Heads of department: Me | Team

- A head's Overview has a **Me | Team** switch.
- Team mode changes three blocks:
  - "Your numbers" becomes **Team numbers**: check-ins sent, on time, blocked, and hours against
    capacity.
  - **Needs you** becomes the team's waiting decisions and blockers.
  - **Growth** shows team learning completion and the appraisal cycle's progress.
- **The department's condition is always on top** for the HOD, in both Me and Team mode. A banner
  opens the department band: on track, at risk or off track, with the KPI that drives it (§5.5).
- The switch shows when the head holds `org_unit_lead` on the unit (DW-D15). The server narrows
  every read.

### 3.5 Owners and executives: the company Overview

The Office of the GM's Overview keeps the GM cockpit's numbers, in the same band order:
1. **Needs you:** decisions.
2. **Company:** revenue, overdue receivables, projects on track, utilization.
3. **Departments:** one row each, with its condition (on track, at risk or off track) and the KPI
   driving it. The worst comes first (§5.5).
4. **Campaigns:** across departments.
5. **Growth:** learning compliance and appraisal-cycle progress.

### 3.6 Built from widgets

- Each workspace lists its Overview widgets in the registry.
- A new feature is one widget, plus a row if it needs one.
- A new widget must replace something or earn its place in its ticket. That keeps the page clean as
  it grows.


### 3.7 Build notes (DW-3, 2026-10-13)

Written when DW-3 started, from a survey of every source on main (`5703f27b`).

**Where the Overview renders.** Each workspace's existing Overview URL renders it, so no URL moves:
- `/departments/[deptId]` for a department, and `/hr`, `/finance` and `/it`;
- the Office of the GM's page renders the company Overview (§3.5);
- for someone whose home is the Company area, `/` renders the company-level Overview;
- `/` otherwise sends a pilot user to their home workspace's Overview.

All of this is for people on the pilot switch (DW-D7). Everyone else keeps today's pages.

**How a block behaves.**
- Each widget is a server component behind its own Suspense boundary.
- A read that fails renders "unavailable" in that block alone.
- A widget whose ticket is still open is hidden (`isPlanned`), so a band can be empty or absent.

**The period.**
- `?period=` carries the period: day, week or month, defaulting to month.
- Quarter, semester and year show, disabled, until DW-4a.
- Numbers come from the reports document (`getReportDocument`), whose `header.comparison` and per-KPI `delta` give "against the previous period" in the same call.

**Only honest readers feed a number.** Many readers turn a 403, a 404 or an error into `[]` or 0. They must not feed a tile, because a denied reader would read as "nothing to do". A tile without an honest reader stays hidden, and its reason is written next to it in the registry. Two kinds qualify:
- readers built on `ReadResult` or `Guarded`, or that return `null` for "not available";
- `getReportDocument` and `getReportOverview`, where a ratio whose denominator is 0 means "no data".

**What exists, block by block:**

| Block | Built on | Gap that stays visible |
|---|---|---|
| Needs you (3c) | `getMyWorkQueue` already ranks PM tasks (`fromPmTask`) and mentions; `computeUrgency` | "See all" waits for My tasks (DW-8a); until then it links to the queue's own pages |
| Today (3c) | `getTodayCheckin`, `listMyTasks` (due today), the workspace's tool set | No calendar events exist yet (DW-8g) |
| Your numbers (3d) | person `getReportDocument`: tasks completed, on-time rate, minutes logged, check-in compliance, each with its delta | — |
| My activity (3j) | `getProductivity` (16 weeks plus today; PM work only until DW-4h) | — |
| Pulse (3e) | Web Dev: change requests (new), pipeline gates waiting, monitoring summary. Social: scheduled and failed posts. IT: account requests | SEO, Creatives and the deliverables tile have no honest reader yet. HR and Finance tiles are DW-7e |
| Projects (3f) | owned projects with `computeProjectHealth`, top 4 by risk | `listProjects` must be read through `ReadResult`, not `.catch(() => [])` |
| Campaigns, Requests (3f) | Built after DW-5: `readSharedCampaigns` (`GET campaigns?unitId=`) and `readRequestSummary` (`GET requests/summary`), both `ReadResult` readers, for the department's unit | Agency pack only. Hidden where the workspace has no org node (HR, Finance, IT). Requests links to Incoming only where the workspace has that tab |
| Learning (3g) | `getMyLearning`: assigned, due, overdue | No per-course progress, so "next course" becomes "next due" |
| Appraisal (3g) | `getMyAppraisals`: the last finalized result and the current pack's status | Staff cannot read the cycle's stage (HR-only endpoint), so it is not shown. "My next step" is derived from the status alone: only `submitted` has one (acknowledge or dispute); built in `lib/overviewGrowth.ts` |
| Me \| Team (3h) | Built (`lib/overviewTeam.ts`). `?view=team`, for a head of THIS unit only (`org_unit_lead` on it or above it); anyone else reads Me and nothing about a team. Team numbers: department `getReportDocument` (on time, blocked share, hours vs `effort.capacity_utilization`) and `getCheckinCompliance` with `rollUpCompliance`. Team needs you: `requests/summary` and the blocked tasks of the open projects. Team learning: `lms compliance?unit=` (BFF §38). Team appraisals: the head's `appraisals` list (BFF §39) | "Team learning is tenant-wide only" no longer holds: DW-4g built `compliance?unit=`. The check-in grid and the appraisal list are narrowed to everyone the head LEADS, not one department, so a head of more than this department sees that said in words, and the appraisal list also holds the head's managed rows. A cycle's name and stage need the HR-only cycle read, so only the count of cycles is shown. The condition banner stays DW-3k |
| Company Overview (3i) | Built (`lib/overviewCompany.ts`, `lib/overviewDepartments.ts`, `widgets/Company*.tsx`). The Office of the GM's page is the company Overview on the pilot, with today's cockpit under it as "More from the Office of the GM"; the Company-home `/` frame draws the same blocks the person may see. Needs you: decisions (the work queue's approvals and gates, as the cockpit's Decisions tab). Company: revenue and overdue receivables (the `GmMoneyCard` finance reads, kept honest in `overviewCompany-data.ts`), milestones hit and utilization (`getReportDocument`, grain `company`). Departments by condition: `GET dept-kpis/overview` (BFF §40), worst first, no condition last. Campaigns (key `company-campaigns`): `GET campaigns` with `partCount`. Learning compliance: `GET lms/compliance` (company-wide). Appraisal cycle: `GET appraisals` counted by stage | Every block carries the cockpit's gate (`gmAccessFor`, `canReadGmMoney`): decisions need console access, money console plus finance, figures, departments, learning and appraisals the "full" tier. A block the person may not see is not placed; a part of the Company block that is not theirs is not read. A department with no approved target says "No condition yet / No target set" (every department on live until targets are approved). "Projects on track" has no honest company reader, so the Company block says "Milestones hit". The GM's four Pulse tiles stay planned (they would repeat the Company block). The monitoring summary stays in the cockpit body |
| Condition (3k) | Built (`lib/overviewCondition.ts`, `widgets/Condition.tsx`). `getDeptKpis` (the honest reader, BFF §40.3a) for the workspace's unit and the Overview period. A head of the unit (`canSwitchToTeam`) gets the banner and a tile per KPI, in Me and Team alike, linked to `/appraisals/department`; anyone else the server admits gets a one-line strip with no tiles and no ranking; a refused read (a visitor) draws nothing, and a band left empty is hidden. Words and tiles are `deptKpiFormat`'s, the same as the KPI page (DW-3i2 folded the company block's duplicates into it) | Until a department's targets are approved every condition is "unavailable", and says why; it never reads as on track. A failed read says "Unavailable". Not built: notifications and the weekly digest (DW-4j) |

**Testing.**
- No demo login is placed in a department today: `u-dev`, `u-pm` and `u-gm` sit in the demo org tree, but no login uses them. DW-3a adds a placed demo identity, so the Overview can be driven as a real employee.
- The workspace-shell e2e (`e2e/workspace-shell.spec.ts`, run with `qa/e2e-gate.sh` on sumopod) grows with each ticket.

---

## 4. Workspaces, department by department

Every workspace has the **Overview** and **AI Assistant** rows, the **Performance block** (Reports,
Analytics, Appraisals, Learning) and a **Tools & connections** row (§4.1). These are not repeated
below. Paths are unchanged, and `*` marks a row that keeps its current gate.

| Workspace | Work rows → tabs | Pulse tiles | Quick actions |
|---|---|---|---|
| **Web Dev** | Project Management (Projects, Board, Ball, Timeline, Charts, Activity) · **Build** (PRD Studio, Pipeline\*, Repositories, Deliverables) · **Run** (Portfolio, Monitoring) · **Website** (Content, Media, Leads, Writers' room) · **Requests** (Incoming: engineering + client maintenance, Sent) · **Campaigns** (Shared) · Clients | requests waiting · sites with a problem · runs waiting approval · deliverables due | New briefing · Triage requests |
| **SEO** | Project Management · **Accounts** (Engagements, Cost Ledger, Client reports) · **Optimize** (Site Audit, Keywords, Rankings, Content Briefs, AI Visibility) · **Campaigns** (Shared, Planner, Ads Studio, Search Terms, Pacing) · Clients | ranking drops · critical audit findings · client reports waiting · budgets off pace | Run a site audit · New content brief |
| **Social Media** | Project Management · **Publish** (Calendar, Composer, Inbox) · **Campaigns** (Shared, Social campaigns) · Clients | posts scheduled · waiting client review · failed posts · unanswered inbox (once SMM-15 lands) | Compose a post · Ask Creatives for assets |
| **Creatives** | Project Management · **Requests** (Incoming asset requests, Delivered) · **Studio** (Image Studio, Asset Library) · **Campaigns** (Shared) · Clients | asset requests waiting · in review · due this week · delivered this period | Open Image Studio · Upload to library |
| **Office of the GM** | Project Management · **Command** (Business Review, Decisions) · **Oversight** (Departments, Clients & Money, People) · **Campaigns** (all) · **Clients & sales** (Clients, Leads) | the cockpit: revenue, AR, project health, utilization | Business review · Decisions |
| **HR** | **People** (Directory, Onboarding, Org structure) · **Time** (Leave, Attendance) · **Pay**\* (Compensation, Payroll) · **Talent** (Recruitment, Reviews, Appraisal cycles\*) · **Cases & compliance** | leave pending · onboarding · open cases · payroll status | Approve leave · New hire |
| **Finance** | **Ledger** (Journals, General ledger, Chart of accounts) · **Receivables** (Receivables, Invoices\*) · Payables · **Treasury & assets** · Tax · **Close** (Period close, Consolidation, Ownership, Cutover) | client payments to confirm · overdue receivables · close progress · integrity findings | Confirm payments · Record a journal |
| **IT** | Devices · **Network** (Topology, Traffic, Threats, Isolation, Occupancy) · IT accounts\* · Workflows | devices offline · threat alerts · account requests · failing workflows | Register a device |
| **Generic** (any other department, any vertical) | Project Management | active projects · due soon · blocked | New task |

**What moves compared with today:**
- **Analytics tabs move into each department's Analytics row:** Website › Analytics, Publish ›
  Analytics, SEO's Search Console & GA4, HR's Analytics, and Project Management's Charts.
- **SEO's Accounts › "Reports" is renamed "Client reports"**, so it is never confused with the
  department's Reports row. The route is unchanged.
- **Finance's own "Reports" tab** (the financial statements) becomes a tab of the Finance Reports
  row.
- **Requests and Campaigns are new rows** (§7).

### 4.1 Tools & connections, per department (DW-D16)

Each department has its own set. The row opens one page with two sections:

- **Tools.** One-click launchers for the apps this department works in, with your own seat shown
  where the tool has seats (Claude). This is today's `launchers` list, now with a home of its own.
  You can pin up to 6 tools to the Overview's Today card.
- **Connections.** The accounts this department's work is linked to: GitHub organisations, Google
  Drive, Search Console and GA4 properties, social accounts, Claude seats. Everyone sees whether
  each is connected. Managers connect and disconnect them, with the gates unchanged
  (`company.manage`, `search.manage`). This is today's Connections page.

| Department | Tools | Connections |
|---|---|---|
| Web Dev | Claude Code, Claude, Claude Design, GitHub, Figma, VS Code | GitHub, **Figma**, Google Drive, Claude seats |
| SEO | Search Console, Analytics (GA4), Google Ads, Looker Studio, Claude | Google accounts (Search Console, GA4, Ads), Google Drive, Claude seats |
| Social Media | Claude, Claude Design, Shared Drive | social accounts, Google Drive, Claude seats |
| Creatives | Figma, Photopea, Claude Design, Shared Drive | **Figma**, Google Drive, Claude seats |
| Office of the GM | Claude, Shared Drive, Looker Studio | Google Drive, Claude seats |
| HR | Shared Drive, Claude | Google Drive, Claude seats |
| Finance | bank portal, Shared Drive, Claude | bank feeds (when built), Google Drive, Claude seats |
| IT | UniFi, Google Admin, n8n | network controller, Google Workspace admin |
| Generic | none until the department asks | Google Drive |

**Where the sets live.**
- The sets live in the workspace registry, keyed by (vertical, department slug). Nothing is
  hard-wired to Gaiada.
- Adding a tool to a department is a registry edit and nothing more.
- The rows for HR, Finance, IT and generic are new sets. The owner ruled them as proposed (DW-Q5);
  they stay adjustable in the registry.

**Figma, connected (DW-Q6, owner ruling: "use Figma too").**
- **Linking.** A Figma file or frame can be linked to a task, a request or a campaign part.
- **What the ERP shows.** It shows the frame's thumbnail, the file's last change and its open
  comments, read through the Figma API under the department's connection.
- **Exports.** Exports (PNG, SVG, PDF) go straight into the Asset Library, versioned against the
  request. Delivery and review therefore happen in the ERP even when the design happens in Figma.
- **Editing still opens Figma.** A design tool cannot run inside the ERP.
- **The exit.** Every delivered design exists as an exported file in the Asset Library, so nothing is
  lost if Figma goes. That keeps the vendor doctrine's point (§2.6, amended for this ruling).

### 4.2 Build notes (DW-6, 2026-10-13)

Written when DW-6 started, from a survey of main (`2e222711`). Pilot users only, like DW-2.

**Most of the regrouping is already built.**
- The registry (DW-1a) holds every row of §4 for Web Dev, SEO, Social Media, Creatives and the
  Office of the GM. The pilot shell (DW-2) draws them. That includes Pipeline and Monitoring in Web
  Dev (its owned routes) and SEO's "Client reports" label.
- The generic workspace already draws the full skeleton: Overview, AI Assistant, Project
  Management, Tools & connections, the Performance block and You.
- So 6a, 6b and 6e are proofs, not builds. What is left:
  - SEO's client-reports page and the classic toolkit still say "Reports". They follow the
    registry.
  - A browser test walks each agency workspace and a generic department, and checks the rows and
    tabs against §4.
- Tabs that carry another phase's ticket stay hidden until it lands: Campaigns (DW-5b), Requests
  (DW-5c, DW-5d) and the new analytics tabs (DW-4c). The Clients row is counted under 6d. 6a and 6b
  tick when everything else in their rows renders and is proven.

**What each ticket builds on, and what it adds:**

- **6c · Tools & connections.**
  - *Builds on:* the Connections page `/departments/[deptId]/connections`. It already shows your
    own GitHub, Drive and Claude seat, the organisation's GitHub App, the team grid (for
    `company.manage`) and SEO's Google accounts. It also builds on the department Home's launcher
    row, which already shows your seat on the Claude tools.
  - *Adds:* one page with two sections drawn from the registry:
    - **Tools:** the workspace's `tools`, each with your seat where it has one.
    - **Connections:** the workspace's `connections` kinds. A kind with a ticket is hidden
      (Figma until 6k; bank feeds and the IT consoles until DW-7e).
  - *Adds:* pins. You pin up to 6 tools per workspace. The Overview's Today block (DW-3c) shows
    the pinned tools, or the first six when none are pinned. The classic Home keeps its launcher
    row.
  - *Gap:* pins live in the `gaiada_prefs` cookie, so they belong to the browser, not the account.
    No server-side preference store exists.
- **6c2 · Launch with context.**
  - *Adds:* an "Open in" menu on the task, project and client pages. It lists the workspace's
    tools, each with a context link where one exists: the project's linked GitHub repository, the
    client's Search Console property and GA4, Figma after 6k and Drive after 6i.
  - *Return paths:* pull requests on the task (6f), the Asset Library upload (exists), and Figma
    exports (6k).
  - *Gap:* a tool with no context link opens its home page.
- **6d · Clients row.**
  - *Builds on:* `projects.department_id`, an org-node id with no FK, is the only department link a
    client has. The `clients` table has no department column, and `GET /clients` takes no filter.
  - *Adds:* contract §33, then `GET /clients?departmentId=`. It returns the clients that have a live
    project owned by that department or any unit under it (`org_unit_closure`, which includes the
    node itself and is keyed by tenant). The filter narrows the list for display; it is not a
    boundary, and authorisation stays `client read`. The row's page is
    `/departments/[deptId]/clients`.
  - *Gap:* a client served only through an engagement or a site, with no project, is not listed,
    and the page says so.
- **6g · Web Dev Deliverables.**
  - *Builds on:* `deliverables`: `project_id` is not null, with status and due date, and files
    attach to it. It also builds on `GET /deliverables?projectId=&clientId=`. Today's tab is a
    placeholder that reads nothing.
  - *Adds:* `?departmentId=` on the same join (contract §33), and a tab that lists the department's
    deliverables with project, client, status and due date.
  - *Gap:* produced artefacts that are not deliverable rows, such as PRDs and site builds, stay on
    their own tabs.
- **6f · Pull requests and CI on tasks.**
  - *Builds on:* the GitHub App webhooks already receive `pull_request` and `workflow_run` and
    write `work_activity`. Tasks have `seq` and projects have `short_code`, so a task key like
    `ABC-12` already exists. Nothing parses it, and no PR is stored.
  - *Adds:* contract §34, then:
    - a `github_pull_requests` table, filled by the existing handlers;
    - the task key in the branch name or the PR title, which links a PR to its task;
    - a read on the task, and the task page's Pull requests panel with CI status.
  - *Trap, and how §34 avoids it:* GitHub data lives under the organisation's tenant, which may not
    be the task's.
    - v1 links a pull request only to a task in that same company, which is where Web Dev's
      projects live. The table, the link and the read then stay in one tenant, and the read is
      authorised exactly like the task.
    - A task in another company is never linked (contract §34.2). Linking across group companies
      needs the organisation-tenant resolver (`github-tenant-scope-ruling.md`) and is later work.
  - *Gap:* a PR with no task key in its branch or title is on no task. It stays visible on the
    repository.
- **6h · Asset versions and review rounds.**
  - *Builds on:* `creative_assets` has `department_id`, but no versions and no review. It
    authorises as the generic `file` kind, and its list ignores the department.
  - *Adds:* contract §35, then:
    - version groups and review rounds on assets;
    - a Cerbos kind of its own, so review can be granted separately;
    - the department filter on the list.
  - *Reuses:* the generic comments for threads, and the social review's content hash, which proves
    which version a reviewer saw.
  - *Gap:* not to be confused with `agency_creative_assets`, which is campaign-bound and has its
    own review. 6h targets the Asset Library's `creative_assets`.
- **6k · Figma.**
  - *Builds on:* the credential vault (`integration_connections`) and reference attachments
    (`files.url`). No Figma code exists.
  - *Adds:* contract §36, then:
    - a `figma` provider;
    - `figma_links` on PM tasks, requests (`work_requests.id`, §32) and campaign parts
      (`agency_campaign_parts.id`, §31), the ids DW-5 defines;
    - a server-side read for the thumbnail, last change and open comments. Thumbnails are signed
      and short-lived, so they are proxied, never stored.
    - exports into the Asset Library as versions, which needs 6h.
  - *Gap:* the live proof waits for Figma API access (DW-11).
- **6i · Google Drive.**
  - *Builds on:* `google_drive` is a provider in the vault and in the Google OAuth registry. No
    Drive surface is registered, and no Drive client exists.
  - *Adds:* a Drive surface with the `drive.file` scope and the Google Picker. You pick a file, and
    it attaches as a reference.
  - *Note:* `drive.file` reaches only the files a person picks, which keeps clear of the restricted
    Drive scopes and their verification. Check this against Google's current scope list when the
    ticket starts.
  - *Waits for:* the Drive OAuth client (DW-11).
- **6j:** owned by the SEO and SMM trackers, and ticked here when they land.

**Order, one agent at a time:**
1. 6a + 6b + 6e: the label and the browser test (Sonnet).
2. 6c (Sonnet).
3. Contract §33 (orchestrator), then the 6d + 6g backend (Sonnet), then their screens (Sonnet).
4. Contract §34 (written), then the 6f backend (Sonnet: v1 stays in one tenant, so no read
   crosses tenants), then the panel (Sonnet).
5. Contract §35, then the 6h backend (Sonnet: a migration and a Cerbos kind), then the screens.
6. 6c2 (Sonnet).
7. Contract §36, then 6k after 6h. It goes live after DW-11.
8. 6i, after DW-11.

**Defaults taken, which the owner may overrule:**
- A department's clients come from its projects, in the same company only. Clients it serves for
  another group company through a service assignment are not shown, as in DW-5's v1 (§32.8).
- The Deliverables tab lists the `deliverables` rows of the department's projects.
- Pins belong to the browser.
- Asset review is internal in v1. Clients review posts through the social flow.

**Shared files.**
- `lib/workspaces.ts` is edited by DW-3, DW-4 and DW-5 as well. DW-6 edits only these parts:
  - `CONN`, `CLIENTS_ROW` and `TOOLS_ROW`;
  - the `tools` and `connections` arrays;
  - the generic workspace;
  - Web Dev's Build row.
- DW-3c's Today block reads the tools. 6c changes only which tools reach it.
- DW-6's browser test is its own file, `e2e/workspace-departments.spec.ts`. That keeps it out of
  the shell spec, which DW-3 is growing.
- In the BFF contract, DW-6 takes §33 to §36. DW-5 holds §31 and §32.

**Testing.**
- UI and backend suites run on GitHub Actions CI. Backend HTTP and DB suites run with Postgres and
  Cerbos.
- The browser test runs on sumopod with `platform-ui/qa/e2e-gate.sh`, one gate at a time.

---

## 5. Performance, inside every department

All four rows are in every workspace, with the same tabs everywhere, so a person learns them once.

### 5.1 Reports

- **Periods.** Daily, Weekly, Monthly, Quarterly, Semester and Yearly are the tabs. The selected period
  matches the Overview's selector.
  - **Only day, week and month exist today** (`resolveCalendarRange`, `ReportPeriodKind`).
  - Quarter, semester and year are added in the backend first (DW-4a): the range resolver, fact
    aggregation and the document builder. The contract is written first.
  - Calendar periods are the default: Q1 is January–March, and Semester 1 is January–June (DW-Q3).
- **Scope.**
  - Mine: everyone.
  - Team: heads.
  - Department: heads, and anyone the server allows.
- **Contents.**
  - The period's numbers against the previous period.
  - What was delivered.
  - Highlights and blockers from check-ins.
  - Hours.
- **Sharing.** Print or share, as the report pages do today.
- **Other reports stay where they are.**
  - Project reports stay on the project page.
  - Client reports stay in SEO's Accounts.
  - The company report is in the Office of the GM.

### 5.2 Analytics

**How Analytics differs from Reports.** A report answers "what happened in this period" and can be
shared and signed off. Analytics are live charts for exploring trends. Each page says this in one
line.

**Tabs.** Every workspace has a **Work** tab: flow, burndown and productivity from PM. Each department
then adds its own existing analytics pages, gathered here in one place:

| Department | Its own analytics tabs |
|---|---|
| Web Dev | Website (site health stays in Run › Portfolio and Monitoring, DW-4c) |
| SEO | Search Console & GA4 (the rankings trend is on Optimize › Rankings, one page in one row, DW-4c) |
| Social Media | Reach and engagement |
| HR | People analytics |
| Finance | Revenue, AR and cash (no page yet; built with the Finance workspace, DW-7b) |

### 5.3 Appraisals

| Tab | For | What | Exists? |
|---|---|---|---|
| **Mine** | everyone | my appraisal this cycle: self-review, scores, history | yes (`/appraisals/mine`) |
| **Team** | heads (`appraisal.score`) | score my people; who is written, scored and signed | yes (`/appraisals`) |
| **Department** | heads, the GM, HR | **the department's own appraisal for the cycle**: its KPIs against their targets, its condition and standing (§5.5), plus how its people's appraisals went (completion, distribution) | **new** (DW-4e, DW-Q4 ruled) |

- HR keeps **cycle administration** under HR › Talent.
- The tracker blueprint's rule stands: an appraisal is blended and manager-weighted, and utilization
  is never an appraisal signal.

### 5.4 Learning

| Tab | For | What | Exists? |
|---|---|---|---|
| **My learning** | everyone | assigned and mandatory training, progress, certificates | yes (`/me/learning`) |
| **Department courses** | everyone | this department's curriculum and paths | catalogue yes; department filter new |
| **Add material** | heads | create, edit, publish and assign courses or paths for this department | page exists (`/learning/authoring`); **HODs lack the right today** (DW-D15) |
| **Team progress** | heads | who completed what, and what is overdue | page exists (`/learning/compliance`), unit-scoped |

**Why an HOD cannot add material today.** Heads hold `manager`, which has no `lms.*` rights, and the
sidebar asks for authoring at company scope.

**The fix (DW-D15, DW-4g):**
- A head gets `org_unit_lead` on their own department, derived from their lead position.
- That role already carries authoring, publishing, assigning, grading, progress and department-report
  rights, all limited to the head's unit.
- It deliberately cannot waive mandatory training.
- The UI gains a unit-aware check, so a head sees "Add material" and "Team progress".

### 5.5 Department KPIs, condition and standing (DW-Q4, owner ruling)

**The owner's ruling.** Each department has **its own KPIs and its own appraisal**. They are
highlighted so everyone sees the department's condition and standing, and the HOD is always aware of
it.

**What a department KPI is.**
- It is a named measure with a target per period:
  - "projects delivered on time ≥ 85% per month";
  - "asset requests delivered within 2 working days ≥ 90%".
- The definitions live in the workspace registry, keyed by (vertical, department slug), so a new
  department or company gets a sensible starting set.
- The targets are data, set per company and per period.

**Where the numbers come from.** Existing facts first:
- The reports module already computes department-grain metrics (`delivery.on_time_rate`,
  `delivery.tasks_completed`, `discipline.overdue_open`, `effort.minutes_logged`, `flow.reopen_rate`
  in `PN/modules/reports/fact-job.ts`).
- The module reads add the rest: requests, campaigns, site uptime, payroll on time, close on time.
- SEO's and Social's existing **client** KPI targets (`search_kpi_targets`, `social_kpi_targets`) stay
  per client. They are inputs, not department KPIs.

**Starting sets** (the HOD and the GM adjust them):

| Department | KPIs |
|---|---|
| Web Dev | projects on time · requests answered within the SLA · client site uptime · reopened work rate |
| SEO | clients with ranking growth · client reports delivered on time · ad budgets on pace · client retention |
| Social Media | posts published on schedule · client approval turnaround · engagement growth across clients |
| Creatives | asset requests delivered on time · revision rounds per asset · assets delivered |
| HR | leave decided within 2 days · payroll published on time · time to hire · mandatory learning complete |
| Finance | period closed on time · overdue receivables share · client payments confirmed within 1 day |
| IT | device and network uptime · account and device requests resolved within the SLA · open threat alerts |
| Office of the GM | revenue against plan · margin · utilization · departments in good condition |
| Generic | projects on time · overdue tasks · check-in compliance |

**Who sets the targets.** The HOD proposes a period's targets and the GM approves them. Until a
target is approved, last period's target stays in force. The KPI shows "no target" rather than
inventing one.

**Condition.** Each KPI, and the department as a whole, is in one of three conditions:
- **on track**: every KPI is at or above target;
- **at risk**: a KPI is below target but within its tolerance, or trending to miss;
- **off track**: a KPI has missed its tolerance, or two KPIs are at risk.

The thresholds are set per KPI. A KPI with no data says "unavailable", never a condition.

**Standing.** Two things show where the department stands:
- the department against its own targets, and against its last periods;
- for the GM and HR only, all departments side by side.

Departments are never ranked to their own staff. The comparison is a management view, not a league
table.

**How the HOD is made aware.** The HOD can't miss it:
1. **The Overview.** On the HOD's Overview, the department band opens with a **condition banner**:
   "Web Dev: at risk · projects on time 79% against 85%". Each KPI is a tile with its own condition
   colour.
2. **Notifications.** When any KPI changes condition (on track → at risk → off track, or back), the
   HOD gets an Inbox notification, and an approval-style item in Needs you when a KPI goes off track.
3. **A weekly digest.** It goes to the HOD's Inbox: each KPI, its trend and the top contributors to
   any miss.

**Everyone else.**
- Staff see the department's condition on their Overview, as a quiet strip.
- The GM's company Overview lists the departments by condition, and the worst comes first.

**The department appraisal.** The cycle's department appraisal is these KPIs over the appraisal period:
- the result against each target;
- the condition history;
- the HOD's commentary;
- the GM's assessment.

The Appraisals › Department tab shows it next to how the people's appraisals went.

**What it is not.**
- It is not a person's score.
- A person's appraisal stays blended and manager-weighted.
- A department KPI is never pinned on one person automatically. The "top contributors to a miss"
  list is for the HOD's understanding, not a judgement.

### 5.6 Build notes (DW-4, 2026-10-13)

Written when DW-4 started, from a survey of every source on main (`ad42d529`).

**Order, one agent at a time:** 4a → 4b → 4f → 4g → 4d → 4c → 4e → 4j → 4h → 4i, with 4k (export) whenever a window is free. 4a is live in `v1.0.0-alpha.374`.
- 4a's contract carries the judgement, so Sonnet builds it and Opus reviews.
- 4g (access) and 4e (KPIs) are the Opus tickets, in separate windows.
- 4e and 4h write their contracts first. DW-3k and DW-3i's "by condition" wait for 4e.

**4a, the contract.** It is written into the reporting blueprint
(`docs/blueprints/tracker-reporting-foundation.md` §15, the DW-4a entry). In short:
- Quarter, semester and year are calendar kinds like month. Calendar quarters and semesters (DW-Q3).
- Labels read `Q3 2026`, `Semester 2 2026` and `Year 2026`.
- The comparison is the preceding period of the same kind.
- One resolver serves reports, periods and check-ins.
- They can be sealed, but appraisals still freeze from sealed months only.
- No new schedule.
- `REPORT_PERIODS` drops its tickets in the same change, so no page offers a kind the server refuses.

**What exists, ticket by ticket:**

| Ticket | Built on | Gap |
|---|---|---|
| 4b Reports | `/reports/person` and `/reports/department` read `getReportDocument` and `getReportOverview` with `?periodKind&start&end&scopeRef`. TR-25's person-scope rule narrows a head to their led subtree (`person-scope.ts`, `assertPersonInLedScope`). The person-grain overview is already narrowed the same way | `/reports/team` does not exist, and there is no team grain. The overview lists only people with facts in the range, so a quiet member would drop off. Contract first: BFF §37 adds `unit` to the person-grain overview, returning the unit's whole roster with `activity`. The Team tab opens `/reports/team?unit={dept}`. The report selector gains the three new periods. No report page offers print or export today, although the backend export exists; that is DW-4k |
| 4f Learning | All four pages exist. `GET lms/courses` already takes `unitNodeId` | The catalogue page has no department filter. "Department courses" passes the workspace's unit node |
| 4g Access | `org_unit_lead` exists: the derived role (`cerbos/policies/derived_roles.yaml`), seeded in `0102`, with the UI bundle in `lib/rbac.ts`. A lead position's role set already carries it at `own_unit` (`seed/positions.ts`), and the position reconciler turns that into the grant; `lms-l1-acceptance.test.ts` already proves a head authors only for their own department. It has no waive right (only HR and the admin tier hold `lms.waive`) | Traced 2026-10-13. The gap is not the grant but the reads and pages: `GET lms/compliance` passes no unit to Cerbos and aggregates company-wide, and the Learning pages gate on company-wide `can()`, so a head is refused behind the tabs they are shown. Contract first: BFF §38 adds `?unit=` to compliance and opens the two pages through `canInUnit`. Prove a head cannot waive. Check which live heads hold the grant through a lead position (data, fixed in Positions) |
| 4d Appraisals | Mine and Team exist and are in the registry. The single read (`GET /appraisals/:id`) already passes `unitAncestors` to Cerbos | Traced 2026-10-13: `GET /appraisals` shows a head only the rows they manage personally (a division lead's reports are invisible to the department head), and refuses an `org_unit_lead`-only caller while the Team tab admits them. Contract first: BFF §39, the head's list is their led subtree's appraisals plus their manager rows, narrowed on the server; the page opens through `leadsAnyUnitWith` |
| 4c Analytics | Work is `/departments/{d}/charts`. Each department's own analytics pages exist: `website/analytics`, `rankings`, `gsc-ga4`, Social's `analytics`, `/hr/analytics` and `/finance/reports`. DW-1a already moved `website/analytics`, `gsc-ga4` and Social's `analytics` out of the Work rows | Three registry hrefs point at pages that do not exist: `analytics/sites`, `analytics/rankings` and `/finance/analytics`. URLs never move, so 4c points those tabs at existing pages. SEO's `rankings` is the one page in two rows (Optimize › Rankings and Analytics); 4c keeps one. One page, one row. DW-6's `e2e/workspace-departments.spec.ts` pins the Work rows, so 4c updates it in the same change |
| 4e KPIs | The registry's `DeptKpi` labels per workspace. The department-grain metrics in `metrics.ts`: on-time rate, tasks completed, milestone hit rate, reopen rate, overdue open, check-in compliance, minutes logged | Contract first: BFF §40 (2026-10-14). 4e-1 is the engine: a server-side catalogue (parity-tested with the registry), `dept_kpi_targets` (the head proposes, the approver approves, the latest approved target stays in force), a new Cerbos kind `dept_kpi_target`, the condition rules, the unit read and the GM's overview. Only report-fact KPIs have a reader at first (projects on time, reopened work, overdue tasks, check-in compliance, utilization, departments in good condition); every other KPI reads unavailable until its module read lands. 4e-2 is the UI, 4e-3 the department appraisal. Open owner decision: who approves besides the `company_admin` tier |
| 4j Awareness | `notify()` (`core/http.ts`) writes the Inbox row and taps mail | Detecting a condition change needs a periodic evaluation. The reports house rule is that n8n schedules and the platform exposes an endpoint (blueprint §10), so the 4e contract names the endpoint and 4j adds the flow |
| 4h Activity | `work_activity` (`0030`), fed from pm, pipeline, github, google_drive, claude, manual and system. `GET /pm/productivity` builds the daily map from it plus PM tables | Most modules emit nothing yet (WebDesk, Social, SEO, Creatives, Finance, HR, meetings, learning, check-ins). The contract names each event and its source |
| 4i My activity | The map renders at `/project-management?view=productivity`. Its visibility rule is `assertProductivityReadAllowed` (self, the company-wide tiers and the led subtree) | Moving it to Analytics › My activity needs a page with an `AREA_RULES` entry. The visibility rule is unchanged (DW-D19) |
| 4k Export | `POST /reports/export` (PDF via the report-renderer sidecar, XLSX, CSV) and the job download exist (TR-18); the print surface is `app/print/reports/[jobToken]` | No report page offers print or export. 4k adds one Export control to the report viewer (format, job, download), carrying the `AD HOC · UNSEALED` mark the backend already prints |

---

## 6. The AI Assistant, and what "Intelligence" was for

"Intelligence" grouped four AI surfaces:

| Today | What it is for |
|---|---|
| **Assistant** | A chat with an AI that can look things up in the ERP and, with approval, act for you |
| **Knowledge** | The library of company documents (SOPs, briefs, policies) that the AI reads and people search |
| **AI Agents** | AI workers that run jobs on their own (draft a report, triage requests), each with a goal and a run history. Anything risky waits for a person's approval |
| **The Office** | A visual "virtual office" showing who, people and AI agents, is working on what |

**What this plan does (DW-D9, DW-D17).** Every workspace gets one **AI Assistant** row.

- The row opens **the assistant page we have today, made better**. It keeps today's engine, threads,
  streaming, proposals, memory, model picker and routing. It is usable from day one.
- Today's page is `/assistant` plus the drawer. It already has:
  - a thread rail;
  - streaming replies;
  - tool-call and citation chips;
  - write proposals;
  - memory, roster and capabilities panels;
  - a page-context chip;
  - empty-state suggestions;
  - a brain picker.

**"Better" means the page and how it is used, not the AI behind it:**

1. **A calm layout.** The conversation gets the full width. Memory, Roster and Capabilities fold into
   one **Details** panel that opens on demand, instead of three panels always beside the chat.
2. **Threads you can find.** The thread rail gains search and pinned threads, as in the owner's Aira
   chat (aivory `components/sidebar/`). Threads are grouped Today, This week and Older.
3. **It knows where you are.**
   - The page-context chip shows the department and page you came from.
   - The empty state suggests prompts for that department, for example "Summarise this week's
     requests" in Web Dev or "Which keywords dropped?" in SEO.
   - These are suggestions only. They send nothing different to the model.
4. **Drawer and page are one conversation.** Opening the row from any page shows the drawer.
   "Expand" moves the same thread to the full page, and closing returns you to where you were.
5. **One look.** The assistant uses the same tokens, header and spacing as the rest of the new
   shell, light and dark, desktop and phone.

**What stays out of this plan.** Knowledge, AI Agents and The Office move to the Company area for now.
A **separate AI plan** decides:
- **Model use:** routing, which model answers what, and model choice.
- **Department context:** the assistant using department context as real context, and agents and
  knowledge per department.
- **Usage and cost:** AI usage, seats and costs per department and person.

The brain picker stays exactly as it is until that plan changes it. That plan is its own document; it
is listed on the board as a Record item, not as a phase here.

---

## 7. Working together: campaigns and requests

### 7.1 Campaigns are multi-department (DW-D13)

```
                   ┌──────────────────────────────────┐
                   │ Campaign: Tirta Spa launch        │  one campaign, owned by the GM
                   │ client · budget · dates · status  │  or the lead department
                   └──────────────┬───────────────────┘
        ┌──────────────┬──────────┴───────┬───────────────────┐
   ┌────▼─────┐  ┌─────▼──────┐  ┌────────▼───────┐  ┌────────▼────────┐
   │ SEO part │  │ Social part│  │ Creatives part │  │ Web Dev part    │
   │ its own  │  │ its own    │  │ asset requests │  │ engineering     │
   │ SEO      │  │ social     │  │ → Asset Library│  │ requests →      │
   │ campaign │  │ campaign   │  │                │  │ landing page    │
   └──────────┘  └────────────┘  └────────────────┘  └─────────────────┘
```

- **A shared campaign gains parts.** Today's `/agency` campaign (`agency_campaigns`) gets a list of
  the departments that take part. Each part has an owner, a status, and the work linked to it: the
  SEO campaign, the Social campaign, asset requests or engineering requests. This needs a new table
  and a contract (DW-5a).
- **SEO's and Social Media's own campaigns stay their own.**
  - SEO's campaigns already exist.
  - Social Media's API exists and gets its screen (DW-5b).
  - Each campaign can stand alone or be linked to a shared campaign as that department's part.
- **Every department's Campaigns row** shows:
  - **Shared:** the campaigns we have a part in, with our part's status.
  - **Our own:** in SEO and Social Media, their own campaigns.
- **The Office of the GM** sees every campaign.

### 7.2 Requests between departments (DW-D14)

- **Creatives supplies the assets.**
  - Any workspace can "Ask Creatives for assets".
  - The request lands in Creatives › Requests › Incoming.
  - The delivered asset goes into the Asset Library and links back to the request and the campaign.
- **Web Dev handles anything that needs a software engineer.**
  - Any workspace can "Ask Web Dev".
  - The request lands in Web Dev › Requests, beside client maintenance. It uses today's MI intake with
    an "internal" source.
- **Recommended build.** A request is a PM task routed to the receiving department, with a request
  form and a "requested by" department. It appears in the receiver's board and in the assignee's
  Needs you, so there is no second queue.
- **The requester tracks it.** The request shows under their Sent tab with its status.

### 7.3 DW-5 build notes (2026-10-13)

The backend contracts come first. They are in `docs/FRONTEND-BFF-CONTRACT.md`: **§31, Campaign parts** (DW-5a) and **§32, Requests between departments** (DW-5c). Pilot users only, as for DW-2 and DW-3. Nothing below changes the classic layout.

**Choices the contracts make.** Each is recommended and can be overturned by the owner:
- **A part's money is an allocation from the campaign budget, never its own currency.** The server refuses allocations that add up to more than the budget, and it does the sums. Actual spend is not rolled up: each department's own campaign keeps its own budget (§31.3).
- **A part's owner and its department's head may change its status and brief, but never its money.** Adding or removing departments and allocating money stay with managers (§31.2).
- **Any staff member may send a request; viewers and bots may not.** The receiver's assignee delivers, the receiving head or a manager declines, and the requester may cancel while the request is open (§32.2).
- **The work stays where each receiver already works.** An asset request is a PM task owned by Creatives, in a "Creatives · Requests" project made on the first request. An engineering request is a Web Dev change request with the `internal` source, triaged as today. One thin `work_requests` row carries the ask and its open, delivered, declined or cancelled state. Progress is read live from the work item (§32).
- **Same company only in v1.** A group company with no Creatives of its own cannot yet ask another company's Creatives (§32.8).
- **Every agency workspace gets Requests › Sent,** not only Web Dev: §7.2 says the requester tracks their request there. `/requests` lists a person's own requests, for people with no department. `/requests/new` and `/requests/[id]` are record pages (area `shared`, which keeps the area you came from, §2.3).

**What already exists.**
- **DW-5g is mostly built by PV-4.** The client page has a Conversation section with "awaiting our reply" first (PV4-09), and the client hub counts conversations awaiting a reply. What is left is a Needs-you source for threads awaiting a reply from me. It needs a "mine" filter on `GET conversation` and a queue item, and it lands after DW-3c, which owns Needs you.
- **The Overview's Campaigns and Requests blocks belong to DW-3f.** They read `GET campaigns?unitId=` and `GET requests/summary`, both honest readers.

**Order, one agent at a time:**
1. 5a backend, including the new Cerbos kind.
2. 5c backend, including its kind and the change-request sync.
3. 5b: the Campaigns row, the campaign page's parts and the Social campaigns screen.
4. 5c UI: the request form, the request page and Sent.
5. 5d: Creatives › Requests and delivery from the Asset Library.
6. 5e: Web Dev's Incoming shows internal requests and where they came from.
7. 5f: the two quick actions, shown only where the receiving department exists.
8. 5g: after DW-3c.

**Tiers.** The contracts carry the design judgement, so the backends are Sonnet (senior-be, high effort) with an Opus review. The UI tickets are Sonnet, and 5f is Haiku.

---

## 8. The You block

- **My tasks.** A personal task list across projects, on the existing `/api/tasks/mine` reader. This
  is new, because `/pm` has no "my tasks" scope.
- **Inbox.** It lives at `/me/inbox`. The bell pops over it, and `/notifications` redirects there.
- **Calendar.** It gains a Meetings tab, which is `/meetings`.
- **Me.** Personal admin only: Summary, Leave, Loans, Pay, Timesheet and Account.
  - My learning, appraisals and report now live in the department's Performance block, under
    "Mine".
  - The `/me` door cards that repeated the tabs are removed.

---

## 9. Company and Admin

### 9.1 Admin

Admin holds Settings, Group and Platform, each with its gate unchanged.

### 9.2 Company

One door to the things people need only occasionally:

- Departments (the directory)
- People
- Organization\* (Overview, Positions, Access)
- Projects (all: `/pm`, `/project-management`, `/deliverables`)
- Clients (all)
- Campaigns (all shared)
- Knowledge
- AI Agents
- Learning catalogue
- The Office

Each row keeps its gate. A generic-pack company has no Clients or Campaigns row.

---

## 10. Where every current sidebar row goes

| Today (group › row) | New home |
|---|---|
| Me › Overview, Leave, Loans | Me (Summary, Leave, Loans, Pay, Timesheet, Account) |
| Me › Inbox | Inbox (You) |
| Me › Learning | Department › Learning › My learning |
| Workspace › Dashboard `/` | Your department's **Overview** (`/` resolves there, DW-D1) |
| Workspace › Project Management `/pm` | Company › Projects, and your department's Project Management |
| Workspace › Calendar, Approvals | Calendar (You); Approvals (You, when you decide approvals) |
| Organization › Overview, Positions, Access | Company › Organization |
| Departments › every department | The switcher, and Company › Departments |
| Business › Project Management, Deliverables | Company › Projects; Web Dev › Build › Deliverables |
| Business › Clients | Each delivery department › Clients (theirs); Company › Clients (all) |
| Business › Timesheets | Me › Timesheet; Reports › Team (heads) |
| Business › Invoices | Finance › Receivables › Invoices |
| Business › Agency | Campaigns › Shared in each department; Office of the GM › Campaigns; Company › Campaigns |
| Business › Meetings | Calendar › Meetings |
| Business › Delivery Pipeline, Monitoring | Web Dev › Build › Pipeline; Web Dev › Run › Monitoring |
| Reports › My, Project, Department | Department › Reports (Mine, Department); the project page |
| Appraisals › Mine, Team, Cycles | Department › Appraisals (Mine, Team); HR › Talent › Appraisal cycles |
| Learning › Overview, Catalogue, Authoring, Compliance | Department › Learning (My learning, Department courses, Add material, Team progress); Company › Learning catalogue |
| Intelligence › Assistant | AI Assistant row in every workspace |
| Intelligence › Knowledge, AI Agents, The Office | Company › Knowledge, AI Agents, The Office (until the separate AI plan decides) |
| Department consoles › Connections tab, and the Overview's "Build tools" card | Tools & connections row in every workspace |
| Group, Platform, Settings | Admin (gates unchanged) |

---

## 11. Decisions

### 11.1 Ruled by the owner on 2026-10-13 (review of revision 1)

| ID | Ruling |
|---|---|
| DW-D9 | The AI Assistant has a row in every workspace's sidebar |
| DW-D10 | Reports (daily, weekly, monthly, quarterly, semester, yearly), Analytics, Appraisals (department and individual) and Learning stay inside every department |
| DW-D11 | Heads of department can add new learning material |
| DW-D12 | The Overview is the most important page: the individual's all-seeing dashboard, clean, professional and not confusing |
| DW-D13 | Campaigns are multi-department; Social Media and SEO also run their own campaigns (closes DW-Q1) |
| DW-D14 | Creatives supplies the assets; Web Dev handles anything that needs a software engineer |
| DW-D16 | Each department has its own set of tools and connections (for example Figma, Claude Code, VS Code) |
| DW-D17 | The AI Assistant page is today's assistant made better, usable now. Routing and model usage are planned in a separate AI plan, so they do not bloat this one |
| DW-D18 | ERP first: staff work in the ERP all the time. Another app is opened only when the job is impossible in the ERP, or the vendor gives no usable API or MCP (for example a paywall), and its result comes back into the ERP (§14) |

### 11.2 Ruled by the owner on 2026-10-13: "all the decisions follow the recommendation"

| ID | Ruling | Supersedes |
|---|---|---|
| **DW-D1** | An employee lands on their department's Overview. Owners with no department land on the Office of the GM | 2026-07-22 "everyone lands on the Dashboard" |
| **DW-D2** | The sidebar shows one workspace at a time. Every department sits in the switcher and in Company › Departments | GM-01/OQ-4's Departments group (its "never hide a department" rule is kept) |
| **DW-D3** | Business, Organization and the rest of Intelligence leave the sidebar; each row gets one home (§10). Reports, Appraisals, Learning and Analytics stay, inside the department (DW-D10) | the 2026-08-07 sidebar map |
| **DW-D4** | The My-work rail goes. "Needs you" lives on the Overview | WS-UX / dept-console-design decision #10 (persistent rail) |
| **DW-D5** | The floating Assistant button retires. One search box; the theme toggle moves to the avatar menu | |
| **DW-D6** | HR, IT and Finance become real departments in each company's org tree | |
| **DW-D7** | A per-person pilot switch for one week, then on for everyone. The old layout is removed two releases later | |
| **DW-D8** | Heads get a Me / Team switch on the Overview, and Team tabs in Reports, Appraisals and Learning | |
| **DW-D15** *(access change)* | Heads get `org_unit_lead` on their own department, derived from their lead position. It lets them add learning (DW-D11), read the department report and read appraisals, for their own unit only. It cannot waive mandatory training | heads hold only `manager` today |
| **DW-D19** *(people decision)* | Keep today's rule on who sees a person's activity map: self, their head (subtree), HR and company-wide tiers; colleagues never. **No single score**: show what was done, by kind. Activity is never an appraisal signal on its own | resolves P4-E1 for this surface |

### 11.3 Questions, ruled the same day

| ID | Question | Ruling |
|---|---|---|
| DW-Q2 | Someone in two of our companies: one Overview per company, or one combined? | Per company. Needs you keeps every company's items, tagged |
| DW-Q3 | Do quarters and semesters follow the calendar year? | Yes: Q1 is January–March, Semester 1 is January–June |
| DW-Q4 | What is a "department appraisal"? | **Owner: each department has its own KPIs and its own appraisal.** It is highlighted to show the department's standing and condition, and the HOD is made aware of it. See §5.5 |
| DW-Q5 | The proposed tool sets for HR, Finance, IT and generic (§4.1) | As proposed; adjust any time in the registry |
| DW-Q6 | Figma is a Web Dev and Creatives tool, but the vendor doctrine said "Figma not adopted". Connect it? | **Owner: use Figma too.** Figma is connected (§4.1), and the vendor doctrine §2.6 is amended to match. The exit stays: designs are exported into the Asset Library, so nothing is lost if Figma goes |

### 11.4 Ruled during the build

| ID | Question | Ruling |
|---|---|---|
| DW-D20 | DW-2g found that a member who types `/admin` gets an empty Admin area (the pages render and the server refuses each read). Should such a page be reachable? | **Owner (2026-10-13): a page is reachable only by those allowed to use it; everyone else gets a 404.** Applied to the whole Admin area (Settings `/admin/*`, Group `/group`, `/group/reports`, `/rollups`, Platform `/systems/*`), each page by its own gate, and the Settings tabs offer only the pages the person may open. The server stays the authority |
| DW-D21 | Every department's Project Management "Board" tab was labelled "Overview" (PM_TERMS.board, owner decision 2026-08-10), right under the workspace's own Overview row. Rename it back? | **Owner (2026-10-13): rename it back to "Board".** "Overview" then means only the workspace dashboard (DW-D12). URLs and keys are unchanged |

---

## 12. Delivery

**How the work runs:**
- **Order.** Phases run in order. DW-4 to DW-8 can run side by side once DW-2 lands.
- **Contracts first.** DW-4a, DW-5a and DW-5c each need their backend contract written first.
- **Tiers.** Haiku does mechanical edits and Sonnet does most implementation. Opus takes the cores,
  the access change and reviews.
- **Testing.** Every test runs on sumopod. Local results do not count.
- **Merging.** Nothing merges without the orchestrating session's review.

**DW-0 · Decisions and record**
- Every decision is ruled (2026-10-13): DW-D1 to DW-D19 and DW-Q2 to DW-Q6 (§11).
- Commit the plan, publish the drafts, and add the program to `TASKS.md`.
- Write the supersessions into the documents they change:
  - the dept-console IA plan (2026-07-23);
  - WS-UX #10;
  - GM console OQ-4;
  - the IA doc of 2026-08-22, §2.4;
  - Perspectives §4.1.
- `docs/sidebar-nav-map.md` gains the workspace model.
- The separate AI plan is started (DW-D17). It is its own document, not this program's phases.

**DW-1 · Foundations (no visible change)**
- **1a** (Opus) The workspace registry `UI/lib/workspaces.ts`, grown out of `deptToolkits.ts`. It
  holds:
  - the Work rows and their tabs, with absolute hrefs;
  - the shared Performance block;
  - the Tools & connections set;
  - Overview widgets, pulse tiles, quick actions and owned routes;
  - entries for HR, Finance, IT, the Office of the GM, generic, Company, Me and Admin.
- **1b** (Opus) `myWorkspaces(me, tenant)`.
- **1c** (Sonnet) `areaFor(path)`, the last-area rule, and the page-file test.
- **1d** (Sonnet) The per-person pilot switch.
- **1e** (Sonnet) `isLeadOf` and a unit-aware `canInUnit` UI mirror.

**DW-2 · The new shell**
- **2a** (Opus core, then Sonnet) The four-block sidebar: the switcher, the visiting state, the flat
  rail and the phone drawer.
- **2b** (Sonnet) One tab strip drawn by the shell. The group strip is retired, and there is no
  breadcrumb inside workspaces.
- **2c** (Sonnet) The top bar: one search, the bell pop-over, the avatar menu and the unrestricted
  chip.
- **2d** (Sonnet) The AI Assistant row opens today's assistant drawer, and the floating button
  retires.
- **2h** (Sonnet) The assistant page made better (§6). It touches no model, routing or brain-picker
  behaviour:
  - the calm layout, with one Details panel;
  - thread search, pinned threads and grouping;
  - the department-and-page context chip, and department prompt suggestions;
  - drawer and page as one thread;
  - the new shell's look.
- **2e** (Sonnet) ⌘K built from the registry, with a test that every page a person may open is
  findable.
- **2f** (Haiku) A workspace-aware **+ New**.
- **2g** (Sonnet) The nav tests are rewritten, and the sidebar e2e runs per persona.

**DW-3 · The Overview**
- **3a** (Sonnet) `/` resolves to the home workspace's Overview.
- **3b** (Sonnet) The band layout and the period selector.
- **3c** (Opus) Needs you, from the one queue, including PM-task ranking in `lib/queue.ts`.
- **3d** (Sonnet) Your numbers.
- **3e** (Sonnet) Pulse tiles and quick actions for every workspace.
- **3f** (Sonnet) The Projects, Campaigns and Requests blocks.
- **3g** (Sonnet) The Growth blocks.
- **3h** (Sonnet) The heads' Me | Team switch.
- **3i** (Sonnet) The company Overview for the Office of the GM: departments listed by condition, worst first (§5.5).
- **3k** (Sonnet) The HOD condition banner on the Overview, department KPI tiles with their condition, and the quiet condition strip for staff (§5.5).

**DW-4 · Performance inside every department**
- **4a** (Opus, backend) Quarter, semester and year periods. The contract comes first.
- **4b** (Sonnet) The Reports row: six periods × Mine, Team and Department.
- **4c** (Sonnet) The Analytics row: Work, plus the department's own analytics.
- **4d** (Sonnet) The Appraisals row: Mine and Team.
- **4e** (Opus, backend and UI) Department KPIs (§5.5, DW-Q4 ruled):
  - KPI definitions in the registry, and targets per company and period (the HOD proposes, the GM approves);
  - condition computed from existing report facts plus module reads;
  - the department appraisal per cycle, in Appraisals › Department;
  - the contract comes first.
- **4j** (Sonnet) The HOD is made aware: an Inbox notification on every condition change, a Needs-you item when a KPI goes off track, and a weekly digest.
- **4f** (Sonnet) The Learning row.
- **4g** (Opus, access) Heads get `org_unit_lead` from their lead position (DW-D15). It is verified on
  sumopod that a head authors only for their own department and cannot waive.

**DW-5 · Working together**
- **5a** (Opus, backend) Shared campaigns gain department parts. The contract comes first.
- **5b** (Sonnet) The Campaigns row everywhere, and the Social campaigns screen.
- **5c** (Opus, design) Requests between departments, as routed PM tasks with a request form.
- **5d** (Sonnet) Creatives › Requests, with delivery into the Asset Library.
- **5e** (Sonnet) Web Dev › Requests gains internal engineering requests.
- **5f** (Haiku) "Ask Creatives for assets" and "Ask Web Dev" quick actions.

**DW-6 · Department workspaces regrouped, with their tools**
- Build notes, the order and what DW-1 and DW-2 already built: §4.2.
- **6a** (Haiku) Web Dev, as in §4.
- **6b** (Haiku) SEO, Social Media, Creatives and the Office of the GM, as in §4. SEO's tab becomes
  "Client reports".
- **6c** (Sonnet) The Tools & connections row in every workspace, from the registry sets in §4.1. It
  gains Overview pinning and shows each person's own seat.
- **6d** (Sonnet) The Clients row is filtered to the department's clients. This needs a BFF filter,
  with the contract first.
- **6e** (Haiku) The generic workspace.
- **6k** (Sonnet, contract first) The Figma connection (DW-Q6):
  - link a file or frame to a task, request or campaign part;
  - show its thumbnail, last change and open comments;
  - export into the Asset Library, versioned against the request.

**DW-7 · HR, Finance and IT as workspaces**
- **7a** (Sonnet) HR: 14 tabs become 5 Work rows.
- **7b** (Sonnet) Finance: 15 tabs become 6 Work rows, plus Reports.
- **7c** (Haiku) IT: 10 tabs become 4 Work rows.
- **7d** (Sonnet) HR, IT and Finance are added to the org tree (DW-D6), checked on sumopod before live.
- **7e** (Sonnet) Their pulse tiles and tool sets.

**DW-8 · You, Company and Admin**
- **8a** (Haiku) The My tasks page.
- **8b** (Sonnet) Inbox is unified.
- **8c** (Haiku) Calendar gains Meetings.
- **8d** (Sonnet) Me becomes personal admin.
- **8e** (Sonnet) The Company area.
- **8f** (Haiku) Admin.

**DW-9 · Rollout and verification**
- **9a** Persona e2e runs on sumopod for these users:
  - Web Dev, SEO, Social Media and Creatives employees;
  - a Web Dev head;
  - HR, Finance and IT staff;
  - an unplaced owner;
  - `platform_admin`;
  - a generic-pack user;
  - a client-only user.
- **9b** axe checks, in light and dark, on desktop and phone.
- **9c** A pilot week.
- **9d** The new layout goes on for everyone. The classic layout is removed two releases later.
- **9e** Docs.

**DW-10 · Enrichment (one ticket each, after DW-3)**
- A department notice board.
- Monthly targets against actuals.
- A department calendar.
- Personalising the Overview.
- The PV-7 "My performance" depth.

---

## 13. Traps, ranked

1. **A page that leaves the sidebar and search silently stops existing.** The `areaFor` and palette
   tests land in DW-1 and DW-2, before any row moves.
2. **The sidebar cannot see the URL on the server,** because Next layouts get no pathname. Choose the
   area on the client, from models the server sends. Otherwise the sidebar flashes the wrong
   department.
3. **DW-4g is an access change.** Prove on sumopod that a head cannot author for another department
   and cannot waive mandatory training. Never "simplify" a gate while moving a row.
4. **The period selector must never fake a number.** Quarter, semester and year stay disabled until
   DW-4a. A failed read says "unavailable", never 0.
5. **The Overview can grow back into clutter.** Every new block must replace something or earn its
   place, and the band order is fixed.
6. **Campaign parts touch money and clients.** How a part's budget rolls up is ruled in the DW-5a
   contract, never in the UI.
7. **The AI scope can creep back in.** This plan improves the assistant's page and how it is used.
   Anything that changes which model answers, routing, agents per department, or usage and cost
   belongs to the separate AI plan (DW-D17).
8. **e2e tests pin today's sidebar.** Rewrite each test in the change that moves what it pins.

---

## 14. A working day inside the ERP (DW-D18)

**Owner rule (2026-10-13).**
- Staff work in the ERP all day.
- They open another app only when the job is impossible inside the ERP, or when the vendor gives no
  usable API or MCP connection (for example a paywall).

**Evidence base.** Two read-only surveys of `d574d099` on 2026-10-13:
- each department's pages, and what a user can actually do on each (real, partial or stub);
- every external system the ERP connects to.

### 14.1 Three ways a job gets done

| Mode | Meaning | Examples |
|---|---|---|
| **In the ERP** | The whole job happens on an ERP page | tasks, PRD Studio, WebDesk editing, journals, leave, Image Studio |
| **Connected** | The work lives in another system, but the ERP reads it in or pushes the action through an API or MCP, so the person never leaves | GitHub (repos), Search Console and GA4, Google Ads (approved changes), Postiz and the social networks, DataForSEO, Semrush, Ahrefs |
| **Opens outside** | Only when it is impossible in a browser, or the vendor has no usable API | writing code (VS Code, Claude Code); professional design and video apps; the bank portal; the tax office portal; network features no API offers (Stories stickers, live) |

**Launch and return.** Every outside tool is opened from Tools & connections with its context (the
client, project or task), and its result comes back into the ERP:
- a pull request appears on the task;
- a designed file is uploaded to the Asset Library;
- a payment is recorded against the invoice.

Nothing finished outside stays only outside.

**The AI Assistant does work as well as answering.**
- It can use the hub's ~280 tools under the person's own permissions.
- So "create a task for…", "summarise this client", "draft the October report" happen in the ERP.
- Anything that writes becomes a proposal the person approves.

### 14.2 The same day for everyone

| When | What | Where | Today |
|---|---|---|---|
| Start | See what needs me, today's meetings, my numbers | Overview | to build (DW-3); today's Dashboard covers part |
| All day | Work a task: status, subtasks, comments and mentions, files, time log, pass the ball | the task page | works |
| All day | Ask another department for work, or answer theirs | Requests | to build (DW-5) |
| All day | Talk with the client on their project | client page › Conversation | **to build**: backend built (PV-4), no staff screen |
| Meetings | Record, transcribe and turn into minutes, actions or a PRD | Calendar › Meetings | works |
| Meetings | Schedule a meeting, see events, not only tasks | Calendar | to build: the calendar is tasks-only |
| Any time | Approve what waits on me | Approvals | works |
| Any time | Ask the assistant to find, summarise, draft or do | AI Assistant | works |
| Any time | Find a company document | Company › Knowledge | to build: metadata only, no search |
| Any time | Send an email from the ERP | Mail | in progress (mail module) |
| End | Time logged on tasks fills the timesheet; end-of-day check-in | the task, Me › Timesheet, Overview | works |
| Growth | Learning, appraisal steps | Performance block | works (department views to build, DW-4) |

### 14.3 A day per department

Mode key: **E** = in the ERP, **C** = connected, **O** = opens outside.
- **Works** means it works today.
- **Waits** means it is built but waiting on a vendor approval or a paid plan.
- **Build** means it needs a DW ticket.

| Department | The day | Works | Waits | Build | Outside, and why |
|---|---|---|---|---|---|
| **Web Dev** | Briefing → PRD (E) · triage requests (E) · pipeline and gates (E) · repos via GitHub App (C) · **code** (O) · PR and CI status on the task (C, build) · edit site content, media and writers' room (E) · monitoring and portfolio (E) · deliverables (E, build) | PRD, requests, pipeline, repos, WebDesk, monitoring | none | PR/CI view, deliverables tab, internal requests | VS Code and Claude Code: an editor cannot run in a browser. UI/UX design in Figma: a design app. Editing opens Figma, but its frames, comments and exports are connected back into the ERP (DW-Q6) |
| **SEO** | Rankings (C) · Search Console and GA4 (C) · site audit with AI triage (E) · keywords (E) · content briefs (E, build) · write on WebDesk sites (E) · plan campaigns, ads, negatives (E) · push to Google Ads (C) · search terms, pacing, backlinks (C, build) · client report (E) · cost ledger (E) | audit, keywords, planner, client reports, ledger, WebDesk writing | Google verification (GSC/GA4), Ads developer token, Semrush/Ahrefs/DataForSEO plans (sandbox only) | briefs, AI visibility, search terms, ads apply, pacing, backlinks tabs (most backends exist) | Search Console's own UI only for URL inspection and manual actions |
| **Social Media** | Calendar (E) · own and shared campaigns (E, build) · composer with AI captions (E) · per-network variants (E, build: a stale banner) · assets from Creatives (E) · client review (E) · publish (C) · comments and DMs (C, build) · analytics (C) | calendar, composer, client review, asset pick, analytics | Meta and TikTok app review for client accounts (own-brand accounts work) | campaigns screen, variant fix, inbox thread list | The network apps for features no API offers (Stories stickers, live, trending audio). Until the inbox lands, replying happens in the native apps |
| **Creatives** | Asset requests in (E, build) · brief and references on the task (E) · correct, grade and batch-export photos (E) · **layout, video, motion** (O) · upload to the Asset Library (E) · review with versions (E, build) · deliver to the requester (E, build) · brand files (C, build: Drive) | Image Studio, Asset Library, task briefs | none | requests in and out, review and versions, Google Drive | Figma, Photoshop, Premiere and other professional desktop apps. Figma is connected (frames, comments and exports on the request); finished files from every app return to the Asset Library |
| **HR** | Leave and attendance (E) · onboarding (E) · cases (E) · directory and invites (E) · appraisal cycles (E) · **recruitment** (E, build) · **payroll** (E, build) · compensation, review cycles, policies (E, build) · candidate email (E, build) · documents (C, build) | leave, attendance, onboarding, cases, people, appraisal cycles | none | payroll, recruitment, compensation, reviews, policies screens (**backends complete; today's screens are read-only**), mail, Drive | none needed |
| **Finance** | Confirm client payments (E) · invoices, credit notes, AR (E) · bills and AP approvals (E) · journals (E) · depreciation, loans, leases (E) · close and consolidation (E) · chart of accounts edits (E, build) · VAT return prep (E, build) · online payments (C) | AR, AP, journals, treasury, close | Midtrans merchant approval | chart-of-accounts edits, tax return prep, bank feed | The bank portal for transfers and statements, until a bank feed exists. The tax office portal for filing |
| **IT** | Devices (E) · accounts (E) · topology and presence (E) · automations (E) · firewall rules and threat response (E, build) | devices, accounts, topology, workflows | none | rules, threat response | The UniFi controller and Google Admin until connected |
| **Office of the GM** | Cockpit (E) · decide approvals (E) · business review (E) · departments, money, people (E) · campaigns across departments (E, build) | all of the reading and deciding | none | campaigns view | none |
| **Any other department** | Tasks, board, timeline (E) · meetings → minutes (E) · time and check-in (E) | all | none | none | none |

**Two notes on the table.**
- **Who owns the stub tabs.** The SEO and Social stub tabs are owned by their own trackers
  (`docs/blueprints/seo-sem-execution-tracker.md`, `docs/plans/smm-tracker.md`). This program lists
  them so the day is complete, and does not track them twice.
- **Who owns the client conversation.** The client Conversation screen is coordinated with PV-4.
  Whichever program builds the staff screen, this program places it on the client page and in the
  Overview's Needs you.

### 14.4 Switching on the connections (owner and admin steps, not code)

These are built in code but give no real data until someone outside engineering acts:

1. **Google OAuth app verification** for the Search Console, GA4 and Ads scopes (SM-41G).
2. **Google Ads developer token** and manager-account (MCC) approval.
3. **Meta Business Verification and App Review**, and the **TikTok** audit. These are for client
   accounts; own-brand accounts work without them.
4. **Paid data plans:** confirm the Semrush and Ahrefs plans, and the DataForSEO budget. They run
   sandbox-only today.
5. **Midtrans merchant approval** (already approved by the owner on 2026-10-12, pending with
   Midtrans).
6. **A Google Drive OAuth client.** No Drive connection can be made today.
7. **Figma API access** for the team: an OAuth app or a team token, on the team plan. It is needed for DW-6k.

### 14.5 Personal daily activity (the GitHub-style map)

**What exists today** (checked on `d574d099`):
- **A year map per person already exists.** It is a GitHub-style heatmap in the **Productivity** view.
  - It sits under Workspace › Project Management (`/pm?view=productivity`) and
    `/project-management?view=productivity` (`UI/components/pm/Productivity.tsx`).
  - It is fed by `GET /api/:t/pm/productivity` (P4-E2), a zero-filled daily series over 365 days.
- **It counts project-management work only:**
  - tasks completed, including while holding the ball and those you were involved in;
  - the ball accepted;
  - reactions given and received;
  - notes contributions;
  - comments.
- **The composite score is blank on purpose** (`score: null`). The formula, and who sees it, is a
  people decision nobody has made (P4-E1).
- **Who sees whose map** (`pm.controller.ts`):
  - everyone sees their own;
  - company-wide tiers (HR, company admin, platform admin) see anyone in the company;
  - a manager or unit lead sees their own subtree;
  - a plain member never sees a colleague.
- **A separate check-in calendar** (submitted, missed, excused) sits on the person report
  (`reports/charts/CalendarHeatmap.tsx`).
- **The richer cross-source log** (`work_activity`) already exists with sources `pm`, `pipeline`,
  `github`, `google_drive`, `claude`, `manual` and `system`, but the map does not read it.

**What changes:**

1. **It moves to where people look.**
   - The Overview's "You" band gains a **My activity** card: the last 16 weeks plus "today so far".
   - The full year lives under **Analytics › My activity**. Click a day to see what was done that
     day.
   - Heads get **Analytics › Team activity**: one row per person, with this week's counts.
2. **It counts all work, not only project management (DW-4h).**
   - The series reads every work-activity source.
   - Each module emits its events: GitHub pull requests and commits; WebDesk edits and publishes;
     social posts scheduled and published; SEO audits, briefs and client reports; assets delivered;
     journals posted and payments confirmed; leave decided; meetings recorded; learning completed;
     time logged; check-ins.
   - The contract comes first.
3. **It feeds the check-in (DW-3j).** The day's activity becomes the end-of-day check-in draft.
   People only add blockers and plans for tomorrow, and the same data feeds the Daily report.
4. **No single score (DW-D19).**
   - It shows what was done, by kind.
   - It stays an activity record. It is never an appraisal signal on its own, matching the
     tracker blueprint's rule that utilization is never an appraisal signal.
   - The visibility rule stays as it is today.

### 14.6 What this adds to the delivery phases

- **DW-5:** the client Conversation on the client page (with PV-4).
- **DW-6:**
  - Web Dev: PR and CI status on tasks, and the Deliverables tab.
  - Creatives: review and versions.
  - Google Drive: browse and attach from Drive in Tools & connections.
  - SEO and Social stubs: listed for completeness; owned by their trackers.
- **DW-7:** the HR write screens (payroll, recruitment, compensation, review cycles, policies);
  Finance chart-of-accounts edits and VAT return preparation; IT rules and threat response (later).
- **DW-8:**
  - calendar events and meeting scheduling;
  - attachments on requests, campaigns and client pages;
  - knowledge search for staff;
  - email from the ERP, with the mail module.
- **DW-3j, DW-4h and DW-4i:** personal activity, as in §14.5.
- **New DW-11:** switch on the connections, as in §14.4.

---

## Decision log

- **2026-10-13 (owner, during the build):** DW-D20: Admin-area pages 404 for anyone not allowed to use them (§11.4). Built with DW-2g, whose e2e pinned the old empty Admin area.
- **2026-10-13 (owner, during the build):** DW-D21: the Project Management view is called "Board" again, reversing the 2026-08-10 Board→Overview rename (§11.4). Built as DW-6m.
- **2026-10-13 (owner, "all the decisions follow the recommendation"):**
  - DW-D1 to DW-D8, DW-D15 and DW-D19 ruled as recommended; DW-Q2, DW-Q3 and DW-Q5 ruled as defaulted.
  - **DW-Q4:** each department has its own KPIs and appraisal, highlighted to show its condition and standing, and the HOD is made aware (§5.5).
  - **DW-Q6:** use Figma too. Figma is connected (§4.1); vendor doctrine §2.6 amended.
  - Supersessions written into: the dept-console IA plan (2026-07-23), the dept-console design (decision #10), the GM console foundation (OQ-4), the IA doc of 2026-08-22 (§2.4), Perspectives §4.1, `webdev-design.md` (no-Figma non-goal) and `docs/sidebar-nav-map.md`.
- **2026-10-13 (owner, later the same day):** DW-D18 (ERP first; §14 written from two new surveys),
  plus DW-Q6.
- **2026-10-13 (owner, review of revision 1):** DW-D9 to DW-D14, DW-D16 and DW-D17, as in §11.1.
  - DW-Q1 is closed by DW-D13.
  - DW-D3 and DW-D5 are revised to match.
  - DW-D15, DW-Q3, DW-Q4 and DW-Q5 are added.
