# Web Dev workspace: the skin, the Today page and the inside pages (WDV): plan

**Status:** PLANNED. The owner approved the design on 2026-10-30. Nothing is built.

**The design (the authority for every screen in this plan):** https://claude.ai/artifact/5U1HjMBiuu2AfF3LwwHVYm
(a Design canvas: the Today page in light and dark, the phone, the menu, every drawn inside page, and two
coverage boards). Read it before you start a ticket, and read this plan for what is fixed in words.

**Read with it:**
- DW-D51 and rule 7 of the Department workspaces plan §2.6 (`docs/plans/2026-10-13-department-workspaces.md`):
  what a skin may and may not change.
- The Social skin, built the same way: SCP plan §6 and SCP-K (`docs/plans/2026-10-15-social-content-pipeline.md`),
  `platform-ui/src/lib/skins.ts`, `platform-ui/src/styles/tokens/skin-social.css`, `ShellFrame`, `SkinPhoneBar`.
- The Web Dev workspace in the registry: `WEB_DEV` in `platform-ui/src/lib/workspaces.ts`, and the toolkit in
  `platform-ui/src/lib/deptToolkits.ts`.

## 1. Goal

The Web Dev team works in five places today: Claude Design (the team seat), Claude Code (VS Code or the terminal),
GitHub, reports written by hand, and sites and servers checked by hand. The aim is to do as much of that as
possible inside the ERP, and to stop opening GitHub.

This plan is the first half: **how the workspace looks and is arranged**. It gives each of the five jobs a place
in the menu and on the Home, and rearranges Web Dev's own pages around the work. The jobs that need new server work
(designs in the ERP, pull requests and merges, the weekly report that drafts itself) are phase WDV-B, planned in
their own design pass after this one.

## 2. Decisions

| ID | Decision |
|---|---|
| WDV-D1 | **Web Dev gets its own skin** of the one shell, under DW-D51: skin key `webdev`. It follows the Social skin's rules exactly (SCP plan §6.1). Owner, 2026-10-30. |
| WDV-D2 | **The look is layout A ("Blueprint") in the gaiada.com revamp colours** (the revamp's `src/styles/tokens.css`): gold `#F5C22C` fills with black on them, deep gold `#7A5A00` wherever gold is text, a cream page, black ink. The revamp has no dark theme, so dark is built on its own inverse colour `#1A1916`. Status colours keep their Standard values and meaning. Owner, 2026-10-30. |
| WDV-D3 | **Selected states are gold**: the active menu row, selected pills, the selected half of a switch, radios and checkboxes. Only the keyboard focus ring stays black in light, because gold on cream is too faint to see. Owner, 2026-10-30. |
| WDV-D4 | **Type is IBM Plex Sans, with IBM Plex Mono for repository names, addresses, versions and times**, self-hosted like every font in the app (OFL). Poppins, the revamp's fallback face, was offered and not chosen. Owner approved the design as drawn, 2026-10-30. |
| WDV-D5 | **The menu is ordered by the team's day**, in three labelled groups (§3.3). Website, Deliverables, Clients, Campaigns, Analytics and Tools sit under More. Owner, 2026-10-30. |
| WDV-D6 | **The Home in the Web Dev skin is the Today page** (§4). Every block of the department Overview keeps a place on it; none moves to another page. Owner, 2026-10-30. |
| WDV-D7 | **Web Dev's own inside pages are rearranged as drawn** (§5). This is page work, not part of the skin: everyone who opens these pages sees the new arrangement, in whatever look they use. Every field, button, gate and state the page has today stays. Pages that every department shares keep their layout and only take the skin's colours. Owner, 2026-10-30. |
| WDV-D8 | **The phone** keeps the bottom bar Home, My tasks, New, Sites, More, with Search and Notifications at the top. Owner, 2026-10-30. |
| WDV-D9 | **The GitHub launcher stays** on the Tools card until Code can review and merge pull requests (WDV-B2). Owner, 2026-10-30. |
| WDV-D10 | **Spacing** (§6) is the comfortable density. A person's own density choice still applies (DW-D51 keeps density personal), so the skin never overrides spacing tokens; the page layouts use the existing spacing tokens. |

## 3. The skin

### 3.1 Colours

The token file is `platform-ui/src/styles/tokens/skin-webdev.css`, built like `skin-social.css`: the same four
selector groups (light, OS dark, pinned dark, print), no `--status-*` token, and **no new token name**
(`skinTokens.test.ts` enforces both). Each colour below goes to the existing Tier-3 token that plays that part;
where the canvas used a name of its own (the honey greeting band, the selected pill), use the existing token for
that surface or state, and raise it in review if none fits.

| Role | Light | Dark |
|---|---|---|
| Page | `#FBF8F1` | `#1A1916` |
| Card | `#FFFFFF` | `#22211C` |
| Sunken (table head, tiles, wells) | `#F8F4EA` | `#1E1D19` |
| Hairline · strong line | `#E9E2D2` · `#D3C9B4` | `#34322B` · `#4A473D` |
| Ink · secondary · muted | `#0F0E0B` · `#3A372F` · `#6B6658` | `#FBF4E2` · `#D9D2C0` · `#A8A190` |
| Accent as text (links, gold words) | `#7A5A00` (6.4:1 on white) | `#F5C22C` |
| Accent fill (primary buttons, badges, selected) · text on it | `#F5C22C` · `#000000` (12.6:1) | the same |
| Accent edge (button and selected-pill border) | `#D9A912` | `#F5C22C` |
| Accent soft (active menu row, icon tiles) · text on it | `#FBEBBF` · `#5C4400` | `#3A3014` · `#F8D772` |
| Greeting band | `#FCF0CD` with a 24px grid of `rgba(122,90,0,.08)` lines | `#272314`, grid `rgba(245,194,44,.07)` |
| Menu column | `#FFFFFF` | `#14130F` |
| Focus ring | `#0F0E0B` | `#F5C22C` |

Every pair above was checked on the canvas for WCAG AA; `skinContrast.test.ts` measures them again for both
themes.

### 3.2 Type

`--font-body` and the display face become IBM Plex Sans (weights 400, 500, 600) and `--font-data` the IBM Plex
Mono (400, 500) inside the skin. The woff2 files are added under `platform-ui/public/fonts/`, subset to latin and
latin-ext like Urbanist and Inter, with their `@font-face` rules and the OFL notice.

### 3.3 The menu

The pinned entries, in order. Each names a row and tab of the Web Dev workspace's model, as `lib/skins.ts`
requires, so the skin can add no page and skip no gate.

| Entry | Kind | Opens | Notes |
|---|---|---|---|
| **New** (full-width gold button) | shell `create` | The New menu: New briefing, Ask Creatives for assets | Top of the menu |
| Search (with ⌘K) | shell `search` | The palette | |
| Home | row `overview`, tab `overview` | The Today page, `{D}` | |
| Notifications | shell `notifications` | `/me/inbox`, Needs you on top (SCP-Kh) | Count badge |
| My tasks | row `tasks` | `/me/tasks` | Count badge |
| Projects | row `pm` (whole row) | Projects, Board, Ball, Timeline, Activity | |
| *Delivery* | section label | | New entry kind (WDV-Ka) |
| Requests | row `requests` (whole row) | Incoming, Sent | Count badge |
| Briefs | row `build`, tab `prd` | PRD Studio | |
| Design | a new row | Designs per project, from Claude Design | `ticket: "WDV-B1"`: hidden until built |
| Code | row `build`, tab `repositories` | Repositories | |
| Pipeline | row `build`, tab `pipeline` | `/pipeline` | Count: runs waiting approval |
| *Operations* | section label | | |
| Sites | row `run`, tab `portfolio` | The portfolio | |
| Monitoring | row `run`, tab `monitoring` | `/monitoring` | Count: monitors down, in the danger colour |
| *Insight* | section label | | |
| Reports | row `reports` (whole row) | Mine, Team, Department, Client | |
| AI Assistant | row `assistant` | The drawer | Foot of the menu |
| More | the More panel (SCP-Kd) | Everything else, §3.4 | Foot of the menu |
| Account | shell `account` (new item) | The avatar menu: theme, account, client view, sign out | The person's name and role, at the very foot |

- A section label is drawn only when at least one entry under it is drawn, so no empty heading shows.
- The SIMULATED and access marks sit at the foot of the menu, above the account.
- In the Web Dev skin the desktop top bar is not drawn: search, the bell and New are in the menu and the account is
  at its foot, as in the Social skin.

### 3.4 More

The More panel of SCP-Kd, unchanged in behaviour, lists what the menu does not pin, in the panel's groups:
- **This workspace:** Notices, Department calendar, Department guidance (`unpinnedTopTabs`, SCP-Kj).
- **Work:** Website (Content, Media, Analytics, Leads, Writers' room, Visitors), Deliverables, Clients, Campaigns, Tools & connections.
- **Performance:** My performance, Analytics, Appraisals, Learning.
- **You:** Approvals, Mail, My calendar, Me.
- **Account:** Switch workspace, Appearance (anyone may choose the Standard look), Log out.

### 3.5 Phone

`phoneBar`: Home, My tasks, New, Sites, More. `phoneTop`: Search, Notifications. More is a fifth slot in the bar
(a new shell item, `more`), so the phone needs no ☰ in the top bar. Every other pinned entry is listed first in the
More sheet (`phoneMenuFor`), so each stays one tap away.

### 3.6 What the skin never changes

As for every skin: page addresses, gates and Cerbos, data, what the status colours mean, and the items every skin
keeps (⌘K, notifications, the AI Assistant, More with the workspace switcher, the SIMULATED and access marks).
Every skin passes the same accessibility checks in light and dark, on desktop and phone.

## 4. The Today page

In the Web Dev skin, `{D}` renders the Today page instead of the Overview frame (the Social skin's SCP-Kl did the
same for its feed). The Standard look and every other department keep the Overview exactly as today.

| Block (on the canvas) | Answers | Reads (all exist today) | Overview block it carries |
|---|---|---|---|
| Greeting band: date, "Good morning", one status line, New briefing and Triage requests buttons, Me / Team switch | What is the state of things? | The Pulse sources (`change-requests-new`, `monitoring-problem-sites`, `pipeline-gates-pending`); the Overview's mode switch (DW-3h) | Pulse, the header |
| Notice strip under the greeting, "N more pinned" | What does my head want me to know? | The Notices block's read | Notices (fixed) |
| Needs you, with Approve, Deny and Acknowledge in place | What needs me now? | `readNowQueue` + `selectNeedsYou` | Needs you (fixed) |
| Delivery: projects by stage | Where is our work? | Until WDV-B4 ships, this slot draws the existing **Projects** block | Projects |
| Team activity (yours in Me mode) | What happened? | The activity feed (`lib/activity.ts`) | My activity |
| Today: check-in, calendar, due today | What is my day? | The Today block's three reads | Today |
| Sites: up of total, 30-day uptime, problem sites | Are our sites healthy? | `getSummary`, `listMonitors` (the 30-day figure is the mean of the monitors' `uptime30d`, labelled as such) | — (new, from Monitoring) |
| Tools: the six launchers | Where do I work? | `launchersOf("web-dev")` | Today's tool row |
| Department condition and the four targets | How is the department doing? | `getDeptKpis` (DW-3k); quiet strip for non-heads, as today | Department condition (fixed), Your / Team numbers |
| Your week | What did I do this week? | — | Planned: WDV-B3, hidden until built |
| Requests: new, open, past the date needed, sent and waiting | What is asked of us? | The change-request list and Requests › Sent | Requests |
| Shared campaigns | What are we part of? | The Campaigns block's read | Campaigns |
| Growth: learning, appraisal | How am I growing? | The Learning and Appraisal blocks' reads | Learning, Appraisal |
| "Customise this page" | | The Overview's optional blocks | Client health (optional) |

- Every read fails on its own and says so in words; a failed read is never drawn as zero or "nothing due".
- The canvas's 30-cell daily uptime strip needs a fleet-wide daily read that monitoring does not have. It is
  WDV-B5; until then the Sites card shows the 24-hour and 30-day figures without the strip.

## 5. The inside pages

Rules for every page in this section:
1. **Keep everything.** Before changing a page, list every field, column, button, link, dialog, gate and state it
   has on main, from its source; the acceptance is that each one is still there after the change.
2. **Arrange, don't add data.** Anything marked "new" below works in the browser from data the page already reads.
   A page that needs a new read is WDV-B work.
3. **Same addresses.** Tabs that replace header links point at the same URLs.
4. **Shared page parts first** (WDV-P0), then the pages use them.

| Ticket | Page | What changes (see the canvas) | New in the browser |
|---|---|---|---|
| WDV-P1 | Requests (`{D}/requests`) | The triage queue and the request side by side. Each queue row keeps all eight columns as two lines. | Status chips with counts (All, New, Triaged, In progress, Done, Declined) |
| WDV-P2 | Sites (`{D}/sites/portfolio`) | KPI tiles, one filter bar, the sortable table, then the WebDesk site registry | — |
| WDV-P3 | Monitoring (`/monitoring`, `/monitoring/channels`, `/monitoring/maintenance`) | Open incidents above the monitor table | Alert channels and Maintenance windows as tabs (same URLs) |
| WDV-P4 | Briefs (`{D}/prd`) | The four steps as a numbered strip with live counts; the create form beside the briefings in progress; GM review → client sign-off as a track | — |
| WDV-P5 | Code (`{D}/repositories`) | Sections "Built by the pipeline" and "Everything in the GitHub org"; app health as tags | — (the pull-request tab is WDV-B2) |
| WDV-P6 | Pipeline (`/pipeline`) | Reviews waiting on you first; the server filters in the table's toolbar; Recovery tools behind a header button | — |
| WDV-P7 | Pipeline run (`/pipeline/[runId]`) | Two columns: tracks and the artifact; gates, site & repo, scope sign-off and links on the side | Stage chips per track, the current stage in gold; pick a stage to read or edit one artifact |
| WDV-P8 | Content editor (`{D}/website/content/…/[slug]` and `~new`) | Form with language tabs and a save bar; the side rail ordered Publishing, Review, Writing assistant, Checks, Preview and status | — |
| WDV-P9 | Website site switcher (every Website page) | A switcher in the page header that goes to the same address as picking the site does today | The switcher |
| WDV-P10 | Writers' room (`{D}/website/writers/…`) | Counts as tiles, the filter bar, four review columns | Board, Calendar, Dashboard, People and Uploads as one row of links |
| WDV-P11 | Media (`{D}/website/media/…`) | Upload and filters in one toolbar, the grid and the detail panel | — |
| WDV-P12 | Website analytics (`{D}/website/analytics/…`) | Date range beside the view links; six KPI tiles; the cards in two columns | Visitors, AI visibility and Experiments as one row of links |
| WDV-P13 | Pages not drawn, by layout | **List:** Requests › Sent and Delivered, Deliverables, Content site overview and collection items, Leads, Visitors, Experiments, Uploads awaiting review, People, Alert channels, Maintenance windows. **Record:** site record, WebDesk site detail, monitor detail, visitor detail, brief, experiment detail, item history. **Form:** New monitor, Interest rules, Register a test, New deliverable. **Own layout:** Writers' calendar and dashboard, AI visibility, the recording player | — |

## 6. Spacing and parts

- Page: 32px around it, 24px between sections, 24px between columns.
- Card: 20px inside; card titles, rows, filter bars and the first and last table columns all on that 20px line.
- Rows: 12px top and bottom. KPI tiles: 16px inside.
- Controls: 36px, small 32px. Touch targets on the phone: 44px.
- Selected pill: gold fill, black text, the accent edge, semibold. Planned items: a dashed tag, and in the product
  they are not drawn at all until built.

Use the existing spacing tokens (`styles/tokens/spacing.css`), so the compact density still works (WDV-D10).

## 7. Execution

### 7.1 Model tiers (global rule: the cheapest model that fits)

- **Sonnet:** WDV-Ka to Kh, WDV-P0 to P12.
- **Haiku:** WDV-P13 (mechanical, once P0's parts exist), test scaffolds.
- **Opus:** reviews of Ka (the shell) and Kh (the Home switch), as for SCP-Ka and SCP-Kl.
- The orchestrating session reviews every diff, runs the gates and lands the trains.

### 7.2 Waves

1. **Wave 1, the skin, off:** Ka, Kb, Kc, Kd, Ke, Kf in one train. `SKINS_ON` is unchanged;
   `SHELL_SKIN_PREVIEW=webdev` shows it on a dev or test box.
2. **Wave 2, the Today page, then switch on:** Kh lands, then Kg switches the skin on for Web Dev.
3. **Wave 3, the inside pages:** P0 first, then P1 to P12 in parallel lanes (one page per ticket), then P13.
4. **WDV-B:** after its own design pass (backend brainstorm).

Every wave lands in a shared merge train (workspace `CLAUDE.md`), with the platform-ui version and CHANGELOG set by
the train's conductor.

### 7.3 Tickets and acceptance

| Ticket | Acceptance |
|---|---|
| WDV-Ka Skin key and menu sections | `SkinKey` gains `webdev`; `WEB_DEV.skin = "webdev"`. `PinnedItem` gains a section-label kind, drawn only when an entry under it is drawn. `ShellItem` gains `more` and `account`. The Standard and Social skins render exactly as before (tests prove it). |
| WDV-Kb Tokens and type | `skin-webdev.css` with §3.1's values in the four selector groups; IBM Plex Sans and Mono self-hosted (§3.2); `skinTokens.test.ts` and `skinContrast.test.ts` cover the new skin in light and dark. |
| WDV-Kc The menu | §3.3's entries, icons, counts and section labels; Design carries `ticket: "WDV-B1"`; New at the top, the account at the foot; the SIMULATED and access marks above the account; no desktop top bar in the skin. |
| WDV-Kd More | §3.4, with SCP-Kd's panel and SCP-Kj's "This workspace"; lists exactly the rows the registry gives the person; badges on More. |
| WDV-Ke Phone | §3.5's bar and top; More as the fifth slot; the sheet lists the other pins first. |
| WDV-Kf Tests | The palette, page-home, one-area (DW-1c), sidebar and skin-reachability tests pass in all three skins; a `webdev-skin` Playwright project on sumopod (one gate at a time) with axe clean in light and dark, desktop and phone. |
| WDV-Kh The Today page | §4 in the Web Dev skin; every Overview block has its place; each read fails on its own in words; Your week hidden (WDV-B3); the Projects block in the Delivery slot until WDV-B4; the Standard look and other departments unchanged (a test proves both). |
| WDV-Kg Switch on | `SKINS_ON` gains `webdev` after Kh is live; no menu entry points at a missing page; a live check as a Web Dev placeholder on the mock seed. |
| WDV-P0 Page parts | One set of page parts in the skin's look: page header (crumb, title, lede, actions), tab strip, filter toolbar, KPI tiles, table with the 20px edges, split view, side rail, step strip, link row, site switcher. Existing pages are untouched by this ticket. |
| WDV-P1 to P12 | One page each, per §5. The page's inventory (every element on main) is listed in the PR and each item is still there; its existing tests pass; new behaviour has a test; a DEMO_MODE screenshot in light and dark. |
| WDV-P13 | The undrawn pages use P0's parts in the layout §5 names, with the same inventory rule. |

### 7.4 Phases on the board

TASKS.md, program "Web Dev workspace": WDV-0 (decisions and this plan), WDV-K (the skin and the Today page),
WDV-P (the inside pages), WDV-B (the backend, planned next).

## 8. WDV-B: what the backend pass will plan

Known items, each to be designed in the backend brainstorm before any build:
- **B1** Design: designs per project, handed over from Claude Design (the menu's Design entry).
- **B2** Code: pull requests, review and merge in the ERP, so nobody opens GitHub (the GitHub write arm, GH-10 in
  `docs/blueprints/github-integration-foundation.md`).
- **B3** Your week: the weekly report that drafts itself from tasks, deploys and requests.
- **B4** Delivery: a read of projects by stage (Brief, Design, Build, Review, Live) for the Today page.
- **B5** Sites: a fleet-wide daily uptime read for the 30-day strip.
- **B6** Deliverables due: a due date on deliverables (DW-3e).
- **B7** Claude Code from the ERP: start a coding task from a ticket and see what it did.
