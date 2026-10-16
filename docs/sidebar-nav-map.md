# Sidebar nav map: where every item lives

**Status:** living document. **Owner of truth:** the workspace registry,
[`platform-ui/src/lib/workspaces.ts`](../platform-ui/src/lib/workspaces.ts), drawn through
[`lib/workspaceAccess.ts`](../platform-ui/src/lib/workspaceAccess.ts) (home, gates) and
[`lib/shellModel.ts`](../platform-ui/src/lib/shellModel.ts) (what one person sees). This file is the human index of those
files plus a record of what moved.

**Update this file in the same commit that adds, moves or re-gates a row in `lib/workspaces.ts`.** A row move with no entry in
§3 is treated as an accident, not a decision.

Since **DW-D38 (owner, 2026-10-16)** the department workspace shell is the only layout. The classic sidebar (`components/shell/nav.ts`
and its renderers), the per-person layout switch and the `gaiada_prefs.shell` cookie field are gone. The design is the
[Department workspaces plan](plans/2026-10-13-department-workspaces.md) §2.

---

## 1. How the sidebar renders

Top to bottom, for every staff person (`components/shell/WorkspaceSidebar.tsx`):

| Part | What it shows | Where it comes from |
|---|---|---|
| Wordmark | The root company's name | data, never a literal (PV-D13) |
| Switcher | "Your workspaces" first, then every department of the active company, then "Switch company" | `resolveMyWorkspaces` + the org tree |
| Top rows | **Overview** (the department's all-seeing dashboard) and **AI Assistant** (opens the drawer over the page) | registry |
| **Work** | the workspace's own sections, then the shared rows (Requests, Campaigns, Clients, Tools & connections) where its pack and gates allow | registry `work` rows |
| **Performance** | My performance · Reports · Analytics · Appraisals · Learning | the shared block; tabs carry the gates |
| **You** | My tasks · Inbox · Calendar · Approvals · Me | the shared block; Approvals per DW-D23 (below) |
| Footer | **Company** (everyone) · **Admin** (only for those its gates allow) · **+ New** (the workspace's own create action first) | `ADMIN_ROWS`, `lib/adminAccess.ts` |

**Home** (`lib/workspaceAccess.ts`, in this order): the person's placement in the org tree; a unit they lead (`org_unit_lead`); an HR,
Finance or IT role in the company; GM access (full or narrowed) when the company has an Office of the GM; otherwise the Company area.
`/` answers with a real redirect to the home workspace's Overview, or shows the company-level Overview for a Company home. A person
with no company at all gets a short "not a member of any company yet" page.

**Areas** (`lib/areas.ts`): every page belongs to exactly one area (a workspace, Company, the personal area or Admin), chosen by
`areaFor(path)`. A page-file test fails when a page has no area. Visiting another department shows its rows under "Visiting …" with
"Back to …"; personal pages keep your workspace's sidebar; record pages (`/tasks/[id]`, `/projects/[id]`, `/clients/[id]/*`,
`/people/[id]`) keep the area you came from.

**Inside a row:** the shell draws ONE tab strip for the row's tabs (`WorkspaceTabStrip`). A console's own strip (`DeptTabs`,
`SectionTabs`, `FinanceTabs`) draws only when the row's tabs do not cover every tab of that console.

**Collapsed rail and phone:** the same rows as flat icons with tooltips (no fly-outs); below the drawer breakpoint the off-canvas
panel opens from the top bar's menu button. The collapsed state persists in the `gaiada_sidebar` cookie and is stamped on
`<html data-sidebar>` server-side, so a collapsed rail never flashes open.

**Gates are data.** Each row and tab carries a `Gate` (`cap`, `unitCap`, `agencyRow`, `pack`, `module`, `hasWorkspace`, `elevated`,
`platformOperator`, `rootGroup`, `decider`, `all`, `any`), evaluated by `gateAllows`. Rows with a `ticket` are planned and never
drawn. A gate only narrows what the menu offers; Cerbos and RLS stay the authority, and the Admin area's pages are a 404 for anyone
their gate refuses (DW-D20, one table in `lib/adminAccess.ts`).

**Approvals (DW-D23):** the You row shows when something waits on your decision or you hold any right to decide; its badge is the
pending count. The page stays reachable for everyone through the command palette.

**The command palette** (⌘K, the top bar's search): every concrete row and tab the person's model offers, the Company and Admin
rows, a short list of explicit, gated entries for real pages that no row owns (see `lib/palette.ts`), and live records from
`/api/search/palette`. `src/lib/paletteFindability.test.ts` pins that a page reachable today stays findable.

**Client-only principals** (`isClientOnly`) never see this shell: they are sent to `/portal`, which has its own route group and shell.

---

## 2. The Work rows, per workspace

As a member of the agency company sees them (`e2e/workspace-personas.spec.ts` pins these lists persona by persona; rows whose gate
the person fails are left out, and a generic-pack company has no agency rows).

| Workspace | Work rows (in order) |
|---|---|
| Web Dev | Project Management · Build · Run · Website · Requests · Campaigns · Clients · Tools & connections |
| SEO | Project Management · Accounts · Optimize · Requests · Campaigns · Clients · Tools & connections |
| Social Media | Project Management · Publish · Requests · Campaigns · Clients · Tools & connections |
| Creatives | Project Management · Requests · Studio · Campaigns · Clients · Tools & connections |
| Office of the GM | Project Management · Command · Oversight · Requests · Campaigns · Clients & sales · Tools & connections |
| HR | Project Management · People · Time · Talent · Cases & compliance · Tools & connections |
| Finance | Project Management · Ledger · Receivables · Payables · Treasury & assets · Tax · Close · Tools & connections |
| IT | Project Management · Devices · Network · IT accounts · Workflows · Tools & connections |
| Any other department (generic) | Project Management · Tools & connections, under the department's own name |

The Company area lists Departments, People, Organization, Projects, Clients, Campaigns, Knowledge, AI Agents, the Learning catalogue
and The Office. Admin holds Settings, Group (on a root company) and Platform, each by its own gate.

---

## 3. Change log

### 2026-10-16 — DW-D38: the workspace shell is the only layout

The owner ruled that there is no pilot week and no opt-in: the new layout is permanent. Removed in one change (DW-9d):
- the classic sidebar (`nav.ts`, `Sidebar`, `NavGroupSection`, `RailCategory`, `NavLink`, `CompanyContext`), the classic top bar, the
  floating assistant button and the full-width special-access strip;
- the per-person switch ("Try the new layout" / "Back to the classic layout"), `lib/shellLayout.ts` and the `shell`/`shellChosen`
  fields of `gaiada_prefs` (old cookies are ignored);
- the classic Home page at `/` (the Command Center and the queue/agenda home): the Overview replaced it (DW-D1, DW-D4, DW-D12);
- the departments' My-work rail ("Needs you" lives on the Overview).

What did not move: every URL, every gate, and every page's own content. The palette took over the findability that the classic nav
used to give (`/approvals` for everyone, and the explicit entries listed in `lib/palette.ts`). The classic nav's gate tests were
ported to `gateAllows` and shell-model tests before `nav.ts` was deleted.

### 2026-10-13 to 2026-10-15 — DW-1 to DW-8: the workspace shell, built behind a per-person pilot switch

The registry (`lib/workspaces.ts`), the access and home rules (`lib/workspaceAccess.ts`), the areas (`lib/areas.ts`), the shell
(DW-2), the Overview (DW-3), Performance inside every department (DW-4), Requests and Campaigns (DW-5), each department's tools
(DW-6), HR, Finance and IT as workspaces in the org tree (DW-7d), and You, Company and Admin (DW-8). DW-9 proved it for twelve kinds
of person (`workspace-personas`) and with an axe pass (`workspace-a11y`), then made it the only layout.

### Classic era (before DW-D38): one entry per push that touched `nav.ts`

These entries describe the classic sidebar (`components/shell/nav.ts`), which DW-D38 removed on 2026-10-16. They stay as
the record of why rows sat where they sat; several reasons (GM first, Monitoring as client work, ungated department rows)
carried into the workspace registry.

#### 2026-08-24 — GM-01: **GM hoisted to the top of Departments** (no route moved)

The GM department gains a bespoke console (`docs/blueprints/gm-console-foundation.md`), and with it
one nav change: for every principal, **GM sorts FIRST inside the `Departments` group** instead of
alphabetically among its own children.

**Why.** `d-gm` is the ROOT of the department spine — platform-nest `seed/roster.ts` has
`DEPT_PARENT["d-gm"] = null` and every other department parents to it. Sorting it between Creatives
and SEO files the parent inside the list of its children. Implemented in `nav.ts` as an ordering pass
over the `departments` argument (`deptSlug(name) === "gm"` first), not as a new group.

**Why the hoist matters.** GM arrives LAST from the org structure (its node is appended, because
`defaultStructure`'s ids are positional and inserting would renumber Web Dev off `dept-1` and SEO
off `dept-3`), so on a wide estate an unhoisted GM sorts to the bottom of the list instead of sitting
with its children. Pinned by `nav.test.ts`.

**No visual cap.** The Departments group used to truncate at 6 rows and offer an "All departments
(N more)" link to `/organization`. Removed: that link duplicated Organization > Overview, and hiding
real departments behind a truncation cost more than the six saved rows. Every RBAC-visible
department paints.

**Deliberately NOT gated.** No capability in the Gate column, and `nav.test.ts` pins the row for a
plain `member`. These rows come from the active company's org structure; hiding a department from the
tree to hide its console would lie about the org chart. The **console** gates its content instead
(`lib/gm.ts` → `reports.company.view`, with the `/rollups` 403-page precedent), so a member who
clicks GM gets an explanation, not a 404 and not an empty grid.

**What did NOT move — the important half.** `Business` and `Reports` keep every row and every URL.
The GM console COMPOSES `/reports/company`, `/reports/department`, `/rollups`, `/approvals`,
`/clients` and the per-department consoles and drills INTO them; it is a second door, never a
relocation. The foundation doc §0 records the owner's "can the whole business move under GM?"
question and why the answer is no: `Business` is not GM-grain (a junior needs Timesheets), `Reports`
is already organised by GRAIN rather than ownership (only the company grain is GM's), and moving
routes breaks deep links, the palette's tier-3 search, MCP hrefs and the agentic-native bar.

**No new glyph.** The row keeps the `hr` group glyph every department row uses.

#### 2026-08-13 — MON: **Monitoring** added to Business

Plane B (client property/service monitoring) gets one row: **Monitoring** `/monitoring`, icon
`pulse`. Sub-surfaces `/monitoring/new` and `/monitoring/channels` are reached from the page, not
the sidebar — three rows for one capability would crowd a group that already has ten.

**Why Business and not Systems.** Systems holds *our* infrastructure consoles (Bot, Gateway, Hub,
Automation). Monitoring's subject is the **client's** websites and services — it is client work, and
it is the surface we intend to sell. Putting it in Systems would file it as internal plumbing and
quietly re-merge the two planes the design keeps apart (`docs/blueprints/monitoring-program.md` §0).
Platform observability (Prometheus/Grafana/Loki/Tempo) stays out of the ERP entirely, behind an SSH
tunnel, and is deliberately **not** a nav row.

**Ungated on purpose.** No capability in the Gate column: `monitoring.read` on platform-nest is the
boundary, and `nav.test.ts` pins the row for a plain `member` so a future gate cannot be added here
by accident. A UI-only gate would hide a page the server would serve — which users read as broken,
not forbidden.

**Glyph:** reuses `pulse` (shared with Delivery Pipeline and Rollups). No new icon: `pulse` is the
right shape for a health/liveness surface, and the rail only draws a group glyph, so the collision
is invisible there.

#### 2026-08-07 — merge `fadhil/ui` → `main` (collapsible sidebar + 64px icon rail)

Branch was **1 commit ahead / 163 behind**; it forked before `Me` and `Assistant` existed. One
conflict (`nav.ts`), resolved by keeping **both** sides:

| What | Where it came from | Resolution |
|---|---|---|
| `Me` group (position 1) | `main` | Kept first, ungated. Given `icon: "user"` so it has a rail glyph. |
| `Assistant` row in Intelligence | `main` | Kept as the group's first row. |
| `pinned: true` on Workspace | `fadhil/ui` | Kept. |
| `icon` on Organization/Departments/Business/Reports/Appraisals/Intelligence/Systems | `fadhil/ui` | Kept. |
| `NavGroup.icon` + `NavGroup.pinned` fields | `fadhil/ui` | Kept. |

**Decision — `Me` is a flyout, not pinned.** Pinning both `Me` (4 rows) and `Workspace` (3 rows)
would put 7 flat rows above the category glyphs and undo the rail's point. Flip `pinned: true` on
`Me` in `nav.ts` if personal rows should out-rank that; nothing else needs to change.

**New icon:** `user` (one person) added to `icons.tsx` — `hr` is the group-of-people glyph and was
already the Departments category, so reusing it would have put the same shape twice in the rail.

Also landed in the same merge (not `nav.ts`, but sidebar behaviour):
`sidebarState.tsx` (client context — the rail is a different *renderer*, not narrower CSS),
`SidebarToggle.tsx`, `RailCategory.tsx`, `NavGroupSection.tsx`, `railTooltip.tsx`,
the `gaiada_sidebar` cookie in `lib/prefs.ts`, and `shell.css` rail rules.

**Known cosmetic gap:** Organization has one row, so the rail draws that row's `inventory` glyph and
the group's `sitemap` glyph is never used. Harmless today; it becomes the right glyph the moment a
second row lands under Organization.

#### Earlier (pre-dating this file)

Not reconstructed. `git log -- platform-ui/src/components/shell/nav.ts` is the fallback.
---

## 4. Rules for the next row change

1. **Add or move the row in `lib/workspaces.ts` and update §2 in the same commit**, with a §3 entry saying why it sits where it sits.
2. **A new page needs an `AREA_RULES` entry** (`lib/areas.ts`); the page-file test fails without one. URLs never move; only true
   duplicates redirect.
3. **Every row and tab carries its gate as data.** Mirror the gate of the page's PRIMARY read, never a guess; extend the
   `gateAllows` tests, do not loosen them. A gate only narrows the menu; the server stays the authority.
4. **A page no row owns must stay findable**: add a gated entry to the palette's explicit list in `lib/palette.ts` and a case to
   `paletteFindability.test.ts`.
5. **Planned rows carry `ticket`** and are never drawn; remove the ticket in the change that builds the row.
6. **Run the workspace e2e on sumopod** (`platform-ui/qa/e2e-gate.sh`, one gate at a time): `workspace-shell`,
   `workspace-departments`, `workspace-functional`, `workspace-personas` (the rows per persona) and `workspace-a11y` (axe, light and
   dark, desktop and phone). CI's Playwright step runs only `smoke`.
