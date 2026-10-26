# Social Media content pipeline (SCP): plan

Status: PLANNED 2026-10-15; **re-planned 2026-10-26** for the team's v2 design. Board: `TASKS.md` › "Social Media content
pipeline" (program key `smm-pipeline`).

- Design fit, the annotated screens, the menu and the More panel: https://claude.ai/artifact/Cq2UXa5SxsQMAzKWDRbtqS
- The 15 Oct comparison and combined mockups (superseded): https://claude.ai/artifact/2UF5vQZ4uqpPfcRvmMftAA
- The 15 Oct version of this plan: `docs/history/2026-10-15-social-content-pipeline.v1.md`.

This plan landed on main with SCP-0a on 2026-10-26, and this copy is the one to edit. It holds no client or staff names
on purpose, because the repo is public. Keep it that way. Both of the team's prototypes hold real client and
staff names: they never go into the repo, and nothing is copied from their sample data.

**To start a session on a phase:** open a session in the workspace folder and say "Work on SCP-1 from TASKS.md".
Read §1 to §4 first, then §7 (execution), your phase in §8, §9 (how work lands here) and §11 (the mock seed).

---

## 0. What changed on 2026-10-26

The Social Media team sent a second design, "Gaia SMM ERP": an Instagram-style working prototype in one HTML file, with
sample data and no server. The owner asked for that UI with all of the ERP behind it, and pushed back on a mockup that
wrapped it in the ERP's standard look. This plan therefore targets the v2 design's layout, look and workflow (SCP-D5).

| Topic | 15 Oct plan | Now |
|---|---|---|
| Steps | Planning, Creative, Internal review, Client review, Scheduling, Live, Boosting | Draft, Proofread, HoD approval, Creative, Final check, Client, Schedule, Live (§1) |
| Internal approval | The Officer and the Lead, both, after design (SCP-Q4) | The Copywriter approves the copy; the HoD or GM approves it for design and does the final check; the Officer authors and never approves |
| Client changes | All go back to Creative | Copy: Officer, then the Copywriter checks the changed text, then the client. Design: Creative, final check, client |
| Deadlines | Batch A or B per client | A deadline per client per cycle, ready-by, optional step estimates, holidays (§4.4) |
| Main views | Seven-column board, content plan table, post drawer | Home feed, post page, client profile with five tabs, client approval page, Team dashboard |
| Look | The ERP workspace's standard look | The design's own skin of the one workspace shell (§6) |
| Boost | A stage of its own, with the client approving the budget | An action on a live post; budget approval is SCP-Q11 |

Nothing in SCP had started (0 of 55 boxes), so nothing is redone.

## 1. Goal and the flow

The Social Media team plans, writes, proofreads, approves, designs, gets client approval, schedules, monitors and boosts
every post inside the ERP, in their own design's layout and look. They stop using the Excel / Google Sheet (the
allocation tab, one tab per officer, the content plan rows) and the separate content approval app.

**The flow, per post:**

| # | Step | Who acts | What happens | Phase people see |
|---|---|---|---|---|
| 1 | Draft | The client's SMM Officer | Topic, format, pillar, angle, caption, on-image text, call to action, hashtags, date and time, a reference image. The hand-off checks run (§4.6) | Brief |
| 2 | Proofread | Copywriter | Suggests edits. "Approve copy" applies them and logs each before and after; or the copy goes back with a note | In production |
| 3 | HoD approval | HoD or GM | Approves it for design, which adds the post to the client-month Creatives request; or asks for changes | In production |
| 4 | Creative | A Creatives designer | Designs from the Creative brief, uploads versions, submits for the final check | In production |
| 5 | Final check | HoD or GM | Sends it to the client, or asks for a copy change (Officer) or a design change (Creative) | In production |
| 6 | Client | The client | Approves, or asks for a copy or a design change, with a note and an optional pin on the image | With client; Client changes |
| 7 | Schedule | Officer | Date, time and placement; scheduled by hand ("Schedule in Meta") or through the publisher | Client approved |
| 8 | Live | Officer, or the publisher | The post's link; metrics; a boost when it is worth one | Posted |

**Loops:**

- **a.** Proofread → Draft. The Copywriter returns the copy with suggestions and a note.
- **b.** HoD approval → Draft. The Officer's fix goes straight back to the HoD, without a second proofread.
- **c.** Final check → Creative (a design change), or → Draft (a copy change). Both come back to the final check.
- **d.** Client → Creative (a design change) → final check → client.
- **e.** Client → Draft (a copy change) → the Copywriter checks only the changed text → client. The HoD and Creative are
  skipped, and the HoD is told.

**Blocked.** Any step before Client can be blocked with a reason and who we are waiting on, for example "waiting for the
client's photos". Resolving it returns the post to the step it left.

## 2. Rulings and decisions

| # | Date, by | Decision |
|---|---|---|
| SCP-D1 | 2026-10-15, owner | **Mock seed only; dev review.** In the owner's words: "we still going to use mock data as seed. as this is still dev review only. and we need to ensure that it will work. so we need to simulate everything to see if its working." Every step runs end to end on mock data: publishing, metrics, client decisions and boosts. |
| SCP-D2 | 2026-10-15, plan | **Build on the existing social module.** The design's own `/api/smm` store is not built. Posts stay `social_posts` and their per-network `social_post_variants`. The calendar, portal review, publish gate, metrics, KPI readers, Overview and reports therefore keep reading one record. The design's role and stage rules (`Workflow.check` / `apply`) move server-side, as the design itself says. |
| SCP-D3 | 2026-10-15, plan, from SCP-D1 | **A labelled simulator, for the dev stage only.** This reverses the module's own "no simulator" rule (`platform-nest/src/modules/social/publisher/mock-driver.ts` header and `publisher/boot.ts`). That rule exists because a fake publish is "a post that never appeared on a client's account while our calendar said it did". The guardrails in §5 answer that hazard. The precedents are search's SM-33 simulated providers and PV-D41's simulated Midtrans. **Before real data:** the flag goes off (add it to "Before real clients use the portal"). |
| SCP-D4 | 2026-10-15, plan (the owner asked whether this duplicates the Repsona-style PM) | **A post is content; a task is work. There is no second task system.** The PM module (the Repsona clone: Ball, custom statuses, board, templates, recurrence) keeps all work that is not a single post. That means the client's content month as one deliverable task, the monthly cycle, onboarding, the Creatives request, campaigns and ad-hoc work. The pipeline keeps only what a PM task cannot hold: the post's content, its per-network versions, the two-person and client approvals tied to the exact content, publishing, metrics and boosts. **No PM task is created per post.** Comments, history, notifications, "Needs you" and the board component are shared, not rebuilt. See §4.5. |
| SCP-D5 | 2026-10-26, owner | **The team's v2 design is the target.** The owner asked for "that ui but still have all the goodness of our erp", then pushed back on a mockup that changed its layout and look. Its layout, look and eight-step workflow are kept as drawn; the ERP supplies identity, authorization, records, publishing, the portal and reporting behind it. This supersedes the 15 Oct workflow and SCP-Q3, SCP-Q4 and SCP-Q6. |

**Open, with defaults in force** (non-blocking; the owner may overrule any of them at any time):

| # | Question | Default in force |
|---|---|---|
| SCP-Q2 | Who does the Creative step? | The Creatives department, through the existing work requests (DW-D14), with **one request per client per month**. A post joins its month's request when the HoD approves it for design. |
| SCP-Q5 | What is in the first release? | SCP-K, SCP-1 to SCP-4 and SCP-S, proved by SCP-7. SCP-5 comes after. SCP-6 waits for real data. |
| SCP-Q7 | A skin per department? (owner leaning, 2026-10-26: "i kinda agree that each department can have their own skin") | Adopt the rule in §6.1, with Standard and Social as the first two skins. Recorded in the Department-workspaces decision log as well (SCP-0d), since it touches every workspace. |
| SCP-Q8 | How does the client reach the approval page? | Portal login. The link we send, shareable to WhatsApp, opens the portal page; staff record decisions the client gives by WhatsApp or email. The design's no-login link is possible only after a threat model and an Opus review, if the owner rules for it. |
| SCP-Q9 | Who fills each role? | The Copywriter is a role any member can hold. "PM / Head of SMM" and GM approve with equal authority: the Social Media unit head (`org_unit_lead`), the GM, or a `social_manager` grant. The Officer authors and never approves their own post. Replaces SCP-Q4 and SCP-Q6. |
| SCP-Q10 | How are deadlines set? | A deadline per client per cycle, as in the design. Ready-by is a buffer of working days earlier; step estimates are optional; holidays come from the HR holiday calendar. The A/B batch rule only pre-fills the table. |
| SCP-Q11 | Who approves boost money? | The client approves each boost budget in the portal, or staff record it. (The design boosts with no approval step; it is the client's ad account.) |
| SCP-Q12 | Keep the board and the spreadsheet table? | Drop both from SCP-1. The home feed, the client's List and the Team dashboard cover the board; pasting from a sheet moves to the one-off import (SCP-6). |

**Superseded on 2026-10-26:** SCP-Q3 (the client page's look) by SCP-D5 and SCP-Q8; SCP-Q4 (two internal approvers) and
SCP-Q6 (the PM is the account manager) by SCP-Q9.

## 3. What exists today

Re-verified on `origin/main` 57846487 (release 1.0.0-alpha.427) on 2026-10-26: the social module has not changed since
2026-10-15, so the inventory below still holds. The additions that matter for v2 follow it.

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

### Newly relevant to v2

- **The shell.** `platform-ui/src/components/shell/Shell.tsx` is the one layout (DW-D38): `WorkspaceShellSidebar`,
  `WorkspaceTopBar`, `WorkspaceTabStrip`, the page and `CommandPalette`, fed by the workspace model from
  `lib/workspaces.ts`. Every workspace also gets the Performance rows (`PERFORMANCE_ROWS`) and the You rows (`YOU_ROWS`:
  My tasks, Inbox with Notifications and Mail, Calendar with Meetings, Approvals, Me).
- **Calendars.** The department calendar (DW-10c, `core/dept-calendar.service.ts`) returns holidays, approved leave,
  project deadlines and events. The HR holiday calendar is `hr_holiday_calendars` (with its weekend days) and
  `hr_holidays`.
- **AI drafts.** Social's brand-draft lookup (`modules/social/knowledge-client.ts`, `queryBrandKnowledge`) reads only that
  client's brand corpus (DW-D31).
- **Asset versions.** Creative asset versions and review rounds (migration `202610140730_creative_asset_versions_reviews`).
- **Comments.** The shared `comments` table has no visibility and no anchor today.
- **The portal.** The client conversation (PV-4) and the approvals page exist; `/portal/social-reviews` is still one card
  per network variant with an attachment count.

## 4. Target model

### 4.1 Roles

| Design role | In the ERP | Acts on |
|---|---|---|
| SMM Officer | A Social Media member set as the client's officer on the allocation (SCP-1a) | Their clients: drafts, fixes, schedules, marks live, follows up. Never approves their own post |
| Copywriter | Holder of the copywriter role (SCP-Q9), any member | The proofread step on every client |
| Creative | A Creatives member working the client-month request (SCP-Q2) | Design, versions, submit for the final check |
| PM / Head of SMM, GM | The Social Media unit head, the GM, or a `social_manager` grant; equal authority | HoD approval, final check, tasks, settings, the report check |
| Client | A portal contact of that client | Approves or asks for changes; boost budgets (SCP-Q11) |

The design's demo account switch does not exist in the ERP: the signed-in person acts and Cerbos decides. Mock seed gives
each role a login (SCP-0c). No approval step may be passed by the post's author: if a HoD drafted a post as a client's
officer, the GM or another approver takes its HoD approval and final check.

### 4.2 Data (names are proposals; SCP-0b fixes them, and migrations take a timestamp after main's newest)

- **Allocation and brand book, on `social_engagements`** (real columns where they are queried): `smm_officer_user_id`,
  `posts_per_cycle`, `report_format` (`email|meeting`), `report_due_day`, `platforms text[]`, `formats text[]`,
  `default_post_time`, `content_pillars text[]`, `tone`, `must_have_notes text[]`, `brand_rules text[]`, `hashtag_sets`,
  `channels`, `key_dates`, `links` (jsonb where they are only shown). The brand fields also feed the brand knowledge that
  "Draft with AI" reads.
- **`social_cycles`:** `engagement_id`, `month` (the first of the month), `deadline`, `ready_by` (computed),
  `estimates` (working days per step, optional). A company setting holds the buffer (working days, default 1).
- **On `social_posts`:** `cycle_id`; `format` (`feed|carousel|reel|story`); `pillar`; `angle`; `objective`; `key_message`;
  `caption` (the master caption); `on_asset_text`; `cta`; `hashtags`; `visual_direction`; `raw_assets_url`; `placement`;
  `pipeline_status` (§4.3) and `status_since`; `change_by`, `change_kind` (`copy|visual`), `change_note`, `return_to`;
  `changed_only`; `suggestions` (the Copywriter's pending edits); `block_reason`, `block_waiting_on`, `blocked_from`;
  `must_haves text[]` (ticked checks); `skipped_checks` (reason, who, when); `creative_state`
  (`not_started|in_progress|revision|submitted`); `is_extra`; `idea_id`; `live_url`, `went_live_at`; `simulated`.
  The publish engine's `status` stays, held to `pipeline_status` by one mapping (§4.3) that the 0b fixture pins.
- **Variants** are created at the final check, one per placement network, from the master caption. Per-network changes
  stay in the Composer, and the existing rule that an edit clears an approval still holds. An Instagram Story is an
  Instagram variant with `settings.igType='story'`.
- **Client review:** `social_post_client_reviews` stays per variant. One decision per post applies to all of its variants
  in one transaction. New columns: `change_kind`, `anchor` (a pin on the image), `recorded_by`, `channel`
  (`whatsapp|email|meeting`).
- **Comments:** `visibility` (`team|client`) and `anchor` (`{x, y, version}`) on the shared `comments`.
- **Creative assets:** `source` (`own|client|stock|ai|unknown`) and `ai_note`.
- **Metrics:** `social_post_metrics.source` (`pull|manual|simulated`) and a manual-entry endpoint. Engagement rate is
  (likes + comments + saves + shares) ÷ reach; a boost candidate is at least 1.25 × its account's average.
- **`social_boosts`:** `post_id`; `status` (`requested|approved|running|stopped|completed|cancelled`); `goal`
  (`profile_visits|website|messages`); `audience` (`automatic|local|custom`, plus a description); `daily_budget_minor`
  with `currency` (IDR); `days`; `starts_on`; `approved_by`, `approved_via` (`portal|recorded`); `spend_minor`,
  `paid_reach`, `clicks`; `simulated`. The client sees their own budget and spend (PV-D38), never our fees.
- **`social_ideas`** ("Ideas for next month"): `engagement_id`, `cycle_id`, `saw`, `metric`, `suggestion`, `status`
  (`proposed|planned|shared`), `post_id`.
- **`social_reports`:** a `weekly` kind, `notes` (one insight and one suggestion per area), `action_plan`. The design's
  Draft, HoD check, Ready, Sent map to the existing `draft`, `in_review`, `approved`, `delivered`.
- **Tasks:** PM tasks gain a link to a post. No new task table (SCP-D4).

### 4.3 The stage machine (server-side; every action writes `work_activity`; each refusal has its own code)

**Statuses:** `planned`, `drafting`, `proofread`, `hod`, `design`, `final`, `client`, `approved`, `scheduled`, `live`,
`changes`, `blocked`.

| Phase people see | `pipeline_status` | Engine `status` |
|---|---|---|
| Brief | `planned`, `drafting`, `blocked`; `changes` for a copy fix not asked by the client | `draft` |
| In production | `proofread`, `hod`, `design`, `final`; `changes` returning to the final check, or a design change | `draft` |
| With client | `client` | `in_review` |
| Client changes | `changes` asked by the client | `draft` |
| Client approved | `approved`, `scheduled` | `approved`, then `scheduled` (`publishing` and `failed` come from the engine) |
| Posted | `live` | `published` |

| Action | From → to | Who | Guards and effects |
|---|---|---|---|
| `start_draft` | `planned` → `drafting` | Officer | |
| edit copy | `drafting`, `changes` | Officer | Only in these statuses. In `proofread` the Copywriter's edits are suggestions |
| `send_to_proofread` | `drafting`, `changes` (return to proofread) → `proofread` | Officer | The hand-off checks pass, or "send anyway" with a reason, logged. After a client copy change, `changed_only` is set |
| `approve_copy` | `proofread` → `hod`; → `client` when `changed_only` | Copywriter | Applies the suggestions and logs each field's before and after. With `changed_only` the HoD is notified |
| `return_copy` | `proofread` → `changes` (return to proofread) | Copywriter | A note is required |
| `approve_for_design` | `hod` → `design` | HoD or GM, not the author | Adds the post to the client-month Creatives request, opening it if none exists |
| `hod_changes` | `hod` → `changes` (return to hod) | HoD or GM | A note is required |
| `resend` | `changes` → `hod` or `final`, as the return says | Officer | For copy fixes asked at the HoD approval or the final check |
| `start_design` | `design` | The designer on the request | `creative_state` becomes `in_progress`, or stays `revision` |
| `submit_design` | `design`, or `changes` (design) → `final` | The designer | Needs an asset version or a shared link |
| `final_approve` | `final` → `client` | HoD or GM, not the author | Creates the variants and requests client review on each |
| `final_changes` | `final` → `changes` (return to final), copy or design | HoD or GM | A note is required. A design change sets `creative_state` to `revision` |
| `client_approve` | `client` → `approved` | The client in the portal; or the Officer, HoD or GM recording it with channel and note | Every variant's review approved with its hash |
| `client_change` | `client` → `changes`: copy (return to proofread, the before-text kept) or design (return to client, revision) | The client, or recorded by staff | A note is required; a pin on the image is optional |
| `schedule` | `approved` → `scheduled` | Officer | Date, time and placement; the media validator passes; by hand or through the publisher |
| `unschedule` | `scheduled` → `approved` | Officer | Cancels a dispatch |
| `mark_live` | `scheduled` → `live` | Officer, or the publisher's result | The post's link; metrics start |
| `block` | any status before `client` → `blocked` | Officer, HoD or GM | A reason and who we wait on; `blocked_from` kept |
| `resolve` | `blocked` → the status it left | Officer, HoD or GM | |
| `request_boost` | on `live` | Officer, HoD or GM | Budget and days above zero; no open boost |
| `approve_boost` | `requested` → `approved` | The client in the portal, or recorded by staff (SCP-Q11) | |
| `start_boost`, `stop_boost`, `complete_boost` | `approved` → `running` → `stopped` or `completed` | Officer, HoD or GM | Completing needs spend and paid reach; spend above budget warns |
| delete | `planned`, `drafting` | Officer, HoD or GM | Later statuses are archived instead |

A content edit after the client approved sends the post back to the client: the existing hash rule does this. Every
action is a Cerbos action on `social_post` (and on `social_boost` if 0b makes it a kind). The attributes conditions read
go on the resource's allow-list: the officer, the author, the unit lead ids, the request's designers and the client.

### 4.4 Cycles and schedule health

- **A cycle** is one client's content month. Its deadline comes from the deadline table (SCP-Q10). The A/B batch rule
  pre-fills it: batch A is the last working day on or before the 15th of the month before; batch B is the last working
  day of the month before.
- **Ready-by** is the deadline minus the buffer, in working days.
- **Working days** are the company's working days less its holidays, from the HR holiday calendar, in the company's time
  zone. `REPORTS_TZ` is unset on live (UTC days), a known DW-4 item.
- **Step estimates** are optional, in working days per step and per client: proofread, HoD approval, Creative, final
  check, client approval, scheduling. With them a post shows the latest safe day to hand it on; without them, only
  ready-by.
- **Health,** per post and per client: On track (n spare days), Tight (no spare day, or the client is slower than
  usual), At risk, Late (n days, and with whom). Waiting time counts against whoever holds the post, never the Officer.
- **Counting.** The target counts posts. Stories and extra posts (a client's event brief) are shown beside it and do not
  count toward it.

### 4.5 What stays in PM (SCP-D4)

| Work | Lives in | How the two meet |
|---|---|---|
| One post: caption, asset, per-network versions, approvals, publishing, metrics, boost | **Pipeline** (`social_posts`) | |
| A client's content month ("November content", for example) | **PM**: one task per client and month in the client's project, due on the cycle's ready-by, Ball on the officer | Progress is computed from the pipeline (posts past client approval ÷ quota). It is done when every post is approved. It shows on PM's board, Timeline, Ball and workload, and counts in "on time". |
| The monthly cycle (report, planning, copy lock, client window, artwork, deploy) | **PM**: tasks generated per client and month (SCP-5f) | Steps the pipeline can see close themselves. For example, "Artwork production" closes when the month's last post leaves Creative. |
| The designer's work | **PM**: the Creatives request's task in Creatives' Requests project (DW-5) | The month's posts are its lines. The designer works in Creatives' own PM board. |
| Onboarding a new client | **PM**: a project template (SCP-5h) | It replaces the "Repsona project" step in the team's checklist: the client's ERP project is that project. |
| Campaigns, ad-hoc and internal tasks | **PM** as today | |
| Comments, history, notifications, "Needs you" | **Shared** | The pipeline uses the generic comment thread (entity `social_post`), `work_activity`, the notification handlers and `lib/queue.ts`. It adds no tables of its own for these. |
| Board, drawer, table components | **Shared** | `components/pm/Board.tsx` and the `TaskDrawer` pattern are reused. Only the inline-edit plan table is new, and PM may reuse it. |

**Why posts are not PM tasks:**

- A PM status is a column that anyone with edit rights may move. The pipeline's steps carry rules a column cannot:
  two different approvers, a client decision in the portal, approval tied to the exact content, a publish, and
  metrics.
- About 300 posts a month as tasks would flood PM's boards and distort "tasks done" in each officer's numbers.
- A post-per-task mirror would need syncing both ways, which is a constant source of drift.

### 4.6 Hand-off checks (run on the server; "send anyway" needs a reason, logged on the post)

- The ten must-haves, the same for every client: logo; brand colours; brand fonts; contact or booking info; correct
  handle and tags; mandatory words or tagline; no forbidden claims; price and promo terms checked; location tag; the
  client's hashtag set. The client's own must-have notes show beside them.
- The caption within the network's limit (2,200 characters on Instagram); at most 30 hashtags on Instagram.
- On-image text present where the format needs it.
- Every asset link shared ("anyone with the link"). The real check needs the Drive OAuth client (DW-11); until then the
  check is that a link is present.
- Every asset's source known, and an AI note on AI-made assets.
- The date not before the cycle's ready-by (it then needs an earlier hand-off than the rest).

## 5. Simulation (SCP-D1, SCP-D3)

The goal is that one person can walk a whole mock month through all eight steps and five loops, as every role, and see every number
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
- **Simulated read-back (SCP-Sg).** Each mock client's live feed, followers and reach come from the simulator, so Feed
  preview, "Last synced" and the profile counts work without Meta. Every value carries the SIMULATED mark.

## 6. The Social skin and the menu

### 6.1 The skin rule (SCP-Q7)

- There is one workspace shell (DW-D38). A workspace may choose a **skin** of it.
- **A skin may change** the menu's shape and which rows are pinned (the rest sit in More), the colours and type in light
  and dark, and the workspace's home layout.
- **A skin never changes** which pages exist or their addresses; who may see or do what (registry gates and Cerbos); the
  data; what the status colours mean; or the items every skin keeps: ⌘K, notifications, the AI Assistant, More with the
  workspace switcher, and the SIMULATED and access marks. Every skin passes the same accessibility checks in light and
  dark, on desktop and phone.
- **The skin follows the workspace,** so everyone sees a department the same way. Light or dark, density and width stay
  personal, and anyone may choose the Standard skin for themselves.
- **Skins are built in code with the department,** never typed in by users. The client portal keeps the company's look.
- **How:** the registry gains a `skin` per workspace and a list of pinned rows per skin; `Shell` sets the skin on the
  page; each skin is a token file for light and dark plus a menu layout; the token contrast test, the palette, page-home,
  one-area (DW-1c) and sidebar tests, and the axe runs cover every skin.
- **First skins:** Standard (today's look, unchanged) and Social (the team's design).

### 6.2 The Social menu

| Row (pinned) | Opens | Notes |
|---|---|---|
| Home | The Social Media Overview `{D}`, laid out as the design's feed | "Your turn", "Waiting on others", tasks, reports due, client stories, accounts this cycle |
| Search | ⌘K | Posts, clients, people and pages |
| Messages | "Waiting on": who holds each of your posts, with Follow up | Client threads open the portal conversation (PV-4). Team chat stays outside the ERP |
| Notifications | The notification feed (`/me/inbox`) | |
| Tasks | PM tasks: for me, given by me, whole team | A task can point at a post |
| Create | The New menu | New post, Extra post, New task, Ask Creatives for assets |
| Calendar | `{D}/calendar`, all clients | Added: not in the design |
| Reports | Social reports | The existing reports until SCP-5a |
| Saved | The content bank | The Asset Library until SCP-5e |
| Profile | The client page, with a switcher across your clients | |
| AI Assistant | The assistant drawer | Added: not in the design |
| Dashboard (HoD, GM) | The Overview's Team view | The existing Team view until SCP-5d |
| Settings (HoD, GM) | Cycles, estimates, targets, the buffer | Built in SCP-1c |

**More** (the design's Account row becomes More): the menu shrinks to icons and a panel slides out, with Find a page and
three groups. **Work:** Project Management, Requests, Campaigns, Clients, Social inbox, Tools & connections.
**Performance:** My performance, Reports, Analytics, Appraisals, Learning. **You:** Approvals, Mail, My calendar, Me.
The account sits at its foot: Switch workspace, Appearance, Log out. A badge inside More also shows on More.

**Phone:** the design's bottom bar (Home, Search, Create, Tasks, Profile); Notifications and Messages at the top; More as
a full-screen sheet from ☰ on the profile.

### 6.3 Pages and addresses

URLs never move, new pages get new URLs under the department, and every page keeps exactly one area (the DW-1c test).
The top-level `/pipeline` and `/monitoring` are Web Dev's. A post opens at `{D}/posts/[postId]` as a drawer over any list
(the `TaskDrawer` intercepting-route pattern). The Composer stays at `{D}/composer/[postId]` as the per-network step,
findable from ⌘K. SCP-0b names the other new pages.

### 6.4 The Overview

- **Needs you,** per role: Officer (drafts to send, fixes asked, ready to schedule, metrics missing two days after going
  live); Copywriter (the proofread queue); HoD and GM (HoD approvals, final checks, reports to check, boosts approved
  but not started); Creative (designs and revisions).
- **Pulse tiles:** In production · With client (closes DW-3e's "Waiting client review") · Late · Scheduled this week ·
  Failed posts · Boosts waiting. The KPI strip and banner stay.

### 6.5 The portal

The client's approval page is SCP-2: the company's portal look, with post previews that look like the network they
will appear on. Boost budgets wait in `/portal/approvals`.

## 7. Execution

### 7.1 Model tiers (global rule: the cheapest model that fits)

| Kind of work | Model | Why |
|---|---|---|
| Contract, migrations, the stage machine, Cerbos, the simulator's containment, boost money, the shell's skin seam | Opus | Risky cores |
| Pages, components, the portal page, the skin's tokens and menu, readers, the import tool | Sonnet | Specified implementation |
| Registry rows, seed fixtures, demo data, doc edits | Haiku | Mechanical |

The orchestrating session reviews every agent diff before it lands, owns all server work and runs the gates.

### 7.2 Waves and lanes

**Wave 0 · Record and contract (no code).**

| Ticket | Who | Needs | Output |
|---|---|---|---|
| 0a | Orchestrator | — | This plan and its decision log on main (a docs-only fast-forward) |
| 0d | Orchestrator, with the DW session | SCP-Q7 standing | The skin rule as a DW decision row |
| 0b | Architect, Opus | 0a | BFF and permission sections, the migration list, the stage-machine fixture |
| 0c | Sonnet | a draft of 0b | The mock-seed plan |

**Wave 1 · Foundations, three lanes in parallel** (after 0b; the skin lane after 0d).

| Lane | Tickets, in order | Model |
|---|---|---|
| Pipeline core | 1b → 1c → 1i | Opus for 1b; Sonnet for 1c and 1i, with an Opus review of the working-day maths |
| Skin | Ka → Kb → Kc → Kd → Ke → Kf | Opus for Ka (the shell seam); Sonnet for the rest |
| Records | 1a → 1l → 1o | Sonnet (1l's migration reviewed by Opus); Haiku for 1o's fixtures |

**Wave 2 · The staff screens** (after 1b and Ka to Kc).

| Lane | Tickets | Model |
|---|---|---|
| Screens | 1d, 1e, 1k, 1m | Sonnet (frontend) |
| Steps | 1f, 1g, 1h, 1j | Sonnet (backend and frontend) |
| PM | 1n | Sonnet |

Then **Kg** switches the skin on for Social Media once 1d, 1e and 1k are live, and **1p** walks every role (QA, Sonnet).

**Wave 3 · Client, publishing, money** (after wave 2; lanes in parallel).

| Lane | Tickets | Model |
|---|---|---|
| Portal | 2a to 2e, 2g; 2f as SCP-Q8 rules | Sonnet; Opus reviews 2c's transaction. A no-login link would be Opus with a threat model first |
| Simulation | Sa and Sf (Opus); Sb to Se and Sg (Sonnet) | |
| Schedule and calendar | 3a to 3f | Sonnet |
| Boost | 4a (Opus), then 4b and 4c (Sonnet) | After Sa |

**Wave 4 · Proof and the first release.** 7a to 7d (QA, Sonnet; the orchestrator drives 7b live and runs 7d with the
team). The first release is complete when SCP-7 is ticked (SCP-Q5).

**After:** SCP-5 (Sonnet; Opus reviews 5d's people data against the DW-4 privacy rules), then SCP-6 when real data is
allowed.

At most three implementer agents run at once, and only one sumopod gate at a time, with memory caps.

### 7.3 Release checkpoints

Each lands through the main landing queue: announce to the live sessions, fast-forward only, green CI on the exact sha,
then a VERSION-only commit and an annotated tag. Any session may cut a release, one at a time.

1. **Record:** 0a and 0d (docs; they ride the next release).
2. **Contract live, nothing visible:** 1b's migrations and Cerbos policies (restart Cerbos and probe it after the
   deploy), and Ka with the skin off.
3. **Staff dev review:** wave 2 with Kg. The skin is on for Social Media on the mock seed, and the team reviews it side by
   side with their prototype.
4. **First release complete:** waves 3 and 4.

## 8. Phases and acceptance

Every ticket is ticked only when DEV-VERIFIED: driven on a Linux server (sumopod gate or CI) with the result seen, and,
once deployed, checked on the live ERP's mock seed.

### SCP-0 · Decisions, contract and plan

- **0a.** This plan goes to `docs/plans/` on main as it is (no names), with SCP-D1 to D5 and the open questions in its
  decision log.
- **0b.** Contract first: a BFF section for every pipeline route (shapes, refusals, idempotency); a permission section for
  every Cerbos action and attribute; the migration list with timestamps after main's newest; the stage-machine table of
  §4.3 as one fixture that both sides test against.
- **0c.** A mock-seed plan: DEMO_MODE personas (Officer ×2, Copywriter, Creative, HoD, GM, client); labelled live
  mock-seed logins for the same roles on a teardown list, plus the portal placeholders; mock clients' allocations, brand
  books and cycles.
- **0d.** The skin rule (§6.1) recorded as a Department-workspaces decision on main, agreed with the DW session.

### SCP-K · The Social Media skin

| Ticket | Acceptance |
|---|---|
| Ka Skins in the shell | The registry carries a skin per workspace and pinned rows per skin; `Shell` sets the skin on the page. The Standard skin renders exactly as before (a test proves it). The Social skin is off until Kg. |
| Kb Social tokens | Light and dark token sets with the design's white, black and blue. Stage colours keep the meaning of the status families. The token contrast test covers both skins. |
| Kc The Social menu | The design's rows, icons and badges; Calendar and AI Assistant added; Dashboard and Settings for the HoD and GM by role. Search, Notifications, Create and Profile do what the top bar's search, bell, New and avatar did. |
| Kd More | The menu shrinks to icons and the More panel slides out: Find a page, Work, Performance, You, and the account (Switch workspace, Appearance, Log out). It lists exactly the rows the registry gives the person. Badges show on More. Complete by keyboard and screen reader. |
| Ke Phone | The bottom bar (Home, Search, Create, Tasks, Profile); Notifications and Messages at the top; More as a full-screen sheet. |
| Kf Tests | The palette, page-home, one-area and sidebar tests pass in both skins; axe passes in light and dark, desktop and phone. |
| Kg Switch on | The skin is on for Social Media once 1d, 1e and 1k are live, so no menu row points at a page that does not exist. |

### SCP-1 · The pipeline for staff: draft to final check

| Ticket | Acceptance |
|---|---|
| 1a Allocation and brand book | The officer, posts per cycle, report format and due day, platforms, formats, default time, pillars, tone, must-have notes, brand rules, hashtag sets, channels, key dates and links can be set per client. Clients › Allocation lists every client with its officer and target. Refused for non-managers. |
| 1b Stage machine | Every row of §4.3 is enforced on the server with its own refusal code. The fixture runs green in nest and ui. Activity is written. The phase and status mappings are pinned. |
| 1c Cycles and health | The deadline table, the buffer and step estimates, edited on the HoD's Settings page. Ready-by and the latest safe hand-off on working days from the HR holiday calendar. On track, Tight, At risk and Late, tested on month ends, weekends, holidays and the year turn. |
| 1d Home | "Your turn" per role with the next allowed action as the main button; "Waiting on others"; tasks given to you; reports due; client stories with state rings; "Your accounts this cycle". Read on the server; fast at 600 posts. |
| 1e Post page | `{D}/posts/[id]` as a drawer: the image and its versions, the status chip, the eight-step stepper, health, Post and Creative brief tabs, the field rows, the copy edit log, comments and activity, and the Composer link. Buttons the person may not use are disabled with the reason. |
| 1f Proofread | The Copywriter's suggestions show to the Officer as suggestions. "Approve copy" applies them and logs before and after per field. "Return with edits" needs a note. "Approve all" per client. |
| 1g HoD approval and final check | Approve for design, or changes with a note. At the final check a copy change goes to the Officer and a design change to Creative as a revision; both come back to the final check. The author cannot pass these steps (a test proves it). |
| 1h Creative | On "approve for design" the post joins the client-month Creatives request. The designer's queue; start; a version in the Asset Library or a Drive link; submit for the final check; asset source and AI note; revision notes shown. |
| 1i Hand-off checks | The checks of §4.6 run on the server. "Send anyway" needs a reason, logged on the post and shown in its activity. |
| 1j Blocked and follow-up | Block with a reason and who we wait on; resolve returns to the same step. Messages lists who holds each of your posts; Follow up sends a notification and logs it. "Needs you" gains the pipeline per role (§6.4). |
| 1k Client page | The profile header (counts, cycle line, tone), cycle highlights, the Plan grid with slots placed for the target, Stories (not counted), the List with bulk "Send to proofread", the Calendar tab, Client profile (the brand book) and Extra post. |
| 1l Comments | The shared thread gains team-only or client-visible, and a pin on the image. Pins show on the post and in the portal. |
| 1m Create | + New post inside a client's cycle; Extra post, flagged and outside the target; New task; Ask Creatives for assets. |
| 1n Content month in PM | One task per client and cycle, due on its ready-by, Ball on the Officer, progress from the pipeline, done when every post is client-approved. No PM task per post (a test proves it). A task can point at a post. |
| 1o Seed | Mock clients with allocations, brand books, cycles and a month of posts across every status, with no real names, in DEMO_MODE and the live mock seed. |
| 1p e2e | On sumopod, the Officer, Copywriter, HoD, Creative and GM each walk their part, including loops a, b and c. |

### SCP-2 · Client review in the portal

| Ticket | Acceptance |
|---|---|
| 2a Approval page | The header (to approve, approved, changes), the stories circle, To review, Grid preview and Approved tabs. "Approve all" approves only what waits. |
| 2b Images | Served through the portal's file route, so a portal user sees only their client's files. Thumbnails; the grid preview. |
| 2c One decision per post | Applies to every variant in one transaction. A visible Approve button, double-tap as a shortcut, and a short undo. |
| 2d Changes | Copy or design, with a note and an optional pin. Copy goes Officer → Copywriter (changed text only) → client; design goes Creative → final check → client. The HoD is told. |
| 2e Recorded decisions | Staff record a WhatsApp or email decision with channel and note, shown as recorded on the client's behalf to staff and the client. |
| 2f The way in | As SCP-Q8 rules: by default the link we send, shareable to WhatsApp, opens the portal page. |
| 2g Proof | Portal e2e on DEMO_MODE, and a live drive as a placeholder portal login (invite, accept, decide, revoke). |

### SCP-S · Simulation (runs beside SCP-3 and SCP-4; Opus for the containment)

| Ticket | Acceptance |
|---|---|
| Sa Flag and containment | Boot refuses the simulator beside a real driver or a real account (a test proves it). The flag is visible in `config.ts` and the health output. |
| Sb Simulated accounts | Seeded per mock client; Connections shows them as SIMULATED. |
| Sc Simulated publisher | Due posts publish through the real dispatch path; the failure keyword fails; "posts on schedule" moves. |
| Sd Simulated metrics | Deterministic numbers on days 1, 3 and 7, shown with the SIMULATED mark. |
| Se Simulated boost run | A started boost completes with results. |
| Sf Marking | Every simulated row and screen is marked; reports are watermarked; a test fails if a simulated row renders unmarked. The purge script and the flag-off step are listed under "Before real clients use the portal". |
| Sg Simulated read-back | Feed preview, "Last synced" and the profile counts work from simulated feed, follower and reach data, all marked. |

### SCP-3 · Schedule, live and the calendar

| Ticket | Acceptance |
|---|---|
| 3a Schedule | Date, time and placement (Instagram and Facebook feed; Instagram Reels and Facebook; Instagram Story) with the existing validator. "Schedule in Meta" by hand marks it scheduled; unschedule works. |
| 3b Live | "Mark live" with the link when posting by hand; the simulated publisher in dev; the real publisher after DW-11. A failed publish shows on the Failed posts tile. |
| 3c Metrics | Pulled, typed in or simulated; engagement rate; boost candidates as in §4.2. |
| 3d Feed preview | The client's grid with planned posts; dragging swaps publish dates; live posts are locked. |
| 3e Calendar | The pinned row: every client's posts, Monday-first, stage colours with a legend, holidays and approved leave from the department calendar; plan a post on a day; drag to change a date. |
| 3f Readers and tiles | The KPI readers (posts on schedule, client approval turnaround) and the Overview tiles of §6.4 read the pipeline. |

### SCP-4 · Boosting

| Ticket | Acceptance |
|---|---|
| 4a Boost request | On a live post: goal, audience, daily budget in IDR and days, a reach estimate. Contract first; money in minor units; one open boost per post. |
| 4b Budget approval | As SCP-Q11 rules: by default the client approves in the portal's approvals, or staff record it. |
| 4c Run and results | Start, stop, or complete with spend, paid reach and clicks. The Boosting list shows candidates, running boosts and totals. |

### SCP-5 · Reports and management (after the first release, SCP-Q5)

| Ticket | Acceptance |
|---|---|
| 5a Monthly report | Numbers filled from metrics; one insight and one suggestion per area (followers, engagement, audience); an action plan; Draft, HoD check, Ready, Sent; a PDF; published to the client's portal reports (PV7-04a); "Draft with AI" from the brand-draft lookup. |
| 5b Weekly report | A summary and next week's plan, on the same reports. |
| 5c Ideas for next month | What we saw, the metric and the suggestion. "Add to next plan" creates a planned post linked to the idea; "Mark shared". |
| 5d Team dashboard | Needs attention, workload per person, clients this cycle, where work waits longest (against the holder, never the Officer), estimates not set. On the Overview's Team view and Reports › Team, following the activity privacy rules. |
| 5e Saved | The content bank per client: the Asset Library's photos and videos (used, unused, source) and saved captions, hashtag sets, templates and references. |
| 5f Monthly cycle | Report, planning, copy lock, client window, artwork and deploy as PM tasks per client and cycle. Steps the pipeline can see close themselves. |
| 5g Audit | The twelve-dimension scorecard: automatic from pipeline data for existing clients, typed in for prospects. |
| 5h Onboarding | The onboarding checklist as a PM project template, with due dates in working days from kickoff. |

### SCP-6 · Leave the Excel (after real data is allowed; SCP-D1 keeps it on hold)

- **6a.** A one-off import of the sheet (allocation, next month's plan), built and proved on a mock sheet now.
- **6b.** One month run in parallel.
- **6c.** The sheet retired.

### SCP-7 · Proof: a simulated month, end to end

- **7a.** e2e on sumopod: one mock client's month through all eight steps as every role, all five loops, a block, a
  failed publish, a boost and the month report.
- **7b.** A live drive on the ERP's mock seed, as each role login and a portal placeholder.
- **7c.** axe, light and dark, desktop and phone, on every new page in the Social skin and on the portal page; the
  Standard skin unchanged.
- **7d.** A side-by-side review with the Social Media team against their prototype, screen by screen, with their
  feedback folded in.

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
- **Numbers taken by other sessions.** On 2026-10-26 the portal go-live session (PGL) took FRONTEND-BFF-CONTRACT §62,
  PERMISSION-CONTRACT §52, the migration prefix 202610261100, PV-D46, PV-D47, WSK-D84 to D89 and M6-P6o and P6p. At
  SCP-0b, fetch main and take the next free numbers then; never reserve them in advance.
- **The skin flag.** The Social skin stays off for every company until Kg. Nothing visible changes for other
  workspaces at any point (Ka's test).

## 10. Open items and risks

- **Public holidays** come from the HR holiday calendar; a company without one gets weekends only, and the Settings
  page says so.
- **Timezone:** markers and "today" use the company's timezone. `REPORTS_TZ` is unset on live (UTC days, a DW-4
  finding).
- **One caption or per network:** the master caption is copied into the variants, and the variants may differ. The
  client approves what each network will get.
- **Images at scale:** about 18 clients × 10 to 18 posts a month is 200 to 300 image cards a month and 600 across two
  months. The feed and grids use thumbnails through the portal-safe file route, loaded lazily, and read on the server.
- **Double-tap alone is not accessible.** The visible Approve button stays the main control; double-tap is a shortcut.
- **Undo on the server.** The prototype undoes any action in the browser. In the ERP, undo is a recorded reverse of the
  person's own last step, and notifications wait out the undo window.
- **People data on the Team dashboard.** "Last sign-in" and per-person waiting times follow the existing activity privacy
  rules (DW-4).
- **Skin upkeep.** Every shared component styled only through tokens keeps a new skin cheap; every skin adds to the
  visual test matrix. Start with two.
- **Reversing the "no simulator" rule** stays the biggest technical hazard. SCP-Sa and Sf contain it, as Opus work with a
  review.
- **Real publishing** needs Meta Business Verification and App Review (DW-11, D-23), Postiz deployed and the AGPL counsel
  sign-off (OQ-3). "Schedule in Meta" by hand covers the dev review.
- **The prototypes' names.** Both designs carry real client and staff names in their sample data. Seeds, fixtures, tests
  and docs use mock names only.

## 11. Mock seed (SCP-0c)

Nothing in the seed is a real client or person. Every name is invented here, never taken from either of the team's
prototypes.

### 11.1 DEMO_MODE (platform-ui)

The identities live in `lib/demoIdentity.ts`, the people and their seats in `lib/org.ts` and `lib/demoFixtures.ts`, and
the social store in `lib/demoSocial.ts`.

| Role | Identity | DEMO_MODE login | State today |
|---|---|---|---|
| Officer 1 | `u-social`, placed in Social Media | `social@gaiada.com` | Exists (DW-9a) |
| Officer 2 | New `u-social-2`, placed in Social Media | `social-two@gaiada.com` | New |
| Copywriter | New `u-copy`, placed in Social Media, holding the copywriter role (SCP-Q9) | `copywriter@gaiada.com` | New |
| HoD | `u-pm`, already in Social Media, given the Social Media lead seat (`org_unit_lead` on `dept-4`) | `social-head@gaiada.com` | New login, existing person |
| Creative | `u-creative`, in Creatives › Design | `creative@gaiada.com` | Exists (DW-9a) |
| GM | `u-gm`, the General Manager's lead seat on `dept-5` | `gm@gaiada.com` | New login, existing person |
| Client | The demo portal client | any `@northwind.example` | Exists |

- **Matching.** Each new address matches exactly. It sits after the "client" test and before the "manager" and "ic"
  tests, as DW-9a's do. None of the new tokens contains "ic" or "client", and a test pins each address to its identity.
- **The store.** `lib/demoSocial.ts` keeps Northwind Traders and gains two invented clients, a spa and a hotel brand.
  Each gets an allocation (officer, posts per cycle, report format), a brand book, cycles for last month, this month
  and next, and a month of posts that covers all twelve statuses. That includes a blocked post, a client copy change, a
  client design change, a post with suggested edits waiting, and a live post with metrics for a boost. The images are
  generated placeholders; none comes from the prototypes.
- **The clock.** Tests that seed "a few days after today" pin the clock to mid-month, as `demoDeptCalendar.test.ts`
  now does, so they do not fail from about the 26th.

### 11.2 Test personas (IAM-06b)

`seedPersonaTenant` gains the role keys SCP-0b names for the Copywriter and the social approver, and a helper that
places an Officer on a client's allocation. Every stage-machine test seeds: two Officers, the Copywriter, the HoD, a
second approver (the GM), a designer on the client-month request, and a client contact.

### 11.3 The live mock seed (gda-aicenter, under the owner's 2026-10-13 ruling)

- **Staff logins:** one labelled test user per role, display name "SCP test · <role>": Officer 1, Officer 2,
  Copywriter, HoD, Creative. They use addresses on a reserved test domain, never a real mailbox. They are created
  through the ERP's own invite flow if it provisions a login, and otherwise with the Keycloak provisioner
  (`gaiada-provisioner`). If the classifier refuses the live write, the owner runs the prepared command. The GM checks
  use the owner's account, as the ruling allows.
- **Client logins:** the 19 `portal@<client>.test` placeholders, invited, accepted and revoked as proven in release
  386.
- **Mock clients:** three of the live seed's existing mock clients get allocations, brand books, cycles and a month of
  posts. These are written through the API as the test logins, so the stage machine and the activity log run for real.
- **Simulated accounts** for the same clients come with SCP-Sb.
- **Runs:** log in once per run, stop on the first failed login, and never retry a failed login on a real account.
- **Teardown list:** every test user, client allocation, cycle and post created on live is listed with its id in
  `CREDENTIALS.local.md` (gitignored), never in the repo, together with the commands that remove it. SCP-7b ends with
  the teardown, and the list is re-checked before real data arrives ("Before real clients use the portal").
