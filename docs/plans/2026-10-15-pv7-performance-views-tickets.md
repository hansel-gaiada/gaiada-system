# PV-7: Performance views (tickets)

**Status: COMPLETE, DEV-VERIFIED live (2026-10-15).** Started by the owner ("start pv7") and finished the same day
("proceed to finish it"). All nine tickets are live:

- **1.0.0-alpha.407:** PV7-01 (client grain), PV7-02 (client health backend), PV7-06 (My performance).
- **1.0.0-alpha.409:** PV7-03 (health on the client Overview), PV7-04a and PV7-04b (client reports), PV7-05 (the health
  board and Reports › Client).
- **1.0.0-alpha.411:** PV7-07 (the monthly account summary), PV7-08 (agent tools).
- **PV7-09, the live drive (on 411, review data):**
  - **Access, probed against the live policy:** `read_client` 7/7 and `client_report` 9/9 (automation and bot
    principals cannot publish or withdraw).
  - **As the owner:** the board for 70 clients in about 1 s; one client's health; the client document with its project
    list.
  - **One labelled test summary** ("ZZ TEST PV7-09"): drafted with an AI narrative, edited, published (the PDF rendered
    in 4.7 s) and withdrawn with a reason.
  - **As the placeholder contact `portal@hubble-bali.test`:**
    - the portal health view, with no forbidden field;
    - the staff reads refused (403);
    - the report listed with New, downloaded as a 148 KB PDF, and New cleared on read;
    - after the withdraw, the report gone from the list and its file and read marker 404.
  - **Backfill:** a dry run found nothing to back-fill.
  - **e2e and axe on sumopod:** portal 28/28, the staff client pages and the board 21/21, My performance 3/3 (after a
    stale e2e expectation for the activity link was fixed, `ad4c8db5`).
- **Teardown:** the test summary stays as a withdrawn row, hidden from the client: one report, its file, one read marker,
  one notification and four activity rows.
- **Still open, non-blocking:** owner questions PV7-Q1 to Q4 and Q6 (the lead's defaults are in force). PV7-Q5 was
  answered by DW-D29.

- **Parent plan:** `docs/plans/2026-10-10-three-perspectives.md` §3.4 (the client's performance view),
  §4.3 (the employee's productivity view), §5.1 (the client health board), §5.4 (the client grain),
  §6, §8 (PV-7 row), §9 (traps).
- **Rulings in force:** PV-D4 (same areas on both sides, every URL kept), PV-D10 (one request per
  company, never a cross-company query), PV-D13 (no company names or ids in code), PV-D23 (agents
  draft, staff send), PV-D33 and PV-D37 (client-wide material only for client-wide contacts), PV-D36,
  PV-D38 (no money figures in Services & results). From the department workspaces plan: DW-D3 and
  DW-D10 (Reports, Appraisals, Learning and Analytics stay in the Performance block), DW-D19 (no
  single score; activity is never an appraisal signal on its own), DW-D20 (a page is reachable only
  by those allowed to use it). Tracker blueprint §5.2 (anti-gaming) and §11 (privacy:
  line-of-sight, symmetric transparency, hours are context and never a score).
- **Base:** `origin/main` at `4411a2db` (1.0.0-alpha.402), read 2026-10-15 from a clean worktree.
- **Paths:** `PN` = `platform-nest/`, `UI` = `platform-ui/src/`.

## What people will notice

- **Clients, on Overview:** each project shows its health in plain terms: milestones done, due and
  late; deliverables late; and **who holds the ball**: what is waiting on you, since when, and what
  is waiting on us. Below that, how quickly each side usually answers over the last 90 days. A
  client-wide contact also sees the headline numbers from Services & results.
- **Clients, a new Overview › Reports tab:** the monthly social and search reports and a monthly
  account summary, published by our team, each with its PDF. A new report shows a "New" badge.
- **Staff, on a client's Overview:** the same health block, marked where the client sees it, plus a
  health state (on track, at risk, off track) with its reasons. A Reports tab under Overview lists
  every report for the client, with Publish and Withdraw.
- **Staff, Clients › Health:** every client on one board, with its state and reasons. It shows
  what waits on us and on the client (with ages), late work, open requests, unanswered messages,
  overdue invoices and site incidents. The clients list gains a Health column and filter.
- **Staff, Reports › Client:** delivery numbers for one client, summed across its projects, for
  the six periods, sealed with the month like the other reports.
- **Employees, Performance › My performance:** one page with your numbers, your check-ins, your
  latest appraisal, your learning and your logged time. Each section links to its full page. There
  is no single score.
- **Agents** can read client health and client reports, and draft (never publish) an account
  summary.

## Findings from reading the code (they shaped the tickets)

1. **There is no client grain, and the grain list is hard-coded in about twelve places.** The places
   are `PN/src/modules/reports/report-document.ts:15`, `metrics.ts:35`, `reports.controller.ts:88,101-106,137-144,397-404`,
   `document-builder.ts:79-88,447-464,478-499,997-1001`, `report-seal.ts:143-155`, `report-pdf-export.ts:84`,
   `report-export.ts:118`, the MCP enums in `reports/index.ts`, and the UI mirrors `UI/lib/reports.ts:28` and
   `UI/lib/demoReports.ts`. A hard CHECK sits at `PN/migrations/0067_report_periods_documents.sql:137`. DW-4a's
   `202610140010` is the template for widening a CHECK by its column set. → **PV7-01.**
2. **Client figures need careful arithmetic.**
   - **Ratios:** sum the numerators and the denominators, and never average per-project ratios.
   - **Day-count trap:** `flow.wip_open_avg` divides by a day count (`report-rollups.ts:295`). Summing denominators across projects would multiply the days, so keep `days` (company grain does, `:314`).
   - **Point in time:** `discipline.overdue_open` is a count at range end and keeps `pointInTime`.
   - **Not offered:** `evidence.source_diversity` has no project grain, so the client grain does not offer it.
   - **Excluded work:** internal work comes in two shapes, `projects.is_internal` and the sentinel `clients.is_internal`. Both are excluded, as `dept-kpi-readers/scope.ts:21-29` does.
   - **Moved projects:** `projects.client_id` can change (`core.controller.ts:~383`). A sealed month freezes the old attribution; a live range follows the current one. → **PV7-01.**
3. **Project documents are internal.** They carry `effort.*`, `collab.*`, overdue task titles, and a
   narrative that does not know its reader. So the client-grain document stays staff-only. What a
   client sees is computed only from records the client can already see: milestones, deliverables,
   client gates, contracts, change requests and conversation. It never draws on tasks, time,
   people or internal gates (plan §3.4 "never shown"). → **PV7-01, PV7-02, PV7-07**; PV7-Q1 asks
   the owner to confirm.
4. **No client health exists anywhere, but its parts do.**
   - **The parts:** the hub overview's `needsUs` and `needsClient` with `since` (`PN/src/modules/clients/clients.controller.ts:370-476`, `ClientBallList` stale after 7 days), `clientMoney`, `monitors.client_id`, and the `clients.retention` reader.
   - **Why it must be set-based:** the hub overview runs seven queries per client, so fanning it across 71 clients would cost about 500 queries. The board needs a set-based read.
   - **Sharing the ball logic:** it must be shared with the hub overview, not copied. A parity test pins it. → **PV7-02.**
5. **Delivered social and search reports reach the client as an empty deliverable.**
   - **What delivery does:** `deliver` writes the PDF as a `files` row targeting `social_report` or `search_report` (`PN/src/modules/social/social-reports.controller.ts:455`; search likewise).
   - **Why the client can't download it:** the portal download route serves only the kinds in `DOWNLOADABLE` (`PN/src/core/portal-commerce.controller.ts:74-86`), and the deliverables list attaches only files that target the deliverable.
   - **What the client gets:** delivery adds a `delivered` deliverable with no file, and only when the engagement has a project. → **PV7-04.**
6. **Published reports need a home of their own.**
   - **Documents:** it is legal and money only (PV-5 decision 18).
   - **Deliverables:** they have no publish flag, and any file attached to one is downloadable by the client at once.
   - **The home:** a `client_reports` record with a draft → published step. It follows the meeting-minutes precedent (`shared_at`/`shared_by`, a scope builder in `portal-visibility.ts`, a notice to the contacts in scope, an SSE topic). → **PV7-04.**
7. **Only the turnaround parts that clients can see carry timestamps.**
   - **Client gates:** `pipeline_gates` (`created_at` → `decided_at`, `actor_side='client'`).
   - **Contracts:** `sent_at` → `signed_at`.
   - **Post reviews:** `requested_at` → `decided_at`.
   - **Change requests:** `created_at` → `triaged_at`.
   - **Payments:** `invoice_payments` (`created_at` → `confirmed_at`).
   - **Conversation:** messages by side.
   - **Missing:** milestones, projects and change requests have no completion time, so "on time" can only mean done versus due today. PV7-02 starts recording `pm_milestones.completed_at`; nothing is back-filled, and history says from which date it is known. → **PV7-02.**
8. **The portal Overview blends all of a contact's clients within one company.** Its percent and
   deliverables are blended (`PN/src/core/portal-workspace.controller.ts:95-182`). Health must be
   per client. The Overview's money is client-wide even for a project-scoped contact. That is
   pre-existing, and PV-7 does not copy it. → **PV7-02, PV7-03.**
9. **Clients have no inbox.**
   - **Rows nobody can read:** notification rows are written for contacts, but the Cerbos `notification` kind does not admit the `client` role.
   - **No mail for this:** the mail allowlist has three kinds, and the conversation mail flag is off.
   - **What v1 does:** a published report shows as a "New" badge and an SSE hint. Mail waits for the mailer ("Before real clients use the portal"). → **PV7-04.**
10. **My performance needs no new backend, but it has traps.**
    - **Real routes differ from the docs:** "Reports › Mine" is `/reports/person`; there is no `/reports/mine`.
    - **Me › Timesheet shows everyone:** it opens `/timesheets`, which lists the whole company's entries because `mine=me` is not passed (`UI/app/(app)/timesheets/page.tsx:28,50`; `PN/src/core/client-work.controller.ts:117-130`).
    - **Learning can blank the page:** `getMyLearning` throws on failure.
    - **Module gates differ:** check-ins need `hr`, learning needs `lms`, reports need `reports`.
    - **Owned elsewhere:** DW-4i owns moving the year map, DW-4k owns export and print, DW-4h owns the all-work activity series. → **PV7-06.**
11. **Every member and viewer can list every colleague's time entries.** `GET :t/time-entries` with no
    filter returns the company's rows (user, minutes, task, notes). Cerbos `time_entry · read` admits
    `company_admin, manager, member, viewer` (`PN/cerbos/policies/resource_time_entry.yaml:12-15`).
    That gets around the reports' line-of-sight rule for `effort.minutes_logged` (blueprint §11
    principle 3). It is pre-existing and outside PV-7. PV-7 reads only your own entries. → **PV7-Q5.**

## Lead's calls in planning (the owner can overturn any of them)

- **L1. Clients never see task- or time-derived numbers.** The client-grain report is staff-only
  (finding 3, PV7-Q1).
- **L2. The client grain is sealed with each month, like the other grains**, so a moved project
  does not rewrite history. Its narrative is deterministic, with no AI call per client, because 71
  clients would add 71 AI calls to every seal.
- **L3. The health state is staff-only and is never a score.** It is one of `on_track`, `at_risk`,
  `off_track`, `quiet` (no active work) or `unknown` (a source could not be read and the rest would
  say on track). Every state below on track lists its reasons. The rules are a pure function in one
  file, pinned by a golden table on both sides. The portal shows facts (what is late, who holds the
  ball), never a state label.
- **L4. My performance lives in the Performance block** (DW-D3, DW-D10) at `/me/performance`, in
  area `performance`, following the `/me/learning` precedent (`UI/lib/areas.ts:58`). It links to
  the full pages and copies none of them. It covers DW-10's "My performance depth (with PV-7)"
  item, and the DW session ticks that box.
- **L5. Published reports live under Overview › Reports on both sides**, not in Documents and not
  in Deliverables. A delivered social or search report's deliverable row links to its report.
- **L6. Agents draft and staff publish** (the PV-D23 shape). Cerbos denies `publish` and `withdraw`
  to the `automation` and `bot` principal kinds (precedent `resource_webdesk_content_item.yaml:437`).

## Contract and numbering

- **BFF sections:** **§53** client grain (PV7-01), **§54** client health (PV7-02), **§55** client
  reports (PV7-04), **§56** account summary (PV7-07).
  - Taken elsewhere: §44 is reserved by DW-4h, §45–§48 are DW-8's, §49–§52 are DW-7's.
  - My performance adds no route, so it gets no section.
- **PERMISSION sections:** **§45** (`report_document · read_client`) and **§46** (the `client_report`
  kind). Each ticket re-checks the next free number when it writes, renumbers if one is taken, and
  tells the lead.
- **Migrations:** use the prefixes below, and re-check that each is unused and later than main's
  newest at landing. Names follow `YYYYMMDDHHMM_snake_case.sql` (UTC). Each ticket owns its own
  prefix, so the three never collide: PV7-01 `202610151700`, PV7-02 `202610151710`, PV7-04
  `202610151720`.
- **Contract first:** each backend ticket's first commit is its BFF (and PERMISSION) section,
  marked PLANNED. The build follows, and the section is flipped to BUILT, PROTOTYPED as built.

## Waves

| Wave | Tickets | Why this order |
|---|---|---|
| 1 | PV7-01 (client grain), PV7-02 (client health backend), PV7-06 (My performance) | disjoint files; 06 needs nothing new |
| 2 | PV7-03 (health on the client Overview, both sides), PV7-04 (client reports: publication), PV7-05 (health board and Reports › Client) | 03 needs 02; 05 needs 01 and 02; 04 is independent but shares the portal shell with 03, so 04's UI rebases on 03 |
| 3 | PV7-07 (account summary), PV7-08 (agent tools) | 07 needs 01, 02 and 04; 08 needs every route |
| 4 | PV7-09 (QA gate, release, live drive) | after the merged tree is green |

Each ticket lands on its own as soon as it is reviewed and green (owner approval 2026-10-12), through
the sessions' landing protocol. Seats: Sonnet by default; **Opus for PV7-04's backend only** (a new
Cerbos kind, a new portal download kind and a new portal scope builder).

---

### PV7-01: the client grain in reports (backend)

**Seat:** senior-be, Sonnet, high effort. **Contract:** BFF §53, PERMISSION §45.

Build:
- **The grain everywhere:** `client` joins `person | project | department | company` in every
  place listed in finding 1, including the UI type mirror and the demo fixture.
- **The migration:** `202610151700_reports_client_grain.sql` widens `report_documents.grain`, finding
  the constraint by its column set, as `202610140010` does.
- **Rollups:**
  - `computeOwnFactRollups` gains a regroup by `p.client_id` through
    `report_work_facts f JOIN projects p ON p.id = f.project_id AND p.tenant_id = f.tenant_id JOIN clients c ON c.id = p.client_id`.
  - It filters `p.deleted_at IS NULL AND c.deleted_at IS NULL AND NOT p.is_internal AND NOT c.is_internal`.
  - Milestone, flow and overdue rows are regrouped through a project → client map, as flow already
    maps project → department (`report-rollups.ts:299`).
  - The ratio rules follow finding 2. `rowGrainShape` learns `clientId`.
- **The builder:** `resolveScopeName` returns the client's name and `scopeFilter` gains a client
  branch. The KPI set is the project grain's 16 metrics; `evidence.source_diversity` is not offered.
- **Sealing:** `enumerateInScope` adds every client with rollup rows. Client documents get the
  deterministic narrative only (L2).
- **Routes:** `GET reports/document?grain=client&scopeRef=<clientId>`, `GET reports/overview?grain=client`
  (one headline row per client, for the board) and `POST export` with `grain=client`.
- **Cerbos:** a new action `read_client` on `report_document`, given to the same derived roles as
  `read_project`, minus the served-provider arm (served slices are department only). Anyone who can
  read every project document can already compute the sum, so nobody gains reach. Update
  `reports-cerbos.test.ts`, the policy's comment, and PERMISSION §45. Do not add a `perm_*` rule
  (the policy's IAM-04-B5 note; `permission-arm-hazard-scan.test.ts`).
- **MCP:** the `grain` enum in `reports.getDocument` and `reports.getMetrics` gains `client`.

Tests (the HTTP and DB suites run on CI):
- A golden table: two clients with three projects between them, one internal project and one
  sentinel-internal client.
  - Additive KPIs equal the sum of their projects.
  - Each ratio equals Σn/Σd, never the mean.
  - `wip_open_avg` keeps the day count.
  - The internal work is absent.
- A project moved to another client after a month is sealed: the sealed document keeps the old
  attribution, and a live range shows the new one.
- `read_client` matrix: allowed and refused for each role, matching `read_project`.
- The capability inventory is regenerated (`UPDATE_INVENTORY=1`) and `docs/MAP.md` too
  (`node scripts/gen-map.mjs` from a clean tree).

Not in this ticket: any page (PV7-05).

### PV7-02: client health (backend)

**Seat:** senior-be, Sonnet, high effort. **Contract:** BFF §54.

Build:
- **`PN/src/modules/clients/client-ball.ts`:**
  - Move the `needsUs` and `needsClient` queries out of `clientOverview` and make them set-based over
    `clientIds[]`.
  - The hub overview calls it for one client and its output must not change; a parity test compares
    it with the old output on the same fixture.
  - Keep the `{modules:["social"]}` scope note: without it, post reviews read zero rows silently.
- **`PN/src/modules/clients/client-health-rules.ts`:** a pure function from signals to `{state, reasons[]}`
  (L3), with the thresholds of PV7-Q4 as named constants. It is pinned by a golden table that the UI's
  demo mirror also runs.
- **`GET :t/clients/health` (staff board):**
  - **Rows:** one per client that is not archived and not internal.
  - **Signals:** waiting on us `{count, oldestSince}` and waiting on the client `{count, oldestSince}`;
    late deliverables and late milestones; open change requests; conversations awaiting our reply;
    overdue issued invoices `{count, oldestDue}`; site `{openIncidents, uptime30d}` from monitors by
    `client_id`; delivery on time this month from PV7-01's client overview (`null` while PV7-01 is
    not on main, or with the reports module off); and active projects.
  - **Cost:** a fixed number of queries whatever the client count; a test pins the count.
  - **Gate:** the clients list's gate, and the money signal is shown to the same readers as the hub
    overview's `money`.
  - **Failed sources:** each source reads on its own, and a failed one goes to `unavailable[]`,
    never 0.
- **`GET :t/clients/:clientId/health` (staff, one client):**
  - The board row, plus per-project health and the 90-day turnaround on both sides.
  - **Turnaround:** the median days per side, with `n`, withheld below 3 samples.
  - **Client side:** client gates decided, contracts signed after they were sent, and post reviews
    decided.
  - **Our side:** change requests triaged, payments confirmed, and replies to client messages.
  - Each part carries `clientVisible`, computed from the portal predicates.
- **`GET :t/portal/health` (portal):**
  - **Shape:** one section per client in the caller's scope within this company; per project only
    for the projects in reach.
  - **Client-wide parts:** turnaround on items with no project and the client-wide ball items reach
    only client-wide contacts (PV-D33, PV-D37). PV7-Q2 asks whether a project-scoped contact sees
    their own projects' health; the default is yes, for those projects.
  - **Predicates:** every one comes from `portal-visibility.ts`, adding builders there with a
    `staff*` mirror where needed. Add the controller to the SWITCHED list in
    `portal-visibility.test.ts`.
  - **Never included:** tasks, `blocked`, time, activities, internal gates, people, or a state label.
- **`pm_milestones.completed_at`:**
  - Migration `202610151710_pm_milestones_completed_at.sql` adds the column.
  - A trigger sets it when the status enters the done set that `report-rollups.ts:198-238` uses, and
    clears it when the status leaves.
  - Nothing is back-filled. The health payload says `onTimeKnownSince`.

Tests:
- The ball parity test.
- The golden rules table.
- The query-count pin.
- Portal isolation, using the shared fixture `createMultiClientContact`
  (`PN/src/testing/portal-fixtures.ts`): a project-scoped contact never sees another project's or
  a client-wide item, and a contact of two clients gets two sections.
- A tooth seen red: an internal gate added to the portal payload fails the test.
- The milestone trigger.
- Capability inventory and MAP as in PV7-01.

### PV7-03: health on the client Overview, both sides (UI)

**Seat:** senior-fe, Sonnet. Needs PV7-02 on main.

- **Portal `/portal`:**
  - **Sections:** one section per client, which replaces the blended percent (finding 8).
  - **Per active project:** milestones done, due and late; late deliverables; next milestone;
    "Waiting on you" and "Waiting on us" with ages; and turnaround ("You usually reply in N days ·
    We usually reply in N days", or "Not enough yet").
  - **Results:** a client-wide contact also gets up to four headline numbers from the existing
    portal results route, linking to Business › Services & results.
  - **Project-scoped contacts:** they get the PV-D37 line for results.
  - **Reads:** a failed read says it could not be loaded, never zero.
- **Hub `/clients/[clientId]`:** the same block with the PV-3 "client sees this" markers. Staff also
  get the state chip and its reasons.
- **Tests and checks:**
  - Demo fixtures in `UI/lib/demoPortal.ts` (add the route to `OWNED`), and the staff hub's
    overview fixture.
  - `demoClientVisible.test.ts` parity.
  - Unit tests for the formatting (days, "not enough yet").
  - e2e `client-hub.spec.ts` and `portal.spec.ts` updated.
  - The axe portal sweep, which already lists `/portal`.

### PV7-04: client reports, publication (backend + UI)

**04a backend.** **Seat:** senior-be, **Opus**. **Contract:** BFF §55, PERMISSION §46.

- **Migration `202610151720_client_reports.sql`:**
  - **Table `client_reports`:**
    - **Columns:** `tenant_id`, `client_id`, and `project_id NULL`. The project must belong to the
      client, through a composite FK, as conversation threads do.
    - **More columns:** `source` (`social_report | search_report | account_summary`), `source_id`,
      `deliverable_id NULL`, `title`, `period_start` and `period_end`, `file_id`, and
      `status draft | published | withdrawn`.
    - **Status stamps:** `published_at` and `published_by`, and `withdrawn_at`, `withdrawn_by` and
      `withdrawn_reason`, with CHECKs that tie each stamp to its status.
    - **Uniqueness:** one live row per `(tenant_id, source, source_id)`.
    - **RLS:** the plain tenant policy.
  - **Table `client_report_reads(report_id, user_id, read_at)`.**
  - **The `files` CHECKs:** a new `files.role` value `client_report_pdf`, pinned to target
    `client_report`. This re-declares `files_role_check` and `files_role_target` whole: a DROP+ADD on
    a shared CHECK re-declares every value.
- **Delivery publishes:**
  - **What happens:** social and search `deliver`, in the same transaction, insert a `published`
    client report. It gets its own `files` row (role `client_report_pdf`, same storage key and sha256)
    and `deliverable_id` set when the deliverable row was made.
  - **Reach:** an engagement with no project gives a client-wide report.
  - **Already delivered:** reports delivered before this get no automatic backfill. A
    `client-reports:backfill --dry-run` script lists them, for the owner's go at the live drive.
- **Staff routes:**
  - `GET :t/clients/:clientId/reports` lists every status.
  - `POST :t/client-reports/:id/publish` and `POST :t/client-reports/:id/withdraw {reason}`.
  - The staff file download.
- **Portal routes:**
  - **List:** `GET :t/portal/reports` returns published reports only, through a new
    `clientReportInPortalScope`. A report on a project reaches that project's contacts and the
    client-wide contacts. A report with no project reaches client-wide contacts only.
  - **Read marker:** `POST :t/portal/reports/:id/read` sets the read marker.
  - **Download:** `client_report` joins `DOWNLOADABLE`, with an `ownsEntity` branch. A withdrawn or
    out-of-scope report is 404.
  - **Overview:** the overview payload gains `newReports`, the number published in the last 30 days
    and not yet opened by this user.
  - **Deliverables:** the portal deliverables payload gains `reportId` where a published report links
    the deliverable.
- **Notice on publish:**
  - `resolveClientRecipients(clientId, projectId, "report")` notification rows.
  - A new SSE topic, `reports`: add it to `TOPIC_BY_EVENT` and `TAILED_ENTITY_TYPES`, and update the
    UI's hand-copied union in `portal-links` and `PortalLive`.
  - No mail.
- **Cerbos, the new kind `client_report`:**
  - **Six artifacts.** A new kind is the policy, derived roles, the kind registry, the test matrix,
    the capability inventory and the PERMISSION section.
  - **`read`:** client readers.
  - **`draft`:** `company_admin`, `manager`, the client's owner (`owner_user_id`) and `automation`.
  - **`publish` and `withdraw`:** `company_admin`, `manager` and the client's owner, with
    `EFFECT_DENY` for the `automation` and `bot` kinds (L6).
  - **Portal reads:** they go through the `portal` kind and the scope builder, as every portal read
    does.
- **Tests:**
  - **Portal isolation:** the project-scoped versus client-wide matrix, a contact of two clients, a
    withdrawn report at 404, and a guessed file id at 404.
  - **Parity:** staff `clientVisible` matches portal reach.
  - **Delivery:** deliver creates exactly one published report and is idempotent on re-deliver.
  - **Cerbos matrix:** includes the bot deny.
  - **A tooth seen red:** an inline visibility literal fails the SWITCHED scan.

**04b UI.** **Seat:** senior-fe, Sonnet. Rebases on PV7-03.

- **Portal:**
  - **The Reports tab:** Overview becomes two tabs, Overview and Reports (`/portal/reports`). The list
    shows title, period, project or "Whole account", date, a "New" marker and Download PDF. A
    deliverable linked to a report shows "Open report".
  - **Badges and topics:** the nav badge comes from `newReports`, and `PortalLive` gains the
    `reports` topic.
  - **Coverage:** add `/portal/reports` to the axe `PAGES` and to the demo fixtures.
- **Hub `/clients/[clientId]/reports`:** a Reports tab under Overview. Every report shows its
  status. Publish and Withdraw ask for confirmation, and Withdraw asks for a reason. A published
  report carries the "client sees this" marker.
- **Tests:** unit tests and e2e.

### PV7-05: Clients › Health and Reports › Client (UI)

**Seat:** senior-fe, Sonnet. Needs PV7-01 and PV7-02 on main.

- **`/clients/health`, the board:**
  - **Columns:** Client; Health (the state chip and its reasons); Waiting on us; Waiting on client;
    Late work; Open requests; Unanswered messages; Overdue invoices; Site; Delivery on time.
  - **Filters and sort:** filter by state, owner and department (the DW-6d `departmentId` facet).
    The default sort is worst first. A row opens the client.
  - **Wiring:** an area rule in `UI/lib/areas.ts`, a tab on the Clients row in `UI/lib/workspaces.ts`,
    and the palette. Run `areas.test.ts` and `paletteFindability.test.ts`.
- **The clients list:** a Health column and a state facet, withheld if the health read failed.
- **`/reports/client?scopeRef=`:** `ReportPageClient` with grain `client`, six periods and a client
  picker. A "Delivery report" link goes on the hub Overview, and Reports gains the tab. Export and
  print reuse DW-4k's shared Export control and Print button (branch `dw/4k`, building
  2026-10-15). Build no second export control; if 4k has not landed yet, leave the page without
  export and say so.
- **Tests:** demo fixtures that mirror the golden rules table, unit tests, and an e2e of the board.

### PV7-06: My performance (UI only)

**Seat:** senior-fe, Sonnet, medium effort. Independent of every other ticket.

- **`/me/performance`, area `performance`:** the first row of the Performance block in
  `UI/lib/workspaces.ts` (`PERFORMANCE_ROWS`), plus the palette and an area rule.
- **The sections:** each reads on its own (the DW-3 `readResult` pattern) and is withheld behind its
  module gate.
  - **Your numbers:** the person-grain document for the selected period, through the same reads as
    the Overview's `YourNumbers`, with a link to My report (`/reports/person`).
  - **Check-ins:** the streak, compliance and the last 14 entries from `GET /checkins` (self), with
    a link to the day's check-in.
  - **Appraisal:** the latest appraisal from `GET /appraisals/mine`, showing its state and whether
    it is acknowledged, with a link to Appraisals › Mine.
  - **Learning:** outstanding, mandatory and overdue enrolments from `getMyLearning`, wrapped so
    that a failure says "unavailable", never "no training". It links to My learning.
  - **Your time:** hours logged in the period from `GET time-entries?mine=me`, labelled "context,
    not a score" (blueprint §11 principle 5).
  - **Activity:** a link to the year map through the existing `MY_ACTIVITY_HREF` constant. DW-4i
    re-points that constant when it moves the map; this ticket moves nothing. If the page ever
    shows activity counts, they come from DW-4h's core `GET /activity/series` (BFF §44: counts by
    kind, no total, no score, gated by the person-axis rule), never from a reader of its own
    (DW-D19).
- **Never on the page:** a composite score; utilization or hours next to the appraisal; or another
  person's data. A test asserts the appraisal section renders no `effort.*` figure.
- **Tests:** demo fixtures, unit tests, and an e2e that opens the page from the sidebar and the
  palette.
- **Not in this ticket:**
  - The Me › Timesheet tab showing everyone's entries (finding 10). It is DW-8's surface, and the
    lead hands it to the DW-8 session.
  - The time-entries reach (PV7-Q5).

### PV7-07: the account summary (backend + UI)

**Seat:** senior-be, Sonnet. Needs PV7-01, PV7-02 and PV7-04 on main. **Contract:** BFF §56.

- **What it is:** a monthly report per client that is safe to show the client. It is built only
  from what a client-wide contact may see:
  - project health from PV7-02's portal projection;
  - milestones and deliverables completed in the month;
  - turnaround on both sides;
  - the Services & results numbers, frozen;
  - the reports published that month.
  It has no money (PV-D38), no tasks, no time and no people.
- **Draft:** `POST :t/clients/:clientId/reports/summary {period: "YYYY-MM"}`.
  - It writes a `client_reports` row with `source = account_summary` and `status = draft`.
  - It freezes the JSON snapshot.
  - It writes an AI narrative draft that staff edit. `narrativeSource` is frozen with it, as social
    reports do.
- **PDF:** the snapshot is built as a `ReportDocument` (grain `client`, as `buildSocialReportDocument`
  does), so the existing print page and the one-shot token render it at publish. The sha256 goes on
  the file.
- **Hub Reports tab:** "Draft account summary", the narrative editor, and Publish.
- **Tests:** the snapshot carries no `effort.*`, no task title and no person name (a tooth seen red);
  a project-scoped project's data is limited to the client-wide view; and a published summary is
  immutable.

### PV7-08: agent tools (agentic-native bar)

**Seat:** medior, Sonnet. Needs every route on main.

| Tool | Route | Impact |
|---|---|---|
| `clients.getHealthBoard` | `GET :t/clients/health` | read |
| `clients.getHealth` | `GET :t/clients/:clientId/health` | read |
| `clientReports.list` | `GET :t/clients/:clientId/reports` | read |
| `clientReports.draftSummary` | `POST :t/clients/:clientId/reports/summary` | low (a draft; nothing reaches the client) |

- **Staff only:** `publish` and `withdraw` are not tools (L6).
- **Already done:** `reports.getDocument` with `grain=client` comes with PV7-01.
- **Policy rows:** add the hub's policy rows. Watch the GET path-template rule: a filter must sit in
  `pathTemplate` as `?k=:k`.
- **Inventory:** regenerate the capability inventory.

### PV7-09: QA gate, release, live drive

- **The gate:** a merged-tree gate on GitHub Actions (`ci.yml` and `docs-map.yml` on the exact sha).
  - Read the job counts, not just the conclusion.
  - Every tooth must have been seen red.
  - Run the e2e and axe sweeps for the portal and the staff hub on sumopod, one gate at a time.
- **Release, then the live drive:**
  - **As the owner:**
    - **Client grain:** the client-grain document for a seeded client. Additive KPIs equal the sum
      of its projects.
    - **Board:** it loads all live clients, the state reasons read sensibly, and a client with a
      late deliverable is at risk.
    - **Publish and withdraw:** publish a labelled test report, see it, then withdraw it.
    - **Delivery:** deliver a labelled social report and it appears.
    - **My performance:** it renders every section or says why not.
  - **As a placeholder portal contact:**
    - **Health:** per-project health, and the PV-D37 line for a project-only contact.
    - **Reports:** the test report shows "New"; the download works; after withdraw it is 404.
  - **Teardown:** keep a teardown list and delete every test record.

## Open for the owner (non-blocking)

| # | Question | Lead's default, used until ruled |
|---|---|---|
| PV7-Q1 | May clients see delivery numbers computed from our internal tasks (for example "92% of tasks on time")? | **No.** Clients see figures from what they can already see: milestones, deliverables, approvals, requests and conversation. Task and time figures stay internal (plan §3.4) |
| PV7-Q2 | May a contact limited to some projects see the health of those projects? | **Yes, for those projects only.** Results, client-wide reports and the account summary stay with client-wide contacts (PV-D33, PV-D37) |
| PV7-Q3 | May the published social and search reports show the client's own ad spend and budget pacing? | **Yes**, the client's own spend with the ad platforms, as those reports show it, because PV-D38 put spend with the client reports. Never our fees, cost or margin. The account summary shows no money |
| PV7-Q4 | When is a client at risk or off track? | **At risk:** anything waiting on us 7 days or more (today's hub rule), any late deliverable or milestone, any overdue invoice, any open site incident, or anything waiting on the client 14 days or more. **Off track:** anything waiting on us 14 days or more, work 14 days or more late, an invoice 30 days or more overdue, or a site incident open 24 hours or more |
| PV7-Q5 | Every member and viewer can list every colleague's time entries (finding 11). Narrow it? | **Unchanged until ruled.** Recommendation: narrow the unfiltered list to your own entries plus the reports' line of sight (your reporting line, HR, company-wide), and keep a project's entries visible to people who can read the project. PV-7 itself reads only your own |
| PV7-Q6 | Should the account summary draft itself every month? | **Not yet.** Staff or an agent draft it on demand; an automatic monthly draft (n8n) later if wanted |

## Not in PV-7 (and where each goes)

| Item | Why not now | Goes to |
|---|---|---|
| Client health across group companies | One request per company; cross-company views belong to the Group tier | PV-9 |
| Mail to the client when a report is published | Needs the mailer | "Before real clients use the portal" |
| A portal notification inbox | The "New" badge and the SSE hint cover v1 (PV-4 also deferred it) | a portal follow-up |
| Moving the year map; export and print on report pages; the all-work activity series | Owned by DW-4i, DW-4k and DW-4h | DW-4 |
| Me › Timesheet lists everyone's entries | DW-8's surface (finding 10) | DW-8, handed over by the lead |
| Client health on the Overview dashboard or the GM console | DW territory; the board link covers v1 | DW-10 "Personalise the Overview" |
| Report branding per client | Blueprint §13 deferral | later |
| Viceroy's own performance views | PV-D3 | PV-8 |
