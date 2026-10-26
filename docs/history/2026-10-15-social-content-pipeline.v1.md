> **Superseded on 2026-10-26** by `docs/plans/2026-10-15-social-content-pipeline.md`, re-planned for the Social Media
> team's v2 design. Kept unchanged below as the record of the 15 Oct plan.

# Social Media content pipeline (SCP): plan

Status: PLANNED, 2026-10-15. Board: `TASKS.md` › "Social Media content pipeline" (program key `smm-pipeline`).
Comparison and combined mockups (sidebar, Overview, pipeline, content plan, post drawer, portal):
https://claude.ai/artifact/2UF5vQZ4uqpPfcRvmMftAA

This file sits in the workspace folder, not the repo, until SCP-0a lands it on main. It holds no client or staff
names on purpose, so it can go into the public repo as it is. Keep it that way.

**To start a session on a phase:** open a session in the workspace folder and say "Work on SCP-1 from TASKS.md".
Read §1 to §4 first, then your phase in §8, then §9 (how work lands here).

---

## 1. Goal

The Social Media team plans, makes, approves, schedules, monitors and boosts every post inside the ERP. They stop
using the Excel / Google Sheet (the allocation tab, one tab per officer, the content plan rows) and the separate
"GAIA Content Approval" app.

The team's design (`gaia-content-pipeline.html`, received 2026-10-15, sample data only) is the reference for the
workflow and the views. The ERP's social module is the engine. Section 6 explains how the two combine.

**The flow, per post** (from the design):

1. **Planning.** A row in the client's monthly content plan. Owner: the client's SMM Officer.
2. **Creative.** A designer makes the asset. Revisions return here.
3. **Internal review.** The SMM Officer **and** the SMM Lead both approve. Either may send it back to Creative
   with a note.
4. **Client review.** The client approves or asks for changes. Changes go back to Creative.
5. **Scheduling.** Date, time and platforms (IG, FB, IG Story, TikTok).
6. **Live and monitoring.** Metrics are logged and boost candidates spotted.
7. **Boosting.** A budget request, the client's approval of the budget, the run and its results.

## 2. Rulings and decisions

| # | Date, by | Decision |
|---|---|---|
| SCP-D1 | 2026-10-15, owner | **Mock seed only; dev review.** In the owner's words: "we still going to use mock data as seed. as this is still dev review only. and we need to ensure that it will work. so we need to simulate everything to see if its working." Every step runs end to end on mock data: publishing, metrics, client decisions and boosts. |
| SCP-D2 | 2026-10-15, plan | **Build on the existing social module.** The design's own `/api/smm` store is not built. Posts stay `social_posts` and their per-network `social_post_variants`. The calendar, portal review, publish gate, metrics, KPI readers, Overview and reports therefore keep reading one record. The design's role and stage rules (`Workflow.check` / `apply`) move server-side, as the design itself says. |
| SCP-D3 | 2026-10-15, plan, from SCP-D1 | **A labelled simulator, for the dev stage only.** This reverses the module's own "no simulator" rule (`platform-nest/src/modules/social/publisher/mock-driver.ts` header and `publisher/boot.ts`). That rule exists because a fake publish is "a post that never appeared on a client's account while our calendar said it did". The guardrails in §5 answer that hazard. The precedents are search's SM-33 simulated providers and PV-D41's simulated Midtrans. **Before real data:** the flag goes off (add it to "Before real clients use the portal"). |

| SCP-D4 | 2026-10-15, plan (the owner asked whether this duplicates the Repsona-style PM) | **A post is content; a task is work. There is no second task system.** The PM module (the Repsona clone: Ball, custom statuses, board, templates, recurrence) keeps all work that is not a single post. That means the client's content month as one deliverable task, the monthly cycle, onboarding, the Creatives request, campaigns and ad-hoc work. The pipeline keeps only what a PM task cannot hold: the post's content, its per-network versions, the two-person and client approvals tied to the exact content, publishing, metrics and boosts. **No PM task is created per post.** Comments, history, notifications, "Needs you" and the board component are shared, not rebuilt. See §4.5. |

**Open, with defaults in force** (non-blocking; the owner may overrule any of them at any time):

| # | Question | Default in force |
|---|---|---|
| SCP-Q2 | Who does the Creative step? | The Creatives department, through the existing work requests (DW-D14), with **one request per client per month** and every post a line on it. |
| SCP-Q3 | What does the client's approval page look like? | The ERP portal's look, with the design's layout: month feed, Feed / Story tabs, grid preview, approve all. |
| SCP-Q4 | Who must approve internal review? | **Both** the client's SMM Officer and the SMM Lead, on every post. One person never fills both slots. |
| SCP-Q5 | What is in the first release? | SCP-1 to SCP-4 plus SCP-S, with SCP-7 as the proof. SCP-5 comes after. SCP-6 waits for real data. |
| SCP-Q6 | Who is the design's "Project Manager"? | The client's account manager (`clients.owner_user_id`). |

## 3. What exists today (read from origin/main, 2026-10-15)

### Backend

The backend is `platform-nest/src/modules/social/`: about 50 routes under `api/:tenantId/modules/social`. The schema
is `migrations/0105_module_social.sql` plus later files. `docs/plans/smm-tracker.md` covers SMM-01 to SMM-40 and has
been idle since 2026-08-23.

- **`social_engagements`.** One per client. Holds `tool_scope` (jsonb, with `posting.requiresClientOk` and
  `posting.cadencePerWeek`), `owner_id` and `custom_fields`. Status: `draft|active|paused|closed`. Live has none.
- **`social_posts`.**
  - Columns: title, brief, `scheduled_at`, `custom_fields`.
  - Status: `idea|draft|in_review|approved|scheduled|publishing|published|partially_published|failed|archived`.
- **`social_post_variants`.** One per account and network.
  - Columns: body, `media` refs `[{fileId,kind,alt}]`, `settings` (e.g. `{igType:'reel'}`), `args_sha256`,
    `approval_id`, `provider_post_id`, `published_url`.
  - Status: `draft|in_review|approved|queued|publishing|published|failed|cancelled`.
  - Any edit sets the variant back to `draft` and clears its approval.
- **Publish gate (SMM-09/40).** Approving a variant mints a D14 `automation_approvals` row bound to `args_sha256`.
  Dispatch (`dispatch.ts`) goes through Postiz (`publisher/postiz.ts`, not deployed) or the `direct` driver
  (LinkedIn and YouTube, credential-gated). Status comes back through `post-status-sync-job.ts` and
  `POST webhooks/post-status`. The validator is `media-rules.ts`.
- **Client review (SMM-31/32).**
  - `social_post_client_reviews` is one row per **variant** (`UNIQUE(variant_id)`), with status
    `pending|approved|changes_requested|withdrawn`, `reviewed_args_sha256`, comment and decided_by.
  - Staff: `POST variants/:id/client-review`, `…/withdraw`.
  - Portal: `GET :tenantId/portal/social-reviews` and `POST …/:id/decide`, which needs Cerbos `portal:approve_post`.
  - The publish gate refuses until the review is approved, when `requiresClientOk` is set.
- **Metrics (SMM-21).** Nightly pulls only (`metrics-job.ts`) into `social_metrics_daily` and the append-only
  `social_post_metrics`. There is no way to enter metrics by hand.
- **KPI readers (DW-6n).** In `src/modules/reports/dept-kpi-readers/delivery/social.ts`: posts on schedule, client
  approval turnaround, engagement growth.
- **Reports (SMM-23).** `social_reports` (`monthly|campaign|adhoc`; `draft|in_review|approved|delivered`) lead into
  PV7-04a `client_reports`, which publishes them to the portal.
- **Cerbos kinds.** `social_post`, `social_client_review`, `social_account`, `social_engagement`, `social_inbox`,
  `social_report`, plus Creatives' `creative_asset` (DW-6h review rounds: one decision per round).
- **Building blocks.**
  - `work_requests`: an assets request becomes a PM task in Creatives' Requests project and records delivered
    assets.
  - `pm_tasks` and the PM board.
  - The comment threads.
  - `writeActivity()` writes `work_activity`.
  - The notification handlers.
  - Drive (§42, OAuth client not set up).
  - Figma links (§36).
- **Nothing exists yet** for:
  - planning fields: format, pillar, on-asset text, content month;
  - a Creative stage;
  - a two-person internal review;
  - boosting;
  - per-client quota and delivery batch;
  - the monthly cycle;
  - a social audit;
  - a social onboarding checklist.

### Frontend

The frontend is `platform-ui/src`, and `{D}` below stands for `app/(app)/departments/[deptId]`.

- **The Social Media workspace.** `SOCIAL_MEDIA` in `lib/workspaces.ts` has these Work rows:
  - PM;
  - Publish (Calendar, Composer, Inbox);
  - Requests;
  - Campaigns;
  - Clients.

  The Performance block is shared. The pulse tiles are "Posts scheduled" and "Failed posts". "Waiting client
  review" and "Unanswered inbox" are ticketed and hidden.
- **Calendar.** `{D}/calendar` uses `components/social/CalendarGrid.tsx`: Sunday-first, drag to reschedule, no stage
  colours.
- **Composer.** `{D}/composer` and `{D}/composer/[postId]`: per-network variant cards, validation, quota strip,
  request client review.
- **Analytics.** `{D}/analytics` (`AnalyticsPanel`) has no engagement rate and no boost logic.
- **Inbox.** `{D}/inbox` says "no inbox yet" until a publisher offers inbound.
- **Portal.** `app/(portal)/portal/social-reviews` and `/[reviewId]` show the body text and **only an attachment
  count**. There is no image, no grid, no approve-all and no month view, and there is one card per network variant.
- **Reusable pieces.**
  - `components/pm/Board.tsx`: generic columns, drag and a keyboard move menu.
  - `components/overlay/Drawer.tsx` and the `TaskDrawer` intercepting-route pattern.
  - `components/pm/CommentThread.tsx` (already used for `creative_asset`).
  - `components/data/DataTable.tsx` (read-only).
  - `HairlineTable` and `StatusBadge`.
  - `lib/queue.ts` ("Needs you"), which has no social source.
  - **There is no inline-edit or paste-rows table.**
- **Tokens.** There are four status families (ok sage, progress bronze, idle, critical rust). There are no stage
  colours.

## 4. Target model

### 4.1 Roles

| Design role | In the ERP | Notes |
|---|---|---|
| SMM Officer | A Social Media member set as the client's officer on the allocation (SCP-1a) | Acts on the clients assigned to them. Managers act on all. |
| SMM Lead | The Social Media unit's head (`org_unit_lead`, DW-4g/D15), or a `social_manager` | Fills the lead slot. |
| Creative | A Creatives member working the client-month request (SCP-Q2) | Sees the Creative queue in the Creatives workspace too. |
| Project Manager | The client's account manager, `clients.owner_user_id` (SCP-Q6) | Can do most staff steps. Gets "overdue" in Needs you. |
| Client | A portal contact of that client | Decides reviews and boost budgets in the portal. |

The design's "Viewing as" picker does not exist in the ERP. The signed-in person is the actor, and Cerbos decides.
Mock seed gives each role a login (SCP-0c).

### 4.2 Data (migrations are a contract-first job for SCP-0b; names are proposals)

- **Allocation, on `social_engagements`** (real columns, because they are queried):
  - `smm_officer_user_id`;
  - `posts_per_month`;
  - `stories_per_month`;
  - `delivery_batch` (`'A'|'B'`);
  - `platforms text[]`;
  - `report_order`;
  - `content_pillars text[]`.
- **On `social_posts`:**
  - `content_month` (date, the first of the month);
  - `format` (`'carousel'|'static'|'reels'|'story'`);
  - `pillar`;
  - `topic` (or reuse `title`);
  - `caption` (the master caption, copied into the variants);
  - `on_asset_text`;
  - `pipeline_stage` (`'plan'|'creative'|'internal_review'|'client_review'|'scheduling'|'live'|'boost'`);
  - `pipeline_sub` (`'rev_internal'|'rev_client'|'awaiting'|'ready'|'scheduled'|'failed'` or null);
  - `revisions_internal`, `revisions_client`;
  - `asset_ref` (a `creative_assets` version id, or a Drive URL);
  - `posted_url`, `went_live_at`;
  - `simulated boolean`.

  `pipeline_stage` drives the work. The existing `status` stays the publish engine's field. One mapping holds them
  together, and a test pins it:

  | `pipeline_stage` | `status` |
  |---|---|
  | `plan`, `creative`, `internal_review` | `draft` |
  | `client_review` | `in_review` |
  | `scheduling` | `approved`, then `scheduled` |
  | `live`, `boost` | `published` |
- **`social_post_internal_approvals`:** `post_id`, `round`, `slot` (`'officer'|'lead'`), `decision`
  (`approved|changes_requested`), `note` (required for changes), `content_sha256` (asset plus caption), `decided_by`,
  `decided_at`. A new round opens on every submit.
- **Client review:** reuse `social_post_client_reviews` per variant. Two additions:
  - one request covers all of a post's variants, and one portal decision applies to all of them in one transaction;
  - staff can record a decision made outside the ERP, with new columns `recorded_by` (staff) and `channel`
    (`whatsapp|email|meeting`).
- **Variants are created when the post goes to client review**, one per allocated platform, seeded from the master
  caption. Per-network changes stay in the Composer, and the existing rule that an edit clears an approval still
  holds. IG Story is an Instagram variant with `settings.igType='story'`, not a new network.
- **Metrics:** `social_post_metrics.source` (`'pull'|'manual'|'simulated'`), plus a manual-entry endpoint. The
  engagement rate is (likes + comments + saves + shares) ÷ reach. A boost candidate is a post whose engagement rate
  is at least 1.25 × its account's average.
- **`social_boosts`:**
  - `post_id`;
  - `status` (`requested|approved|running|completed|cancelled`);
  - `budget_minor` with `currency` (IDR);
  - `days`;
  - `objective` (`reach|engagement|profile_visits|messages`);
  - `requested_by`;
  - `approved_by` and `approved_via` (`portal|recorded`);
  - `started_at`, `completed_at`;
  - `spend_minor`, `paid_reach`, `clicks`;
  - `simulated`.

  Money is in minor units. The client sees their own budget and spend (PV-D38) and never our fees.

### 4.3 Stage machine (server-side; every action writes `work_activity` and history)

| Action | From → to | Who | Guards and effects |
|---|---|---|---|
| edit plan fields | `plan` | officer of the client, lead, account manager, manager | Only while in `plan`. |
| `send_to_creative` | `plan` → `creative` | officer, lead, account manager | Needs topic, format, a date inside the content month. Adds a line to the client-month Creatives request (opens it if none). |
| `submit_for_review` | `creative` → `internal_review` | the designer on the request, account manager | Needs an asset (a library version or a Drive link). Opens a new round with both slots pending. |
| `approve_internal` (slot) | `internal_review` | officer slot: the client's officer; lead slot: the unit head or `social_manager` | One person never fills both slots. When both slots approve: move to `client_review` (`awaiting`), create the variants, request client review on each. |
| `request_changes_internal` | `internal_review` → `creative` (`rev_internal`) | officer, lead | Needs a note. Adds one to `revisions_internal`. |
| `client_approve` | `client_review` → `scheduling` (`ready`) | the client in the portal; or officer or account manager recording it, with channel and note | Every variant's review is approved with its hash. |
| `client_request_changes` | `client_review` → `creative` (`rev_client`) | the client, or recorded by staff | Needs a note. Adds one to `revisions_client`. Resets the internal approvals. |
| `schedule` | `scheduling` (`ready` → `scheduled`) | officer, account manager | Needs date, time, at least one platform with an account, the validator passing and the client review approved. Dispatches to the publisher (simulated in dev). |
| `unschedule` | `scheduled` → `ready` | officer, account manager | Cancels the dispatch. |
| `mark_live` (by hand) | `scheduled` → `live` | officer, account manager | Needs the post's link. Used when no publisher is configured. |
| publisher result | `scheduled` → `live`, or `failed` | system (webhook or simulator) | Live when every variant is published. A failure shows on the Failed posts tile. |
| `log_metrics` | `live` | officer, account manager | Every number ≥ 0. Writes `source='manual'`. |
| `request_boost` | `live` → `boost` (`requested`) | officer, lead, account manager | Budget > 0, days > 0, no open boost. |
| `approve_boost_budget` | `requested` → `approved` | the client in the portal, or recorded by staff | Recorded approvals carry channel and note. |
| `start_boost` | `approved` → `running` | lead, account manager | |
| `complete_boost` | `running` → `completed`, post back to `live` | lead, account manager | Needs spend and paid reach. Warns when spend is above budget. |
| `cancel_boost` | open → `cancelled`, post back to `live` | officer, lead, account manager, the client | |
| delete | `plan` only | officer, lead, account manager | Outside `plan`, posts are archived instead. |

A content edit after client approval sends the post back to `client_review`: the existing hash rule does this. Each
action is a Cerbos action on `social_post`, so no new kind is added except `social_boost` if SCP-0b chooses one.
Every attribute a condition reads must be on the resource's allow-list. These are: the officer id, the account manager
id, the unit lead ids and the round's earlier decider.

### 4.4 Delivery markers and overdue

For content month M:

- **Batch A** is due on the last working day on or before the 15th of month M−1.
- **Batch B** is due on the last working day of month M−1.

A post is **overdue** when it is still before `scheduling` after its marker. Working days are Monday to Friday, in
the company's timezone. Public holidays are an open item (§10).

### 4.5 What stays in PM (SCP-D4)

| Work | Lives in | How the two meet |
|---|---|---|
| One post: caption, asset, per-network versions, approvals, publishing, metrics, boost | **Pipeline** (`social_posts`) | |
| A client's content month ("November content", for example) | **PM**: one task per client and month in the client's project, due on the delivery marker, Ball on the officer | Progress is computed from the pipeline (posts past client approval ÷ quota). It is done when every post is approved. It shows on PM's board, Timeline, Ball and workload, and counts in "on time". |
| The monthly cycle (report, planning, copy lock, client window, artwork, deploy) | **PM**: tasks generated per client and month (SCP-5b) | Steps the pipeline can see close themselves. For example, "Artwork production" closes when the month's last post leaves Creative. |
| The designer's work | **PM**: the Creatives request's task in Creatives' Requests project (DW-5) | The month's posts are its lines. The designer works in Creatives' own PM board. |
| Onboarding a new client | **PM**: a project template (SCP-5e) | It replaces the "Repsona project" step in the team's checklist: the client's ERP project is that project. |
| Campaigns, ad-hoc and internal tasks | **PM** as today | |
| Comments, history, notifications, "Needs you" | **Shared** | The pipeline uses the generic comment thread (entity `social_post`), `work_activity`, the notification handlers and `lib/queue.ts`. It adds no tables of its own for these. |
| Board, drawer, table components | **Shared** | `components/pm/Board.tsx` and the `TaskDrawer` pattern are reused. Only the inline-edit plan table is new, and PM may reuse it. |

**Why posts are not PM tasks:**

- A PM status is a column that anyone with edit rights may move. The pipeline's steps carry rules a column cannot:
  two different approvers, a client decision in the portal, approval tied to the exact content, a publish, and
  metrics.
- About 300 posts a month as tasks would flood PM's boards and distort "tasks done" in each officer's numbers.
- A post-per-task mirror would need syncing both ways, which is a constant source of drift.

## 5. Simulation (SCP-D1, SCP-D3)

The goal is that one person can walk a whole mock month through all seven stages, as every role, and see every number
move, without any real network account.

- **Flag.** `SOCIAL_SIMULATION_ENABLED=1`, read through `config.ts`. Boot asserts that the simulator and a real
  publisher (Postiz or a credentialed `direct`) are never both registered (the SM-33 pattern). It also refuses when
  any non-simulated `social_accounts` row exists for the tenant.
- **Simulated accounts.** These are seeded `social_accounts` rows (IG, FB, TikTok) per mock client, with
  `simulated=true` and handles like `@mock-<client>`.
- **Simulated publisher driver** (`publisher/simulated-driver.ts`, separate from the test double `mock-driver.ts`). It
  takes the real dispatch path:
  1. A job publishes due variants every minute. "Publish now (simulated)" is available too.
  2. It returns `published_url` on `https://simulated.invalid/…` and sets `simulated=true`.
  3. A caption containing `[simulate-fail]` fails, which exercises the failed-post path.
- **Simulated metrics.** A deterministic generator, seeded by the post id, writes `social_post_metrics`
  (`source='simulated'`) one, three and seven days after go-live, plus daily account rows. Reels are higher and stories
  lower, as in the design.
- **Simulated boosts.** A started boost completes after a short, configurable time, with spend at or below budget,
  paid reach and clicks.
- **Client decisions.** These are real portal logins on the mock clients: the 19 `portal@<client>.test` placeholders,
  invited, accepted and revoked as proven in release 386. Staff can also "record on the client's behalf".
- **Marking.**
  - Every simulated row carries `simulated=true`.
  - Every screen that shows one carries a SIMULATED chip.
  - A report built from simulated numbers is watermarked SIMULATED, in the PDF as well.
  - The KPI readers include simulated rows only while the flag is on, and their tiles say so.
- **Before real data.** The flag goes off and the simulated rows are purged by a script. This is listed under "Before
  real clients use the portal".

## 6. How it fits the new Social Media dashboard (the workspace shell)

URLs never move. New pages get new URLs under the department, and every page keeps exactly one area (the DW-1c test).
The top-level `/pipeline` and `/monitoring` are **Web Dev's** pages, so the Social pages use other words.

**Sidebar, Social Media workspace, after the change:**

- Overview · AI Assistant
- **Work**
  - **Content:** Pipeline `{D}/content` · Content plan `{D}/content/plan` · Calendar `{D}/calendar` (kept) · Client
    review `{D}/content/review`
  - **Live:** Monitoring `{D}/live` · Boosting `{D}/boosts` · Inbox `{D}/inbox` (kept)
  - Project Management: kept for all work that is not a single post. That covers the client's content-month task,
    the monthly cycle and onboarding (SCP-D4, §4.5).
  - Requests · Campaigns · Clients. Clients gains Allocation, and later Onboarding and Audit.
  - The Composer is no longer a row. It becomes the per-network step of a post: `{D}/composer/[postId]` is kept and
    findable from ⌘K.
- **Performance** (the shared block): Reports gains "Monthly client reports" and "Team load"; Analytics gains
  "Insights" beside "Reach and engagement".
- Tools & connections: Social accounts (simulated in dev), Drive, Claude seats.

**A post** opens as a drawer over any list (the `TaskDrawer` intercepting-route pattern) at `{D}/posts/[postId]`. The
drawer shows the stage stepper, preview, caption, "next step for you", comments, history, and the Composer link for
per-network edits.

**The Overview** (DW-3 bands; no faked numbers, and a refused read says so):

- **Now.** "Needs you" gains the pipeline. This is the design's `needsMe`, per role:
  - officer: plan rows to send, my approval slot, ready to schedule, metrics missing after two days;
  - lead: my approval slot, boosts approved but not started;
  - designer: the Creative queue;
  - account manager: overdue items.

  "Today" shows posts going out today and the delivery markers this week.
- **Department.** The pulse tiles become: In creative · Waiting internal review · Waiting client (this closes the DW-3e
  ticket) · Overdue · Scheduled this week · Failed posts · Boosts waiting. The KPI strip and banner stay.
- **Work.** Next month's plan per officer, as planned / quota and done; projects, campaigns and requests as today.
- Quick actions: "Add to content plan" and "Compose a post".

**The Creatives workspace** gains its share of the Creative queue in its Requests and Incoming views (one request per
client and month).

**The portal.** `/portal/social-reviews` becomes the month's plan for the client:

- Feed and Story tabs, a grid preview, images, progress, and approve all;
- one card per post, not per network;
- boost budgets wait in `/portal/approvals`.

## 7. Model tiers (global rule: the cheapest model that fits; Opus only for risky cores and reviews)

| Kind of work | Model | Why |
|---|---|---|
| Contract, migrations, stage machine, Cerbos, the simulator's containment, boost money | Opus | Risky cores. |
| Pages, components, portal UI, the import tool, readers | Sonnet | Specified implementation work. |
| Registry rows, seed fixtures, demo data, docs edits | Haiku | Mechanical. |

Every agent diff is reviewed by the orchestrating session before it lands.

## 8. Phases and acceptance

Every ticket is ticked only when DEV-VERIFIED: driven on a Linux server (sumopod gate or CI) with the result seen,
and, once deployed, checked on the live ERP's mock seed.

### SCP-0 · Decisions, contract and plan

- **0a.** This plan goes to `docs/plans/` on main as it is (no names), and SCP-D1 to D4 go into its decision log.
- **0b.** Contract first:
  - a BFF section for every pipeline route (shapes, refusals, idempotency);
  - a permission section for every Cerbos action and attribute;
  - the migration list, with timestamps after main's newest;
  - the stage-machine table as a fixture that both sides test against.
- **0c.** A mock-seed plan:
  - DEMO_MODE personas: officer ×2, lead, designer, account manager, client;
  - live mock-seed logins for the same roles, as labelled test users on a teardown list, plus the portal
    placeholders;
  - mock clients' allocations.

### SCP-1 · The pipeline for staff: planning to internal review

| Ticket | Acceptance |
|---|---|
| 1a Allocation | The officer, quotas, batch, platforms and pillars can be set per client. The Clients › Allocation tab lists all clients with their officer and batch. Refused for non-managers. |
| 1b Content items + stage machine | Every row of §4.3 up to internal review is enforced server-side, and each refusal has its own code. The table fixture runs green in nest and ui. Activity is written. The status mapping is pinned. |
| 1c Content plan | A sheet-like table per client and month: editable while in `plan`, tab to the next cell, saves per cell. "Paste from spreadsheet" takes the design's column order (date, format, pillar, topic, caption, on-asset text) and refuses bad rows with a reason each. "N of quota" is shown. Bulk "Send to Creative". |
| 1d Pipeline board | Seven columns with counts. Filters: month (active = this month and next), client, officer, format, search. "Needs you" only. A card moves only by an allowed action, with the reason shown when it is not allowed. Bulk send; bulk lead approval. Performs at 600 cards. |
| 1e Post drawer | Stage stepper, preview, next step for my role (buttons disabled with the reason), comments, history, Composer link. Comments use the shared comment thread and history uses `work_activity`, so no new tables are added for either (SCP-D4). |
| 1l Content month in PM | One PM task per client and month in the client's project. It is due on the delivery marker, with Ball on the officer and progress computed from the pipeline, and it is done when every post is client-approved. **No PM task per post** (a test proves it). It shows on PM's board, Timeline, Ball and workload, and in "on time". |
| 1f Creative step | One Creatives request per client and month. The designer sees the queue, attaches a library version or a Drive link, and sees revision notes. |
| 1g Internal review | Two slots. Changes need a note and go back to Creative. Revision counts. One person cannot fill both slots (proved by a test). |
| 1h Delivery markers | The batch rule from §4.4, tested on month ends, weekends and the year turn. Overdue and due chips. "Needs you" items per role on the Overview. |
| 1i Sidebar | The registry rows from §6. Every new page is findable in ⌘K. The palette test and the page-home test stay green. |
| 1j Seed | Mock clients with allocations and one month of planned posts (no real names), in DEMO_MODE and the live mock seed. |
| 1k e2e | Officer, lead, designer and account manager each walk their part on sumopod. |

### SCP-2 · Client review in the portal

| Ticket | Acceptance |
|---|---|
| 2a Month feed | The client sees their month: Feed and Story tabs, approved / changes / waiting, progress bar. |
| 2b Images and grid | The asset preview is served through the portal's file route, so a portal user sees only their client's files. A grid preview of the feed. |
| 2c Approve all; one decision per post | One decision applies to all of a post's variants in one transaction. Approve all approves only what is waiting. |
| 2d Recorded decisions | Staff record a WhatsApp or email decision with channel and note. It is shown as "recorded by …" to staff and the client. |
| 2e Changes loop | Client changes go back to Creative and reset the internal approvals. The client's note shows to the designer. |
| 2f Proof | Portal e2e on DEMO_MODE, plus a live drive as a placeholder portal login (invite, accept, decide, revoke). |

### SCP-S · Simulation (runs beside SCP-3 and SCP-4; Opus for the containment)

| Ticket | Acceptance |
|---|---|
| Sa Flag and containment | Boot refuses the simulator beside a real driver or a real account (proved by a test). The flag is visible in `config.ts` and in the health output. |
| Sb Simulated accounts | Seeded per mock client. Connections shows them as SIMULATED. |
| Sc Simulated publisher | Due variants publish through the real dispatch path. The failure keyword fails. The KPI "posts on schedule" moves. |
| Sd Simulated metrics | Deterministic numbers on day 1, 3 and 7. Monitoring and Analytics show them with the SIMULATED chip. |
| Se Simulated boost run | A started boost completes with results. |
| Sf Marking | Every simulated row and screen is marked, and reports are watermarked. A test fails if any simulated row renders without the chip. |

### SCP-3 · Scheduling and live

| Ticket | Acceptance |
|---|---|
| 3a Schedule | Date, time, platforms. Validation from `media-rules.ts`. The calendar is coloured by stage, Monday-first, with the legend. |
| 3b Live | The simulated publisher takes posts live in dev. "Mark as live" with a link works when no publisher is configured. |
| 3c Metrics by hand | Next to pulled and simulated numbers. Engagement rate and boost candidates as in §4.2. |
| 3d Monitoring | The live list with numbers, missing-metrics and candidate flags. The KPI readers count the pipeline (posts on schedule, approval turnaround). |

### SCP-4 · Boosting

| Ticket | Acceptance |
|---|---|
| 4a Request | Budget (IDR), days and objective on a live post. Contract first; money in minor units. |
| 4b Client budget approval | In the portal's approvals, or recorded by staff. |
| 4c Run and results | Start, then complete with spend, paid reach and clicks, or cancel. The Boosting view has candidates, a status board and totals. |

### SCP-5 · Management views (after SCP-Q5)

| Ticket | Acceptance |
|---|---|
| 5a Team load | Per officer: next month by stage, planned against quota, revision rounds, waiting on them. It is a block on the Overview's Team view and in Reports › Team, not a page of its own, because PM's workload already covers task load (SCP-D4). |
| 5b Monthly cycle | The design's cycle (report, planning, copy lock, client window, artwork, deploy) as PM tasks generated per client and month from the batch rule. "Insights" reads them, not a sheet. |
| 5c Monthly report | The design's deck sections on the SMM-23 builder, with editable numbers. Published through client reports (PV7-04a). |
| 5d Audit | The twelve-dimension scorecard: automatic from pipeline data for existing clients, typed in for prospects. |
| 5e Onboarding | The fifteen-step checklist as a PM project template per new client, with due dates in working days from kickoff. |

### SCP-6 · Leave the Excel (after real data is allowed; SCP-D1 keeps it on hold)

- **6a.** A one-off import of the sheet (allocation, next month's plan), built and proved on a mock sheet now.
- **6b.** One month run in parallel.
- **6c.** The sheet retired.

### SCP-7 · Proof: a simulated month, end to end

- **7a.** e2e on sumopod. One mock client's month goes through all seven stages as each role, including both loops,
  a failed publish, a boost and the month report.
- **7b.** A live drive on the ERP's mock seed, as each role login and a portal placeholder.
- **7c.** axe, light and dark, desktop and phone, on every new page and the portal feed.
- **7d.** A review with the Social Media team against their design, with feedback folded in.

## 9. How work lands here (read before your first change)

- Read code from a fresh `origin/main` worktree. The shared checkout drifts far behind, and other sessions move HEAD.
- Tests run on sumopod or GitHub Actions, never locally. Run one gate at a time with memory caps. There is no local
  Docker.
- Main has a landing queue. Announce to the live landing sessions and land only a fast-forward with green CI on the
  exact sha. A release is VERSION-only, then an annotated tag. `git push --tags` deploys.
- Migrations take a timestamp prefix after main's newest. A deploy that adds a Cerbos policy or kind must restart
  Cerbos and probe it.
- The repo is public, so no client or staff names go into code, seeds, fixtures or docs. Use `*.local.*`.
- Live checks may use the owner's account and the mock seed under the 2026-10-13 ruling. Log in once and never retry
  a failed login. Keep a teardown list.
- Since DW-7h (release 415), a request hook in AuthGuard (`platform-nest/src/core/security/request-guard.ts`) records
  every connection and refuses revoked sessions and blocked addresses. Simulated jobs, portal e2e logins and live drives
  all pass through it. Read it before you blame the pipeline for a refused request.
- Update the board in the same change that moves the work, and run `node scripts/tasks-progress.mjs --check`.

## 10. Open items and risks

- **Public holidays** in delivery markers: Indonesia's calendar is not modelled. The default is Monday to Friday, and
  holidays come later.
- **Timezone:** markers and "today" use the company's timezone. `REPORTS_TZ` is unset on live (UTC days, a DW-4
  finding).
- **One caption or per network:** the master caption is copied into the variants, and the variants may differ. The
  client approves what each network will get.
- **Scale:** about 18 clients × 10 to 18 items a month gives roughly 300 a month and 600 across the active two months.
  The board and plan read on the server, with filters.
- **Reversing the "no simulator" rule** is the biggest hazard. SCP-Sa and Sf exist to contain it, and they are Opus
  work with a review.
- **Real publishing** needs Meta Business Verification and App Review (DW-11, D-23), Postiz deployed, and the AGPL
  counsel sign-off (OQ-3). None of it is needed for the dev review.
