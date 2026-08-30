repo: hansel-gaiada/gaiada-system
branch: main
path: platform-ui

## Last sync
date: 2026-08-26T07:02:49Z
commit: 540870ed73b5

### Updated in this project
- Read `shell/CommandPalette.tsx`; rebuilt the ⌘K palette as a real ARIA combobox — typed filtering grouped by nav section (8 per section), a 2-character floor before record hits, arrow/Enter/Escape navigation.
- Read `shell/UserMenu.tsx` + `portal/PortalUserMenu.tsx`; built the sidebar account popover with its real two items (Account settings · Sign out, the latter as the danger item).
- Made every in-page tab strip work: HR (7 tabs), IT (5), Settings (8), Calendar (4 views), WA/TG Bot (6), the PM surface (7), and the department consoles' two-level DeptTabs — each tab now renders its own content, read from that route's page source.
- Filter chip rows (dashboard, approvals origins, audit verbs, dept sub-tabs) are real buttons with selected state.
- Grounded the new tab bodies in `hr/attendance`, `hr/cases`, `it/devices`, `it/accounts`, `admin/audit`, `admin/modules`, `admin/identity`, `admin/compliance`.
- Retheming pass: the whole surface now follows the user's FlowDash-style reference — violet accent, rounded geometry, sans-only type, tinted status pills, real dark AND light modes. Sitemap, flows, copy and IA untouched.
- Adopted the real icon set: every glyph now uses `shell/icons.tsx` `PATHS` verbatim at 1.6 stroke, round cap and join — header plus the sidebar icon `nav.ts` assigns to each item.
- Rebuilt the top bar from `shell/TopBar.tsx`, `NewMenu.tsx`, `ThemeToggle.tsx` — module-label eyebrow, date line, search field, Jump-to ⌘K, Auto/Light/Dark segments, ＋New menu, bell with 9+ badge.
- Made section tab strips real navigation (`me/layout.tsx` SectionTabs) — Leave and Loans now open.
- Read the FULL route tree (173 page/layout files), `shell/nav.ts`, module layouts, and 40+ page sources to capture the real sitemap, IA and content verbatim.
- Built `Gaiada ERP Redesign.dc.html` — luxury-dark reskin; sitemap, content, flows and IA mirror the live ERP 1:1.

## Screen map
| Project screen (Gaiada ERP Redesign.dc.html) | Repo files it was built from |
| --- | --- |
| Sidebar + groups (Me/Workspace/Organization/Departments/Business/Reports/Appraisals/Intelligence/Systems/Settings) | `platform-ui/src/components/shell/nav.ts`, `shell/Shell.tsx` |
| Top bar (module label, date, search, Jump-to, theme, ＋New, bell) | `shell/TopBar.tsx`, `shell/NewMenu.tsx`, `shell/ThemeToggle.tsx` |
| Sign in (own file: `Gaiada ERP Login.dc.html`) | `platform-ui/src/app/login/page.tsx` |
| Dashboard (check-in, filter chips, Needs-you queue, agenda, throughput) | `(app)/page.tsx`, `components/dashboard/*` |
| Me / Inbox / Leave / Loans | `(app)/me/layout.tsx`, `me/page.tsx`, `me/inbox/page.tsx`, `me/leave/page.tsx`, `me/loans/page.tsx` |
| Approvals (origins, urgency/oldest, pending + recently decided + execution state) | `(app)/approvals/page.tsx` |
| Project Management (Overview/Ball/Timeline/Charts/Productivity + Projects/Tasks) | `(app)/pm/page.tsx`, `(app)/project-management/page.tsx` |
| Calendar | `(app)/calendar/page.tsx` |
| Organization / Positions / Access / Departments | `(app)/organization/*`, `(app)/departments/page.tsx` |
| Department consoles (Web Dev, Creatives, SEO, Social Media; groups + subtabs + My-work rail) | `lib/deptToolkits.ts`, `departments/[deptId]/layout.tsx` |
| HR / IT consoles | `(app)/hr/layout.tsx` + `hr/page.tsx` + `hr/people/page.tsx`, `(app)/it/layout.tsx` + `it/page.tsx` |
| Clients / Deliverables / Timesheets / Billing / Agency / Meetings / Pipeline / Monitoring / Rollups | each module's `page.tsx` under `(app)/` |
| Reports (person/project/department/company) | `(app)/reports/*/page.tsx` |
| Appraisals (mine/team/cycles) | `(app)/appraisals/*` |
| Assistant / Knowledge / AI Agents / The Office | `(app)/assistant/page.tsx`, `knowledge/page.tsx`, `agents/page.tsx`, `office/page.tsx` |
| Systems (WA/TG Bot, AI Gateway, MCP Hub, Automation, Observability) | `(app)/systems/*/page.tsx` |
| Settings (Users & Roles + tab strip) | `(app)/admin/layout.tsx`, `admin/users/page.tsx` |
| Notifications | `(app)/notifications/page.tsx` |
| Design language (what changed vs shipped tokens) | `src/styles/tokens/colors.css` |
