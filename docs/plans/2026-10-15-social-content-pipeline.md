# Social Media content pipeline (SCP): plan

Status: PLANNED 2026-10-15; **re-planned 2026-10-26** for the team's v2 design; the owner's rulings of 2026-10-26 are in §2. Board: `TASKS.md` › "Social Media content
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
| Boost | A stage of its own, with the client approving the budget | An action on a live post, within a monthly boost budget the client agreed in advance (SCP-Q11) |

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
| 3 | HoD approval | HoD or GM (or the owner or the superadmin: the four approvers, SCP-Q19) | Approves it for design, which hands the post to the client's designer (the client-month Creatives request, or the in-team design queue, SCP-Q2); or asks for changes | In production |
| 4 | Creative | The client's designer: Creatives, or the Social Media team's own designer | Designs from the Creative brief, uploads versions, submits for the final check | In production |
| 5 | Final check | HoD or GM (or the owner or the superadmin, SCP-Q19) | Sends it to the client, or asks for a copy change (Officer) or a design change (Creative) | In production |
| 6 | Client | The client | Approves, or asks for a copy or a design change, with a note and an optional pin on the image | With client; Client changes |
| 7 | Schedule | Officer by hand; one of the four approvers through the publisher (SCP-Q16, SCP-Q19) | Date, time and placement; scheduled by hand ("Schedule in Meta") or through the publisher | Client approved |
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
| SCP-D6 | 2026-10-27, plan (SCP-1b, resolving a fixture inconsistency) | **After a client copy change, the date and placement stay locked.** The fixture's `editRules` allowed the date in the `client_copy` case while its `systemRules.date_moves` locked it. Loop e re-syncs only the copy to the variants, so an edited date would split the post's date from the variants' dates. The officer fixes the copy (and the must-haves) only; a new date after the client's next approval goes through `reschedule`, which asks the client again (SCP-Q13 holds). Fixture `editRules`, BFF §63.6.3. |
| SCP-D7 | 2026-10-27, plan (SCP-1q's review, applying the owner's SCP-Q23) | **Nobody may rename, re-type or move a unit on which they hold a live lead seat.** SCP-1q closes self-edits of a held position. But the Social Media and GM units are found by name (the workspace slug, PV-D13), so a company admin holding a lead seat on another unit could rename that unit "Social Media" in the org structure and become one of the four approvers alone. SCP-Q23's rule ("nobody can make themselves a head"; it protects every lead-seat authority) is applied to the org structure the same way: an `org_structure` edit that changes the name, kind or parent of a unit the actor holds a live lead seat on is refused, superadmin included; another administrator makes it. Ticket SCP-1r, landing with SCP-1b and SCP-1q (SCP-Kg went on in code first, with the unbuilt pages' pins still ticketed, so the guard now has to arrive with the approvals themselves). |
| SCP-D8 | 2026-10-27, plan (SCP-1b, correcting BFF §63.3.5 and §63.8) | **A post's design files carry no file role; the design row marks them.** The contract said `files.role = 'social_design'` (and `'social_reference'`), but in this schema a file role marks an issued record: one live file per parent and role (`ux_files_live_role`), never deleted, its role fixed. A post has several designs, so the materialized files keep `role` NULL and `social_post_designs.file_id` names them. The portal serves a post's file only when a live design row of a visible post names it. |
| SCP-D9 | 2026-10-28, owner (amends SCP-D3) | **The simulator runs beside the real Postiz; never mixed.** The live switch-on found a real Postiz running on the ERP box, which SCP-Sa's "never both" containment would refuse at boot. Asked how to proceed, the owner said: "use simulator with poztiz. so we can know if its working or not at the same time". So the rule moves from *never both* to *never mixed*: simulated accounts publish through the simulator and real accounts through Postiz, side by side. Every `social_accounts` row is exactly one kind (a database CHECK: simulated with a `simulated:<network>` integration id and no person who connected it, or real without that prefix; the kind is fixed once used; no OAuth grant on a simulated account), every real path refuses a simulated account (`simulated_account_on_real_publisher`) and the simulator refuses a real one, and a post is wholly simulated or wholly real (`publisher_kinds_mixed`, SCP-Sa3). Boot no longer refuses Postiz, real accounts or grants beside the switch; it refuses rows that break the kind rule. The hazard SCP-D3 answers is unchanged and is now carried by the per-account rule. Tickets SCP-Sa2, SCP-Sa3. |
| SCP-D10 | 2026-10-29, plan (SCP-6a's contract; the owner may overrule) | **The sheet import is a one-off tool of the four approvers, and it never overwrites quietly.** It reads an uploaded or pasted sheet, lets the person map its columns and pick the names it could not match, previews every row, and writes all of it or nothing. An empty cell never clears a value, and a replay writes nothing new (the post ids are derived from the row). The posts arrive Planned through the machine's own `create`, and **the sheet's copy (caption, on-asset text, CTA, hashtags) comes along as the post's starting text**: the team's next-month rows often hold drafted copy, and the 15 Oct paste carried it. The edit rules do not change, so the officer changes the copy once the post is in Drafting. A client with no social engagement is refused, not created, because an engagement carries its contract and scope and is opened in the ERP first. BFF §63.23. |
| SCP-D11 | 2026-10-31, owner (SCP-6) | **A post's images and videos come from Google Drive.** The owner's words: "the assets should be coming from the google drive. so since we will integrate with google drive, we can have their images or videos from there". The team already keeps every post's footage and finished files in Drive, and the sheet links them; the approval link reads them with its owner's Drive access. The ERP reads the Drive files and folders a post links, shows them to staff, and serves them to the client through the portal's file route, so the client needs no Drive access. **How the ERP reaches Drive** (the owner, the same day, in three messages): "later when they login they should be able to conect to the gdrive and auth from there. ensure the ui have it and back end able to perform. The erp will have the access to grive, the same way we do. But erp will be the book record on who did what", then "no erp have 1 aaccount. aand the team pnly log in to erp. This is the same way we do with github".
- **The ERP has one Google account for the company,** as it has one GitHub App: a company connection made once in the ERP's UI through Google's sign-in (OAuth), with its refresh token sealed in the credential vault. The team never connects its own Google account; it signs in to the ERP only.
- **That account has the team's Drive access:** the team's client folders are shared with it, or it is a member of the team's shared drives. The scope is `drive` (what the team itself can do); the first features only read. Every write it ever makes goes through an ERP action and its permissions.
- **The account's token never leaves the server.** The ERP lists folders, reads files, stores thumbnails and streams videos itself. Google's Picker, which needs a token in the browser, is not used with this account; a person pastes a Drive link or browses the folder through the ERP. §42's person-by-person connection (`drive.file`) stays as built for PM attachments.
- **The ERP is the record of who did what.** Drive's own history shows only the ERP's account, so every Drive file or folder put on a post, every version submitted, approved or replaced, and connecting or disconnecting the account, is written to the ERP's activity with the person who did it, the file's Drive id and its version.
- **The client** needs no Drive access: the portal serves what the ERP reads with its account.
- The client's approval covers the exact files it saw: a Drive file changed after the approval asks the client again, as SCP-Q13's rule does for any change.
- `drive` is a restricted scope. An OAuth app marked Internal to the company's Google Workspace uses it without Google's verification; a public app (SaaS later) needs Google's verification and security assessment first.
- The import keeps every link the sheet gives a post as its raw assets (SCP-6b1). SCP-6b5 builds the rest. Owner steps: create the OAuth client as an Internal app with the Drive API (DW-11 item 6), and share the team's folders or shared drives with the ERP's account. |

**Ruled by the owner on 2026-10-26** (first-hand, each chosen from options in the planning session):

| # | Question | Ruling |
|---|---|---|
| SCP-Q2 | Who does the Creative step? | **Either, per client.** Each client's allocation sets its creative source. `creatives`: the Creatives department, through one work request per client per month (DW-D14); a post joins it when the HoD approves it for design. `in_team`: a designer inside the Social Media team, with no request. (The default had been Creatives for every client.) |
| SCP-Q5 | What is in the first release? | **SCP-K, SCP-1 to SCP-4 and SCP-S, plus SCP-5a (the monthly report) and SCP-5d (the Team dashboard)**, proved by SCP-7. The rest of SCP-5 (5b, 5c, 5e to 5h) comes after; SCP-6 waits for real data. (The default had been SCP-5 after the first release.) |
| SCP-Q7 | A skin per department? | **Yes, per department** (DW-D51), by the rule in §6.1. Standard and Social are the first two. |
| SCP-Q8 | How does the client reach the approval page? | **Portal login.** The link we send, shareable to WhatsApp, opens the portal page; staff record decisions the client gives by WhatsApp or email. No no-login link is built. |
| SCP-Q9 | Who fills each role? | **The HoD or the GM**, with equal authority, plus anyone given a `social_manager` grant, pass the HoD approval and the final check. The Copywriter is a role any member can hold. The Officer authors and never approves their own post. Replaces SCP-Q4 and SCP-Q6. (refined by SCP-Q19) |
| SCP-Q10 | How are deadlines set? | **The deadline table:** a deadline per client per cycle. The A/B batch rule pre-fills it and the HoD may change any date. Ready-by is a buffer of working days earlier (default 1); step estimates are optional; holidays come from the HR holiday calendar. |
| SCP-Q11 | Who approves boost money? | **A monthly boost budget.** The client agrees a boost budget per cycle in advance, in the portal's approvals, or staff record it. A boost that fits what remains of that budget starts without asking; a boost over it waits for the client's approval in the portal. (The default had been the client approving every boost.) |
| SCP-Q12 | Keep the board and the spreadsheet table? | **Drop both** from SCP-1. The home feed, the client's List and the Team dashboard cover the board; pasting from a sheet moves to the one-off import (SCP-6). |
| SCP-Q13 | Does changing an approved post's date need the client again? (raised by SCP-0b) | **Yes, always.** The client's approval covers the content and the date, time and placement. Today's hash rule stays: the date is in the review hash. Any change to the date, time or placement of an approved or scheduled post sends it back to the client and asks again on every network (a scheduled one is unscheduled first, cancelling any dispatch). Scheduling at exactly the approved date, time and placement keeps the approval; a feed-preview swap asks again for both posts. |
| SCP-Q14 | Who in the portal may agree boost money? (SCP-0b) | **Signers only:** a contact with signing capability on that client (`signer` or `admin`). A viewer sees the request but cannot agree; staff can record the client's answer instead. |
| SCP-Q15 | The monthly boost budget's edges (SCP-0b) | **Lowering is allowed.** A signer in the portal, or a social approver recording the client's answer, may lower a cycle's agreed budget as long as it still covers what is committed. Committed is the full budget of approved and running boosts, plus the actual spend of stopped and completed ones: a stopped boost counts only what it spent, so its spend is recorded when it stops. The per-cycle lock stays. A boost still draws from the month it starts in. |
| SCP-Q16 | Who files a schedule through the publisher? (SCP-0b) | **The HoD or GM files it, and a second person decides it** (PV-D46: the filer never approves their own high-impact request). The officer schedules by hand ("Schedule in Meta"). (refined by SCP-Q19) |
| SCP-Q17 | May agents move posts? (SCP-0b) | **Yes, with the rights of the person who asked.** The owner's words: "same right as the person login or ask. so if the one that ask ai to do something is staff, than the ai will follow staff permission." The existing on-behalf-of model applies: the person is the author and Cerbos decides on them, the agent is recorded alongside (`via`), and the maker/checker rule applies to the person. Writes classed high go through the agent's write gate and the in-thread confirm. Unattended automations with no person behind them stay refused every new action. |
| SCP-Q18 | Who edits allocations, deadlines and boost budgets? (SCP-0b) | **The social approvers only:** the Social Media unit head (lead seat), the GM (lead seat), or a `social_manager` grant (plus platform admin), not `manager`. That covers the allocations (officer, creative source, target, report), the deadline table and settings (buffer, step estimates), and recording, setting, raising or lowering boost budgets on the client's behalf. (refined by SCP-Q19) |
| SCP-Q19 | Who exactly are the social approvers? (raised in the review of SCP-0b) | **Exactly four:** the Social Media unit head (lead seat), the GM (lead seat), the owner (the IAM `owner` role) and the superadmin (`platform_admin`). The owner's words: "no. social media HOD, GM, Owner and Superadmin only. or the social media team, but need HOD or the other high level mentioned." A company admin is not one, and no grant can make anyone one. A `social_manager` grant is no longer an approver path anywhere (this supersedes that part of SCP-Q9 and SCP-Q18). The Social Media team keeps its own steps. Every approver-only action needs one of the four: the HoD approval, the final check, filing through the publisher, the allocation, the deadlines and settings, boost budgets, and recording the client's money answers. The maker/checker rule stays on top: an approver who authored the post, or is its officer, still cannot approve it, even as superadmin. |
| SCP-Q20 | Who checks and sends a client's monthly report? (raised in the review of SCP-0b) | **Only the four approvers** approve it (the HoD check) and send it. The officer writes it and submits it for the HoD check, but does not send it. |
| SCP-Q21 | Who decides a pipeline post's publish approval? (raised by SCP-0b, from SCP-Q19) | **The four approvers, directly.** For a social pipeline post, being one of the four is the right to decide its publish approval: the HoD, the GM and the owner need no company-admin role, and a company admin who is not one of the four cannot decide it. The person who filed it never decides (PV-D46), and the post's author or officer cannot either. Every other kind of approval keeps today's rule. |
| SCP-Q22 | May the writer of a client's monthly report approve it? (raised by SCP-0b) | **Yes.** Reports have no maker/checker rule: one of the four may approve a report they wrote. (Posts keep theirs.) |
| SCP-Q23 | Close the self-promotion gap into a lead seat? (raised by SCP-0b) | **Yes, with a ticket (SCP-1q).** Nobody may edit a position they hold, the same way assigning yourself is already refused, so nobody can make themselves a head. It protects every lead-seat authority, not only SCP, and lands before SCP's approvals go live. |
| SCP-Q24 | What does the Social Home show? (raised 2026-10-27 by the owner: the Overview's header and blocks clutter the design) | **The design's feed only.** In the Social skin the Home has no Overview header (greeting, period, quick actions, Customise, Me/Team), no Overview blocks and no "More from Social Media" band. What only the Overview offered moves first to slots the design already has: Needs you to the top row of Notifications (Kh); today's check-in and pinned notices to the design's reminder cards (Ki); Notices and the Department calendar to More (Kj); Ask Web Dev to Create (Kk). The KPI strip, Pulse and the head's Team view go to the Team dashboard (SCP-5d). The Standard look and every other department keep the Overview. Reverses §6.4's "the KPI strip and banner stay" for the Social skin. |

**Ruled by the owner on 2026-10-30** (relayed first-hand by the orchestrating session). SCP-Q25 to SCP-Q36 were raised by the
contract for the rest of SCP-5 (BFF §63.24 to §63.29), each with a recommended default, and the owner took every default in two
words: "accept default". SCP-Q37 to SCP-Q41 are the owner's own, ruled the same day. Since SCP-Q41 the rulings that are rules
of work (SCP-Q25 to SCP-Q40, where they are) are the seeded defaults of each company's own SCP-5 rules, which the four edit in the UI.

| # | Question | Ruling |
|---|---|---|
| SCP-Q25 | Who sends the weekly report? | **As the monthly:** the officer writes and submits it; only the four check and send it, and sending publishes it to the client's portal reports. Since SCP-Q37 this holds for every periodic kind. |
| SCP-Q26 | Which clients get a weekly report? | **The clients switched on in the allocation,** off until set. Since SCP-Q37, per kind (`report_kinds`). |
| SCP-Q27 | Do ideas reach the client? | **No.** "Mark shared" records that the team shared an idea; nothing goes to the portal or the PDF. |
| SCP-Q28 | Saved captions, templates and references: per client or team-wide? | **Per client,** as the team's prototype. |
| SCP-Q29 | Who curates Saved? | **The Social Media team adds;** changing or deleting someone else's item is the client's officer, the HoD or the GM. |
| SCP-Q30 | Videos in Saved? | **Drive links only;** the Asset Library stores images. |
| SCP-Q31 | Which monthly-cycle steps close themselves? | **All six,** each on its pipeline condition, and each reopens when the condition stops holding. |
| SCP-Q32 | The audit's dimensions, weights, bands and benchmark? | **The 15 Oct design's twelve, reworded;** equal weights; bands at 75 and 50; the benchmark is our own clients' median engagement rate by business type over 90 days. All reviewed with the team at SCP-7d. |
| SCP-Q33 | Where does a prospect live? | **On its audit,** as a name and a business type, attached to the client once signed. |
| SCP-Q34 | Who writes audits? | **A client's: its officer, the HoD or the GM. A prospect's: the four.** |
| SCP-Q35 | The onboarding checklist? | **The team's fifteen steps in six phases, reworded,** seeded as a PM project template the four edit; the team sets the offsets. |
| SCP-Q36 | Who starts a client's onboarding? | **The four,** because it hands tasks to people. |
| SCP-Q37 | Reports on demand (the owner, 2026-10-30) | **AI generates the reports, for one client or for all, at any period, and by chat.** The owner's words: "the goal is to have a button to make ai generate the reports. it could be per client or all, daily, weekly, monthly, quarterly, semester, yearly. and by chat with ai." Periodic reports from daily to yearly on `social_reports`; "Generate with AI" for one client or for every client the person may draft for; an agent tool that drafts and never approves or sends (BFF §63.24). The four still check and send every kind (SCP-Q25). |
| SCP-Q38 | Reports generated on a schedule, set in the UI | **Yes, owned by the approver who sets it.** The owner's words: "proceed. also ensure the UI is ready and HOD can set the automation however he need in the UI". The four set report schedules (kind, clients, timing, on or off) in a "Report automation" section of `{D}/settings`; each run drafts the period that just ended through "Generate with AI" and acts as the schedule's owner, re-authorized at run time; if the owner no longer may, the run is skipped and the schedule pauses with the reason (BFF §63.24.9). This is how SCP-Q17 is kept: every run has its person; unattended principals stay refused. Runs only draft. |
| SCP-Q39 | Report periods: calendar or fiscal? | **Calendar** quarters, halves and years. |
| SCP-Q40 | Cap the AI spend of report generation? | **Track it, never cap it.** The owner's words: "we track but not cap it". Every generation call is recorded in the AI usage record with its run, each run shows its tokens and cost, and each schedule its spend; nothing is refused on spend (BFF §63.24.5, §63.24.9). |
| SCP-Q41 | Fixed rules, or rules each company sets? | **Each company sets them in the UI; the rulings above are the defaults.** The owner's words: "i want ui can be used to set all these rules. it will give flexibility that company need". It follows the standing ruling "internal now, SaaS later: never hard-wire our group". The four edit, on `{D}/settings`, per report kind (on or off, the due rule, when the numbers freeze, the content, what the check needs, AI drafting), the fiscal year's first month, the monthly cycle's steps, the audit scorecard, the onboarding checklist, Saved's categories, whether shared ideas reach the monthly report, and the report schedules. Rules are versioned: a report, a run, an audit or a cycle keeps the version it was made under, and a change applies to new periods and records only (BFF §63.30). **Not set here:** who may act (approvers, checkers, senders, the four of SCP-Q19; permissions belong to the IAM roles-as-data program and PERMISSION-CONTRACT); the safety invariants (one report per client, kind and period; AI only drafts and never approves or sends; maker/checker on posts; the four for money; a schedule acts as its owner); and the structural shapes, such as where a prospect lives. |
| SCP-Q42 | May a company admin add to a client's Saved? (2026-10-30; adding is gated on `social_post` · `create`, which a company admin holds) | **Yes.** The owner's answer: "yes". Changing or deleting someone else's item stays the client's officer, the HoD or the GM (SCP-Q29). |
| SCP-Q43 | May the owner and the superadmin write a CLIENT's audit? (2026-10-30; SCP-Q34 named only the officer, the HoD and the GM for a client) | **Yes.** The owner's answer: "yes". A client's audit is written by its officer or any of the four; a prospect's stays the four's. |

**Ruled by the owner on 2026-10-31** (first-hand, in the SCP-6 session). The team's real sheet arrived that day: one file per client and month, with a content plan tab and a stories tab, and a separate approval link the client opens without a login. Comparing it with the ERP raised four questions (§8 SCP-6).

| # | Question | Ruling |
|---|---|---|
| SCP-Q44 | Does a reposted story need the client? (the sheet marks 17 of one client's 39 November stories "REPOSTED" and shows them to the client as "no review needed") | **Yes. Every post and story goes to the client, and a repost is marked as one.** The owner's words: "all post should be approved by client and marked repost if its repost." A post or story that reposts another account's content carries a repost mark, which staff and the portal show. It passes the client step like any other post, and the stage machine's other steps do not change. |
| SCP-Q45 | Keep the team's AI check? (the sheet carries an "AI CHECK NOTES" column, graded Critical, Major, Minor and Check, "flag only, SMM to edit") | **Yes.** The owner's answer: "yes". The ERP runs an AI check on a post and flags what it finds at those four levels. It only flags; the officer makes the edit, as SCP-Q41's invariant "AI only drafts" requires. When it runs, what it reads and how its findings show are for SCP-6b2's contract; its spend is tracked and never capped (SCP-Q40). |
| SCP-Q46 | Track the month's output per format, or only the total? (the sheet's header reads, for example, "4 REELS, 3 CAROUSEL, 4 SINGLE POST, 1 CAROUSEL VIDEO") | **Each format.** The owner's words: "track each". A client's allocation sets a target per format, and progress, schedule health and the Team dashboard count each format against its own target, with the total as their sum. Plan reading, which the owner may overrule: stories get a target line of their own and stay outside the posts' total, as §4.4 says. Whether "carousel video" becomes a format of its own is for SCP-6b2's contract. |
| SCP-Q47 | Which month runs in parallel (SCP-6b)? | **December 2026, planned in the ERP from the start; November is seed.** The owner's words: "december. and november is a seed". December's posts are planned, approved and scheduled in the ERP beside the sheet. November, already mostly approved by the client in the sheet, is not reworked. Plan reading: its file is loaded into the live ERP as seed data through the fixed import (SCP-6b1), which rehearses the real file. Asked whether running December puts real client data in the live ERP (SCP-D1), the owner said: "all is just mock seed for trial purpose. so nothing to worry. and proceed". The live ERP stays a trial on mock seed, both months included, so SCP-D1 and the owner's 2026-10-13 live-check ruling still apply. |

**Open:** none.

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
| SMM Officer | A Social Media member set as the client's officer on the allocation (SCP-1a) | Their clients: drafts, fixes, schedules, marks live, follows up; writes the monthly report and submits it for the HoD check. Never approves their own post, and never sends the report (SCP-Q20) |
| Copywriter | Holder of the copywriter role (SCP-Q9), any member | The proofread step on every client |
| Designer | Per the client's creative source (SCP-Q2): a Creatives member working the client-month request, or a Social Media member holding the in-team designer role | Design, versions, submit for the final check |
| PM / Head of SMM, GM: the four approvers | Exactly four, with equal authority (SCP-Q19): the Social Media unit head and the GM (their lead seats), the owner (the IAM `owner` role) and the superadmin. Not a company admin, a head's `manager` role or a `social_manager` grant | HoD approval, final check, filing through the publisher, the allocation, deadlines and settings, boost budgets, the report check and sending the report (SCP-Q20), the Team dashboard. The HoD and the GM also run the team's own steps (block, resolve, a client's recorded decision, boosts) and get the queue and the notifications |
| Client | A portal contact of that client | Approves or asks for changes; agrees the monthly boost budget and any boost over it (SCP-Q11) |

The design's demo account switch does not exist in the ERP: the signed-in person acts and Cerbos decides. Mock seed gives
each role a login (SCP-0c). No approval step may be passed by the post's author: if a HoD drafted a post as a client's
officer, the GM or another approver takes its HoD approval and final check. That holds for the owner and the superadmin
too (SCP-Q19).

### 4.2 Data (names fixed by SCP-0b: FRONTEND-BFF-CONTRACT §63.1 is the authority; migrations take a timestamp after main's newest)

- **Allocation, on `social_engagements`:** the officer is the existing `owner_id` (the engagement owner, who already gets
  every notification about the client's posts; there is no `smm_officer_user_id`); `posts_per_cycle`; `creative_source`
  (`creatives|in_team`, SCP-Q2); `delivery_batch` (`A|B`, pre-fills the deadline table); `report_format` (`email|meeting`);
  `report_due_day`; `platforms text[]`; `formats text[]`; `default_post_time`; `step_estimates` (working days per step,
  optional, per client).
- **Brand book, on the existing `social_brand_profiles`** (one per client, already read by "Draft with AI"): the existing
  `tone` (gains `summary`) and `hashtag_strategy` (gains `sets`), plus `content_pillars text[]`, `must_have_notes text[]`,
  `brand_rules text[]`, `channels`, `key_dates`, `links`.
- **`social_settings`** (one row per company): `buffer_working_days` (default 1), `boost_candidate_factor` (1.25).
- **`social_cycles`:** `engagement_id`, `month` (the first of the month), `deadline`, `ready_by` (computed by the server),
  `creative_request_id` (the client-month Creatives request).
- **On `social_posts`:** `cycle_id`; `format` (`feed|carousel|reel|story`); `pillar`; `angle`; `objective`; `key_message`;
  `caption` (the master caption); `on_asset_text`; `cta`; `hashtags`; `visual_direction`; `raw_assets` (a list of
  `{url, label, source, aiNote}`, replacing `raw_assets_url`); `placement`; `pipeline_status` (§4.3) and `status_since`;
  `change_by`, `change_kind` (`copy|design`), `change_note`, `return_to`; `changed_only` and `copy_before`; `suggestions`
  (the Copywriter's pending edits); `block_reason`, `block_waiting_on`, `blocked_from`, `blocked_at`; `must_haves text[]`
  (ticked checks); `skipped_checks` (reason, who, when); `creative_source` (the post's own, copied at approval for design),
  `creative_state` (`not_started|in_progress|revision|submitted`), `creative_request_id`; `is_extra`; `idea_id`;
  `author_id` (the maker); `client_first_sent_at`; `schedule_via` (`manual|publisher`); `live_url`, `went_live_at`;
  `simulated`; `archived_at`, `archived_by`, `archive_reason`; `last_action_id`, `last_action_at`. The publish engine's
  `status` stays, held to `pipeline_status` by one mapping (§4.3) that the 0b fixture pins.
- **New tables:** `social_post_designs` (the designs in order: an Asset Library version group or a link) and
  `social_post_copy_edits` (the copy edit log, append-only).
- **Variants** are created at the final check, one per placement network, from the master caption. Per-network changes
  stay in the Composer, and the existing rule that an edit clears an approval still holds. An Instagram Story is an
  Instagram variant with `settings.igType='story'`. Variants gain no column: the client's approval keeps today's hash
  rule, with the date in the hash (SCP-Q13).
- **Client review:** `social_post_client_reviews` stays per variant. One decision per post applies to all of its variants
  in one transaction. New columns: `change_kind`, `anchor` (a pin on the image), `recorded_by`, `channel`
  (`whatsapp|email|meeting`), `decision_id`, `undo_until`. The review keeps comparing `reviewed_args_sha256` with the
  variant's `args_sha256`, so it covers the content, the date, the time and the placement.
- **Comments:** `visibility` (`team|client`) and `anchor` (`{x, y, fileId}`) on the shared `comments`.
- **Creative assets:** `source` (`own|client|stock|ai|unknown`) and `ai_note`.
- **Metrics:** `social_post_metrics.source` (`pull|manual|simulated`), `reach` (the table has none today) and `entered_by`,
  and a manual-entry endpoint. Engagement rate is (likes + comments + saves + shares) ÷ reach; a boost candidate is at
  least 1.25 × its account's average.
- **`social_boost_budgets`** (the monthly boost budget, SCP-Q11): one row per proposal or recording for a cycle,
  `amount_minor`, `currency`, `status` (`pending|agreed|declined|withdrawn|superseded`), `decided_via` (`portal|recorded`),
  who and when. The cycle's agreed budget is its one `agreed` row; a new agreement may be higher or lower, never below
  what is committed (SCP-Q15). It is a table on the plain tenant wall rather than columns on `social_cycles`, because
  the portal writes it (the 0105 D-16 rule).
- **`social_boosts`** (plain tenant wall too): `post_id`; `cycle_id` (the month the boost starts in); `status`
  (`requested|approved|running|stopped|completed|cancelled|declined`); `goal` (`profile_visits|website|messages`);
  `audience` (`automatic|local|custom`, plus a description); `daily_budget_minor` with `currency` (IDR); `days`;
  `total_budget_minor`; `starts_on`; `approved_by`, `approved_via` (`budget|portal|recorded`; `budget` means within the
  cycle's agreed boost budget) and `budget_id`; `spend_minor` (recorded when the boost stops or completes),
  `paid_reach`, `clicks`; `simulated`. Committed is the full budget of approved and running boosts plus the spend of
  stopped and completed ones (SCP-Q15). The client sees their own budget and spend (PV-D38), never our fees.
- **Simulation (SCP-S):** `social_accounts.simulated`, `social_post_variants.simulated`, `social_metrics_daily.source`.
- **`social_ideas`** ("Ideas for next month"): `engagement_id`, `cycle_id`, `saw`, `metric`, `suggestion`, `status`
  (`proposed|planned|shared`), `post_id`.
- **`social_reports`:** `notes` (one insight and one suggestion per area), `action_plan` and `simulated` in the first
  release (SCP-5a, SCP-Q5); the `weekly` kind with SCP-5b. The design's Draft, HoD check, Ready, Sent map to the
  existing `draft`, `in_review`, `approved`, `delivered`.
- **Tasks:** `pm_tasks` gain `linked_type` (`social_post|social_cycle`) and `linked_id`: a task can point at a post, and
  the content-month task points at its cycle. No new task table (SCP-D4).

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
| `approve_for_design` | `hod` → `design` | An approver (§4.1), not the author or the officer | Hands the post to the client's designer: with creative source `creatives` it joins the client-month Creatives request (opened if none exists); with `in_team` it enters the in-team design queue |
| `hod_changes` | `hod` → `changes` (return to hod) | An approver | A note is required |
| `resend` | `changes` → `hod` or `final`, as the return says | Officer | For copy fixes asked at the HoD approval or the final check |
| `start_design` | `design`, or `changes` (design) | The client's designer (on the request, or an in-team designer) | `creative_state` becomes `in_progress`, or stays `revision` |
| `submit_design` | `design`, or `changes` (design) → `final` | The client's designer | Needs an asset version or a shared link |
| `final_approve` | `final` → `client` | An approver, not the author or the officer | Creates the variants and requests client review on each |
| `final_changes` | `final` → `changes` (return to final), copy or design | An approver | A note is required. A design change sets `creative_state` to `revision` |
| `client_approve` | `client` → `approved` | The client in the portal; or the Officer, HoD or GM recording it with channel and note | Every variant's review approved with its hash, which covers the content, the date, the time and the placement |
| `client_change` | `client` → `changes`: copy (return to proofread, the before-text kept) or design (return to the final check, revision: loop d) | The client, or recorded by staff | A note is required; a pin on the image is optional |
| `schedule` | `approved` → `scheduled` | Officer | By hand ("Schedule in Meta"), at exactly the approved date, time and placement; the media validator passes. An approved time that has passed needs `reschedule` |
| `schedule_publisher` | `approved` → `scheduled` | An approver, not the author or the officer | Through the publisher, at the approved date, time and placement: one publish approval per variant, decided by a second person (SCP-Q16, PV-D46) |
| `unschedule` | `scheduled` → `approved` | Officer (by hand); an approver (through the publisher) | Cancels a dispatch; the client's approval stands |
| `reschedule` | `approved`, `scheduled` → `client` | Officer | A new date, time or placement: the client approves again on every network (SCP-Q13). A scheduled post is unscheduled first, cancelling any dispatch |
| `mark_live` | `scheduled` → `live` | Officer, or the publisher's result | The post's link; metrics start |
| `block` | any status before `client` → `blocked` | Officer, HoD or GM | A reason and who we wait on; `blocked_from` kept |
| `resolve` | `blocked` → the status it left | Officer, HoD or GM | |
| `agree_boost_budget` | on the cycle | A signer in the portal's approvals, or a social approver recording it with channel and note | Sets, raises or lowers the cycle's monthly boost budget, never below what is committed (SCP-Q11, SCP-Q14, SCP-Q15) |
| `request_boost` | on `live` | Officer, HoD or GM | Budget and days above zero; no open boost. If daily budget × days fits what remains of the cycle's agreed boost budget, it is approved at once (`approved_via` = `budget`); otherwise it waits for the client |
| `approve_boost` | `requested` → `approved` (or `declined`) | A signer in the portal, or recorded by a social approver | Only for a boost over what remains of the monthly budget (SCP-Q11) |
| `start_boost`, `stop_boost`, `complete_boost` | `approved` → `running` → `stopped` or `completed` | Officer, HoD or GM | Stopping records the spend; completing needs spend and paid reach; spend above budget warns |
| delete | `planned`, `drafting` | Officer, HoD or GM | Later statuses are archived instead |

Any change after the client approved, to the content, the date, the time or the placement, sends the post back to the
client: the existing hash rule does this (SCP-Q13). Every action is checked as one of eight Cerbos actions on
`social_post`, grouped by who acts: `author`, `proofread`, `approve`, `design`, `schedule`, `manage`, `record_client`
and `boost`. The allocation, the deadline table and the settings are `plan`, and recording boost budgets is `budget`, on
`social_engagement` (SCP-Q18). Only the four approvers of §4.1 pass `approve`, `plan`, `budget` and the report check;
`manager`, `company_admin` and a `social_manager` grant hold none of the new actions (SCP-Q19). There is no
`social_boost` kind, and the client acts through the portal's `approve_post` and `approve_spend` (PERMISSION-CONTRACT
§53). An agent acts with the rights of the person who asked; an unattended automation acts on none of them (SCP-Q17).
The attributes conditions read go on the resource's allow-list: `ownerId` (the officer), `creatorId` (the author),
`approverIds` (the Social Media and GM lead seats), `assigneeIds` (the request's designers) and `creativeSource`. The
machine itself is the fixture `platform-nest/src/modules/social/scp-stage-machine.json` (FRONTEND-BFF-CONTRACT §63.3).

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

- **Flag.** `SOCIAL_SIMULATION_ENABLED=1`, read through `config.ts`. As first built (SCP-Sa), boot asserted that the
  simulator and a real publisher were never both registered (the SM-33 pattern) and refused when any non-simulated
  `social_accounts` row existed. **Since SCP-D9 (2026-10-28) the two run side by side, never mixed:** each account is
  exactly one kind (a database CHECK), each driver refuses the other kind, a post is wholly one kind, and boot refuses
  only rows that break the kind rule (SCP-Sa2, SCP-Sa3).
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
| Home | The Social Media Overview `{D}`, laid out as the design's feed, and nothing else (SCP-Q24) | "Your turn", "Waiting on others", tasks, reports due, client stories, accounts this cycle |
| Search | ⌘K | Posts, clients, people and pages |
| Messages | "Waiting on": who holds each of your posts, with Follow up | Client threads open the portal conversation (PV-4). Team chat stays outside the ERP |
| Notifications | The notification feed (`/me/inbox`) | |
| Tasks | PM tasks: for me, given by me, whole team | A task can point at a post |
| Create | The New menu | New post, Extra post, New task, Ask Creatives for assets |
| Calendar | `{D}/calendar`, all clients (the Publish row's Calendar tab) | Added: not in the design |
| Reports | Social reports, `{D}/social-reports` (a tab of the shared Reports row) | The shared Reports row until SCP-5a |
| Saved | The content bank | The Asset Library (`{D}/assets`, a Publish tab) until SCP-5e |
| Profile | The client page: Plan, Stories, Feed preview, Calendar, List and the brand book, with a switcher across your clients | |
| AI Assistant | The assistant drawer | Added: not in the design |
| Dashboard (the four approvers) | The Team dashboard, `{D}/dashboard` | Built in SCP-5d. The Overview's Team view stays the HoD's |
| Settings (the four approvers) | Cycles, estimates, targets, the buffer | Built in SCP-1c |

Each pinned row is a registry row or tab, named by its key in FRONTEND-BFF-CONTRACT §63.17 (row keys are unique inside a
workspace). Calendar, Reports and Saved are tabs of existing rows; Messages, Profile, Settings and Dashboard are new
rows, and so are Allocation, Design queue and Boosting, which sit in More. Settings and Dashboard show to the four
approvers only: both gate on `canLeadSocial` (PERMISSION-CONTRACT §53.4).

**More** (the design's Account row becomes More): the menu shrinks to icons and a panel slides out, with Find a page and
three groups. **Work:** Project Management, Allocation, Design queue, Boosting, Requests, Campaigns, Clients, Social
inbox, Tools & connections.
**Performance:** My performance, Reports, Analytics, Appraisals, Learning. **You:** Approvals, Mail, My calendar, Me.
The account sits at its foot: Switch workspace, Appearance, Log out. A badge inside More also shows on More.

**Phone:** the design's bottom bar (Home, Search, Create, Tasks, Profile); Notifications and Messages at the top; More as
a full-screen sheet from ☰ on the profile.

### 6.3 Pages and addresses

URLs never move, new pages get new URLs under the department, and every page keeps exactly one area (the DW-1c test).
The top-level `/pipeline` and `/monitoring` are Web Dev's. A post opens at `{D}/posts/[postId]` as a drawer over any list
(the `TaskDrawer` intercepting-route pattern). The Composer stays at `{D}/composer/[postId]` as the per-network step,
findable from ⌘K. SCP-0b names the other new pages and their registry keys (FRONTEND-BFF-CONTRACT §63.17). Social
reports get `{D}/social-reports`, because `{D}/reports` is SEO's reports page in every department.

### 6.4 The Overview

**SCP-Q24 (2026-10-27): in the Social skin the Home is the feed alone (Kl).** What follows describes the Overview the Standard look draws for Social Media. In the Social skin, Needs you is the top row of Notifications (Kh), the check-in and pinned notices are reminder cards (Ki), and the Pulse tiles and KPI strip are the Team dashboard's (SCP-5d).

- **Needs you,** per role: Officer (drafts to send, fixes asked, ready to schedule, metrics missing two days after going
  live); Copywriter (the proofread queue); HoD and GM (HoD approvals, final checks, reports to check and to send,
  boosts approved but not started); Creative (designs and revisions). The owner and the superadmin act from the same
  pages without a queue.
- **Pulse tiles:** In production · With client (closes DW-3e's "Waiting client review") · Late · Scheduled this week ·
  Failed posts · Boosts waiting. The KPI strip and banner stay.

### 6.5 The portal

The client's approval page is SCP-2: the company's portal look, with post previews that look like the network they
will appear on. The monthly boost budget, and any boost over it, wait in `/portal/approvals`.

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
| Lead-seat guard | 1q | Sonnet, with an Opus review (authorization) |

**Wave 2 · The staff screens** (after 1b and Ka to Kc).

| Lane | Tickets | Model |
|---|---|---|
| Screens | 1d, 1e, 1k, 1m | Sonnet (frontend) |
| Steps | 1f, 1g, 1h, 1j | Sonnet (backend and frontend) |
| PM | 1n | Sonnet |

Then **Kg** switches the skin on for Social Media once 1d, 1e and 1k are live, and **1p** walks every role (QA, Sonnet).

**Wave 3 · Client, publishing, money, reports** (after wave 2; lanes in parallel).

| Lane | Tickets | Model |
|---|---|---|
| Portal | 2a to 2e, 2g; 2f as SCP-Q8 rules | Sonnet; Opus reviews 2c's transaction. A no-login link would be Opus with a threat model first |
| Simulation | Sa and Sf (Opus); Sb to Se and Sg (Sonnet) | |
| Schedule and calendar | 3a to 3f | Sonnet |
| Boost | 4a (Opus), then 4b and 4c (Sonnet) | After Sa |
| Reports | 5a, then 5d (SCP-Q5) | Sonnet; Opus reviews 5d's people data against the DW-4 privacy rules. 5a after 3c (the metrics) and 4a (the boost table it reads spend from); 5d after 1c (health) |

**Wave 4 · Proof and the first release.** 7a to 7d (QA, Sonnet; the orchestrator drives 7b live and runs 7d with the
team), covering 5a and 5d too. The first release is complete when SCP-7 is ticked (SCP-Q5).

**Wave 5 · The rest of SCP-5** (contract BFF §63.24 to §63.30 and PERMISSION §57, 2026-10-30; the owner's rulings SCP-Q25 to
SCP-Q41 of the same day, §2). Three lanes in parallel, one implementer each, so never more than three at once. Within a lane only
its Opus tickets write migrations, one at a time in the lane's order (A0 then A1; B1; C1 then C3); prefixes are taken at landing,
in landing order (BFF §63.1's rule). **W5-A0, the company rules, lands first:** every server ticket reads its rules through A0's
reader and the seed, so no lane builds on a hard-coded rule (SCP-Q41). No Cerbos change, so no restart at the deploy.

| Ticket | Builds | Model | Lane | Order | Depends on |
|---|---|---|---|---|---|
| W5-A0 | The company rules core (BFF §63.30): migration `social_rules` (`social_rule_versions`, append-only; `rules_ref` on `social_reports` and `social_cycles`), the seed `social-rules-defaults.json` and its twin (the report kinds, cycle steps and scorecard moved out of the fixtures), the read-through reader `socialRules`, each section's validation with typed refusals, versions under one lock with `expectedVersion`, the routes (read, set, reset, history, preview), and `social.rules` and `social.setRules` | Opus · medium: every lane builds on it, and its versions must never be rewritten | A, reports | 1 | this contract |
| W5-A1 | Migration `social_reports_periodic`: the eight kinds, the period formats, `next_period`, the one-per-period index, `report_kinds`, `social_report_schedules` and `social_report_runs`, with their assertions and migration suite | Opus · medium | A | 2 | A0 |
| W5-A2 | The periodic kinds on the report routes (BFF §63.24.1 to 63.24.4): each kind's period, due, freeze and check rules, AI drafting at create for every kind, `summary_numbers_changed`, Needs you, `reportKinds`, the dashboard's `reportKind`, every kind's rules read from the company's rules (A0's reader) | Sonnet | A | 3 | A1 |
| W5-A3 | "Generate with AI" (§63.24.5, 63.24.6): `POST reports/generate`, the background run with four drafts in flight and one run per company, resume after a crash with no client drafted twice, the progress read, the end notice, the tracked usage per run (SCP-Q40), and the tools `social.generateReports` and `social.reportRun` | Opus · medium: a concurrency core (bounded parallelism, resume, idempotency per client) | A | 4 | A2 |
| W5-A4 | Report pages and demo answers: the kind switch and period picker, Generate with AI with its progress panel, a short kind's report page, the monthly page's ideas section, "From an idea" | Sonnet | A | 5 | A2, A3, B2 |
| W5-A5 | Report automation's core (§63.24.9): the schedule routes and Run now, the timing maths on the company's zone and working days, the job (`SKIP LOCKED`, one run per schedule and period, latest-period catch-up), each run re-authorized as its owner with the pause and its notices, the spend reads, and the schedule tools (five as built: `social.editReportSchedule` split from the save) | Opus · high: run-as-owner authorization and a job on several instances; a mistake runs work as someone who may no longer do it. Start it on Opus | A | 6 | A3 |
| W5-A6 | The "Report automation" section of `{D}/settings`: cards, the add and edit dialog with the timing preview, pause, resume, delete and Run now, spend, phone width and keyboard, and its DEMO_MODE answers | Sonnet | A | 7 | A5, C4 (both change `{D}/settings`) |
| W5-B1 | Migrations `social_ideas`, `social_saved_items` (with `ux_creative_assets_id_tenant`) and `social_audits` | Opus · medium | B, ideas, bank and audit | 1 | this contract |
| W5-B2 | 5c's server half: the ideas routes, "Add to next plan" through `createPostInTx` in one transaction, `release_idea` on discard, the post read's `idea` | Sonnet, with an Opus review of the transaction and the discard effect | B | 2 | B1, A0 |
| W5-B3 | 5e's server half: the bank's routes and collections, `savedItemIds` on the post edit | Sonnet | B | 3 | B1, A0 |
| W5-B4 | 5g's server half: the scorecard from the company's rules (A0), the pure scoring with its golden table, the routes, Draft with AI | Sonnet, with an Opus review of the golden table | B | 4 | B1, A0 |
| W5-B5 | Pages and demo answers: `{D}/saved` and `{D}/social-audit` | Sonnet | B | 5 | B3, B4 |
| W5-C1 | Migration `pm_task_cycle_steps` and 5f's core: the cycle's step tasks, from the company's rules (A0), made, re-dated, closed and reopened inside the stage action's transaction, the lock order, the report step on delivery | Opus · high: it runs inside every stage action's transaction, so a wrong lock order deadlocks the whole pipeline; start it on Opus, not cheap then escalate | C, cycle and onboarding | 1 | A0 |
| W5-C2 | 5f's reads: the health `steps`, the dashboard's `cycle_step_late`, PM's `linkedStep`, the Plan tab's strip | Sonnet | C | 2 | C1 |
| W5-C3 | Migrations `pm_project_templates` and `social_settings_onboarding`; PM's project template, apply-template (one transaction, idempotent), the applications read and the kickoff move | Opus · medium | C | 3 | C1 |
| W5-C4 | 5h's Social half: the template setting, starting onboarding, `GET onboarding`, `{D}/onboarding` | Sonnet | C | 4 | C3, B4 (the baseline audit link) |
| W5-C5 | The rules sections of `{D}/settings` (BFF §63.30.5): Reports with the ideas settings, Monthly cycle, Audit scorecard, Saved, and Onboarding with the template's steps through PM's routes; current values beside the defaults, Reset to default, the previews, refusals named in words, phone width, keyboard, DEMO_MODE | Sonnet | C | 5 | A0, A6, C4 (the same page) |
| W5-H1 | Registry and skin: `publish` › `saved` and the Saved pin's move, the rows `social-audit` and `onboarding` ("Client onboarding"), their `AREA_RULES`, the registry and one-area tests | Haiku | the first free lane | 8 | A4, A6, B5, C5 |
| W5-H2 | DEMO_MODE data for the rules store (from the seed), the periodic reports, a settled run and two schedules, and for 5c, 5e, 5f, 5g and 5h, and the mock seed's onboarding template (mock wording only) | Haiku | the first free lane | 8 | the lane's server half |
| W5-Q | Proof: the proof lists of 63.24 to 63.30 on the Linux CI gate, then a live drive on the mock seed as an officer, the HoD and the GM | QA, Sonnet | — | 9 | all of the above |

The orchestrator keeps the changelog, `docs/MAP.md` (regenerated from a clean worktree), the board and the landing. Then SCP-6
when real data is allowed.

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
| Kc The Social menu | The design's rows, icons and badges; Calendar and AI Assistant added; Dashboard and Settings for the four approvers only, through one gate kind built from `canLeadSocial` (PERMISSION-CONTRACT §53.4). Search, Notifications, Create and Profile do what the top bar's search, bell, New and avatar did. Rows and tabs use the keys of FRONTEND-BFF-CONTRACT §63.17. Publish gains the Asset Library tab (`assets`, declared in the social-media toolkit), in the Standard menu too; Saved opens it until 5e. |
| Kd More | The menu shrinks to icons and the More panel slides out: Find a page, Work, Performance, You, and the account (Switch workspace, Appearance, Log out). It lists exactly the rows the registry gives the person. Badges show on More. Complete by keyboard and screen reader. |
| Ke Phone | The bottom bar (Home, Search, Create, Tasks, Profile); Notifications and Messages at the top; More as a full-screen sheet. |
| Kf Tests | The palette, page-home, one-area and sidebar tests pass in both skins; axe passes in light and dark, desktop and phone. |
| Kg Switch on | The skin is on for Social Media once 1d, 1e and 1k are live, so no menu row points at a page that does not exist. Pinned rows whose page comes from a later ticket stay hidden until that page is live: Messages until 1j, Settings until 1c, Dashboard until 5d (the skin's pin list carries each row's ticket, and Kg's test checks it). |
| Kh Needs you in Notifications | `/me/inbox` opens with one "Needs you" row, as the design draws it: the counts by kind and a dot while anything waits. It opens the whole ranked queue in place, with the Overview block's Approve, Deny and Acknowledge. Same read as the block (`readNowQueue`, `selectNeedsYou`), streamed so the inbox does not wait. Every department's inbox has it. |
| Ki Reminder cards | On the Social Home, the design's one-line card with a blue button: today's check-in while it is expected and not sent (the button opens the existing pre-filled form; submitting stays one click); pinned current notices of the unit (newest first, "N more pinned" to the board; with no read receipts a card lasts until unpinned or past its end date); Reports due as cards. Each card's read fails on its own, never as "nothing due". |
| Kj More holds the Overview row's tabs | In a pinned skin the Overview row's other tabs (Notices, Department calendar), which only the tab strip reached, are listed in More on desktop and in the phone sheet. The Social Home draws no tab strip. The skin reachability test still proves the Social menus reach every Standard link. |
| Kk Ask Web Dev in Create | Create lists "Ask Web Dev" after "Ask Creatives for assets", with the quick action's gate (an agency company that has a Web Dev department). |
| Kl The Home without the Overview | In the Social skin `{D}` renders the feed alone. The Standard look and every other department render exactly as before (a test proves both). Lands in one train with Kh to Kk. |

### SCP-1 · The pipeline for staff: draft to final check

| Ticket | Acceptance |
|---|---|
| 1a Allocation and brand book | The officer, the creative source (Creatives or in-team, SCP-Q2), posts per cycle, report format and due day, platforms, formats, default time, pillars, tone, must-have notes, brand rules, hashtag sets, channels, key dates and links can be set per client. The Allocation page (`{D}/allocation`) lists every client with its officer and target. Edits are refused for anyone but the four approvers (SCP-Q18, SCP-Q19). |
| 1b Stage machine | Every row of §4.3 is enforced on the server with its own refusal code. The fixture runs green in nest and ui. Activity is written. The phase and status mappings are pinned. |
| 1c Cycles and health | The deadline table, the buffer and step estimates, edited on the HoD's Settings page. Ready-by and the latest safe hand-off on working days from the HR holiday calendar. On track, Tight, At risk and Late, tested on month ends, weekends, holidays and the year turn. |
| 1d Home | "Your turn" per role with the next allowed action as the main button; "Waiting on others"; tasks given to you; reports due; client stories with state rings; "Your accounts this cycle". Read on the server; fast at 600 posts. |
| 1e Post page | `{D}/posts/[id]` as a drawer: the image and its versions, the status chip, the eight-step stepper, health, Post and Creative brief tabs, the field rows, the copy edit log, comments and activity, and the Composer link. Buttons the person may not use are disabled with the reason. |
| 1f Proofread | The Copywriter's suggestions show to the Officer as suggestions. "Approve copy" applies them and logs before and after per field. "Return with edits" needs a note. "Approve all" per client. |
| 1g HoD approval and final check | Approve for design, or changes with a note. At the final check a copy change goes to the Officer and a design change to Creative as a revision; both come back to the final check. The author cannot pass these steps (a test proves it). Only the four approvers pass them; a company admin, a head's `manager` role and a `social_manager` grant cannot (SCP-Q19). |
| 1h Creative | On "approve for design" the post goes to the client's designer: it joins the client-month Creatives request, or the in-team design queue (SCP-Q2). The designer's queue; start; a version in the Asset Library or a Drive link; submit for the final check; asset source and AI note; revision notes shown. |
| 1i Hand-off checks | The checks of §4.6 run on the server. "Send anyway" needs a reason, logged on the post and shown in its activity. |
| 1j Blocked and follow-up | Block with a reason and who we wait on; resolve returns to the same step. Messages lists who holds each of your posts; Follow up sends a notification and logs it. "Needs you" gains the pipeline per role (§6.4). |
| 1k Client page | The profile header (counts, cycle line, tone), cycle highlights, the Plan grid with slots placed for the target, Stories (not counted), the List with bulk "Send to proofread", the Calendar tab, Client profile (the brand book) and Extra post. The Feed preview tab comes with 3d. |
| 1l Comments | The shared thread gains team-only or client-visible, and a pin on the image. Pins show on the post and in the portal. |
| 1m Create | + New post inside a client's cycle; Extra post, flagged and outside the target; New task; Ask Creatives for assets. |
| 1n Content month in PM | One task per client and cycle, due on its ready-by, Ball on the Officer, progress from the pipeline, done when every post is client-approved. No PM task per post (a test proves it). A task can point at a post. |
| 1o Seed | Mock clients with allocations, brand books, cycles and a month of posts across every status, with no real names, in DEMO_MODE and the live mock seed. |
| 1p e2e | On sumopod, the Officer, Copywriter, HoD, Creative and GM each walk their part, including loops a, b and c. |
| 1q Lead-seat guard (SCP-Q23) | Nobody may edit a position they hold: moving it to another unit, or adding or removing a role row on it (the lead role included), is refused, the same way assigning yourself already is. A test proves a person cannot make themselves a head, as a member, a company admin and a manager. PERMISSION §53.4 relies on it. It protects every lead-seat authority, not only SCP, and lands before SCP's approvals go live (before Kg). |

### SCP-2 · Client review in the portal

| Ticket | Acceptance |
|---|---|
| 2a Approval page | The header (to approve, approved, changes), the stories circle, To review, Grid preview and Approved tabs. "Approve all" approves only what waits. |
| 2b Images | Served through the portal's file route, so a portal user sees only their client's files. Thumbnails; the grid preview. |
| 2c One decision per post | Applies to every variant in one transaction. A visible Approve button, double-tap as a shortcut, and a short undo. |
| 2d Changes | Copy or design, with a note and an optional pin. Copy goes Officer → Copywriter (changed text only) → client; design goes Creative → final check → client. The HoD is told. |
| 2e Recorded decisions | Staff record a WhatsApp or email decision with channel and note, shown as recorded on the client's behalf to staff and the client. |
| 2f The way in | As SCP-Q8 rules: by default the link we send, shareable to WhatsApp, opens the portal page. |
| 2g Proof | Portal e2e on DEMO_MODE, and the portal routes' tests on real Postgres and Cerbos. The live drive as a placeholder portal login moved to SCP-Sh (owner, 2026-10-27), because it needs Sb's accounts. |

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
| Sh Live portal drive | Moved from 2g (owner, 2026-10-27). After Sb, on a live mock-seed post with the client: a placeholder portal login is invited, accepts, approves, asks for a change, undoes a decision, and is revoked. |

### SCP-3 · Schedule, live and the calendar

| Ticket | Acceptance |
|---|---|
| 3a Schedule | Date, time and placement (Instagram and Facebook feed; Instagram Reels and Facebook; Instagram Story) with the existing validator. "Schedule in Meta" by hand marks it scheduled; unschedule works. Scheduling at the approved date, time and placement keeps the client's approval; any other date, time or placement asks the client again (SCP-Q13). |
| 3b Live | "Mark live" with the link when posting by hand; the simulated publisher in dev; the real publisher after DW-11. A failed publish shows on the Failed posts tile. |
| 3c Metrics | Pulled, typed in or simulated; engagement rate; boost candidates as in §4.2. |
| 3d Feed preview | The client page's Feed preview tab: the client's grid with planned posts; dragging swaps publish dates, and an approved or scheduled post in a swap goes back to the client (SCP-Q13); live posts are locked. |
| 3e Calendar | The pinned row: every client's posts, Monday-first, stage colours with a legend, holidays and approved leave from the department calendar; plan a post on a day; drag to change a date (an approved or scheduled post goes back to the client, SCP-Q13). |
| 3f Readers and tiles | The KPI readers (posts on schedule, client approval turnaround) and the Overview tiles of §6.4 read the pipeline. |

### SCP-4 · Boosting

| Ticket | Acceptance |
|---|---|
| 4a Boost request | On a live post: goal, audience, daily budget in IDR and days, a reach estimate. Within what remains of the cycle's agreed boost budget it starts without asking. Contract first; money in minor units; one open boost per post. |
| 4b Monthly boost budget | The client agrees a boost budget per cycle in the portal's approvals, or staff record it (SCP-Q11). The remaining budget shows on the client page and the Boosting list. A boost over what remains waits for the client's approval. |
| 4c Run and results | Start, stop, or complete with spend, paid reach and clicks. The Boosting list shows candidates, running boosts and totals. |

### SCP-5 · Reports and management (5a and 5d in the first release, the rest after it; SCP-Q5; the rest contracted in BFF §63.24 to §63.30 and ruled as SCP-Q25 to SCP-Q41 in §2, 2026-10-30. Since SCP-Q41 every rule of work in the rows below is a default that each company sets for itself in Settings, BFF §63.30)

| Ticket | Acceptance |
|---|---|
| 5a Monthly report | In the first release, at `{D}/social-reports` (the Reports row's Social reports tab). The officer writes and submits it; only the four approvers check it and send it (SCP-Q20). Numbers filled from metrics; one insight and one suggestion per area (followers, engagement, audience); an action plan; Draft, HoD check, Ready, Sent; a PDF; published to the client's portal reports (PV7-04a); "Draft with AI" from the brand-draft lookup. |
| 5b Periodic reports and "Generate with AI" (SCP-Q37) | Daily, weekly, monthly (as SCP-5a built it), quarterly, semester and yearly reports on the same `social_reports` (BFF §63.24): one per client, kind and period, each kind with its period format, due day, freeze rule (the short kinds at submit, the long ones at create) and check rule (a summary for daily and weekly, the notes for the long kinds). The officer writes and submits; only the four check and send every kind (SCP-Q25), and sending publishes to the client's portal reports. The allocation's `reportKinds` say which kinds each client is due (SCP-Q26). "Generate with AI" drafts one client's report at once, or every client the person may draft for as a background run with a progress read, idempotent per client and never stopped by one failure; by chat, `social.generateReports` drafts and never approves or sends. The four also set report automation in Settings (SCP-Q38): schedules owned by the one of the four who set them, each run drafting the period that just ended as that person and pausing, with the reason, when they may no longer. Periods are calendar ones (SCP-Q39). AI spend is tracked per run and per schedule, never capped (SCP-Q40). |
| 5c Ideas for next month | `social_ideas` (BFF §63.25): what we saw, the metric it rests on (required) and the suggestion, per client, on the monthly report's page. The client's officer and the four add, edit, share and delete them. "Add to next plan" makes a planned post in a cycle the person picks, linked both ways in one transaction; discarding that post releases the idea. "Mark shared" records it; ideas stay internal (SCP-Q27). |
| 5d Team dashboard | In the first release, on its own page `{D}/dashboard` for the four approvers (SCP-Q19), with a block on Reports › Team. Needs attention, workload per person, clients this cycle, where work waits longest (against the holder, never the Officer), estimates not set. Per-person data follows the activity privacy rules, with the four counting as the Social Media unit's heads. The Overview's Team view is unchanged. |
| 5e Saved | The content bank per client (SCP-Q28) at `{D}/saved`, where the Saved pin then points (BFF §63.26). Photos with used, unused and source, and approved posts, read from the designs and the pipeline; hashtag sets read from the brand book; captions, templates, references and Drive links kept in `social_saved_items`. Using an item in a post goes through the machine's own edit and is counted. Videos are Drive links (SCP-Q30). The team adds; the officer, the HoD or the GM change anyone's item (SCP-Q29). Never in the portal. |
| 5f Monthly cycle | Six PM tasks per client and cycle in the client's project (BFF §63.27): the report (on the month before last), planning, copy lock, artwork, client approval and scheduled. Each is due from ready-by less the client's step estimates, in working days; the Ball is on the officer. Each closes, and reopens, on its pipeline condition (SCP-Q31). Still no task per post. The steps show on the client page's Plan tab, and late ones on the Team dashboard. |
| 5g Audit | `{D}/social-audit` (BFF §63.28): twelve dimensions held in a fixture (SCP-Q32); six automatic from pipeline data for an existing client, all twelve typed for a prospect, who lives on the audit itself (SCP-Q33). An overall score out of 100, a band, three fixes and a summary with Draft with AI; a live draft, then a frozen final. A client's audit by its officer, the HoD or the GM; a prospect's by the four (SCP-Q34). |
| 5h Onboarding | PM gains a project template and "apply" with due dates in working days from the kickoff, and a kickoff that can move (BFF §63.29). The company's onboarding template, seeded from the team's fifteen steps (SCP-Q35), is started for a client by the four (SCP-Q36) in the client's own project. `{D}/onboarding` shows each client's progress and next step, and links the baseline audit. |

### SCP-6 · Leave the Excel (after real data is allowed; SCP-D1 keeps it on hold)

- **6a.** A one-off import of the sheet (allocation, next month's plan), built and proved on a mock sheet now.
  BFF §63.23, SCP-D10. Upload an `.xlsx` or `.csv`, or paste; map the columns; pick the names the server could not
  match; preview every row; write all or nothing. The four approvers only, at `{D}/settings/import`. Proved on a mock
  sheet: on the CI gate (real Postgres and Cerbos) and live on the mock seed as `hod@scp.test`, the replay unchanged.
- **The real sheet (2026-10-31).** One file per client and month. The content plan tab gives each post two rows (merged):
  date, type (single post, carousel, reels, carousel video), the footage link, the designs pasted into the cells with a
  description per image, one cell holding "Content Pillar", "Content Angle" and the brief, separate Instagram and
  Facebook captions with their hashtags on the second row, the team's check, the client's check and its feedback, the
  posting status, the tagged accounts, the live link and the AI check notes. The stories tab gives one row per story
  (two stories on a day share a merged date): photo or video, the text, the call to action with its link, the tagged
  accounts and a story content type (Villa tour, Hard selling, Sticker slider and so on). The approval link is an Apps
  Script web app that anyone holding it can open. Its decisions write the client's check, the feedback and a cell note
  back into the sheet. The ERP portal of SCP-2 already covers its pages (the progress header, the lists, the grid preview
  and the per-network captions) and its decisions, behind a portal login (SCP-Q8).
- **6b1.** The import reads the real file. It takes one client for the whole file, which has no client column (today's
  guess takes "TAG IG ACCOUNT" for the client). It takes a file far over today's 2 MiB cap, because the pasted design
  images make one month about 155 MB, and it skips the images. It reads a post written over two rows, a merged date
  shared by two stories, the pillar, angle and brief cell split into its three fields, and a stories tab as stories
  ("PHOTO" and "VIDEO" are the story's kind). The headers "TEXT" and "INSTAGRAM CONTENT ANGLES" are guessed. Then
  November's file is loaded as seed (SCP-Q47).
- **6b2.** Contract and build for what the post cannot yet hold: the repost mark (SCP-Q44), the AI check (SCP-Q45), a
  target per format (SCP-Q46), the separate Facebook caption (onto the Facebook version), the tagged accounts, the story
  content type and the description per image. Contract: BFF §63.31 (PLANNED, 2026-10-31); its authorization needs
  no new action. Owner questions: SCP-6 OQ-2, OQ-5, OQ-6 and OQ-7 in §10.

**6b2 tickets.** Contract: BFF §63.31 (PLANNED, 2026-10-31). Authorization: PERMISSION §59 (6b2 needs no new action and no Cerbos change, so none of these tickets restarts Cerbos). A model tag other than the seat's default is named with its reason; every ticket without one runs on the seat's default (Sonnet; Haiku for a junior seat). Every path is from the repo root. The stage-machine fixture is one file with a UI twin, so the tickets that edit it (6b2b, then 6b5f and 6b5g) land one at a time, in that order. At most three implementers run at once. The orchestrator regenerates `docs/modules/CAPABILITY-INVENTORY.md` (`UPDATE_INVENTORY=1`) and `docs/MAP.md` and keeps the changelog.

| Ticket | Owned paths | Acceptance (what a QA agent runs) | Tier · model | Needs |
|---|---|---|---|---|
| 6b2a Migrations | `platform-nest/migrations/<prefix>_social_post_sheet_fields.sql`, `platform-nest/migrations/<prefix+1>_social_format_targets.sql`, `platform-nest/migrations/<prefix+2>_social_post_ai_checks.sql`; `platform-nest/src/modules/social/index.ts` (the three registered); `platform-nest/src/modules/social/scp-6b2-schema.db.test.ts` (new) | The three files of BFF §63.31.1 run on boot and re-run clean. Every CHECK refuses its bad row and admits its good one, NULL cases included: a story type on a feed post, a carousel video on a reel, a repost source without the mark, a non-object `caption_overrides`, 31 tags, targets of 2.5, `"3"`, -1 and 501, an empty targets object, an unknown key; the coherence CHECK refuses a total that is not the sum, admits the sum and raises no cast error on a string value. The widened suggestions, copy-log and rules-section CHECKs admit every old value and the new ones. No existing row changed with a tenant GUC set. The third wall on `social_post_ai_checks` (an unset GUC reads zero rows); the two running-check indexes; `lint-migration-rls.mjs` passes | senior-db · **opus·medium**: three CHECKs on live tables are re-declared, and a cross-column CHECK does not promise the order of its clauses; a wrong total or a lost old value fails on live | none |
| 6b2b Machine and fixture | the fixture `platform-nest/src/modules/social/scp-stage-machine.json` and its twin `platform-ui/src/lib/scpStageMachine.json`; `platform-nest/src/modules/social/pipeline/{machine,pipeline-effects,pipeline-data,pipeline-read,pipeline.service,handoff-checks}.ts`; `platform-nest/src/modules/social/media-rules.ts`; their tests, `machine.test.ts` included; `platform-ui/src/lib/demoSocialPipelineRun.ts` | BFF §63.31.2 to 63.31.5 and 63.31.7 hold on both sides. The field groups and edit rules; each dependent-field 400 and clearing warning; the two hand-off prose changes (a story reaches proofread with no caption, a repost passes `on_image_text_missing`, a feed post still needs its caption); `captionOverrides` reaches the variants in all three sync modes; tags reach the Instagram variant; `args_sha256` moves with an override, a tag or an alt text and not with the repost mark or the story type; `JSONB_COLUMNS` round-trips an override; the four new scenarios run on nest and on the UI twin; the twin's bytes equal the fixture's | senior-be · **opus·medium**: the fixture is the contract both sides test against, and the approval hash must cover exactly the new variant fields and no others | 6b2a |
| 6b2c Targets per format | `platform-nest/src/modules/social/pipeline/{allocation.controller,cycles.controller,cycles-data,schedule-health,content-month-progress,cycle-steps,audit-data,team-data,pipeline-effects}.ts` (`pipeline-effects.ts` only for the month request's quantity); their tests | BFF §63.31.8. `outputKind`, `effectiveTargets` (all four sources) and the progress and done rule, each as a golden table; the allocation's every 400 and `format_targets_set`; `PUT cycles` set, clear and absent; `byFormat`, `targets` and `formats` on the deadline table, the cycle health, the allocation row and the Team dashboard; the five readers of `posts_per_cycle` read the cycle's total (a month with an override moves them, the next month does not). The 63.5 health golden table passes unchanged | senior-be · Sonnet (the orchestrator reviews the progress and done maths: it runs inside every stage action's transaction) | 6b2a, 6b2b |
| 6b2d Company rules: stories and checks | `platform-nest/src/modules/social/pipeline/rules.ts`, `platform-nest/src/modules/social/social-rules-defaults.json`, `platform-ui/src/lib/socialRulesDefaults.json`; `platform-nest/src/modules/social/pipeline/{rules.test,rules.http.test}.ts` | BFF §63.31.6. Both sections validate with their `field` paths; the seed holds the twelve types and `defaultsVersion` `scp6-2026-10-31`; `DEFAULTS_ARCHIVE` still resolves `scp5-2026-10-30` and `scp-5a`; a document saved before the change reads the seed's new sections and a save copies them; the twins are byte-equal; the history diff works across added sections; `PUT rules/stories` and `rules/aiCheck` refuse an officer and a `company_admin` | medior · Sonnet | 6b2a |
| 6b2e AI check, server | `platform-nest/src/modules/social/pipeline/{post-ai-check,post-ai-check-data,post-ai-check.controller}.ts` (`post-ai-check.ts` is pure); `platform-nest/src/modules/social/index.ts` (the controller and the three tools); `platform-nest/src/modules/ai-usage/routing.ts`; their tests | BFF §63.31.9. The rules pass's golden table (every code, both sides of each threshold, the date-name readings, the company-day edge); the finding validator; the stale hash; the four routes and their codes; with the AI gateway stubbed at `fetch`, `ok`, a 429, a 503, a timeout, an unparseable answer and an unconfigured gateway each leave the rule findings stored; usage rows with the check's id as `run_id`; **the invariants proved**: a check writes no `social_posts` column, suggestion, copy-log row or status; `send_to_proofread` succeeds with a `critical` finding open; no portal answer or controller touches the table; a bot and an automation are 403 `automation_cannot_act` and an agent acting for an officer passes with `via`. The automatic run after `send_to_proofread` and its three skips | senior-be · Sonnet (the orchestrator reviews the invariant tests) | 6b2a, 6b2b, 6b2d |
| 6b2f Import, server | `platform-nest/src/modules/social/pipeline/{sheet-import,sheet-import.controller}.ts` and their tests `sheet-import.test.ts` and `sheet-import.http.test.ts` in the same folder | BFF §63.31.10, server half. Every reader (the repost words and the non-refusal of other words; the tag forms; the story-type match and its refusal; the image-notes list over a joined pair; `readCarouselVideo`); `columns.imageNotes` and `formatTargets` validated; `format_targets_set`; previewed, applied and replayed on a synthetic workbook of the real file's shape, the new fields on the written post, the cycle's override set once and kept on a second import. **Needs SCP-6b1 on main** | medior · Sonnet | 6b2b, 6b2c, 6b2d, SCP-6b1 |
| 6b2g Post and portal pages | `platform-ui/src/components/social/{PostFields,PostFieldsForm,PostView,PostCard,ClientPlan,ClientStories,PostDesigns}.tsx`; `platform-ui/src/components/portal/social/{PortalSocialPostView,PortalSocialPostCard}.tsx`; `platform-ui/src/lib/{social,socialPipeline,portalSocial,demoSocialPortal}.ts`; `platform-ui/src/lib/demoSocial*.ts` | BFF §63.31.11, the post-page and portal items: the repost chip and source, the Facebook caption editor per placed network, the tag chips with the by-hand note, the story-type picker, the video-carousel tick, the per-slide notes, the portal's repost label and collapsed "N tagged accounts"; a key-list test that `PortalSocialPost` holds no story type, note, carousel mark or check; DEMO_MODE answers; axe light and dark, desktop and phone | medior · Sonnet | 6b2b |
| 6b2h Targets and settings pages | `platform-ui/src/components/social/{AllocationTable,ClientHeader,CycleDeadlineTable,TeamDashboard,TeamDashboardKpis,SocialSettingsForm}.tsx` and, new in the same folder, `StoryTypesForm.tsx` and `ChecksRulesForm.tsx`; `platform-ui/src/lib/{socialAllocation*,socialCycles*,demoSocial*}.ts` | Per-format inputs whose sum is the total; the format lines on the client header, the dashboard and the deadline row; the cycle's override with "Use the client's standard"; the two Settings sections in 63.30.5's shape (current beside default, reset, `expectedVersion`, refusals in words); DEMO_MODE; axe | medior · Sonnet | 6b2c, 6b2d |
| 6b2i AI check pages | new `platform-ui/src/components/social/AiCheckPanel.tsx`; `platform-ui/src/components/social/{PostView,ClientPlan}.tsx` (the mounts); `platform-ui/src/lib/{socialAiCheck*,demoSocial*}.ts` | The panel and "Check the plan" per 63.31.11: findings by level with their field, the "out of date" mark, what the run cost, the line when the AI pass did not run, keyboard and phone width; DEMO_MODE's canned checks | medior · Sonnet | 6b2e |
| 6b2j Import page | `platform-ui/src/components/social/{SheetImport,SheetImportPreview}.tsx`; `platform-ui/src/lib/{sheetImport,socialImportActions}.ts`; their tests | The columns step's new fields and the multi-select for image descriptions, the editable "This month's output" line, the new refusals and warnings worded; the aliases pinned on the real header rows of the sample file the orchestrator hands over. **Needs SCP-6b1's page on main** | medior · Sonnet | 6b2f |
| 6b2q Proof | none (tests only) | The proof list of BFF §63.31.13 on the Linux CI gate. Then a live drive on the mock seed as an officer, the Copywriter and the HoD: a repost story with a source reaches a placeholder portal login marked as a repost; a post with a Facebook caption and tags shows both to the client; a story with a type reaches proofread with no caption; per-format targets move the client header and the content-month task; the AI check runs on one post and on the plan, and a stale one says so | qa · Sonnet | all of the above |

- **6b3.** The client's contacts get portal logins before the parallel month, replacing the link that opens without
  one (SCP-Q8).
- **6b4.** The owner's answers on the real sheet: SCP-Q44 to SCP-Q47 (2026-10-31).
- **6b5.** Designs and footage from Google Drive (SCP-D11). Contract and build:
  - the company's one Google Drive connection: connect, reconnect and disconnect in the ERP's UI through Google's
    sign-in, the token sealed in the vault and used only on the server; the connection's state shown where Drive is used;
  - a post's Drive file or folder link resolved with that account to its files (images, videos, the team's "thumbnail"
    and "textless" names), and a folder browsed through the ERP;
  - thumbnails stored;
  - a video streamed to the portal without copying it whole;
  - each file's Drive version recorded, so that a change after the client's approval asks again;
  - every Drive action written to the ERP's activity with the person, the file's id and its version;
  - the hand-off check "every asset link shared" replaced by "the ERP's account can read it".

  The owner steps: the Google OAuth client as an Internal app (DW-11 item 6), and the team's folders shared with the
  ERP's account.

  Contract: BFF §63.32 and PERMISSION §59 (PLANNED, 2026-10-31). BFF §63.32.9 lists the owner's steps, and the devops
  ticket writes them into a runbook. Owner questions: SCP-6 OQ-1, OQ-3, OQ-4, OQ-8 and OQ-9 in §10.

**6b5 tickets.** Contract: BFF §63.32 (PLANNED, 2026-10-31). Authorization: PERMISSION §59, whose one new action (`connect_shared`) is ticket 6b5a and **needs a Cerbos restart and probe at its deploy**. The same rules as the 6b2 tickets apply (model tags, every path from the repo root, one fixture file, three implementers at once). Nothing here can be proved against real Google until the owner's steps (BFF §63.32.9) are done, so every ticket is proved with Google stubbed at `fetch`, and the live proof is its own last ticket. Google's documentation is read on the day by each seat that touches it, as §42.8 did, and the page and date are recorded in the ticket's report.

| Ticket | Owned paths | Acceptance (what a QA agent runs) | Tier · model | Needs |
|---|---|---|---|---|
| 6b5a IAM: `connect_shared` | `platform-nest/cerbos/policies/{resource_integration_connection,derived_roles}.yaml`; `platform-nest/src/rbac/{permission-catalog,permission-groups,role-permission-bundles}.json`; `platform-nest/scripts/generate-role-bundles.mjs`; `platform-nest/migrations/<prefix>_iam_google_drive_company.sql`; `platform-nest/cerbos/tests/integration_connection_connect_shared_test.yaml`; `platform-nest/src/rbac/cerbos-integration-connection-connect-shared.test.ts`; the tests that pin catalogue counts | PERMISSION §59 in full. The static pins; the live matrix against Cerbos (the owner and `platform_admin` allowed; a `company_admin` and a `manager` denied while their `manage` stays allowed; the owner of another company, a seat holder, a member, a viewer, low assurance, a bot and an automation denied); the YAML suite through `~/cerbos-tests.sh` on the tip; the migration's DO block; the bundles regenerated from a clean worktree. The deploy note says "restart Cerbos and probe" | senior-be · **opus·medium**: an authorization change whose six artifacts must agree, or the key silently grants nothing, or grants too much | none |
| 6b5b The company connection | `platform-nest/migrations/<prefix>_integration_connections_google_drive_company_provider.sql`; `platform-nest/src/core/google-oauth/registry.ts`; `platform-nest/src/modules/search/google/{oauth,oauth-state}.ts` (the two `Exclude`s); `platform-nest/src/core/google-drive/{company-surface,company-service,company.controller}.ts`; `platform-nest/src/core/{integrations.controller,integrations.service}.ts` (`managed_elsewhere`); `platform-nest/src/{config,app.module}.ts`; `platform-nest/src/modules/social/pipeline/drive.controller.ts` (created here with `GET drive/status` only); `company.test.ts`, `company.http.test.ts` and `egress.test.ts` in `platform-nest/src/core/google-drive/` | BFF §63.32.1. Start, the callback's outcomes (`connected`, `denied` for a Cancel and for a missing scope, the state errors), a reconnect keeps one row, `accountChanged`, disconnect revokes and clears; the refresh rules (a 4xx marks `needs_reconnect`, a 5xx and a network error do not, one forced retry on a 401, one refresh for concurrent callers); the notice to `meta.connectedBy`; the generic routes' `managed_elsewhere`; `GET drive/status`; the search types still refuse the new provider; **the secret rule asserted twice** (no token in any response, none in any table written). Google stubbed at `fetch` | senior-be · **opus·medium**: it holds the credential for the company's whole Drive; a token in a response, a log or an activity row is unacceptable, and the generic routes must not become a way around the gate | 6b5a |
| 6b5c Drive data | `platform-nest/migrations/<prefix+1>_social_drive.sql`; `platform-nest/src/modules/social/index.ts`; `platform-nest/src/modules/social/scp-6b5-schema.db.test.ts` (new) | BFF §63.32.11 file 2. `social_drive_files`; the design columns; the all-or-none CHECKs (each NULL case), the store and mime coherence, the md5 and id shapes; the third wall; the index; no existing row changed; `lint-migration-rls.mjs` passes | senior-db · **opus·medium**: a half-filled Drive row would let an unversioned file through the approval binding | none |
| 6b5d The Drive reader | `platform-nest/src/core/google-drive/{links,client}.ts`; `platform-nest/src/core/google-oauth/hosts.ts`; `platform-nest/src/modules/social/pipeline/{drive-files,drive-design-names}.ts` and `platform-nest/src/modules/social/pipeline/drive.controller.ts` (adds the three read routes); their tests, `egress.test.ts` included | BFF §63.32.2 and §63.32.3. The golden tables of `parseDriveLink` and `classifyDesignName` and the order; facts for a shortcut, a native file, a trashed file, `canDownload` false, a shared-drive file and a resource key; a folder over two pages, a sub-folder skipped, 21 media files refused, an empty folder; the rate-limit retry; `GET drive/resolve`, `GET drive/folders/:folderId`, `POST posts/:postId/assets/check`; `isDriveThumbnailUrl` with every look-alike; no other file reaches the network | senior-be · Sonnet (the orchestrator reviews the egress test; the two pure files may go to a junior seat on Haiku with the golden tables as the spec) | 6b5b, 6b5c |
| 6b5e The serving core | `platform-nest/src/modules/social/pipeline/{drive-media,portal-read}.ts`; `platform-nest/src/core/portal-commerce.controller.ts` (the one branch); the staff media route, added to `platform-nest/src/modules/social/pipeline/drive.controller.ts`; their tests | BFF §63.32.5. The image copy with its MD5 check, the caps and their refusals, reference rows for videos, thumbnails from `thumbnailLink` through an allow-listed host; `streamDriveMedia`: `206`, `200`, `416`, `HEAD` and `304` with no Google call, the version gate, the abort on disconnect, the idle timeout, `drive_busy`, no redirect followed; the portal's visibility rule (another client's, a removed design's, an unsent post's and a reference image all 404); a copied image served with Drive disconnected | senior-be · **opus·high**: streaming, Range, a bearer token and SSRF in one path; a mistake serves a client a file or version they did not approve, or exhausts the box. Start on Opus, not cheap then escalate | 6b5d |
| 6b5f Designs on the machine | `platform-nest/src/modules/social/pipeline/{machine,pipeline-data,pipeline-effects,pipeline.service,pipeline.controller,handoff-checks,drive-designs}.ts`; the fixture `platform-nest/src/modules/social/scp-stage-machine.json` and its twin `platform-ui/src/lib/scpStageMachine.json`; their tests | BFF §63.32.4. The add (file and folder), refresh, role change and delete routes; `submit_design` with a `driveUrl` in one step; roles, order and positions; the three prepare steps and the Drive-unreachable rule; the guards `drive_designs_ready`, `drive_designs_current`, `designs_stored` and `design_present`; `materializeDesignMedia`'s Drive branch with `driveMd5` and the 63.31.7 alt text; `asset_link_unreadable` with a connection and today's rule without one; the fixture's `prepare` key loaded and covered on both sides; the scenarios on both sides | senior-be · **opus·medium**: it changes the machine every pipeline action runs through, and the approval hash | 6b5c, 6b5d, 6b5e, 6b2b |
| 6b5g Version binding | `platform-nest/src/modules/social/pipeline/{drive-recheck-job,drive-designs,pipeline.service}.ts`; the fixture's `systemRules` and its twin; the notices; their tests | BFF §63.32.6. The job's selection, advisory lock and budget; a metadata change versus a content change; each status's effect (new media and hash, withdrawn approvals, cancelled dispatches, the reviews asked again once, the post's status judged under the lock); an outage and a partial answer move nothing; two instances never process one tenant; the activity with the old and new md5 and Drive's last modifier; the change found at `final_approve` and at the client's decision | senior-be · **opus·high**: a job on several instances moving posts as a system actor under the post's lock; a wrong lock order deadlocks the pipeline and a mistake sends approved posts back to the client in bulk. Start on Opus | 6b5f |
| 6b5h Env, compose, runbook | `platform-nest/.env.example`, `infra/compose/.env.example`, `infra/compose/docker-compose.vps.yml`; `infra/runbooks/google-drive-company.md` | The eight new variables of BFF §63.32.9 are documented in both examples and listed in the platform service's `environment:` block (a test or a `compose config` check proves it); the runbook carries the eight owner steps with the Internal-app, folder-sharing and download-restriction cautions and the deploy order; no secret in the repo | devops · Sonnet | none |
| 6b5i Connection pages | `platform-ui/src/app/api/google-drive-company/callback/route.ts`; `platform-ui/src/components/departments/DriveCompanyBlock.tsx`; `platform-ui/src/lib/{driveCompany*,drive-pending}.ts` (a second cookie in `drive-pending.ts`); their tests | BFF §63.32.10, Tools & connections: the block's states (not configured, not connected, connected, needs reconnect), the buttons by `canConnect`, the landing and cookie flow with no query-parameter redirect, every refusal in words; DEMO_MODE | medior · Sonnet | 6b5b |
| 6b5j Staff design pages | `platform-ui/src/components/social/{PostDesigns,PostView}.tsx` and new Drive components in the same folder; `platform-ui/src/app/api/social/posts/[postId]/designs/[designId]/media/route.ts`; `platform-ui/src/lib/fileDownload.ts` (the media headers); `platform-ui/src/lib/{socialPipeline*,demoSocial*}.ts` | BFF §63.32.10, the Creative tab and footage states: paste, the folder preview with roles, order and skipped files, refresh, role change, remove, each design's state, the connection banner, "Check links", the `asset_link_unreadable` words; the media route forwards `Range` and `If-None-Match` and the 206, 304 and 416 answers (a unit test); DEMO_MODE's small drive; axe | medior · Sonnet | 6b5e, 6b5f |
| 6b5k Portal media | `platform-ui/src/app/api/[tenant]/portal/files/[fileId]/route.ts`; `platform-ui/src/components/portal/social/PortalSocialPostView.tsx`; `platform-ui/src/lib/{portalSocial,demoSocialPortal}.ts`; their tests | `images[]` with `kind`, `role` and `label`; `<video controls preload="metadata" poster>`; the Range proxy (206, 304, 416, `HEAD`) with images' headers unchanged; the unavailable-video sentence; phone width and keyboard; DEMO_MODE | medior · Sonnet (the orchestrator reviews the proxy route) | 6b5e |
| 6b5l Proof | none (tests only) | The proof list of BFF §63.32.12 on the Linux CI gate with Google stubbed; PERMISSION §59's live matrix; then a drive on the mock seed with DEMO's invented drive as an officer, the designer, the HoD and a placeholder portal login | qa · Sonnet | all but 6b5m |
| 6b5m Live proof | none (live, with the owner) | After the owner's steps: the "Live" list of BFF §63.32.12. The real thumbnail hosts, the real shape of a shortcut answer and any download redirect are written into the contract; the teardown list is kept in `CREDENTIALS.local.md` | the orchestrator with qa; the owner does the Google steps | 6b5l and the owner's steps |

**Order of the 6b2 and 6b5 tickets together** (at most three implementers at once; a ticket starts when what it needs is on main, and the Google steps of BFF §63.32.9 are the owner's and can happen at any time before 6b5m):
1. Wave 1, the data and the key: 6b2a, 6b5a, 6b5c.
2. Wave 2: 6b2b (the machine), 6b5b (the connection), 6b5h (devops).
3. Wave 3: 6b2c, 6b2d, 6b5d.
4. Wave 4: 6b2e, 6b2f (once SCP-6b1 is on main), 6b5e.
5. Wave 5: 6b5f, then 6b5g. The stage-machine fixture is edited by 6b2b, 6b5f and 6b5g, one after the other. Beside them, in any order, the pages: 6b2g to 6b2j and 6b5i to 6b5k.
6. Wave 6, proof: 6b2q and 6b5l, then 6b5m with the owner. 6b2 reaches the live ERP without 6b5: until 6b5f lands there are no Drive designs for the AI check's file-name rule or the alt-text rule to read.

- **6b.** One month run in parallel: December 2026 (SCP-Q47).
- **6c.** The sheet retired.

### SCP-7 · Proof: a simulated month, end to end

- **7a.** e2e on sumopod: one mock client's month through all eight steps as every role, all five loops, a block, a
  failed publish, a boost, the month report and the Team dashboard.
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
- **Self-promotion into a lead seat.** Whoever may edit positions can move a position they hold onto the Social Media
  unit, or add the lead role to it, and so become one of the four approvers (PERMISSION-CONTRACT §53.4). It reaches
  every lead-seat authority, not only SCP, so an IAM ticket closes it: the self-assignment refusal, applied to edits too.
  The owner ruled it fixed (SCP-Q23): ticket SCP-1q, before SCP's approvals go live.
- **The prototypes' names.** Both designs carry real client and staff names in their sample data. Seeds, fixtures, tests
  and docs use mock names only.
- **The company's Google account is one credential for the team's whole Drive (SCP-6b5).** If it is revoked, a Workspace
  policy ends it or its password changes, videos stop streaming, new design submits that need a fresh check refuse, and
  Drive-backed posts wait on the 30-minute freshness window until the owner or the superadmin reconnects. Stored image
  copies keep working. BFF §63.32.1 gives it a "needs reconnect" state, a notice to whoever connected it, and a banner
  wherever Drive is used.
- **SCP-6 open questions (2026-10-31).** The contracts of BFF §63.31 (6b2) and §63.32 (6b5) are written for the default
  named in each, and the owner may overrule any of them. They carry no SCP-Q number on purpose: numbers are taken when the
  owner rules.
  - **SCP-6 OQ-1 · Who may connect, reconnect and disconnect the company's Google account?** Default: the owner and the
    superadmin only (`integration_connection` · `connect_shared`, PERMISSION §59). It puts the whole company's Drive in the
    ERP's reach, so it is the owner's call, as the GitHub App is. Alternatives: the four social approvers as well, or any
    company admin (one line in the contract, §59.4).
  - **SCP-6 OQ-2 · Is a "carousel video" a format of its own, or a carousel with a mark?** Default: a mark on a carousel
    (`carousel_video`), counted as its own kind in the month's output, so "3 carousels and 1 carousel video" is tracked as
    written. A format of its own would add a fifth format value to the posts, the allocation, the machine, the media rules,
    the portal's surface, the audit and the import, for a difference only the counts need; the network publishes it as a
    carousel anyway (BFF §63.31.8).
  - **SCP-6 OQ-3 · Which Google scope?** Default: `drive`, as SCP-D11 rules. `drive.readonly` is enough for every first
    feature (they only read) and would stop a leaked token from changing or deleting the team's files; the cost is one
    reconnect when the first write feature arrives. Both are restricted scopes, so the SaaS-later verification is the same.
    The build keeps the scope in one constant, so the owner's choice is a one-line change.
  - **SCP-6 OQ-4 · Are a post's images copied into the ERP?** Default: yes, exactly, when the designer submits (at most
    20 MiB each), so the record of what the client approved survives a later change or deletion in Drive; videos are never
    copied. At about 300 posts a month and three images of three megabytes each that is about 3 GB a month on the ERP's
    local disk (the server-e move may change the sum); the Drive status shows the running total. Alternative: store
    nothing, serve every image from Drive, and accept that an image replaced in Drive can no longer be shown as approved.
  - **SCP-6 OQ-5 · May a single month have its own targets per format?** Default: yes, an override on the cycle beside the
    client's standard package, because the real sheet states each month's output in its header and the months differ.
    Stories keep a line of their own outside the posts' total (SCP-Q46's plan reading, which the owner may overrule).
    Alternative: the allocation only, one package for every month.
  - **SCP-6 OQ-6 · Should the AI check run by itself when a post is sent to proofread?** Default: yes, in the background,
    as a company rule the four can switch off (with a second switch for rules-only, no AI spend); it never blocks and never
    edits. The month check is on demand only. Alternative: on demand only.
  - **SCP-6 OQ-7 · Do stories need a caption, and reposts on-image text?** Default: no and no. A story's text is its
    on-image text and its call to action, the real stories tab has no caption column, and most of its stories are reposts;
    feed, carousel and reel posts still need their caption. Without this every imported story is refused at "send to
    proofread" and needs a typed reason.
  - **SCP-6 OQ-8 · Should the ERP's Drive reach be limited to named root folders?** Default: no in the first release. The
    owner shares only the team's folders with the account, which is the same boundary, but any team member can paste a link
    to any file the account can read. If the account is ever shared wider, a root-folder allow-list, a setting the four
    edit and checked against each file's parents, is the fix.
  - **SCP-6 OQ-9 · Pin approved Drive revisions?** Default: not in the first release. A video replaced in Drive after the
    client approved it is detected by its MD5 and the post goes back to the client, but the approved bytes cannot be shown
    again: Google serves an old revision only when it is marked "Keep Forever", which is a write to the team's file and
    counts against their storage. Pinning at the client's approval is the later option.

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
| In-team designer | New `u-social-design`, placed in Social Media, holding the in-team designer role (SCP-Q2) | `social-design@gaiada.com` | New |
| HoD | `u-pm`, already in Social Media, given the Social Media lead seat (`org_unit_lead` on `dept-4`) | `social-head@gaiada.com` | New login, existing person |
| Creative | `u-creative`, in Creatives › Design | `creative@gaiada.com` | Exists (DW-9a) |
| GM | `u-gm`, the General Manager's lead seat on `dept-5` | `gm@gaiada.com` | New login, existing person |
| Client | The demo portal client | any `@northwind.example` | Exists |

- **The four approvers.** The existing superadmin identity (the default demo login) and owner identity (`demo-owner`,
  `group-owner@gaiada.com`) complete them with the HoD and the GM (SCP-Q19).
- **Matching.** Each new address matches exactly. It sits after the "client" test and before the "manager" and "ic"
  tests, as DW-9a's do. None of the new tokens contains "ic" or "client", and a test pins each address to its identity.
- **The store.** `lib/demoSocial.ts` keeps Northwind Traders and gains two invented clients, a spa and a hotel brand.
  Each gets an allocation (officer, creative source, posts per cycle, report format), with one client on the in-team
  designer and two on Creatives, a brand book, cycles for last month, this month
  and next, and a month of posts that covers all twelve statuses. That includes a blocked post, a client copy change, a
  client design change, a post with suggested edits waiting, and a live post with metrics for a boost. The images are
  generated placeholders; none comes from the prototypes.
- **The clock.** Tests that seed "a few days after today" pin the clock to mid-month, as `demoDeptCalendar.test.ts`
  now does, so they do not fail from about the 26th.

### 11.2 Test personas (IAM-06b)

`seedPersonaTenant` gains the role keys SCP-0b names for the Copywriter and the social approver, and a helper that
places an Officer on a client's allocation. Every stage-machine test seeds: two Officers, the Copywriter, the HoD, a
second approver (the GM), the owner, a company admin with no Social seat (refused, SCP-Q19), a designer on the
client-month request, and a client contact.

### 11.3 The live mock seed (gda-aicenter, under the owner's 2026-10-13 ruling)

- **Staff logins:** one labelled test user per role, display name "SCP test · <role>": Officer 1, Officer 2,
  Copywriter, HoD, Creative, In-team designer. They use addresses on a reserved test domain, never a real mailbox. They are created
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
